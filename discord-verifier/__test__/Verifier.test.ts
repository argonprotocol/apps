import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keyring } from '@argonprotocol/mainchain';
import { afterEach, describe, expect, it } from 'vitest';
import { signDiscordRoleProof, signDiscordRoleUpdateProof } from '../../core/src/DiscordVerification.ts';
import { createOperationalAccessProof } from '../../core/src/OperationalAccessProof.ts';
import { Verifier, type IAccountEvidence } from '../src/Verifier.ts';

const NOW = 1_788_000_000_000;
const CODE_TTL_MS = 5 * 60_000;
const APPLICATION_ID = '123456789012345678';
const DISCORD_USER_ID = '456789012345678901';
const SECOND_DISCORD_USER_ID = '567890123456789012';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('role proofs', () => {
  it('grants cumulative roles from public access and finalized certification evidence', async () => {
    const upstream = account('//UpstreamOperator');
    const candidate = account('//DiscordCandidate');
    const verifier = createVerifier(':memory:');

    const firstCode = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    const treasuryUser = verifier.completeCode(
      roleProof(firstCode, candidate),
      createOperationalAccessProof(upstream, candidate.address),
      evidence({ upstream: true }),
      NOW + 1_000,
    );
    expect(treasuryUser).toEqual({ discordUserId: DISCORD_USER_ID, roles: ['treasuryUser'] });

    const secondCode = verifier.issueCode(DISCORD_USER_ID, NOW + 2_000).code;
    const certified = verifier.completeCode(
      roleProof(secondCode, candidate),
      createOperationalAccessProof(upstream, candidate.address),
      evidence({ upstream: true, candidateRegistered: true, operational: true }, 123_457),
      NOW + 3_000,
    );
    expect(certified).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified', 'operationallyCertified'],
    });
    await verifier.close();
  });

  it('preserves earned roles across restart and later lower evidence', async () => {
    const upstream = account('//UpstreamOperator');
    const candidate = account('//DiscordCandidate');
    const databasePath = temporaryDatabasePath();
    const first = createVerifier(databasePath);
    complete(first, upstream, candidate, evidence({ upstream: true, candidateRegistered: true, operational: true }));
    await first.close();

    const restarted = createVerifier(databasePath);
    const code = restarted.issueCode(DISCORD_USER_ID, NOW + 2_000).code;
    restarted.completeCode(
      roleProof(code, candidate),
      createOperationalAccessProof(upstream, candidate.address),
      evidence({ upstream: true }, 123_457),
      NOW + 3_000,
    );

    expect(restarted.getVerification(DISCORD_USER_ID)).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified', 'operationallyCertified'],
    });
    await restarted.close();
  });

  it('updates roles through a permanent binding after restart without another Discord code', async () => {
    const upstream = account('//UpstreamOperator');
    const candidate = account('//DiscordCandidate');
    const databasePath = temporaryDatabasePath();
    const first = createVerifier(databasePath);
    complete(first, upstream, candidate, evidence({ upstream: true }));
    await first.close();

    const restarted = createVerifier(databasePath);
    const updated = restarted.completeUpdate(
      roleUpdateProof(candidate, NOW + 2_000),
      evidence({ candidateRegistered: true, operational: true }, 123_457).candidate,
      NOW + 3_000,
    );

    expect(updated).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified', 'operationallyCertified'],
    });
    await restarted.close();
  });

  it('rejects a role update for an operational account without a Discord binding', async () => {
    const candidate = account('//DiscordCandidate');
    const verifier = createVerifier(':memory:');

    expect(() =>
      verifier.completeUpdate(
        roleUpdateProof(candidate, NOW),
        evidence({ candidateRegistered: true }).candidate,
        NOW + 1_000,
      ),
    ).toThrow('not connected');
    await verifier.close();
  });

  it('rejects a stale signed role update', async () => {
    const upstream = account('//UpstreamOperator');
    const candidate = account('//DiscordCandidate');
    const verifier = createVerifier(':memory:');
    complete(verifier, upstream, candidate, evidence({ upstream: true }));

    expect(() =>
      verifier.completeUpdate(
        roleUpdateProof(candidate, NOW),
        evidence({ candidateRegistered: true }).candidate,
        NOW + CODE_TTL_MS + 1,
      ),
    ).toThrow('expired');
    await verifier.close();
  });

  it('requires both candidate ownership and a registered upstream for Treasury User', async () => {
    const upstream = account('//UpstreamOperator');
    const candidate = account('//DiscordCandidate');
    const other = account('//OtherCandidate');
    const verifier = createVerifier(':memory:');

    const invalidOwnershipCode = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    expect(() =>
      verifier.completeCode(
        { ...roleProof(invalidOwnershipCode, candidate), signature: roleProof(invalidOwnershipCode, other).signature },
        createOperationalAccessProof(upstream, candidate.address),
        evidence({ upstream: true }),
        NOW + 1_000,
      ),
    ).toThrow('signature is invalid');

    const unregisteredUpstreamCode = verifier.issueCode(DISCORD_USER_ID, NOW + 2_000).code;
    expect(() =>
      verifier.completeCode(
        roleProof(unregisteredUpstreamCode, candidate),
        createOperationalAccessProof(upstream, candidate.address),
        evidence({ upstream: false }),
        NOW + 3_000,
      ),
    ).toThrow('No Argon role could be proven');
    await verifier.close();
  });

  it('does not let a second Discord account claim an already-bound operational account', async () => {
    const upstream = account('//UpstreamOperator');
    const candidate = account('//DiscordCandidate');
    const verifier = createVerifier(':memory:');
    complete(verifier, upstream, candidate, evidence({ upstream: true }));
    const secondCode = verifier.issueCode(SECOND_DISCORD_USER_ID, NOW + 2_000).code;

    expect(() =>
      verifier.completeCode(
        roleProof(secondCode, candidate),
        createOperationalAccessProof(upstream, candidate.address),
        evidence({ upstream: true }),
        NOW + 3_000,
      ),
    ).toThrow('already bound');
    await verifier.close();
  });

  it('does not let a Discord account replace the operational account behind permanent grants', async () => {
    const upstream = account('//UpstreamOperator');
    const firstCandidate = account('//DiscordCandidate');
    const secondCandidate = account('//SecondDiscordCandidate');
    const verifier = createVerifier(':memory:');
    complete(verifier, upstream, firstCandidate, evidence({ upstream: true, candidateRegistered: true }));
    const secondCode = verifier.issueCode(DISCORD_USER_ID, NOW + 2_000).code;

    expect(() =>
      verifier.completeCode(
        roleProof(secondCode, secondCandidate),
        createOperationalAccessProof(upstream, secondCandidate.address),
        evidence({ upstream: true, candidateRegistered: true, operational: true }),
        NOW + 3_000,
      ),
    ).toThrow('Discord account is already bound');
    await verifier.close();
  });

  it('rejects expired and replayed codes', async () => {
    const upstream = account('//UpstreamOperator');
    const candidate = account('//DiscordCandidate');
    const verifier = createVerifier(':memory:');
    const expired = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    expect(() =>
      verifier.completeCode(
        roleProof(expired, candidate),
        createOperationalAccessProof(upstream, candidate.address),
        evidence({ upstream: true }),
        NOW + CODE_TTL_MS,
      ),
    ).toThrow('expired');

    const code = verifier.issueCode(DISCORD_USER_ID, NOW + CODE_TTL_MS).code;
    const proof = roleProof(code, candidate);
    verifier.completeCode(
      proof,
      createOperationalAccessProof(upstream, candidate.address),
      evidence({ upstream: true }),
      NOW + CODE_TTL_MS + 1_000,
    );
    expect(() =>
      verifier.completeCode(
        proof,
        createOperationalAccessProof(upstream, candidate.address),
        evidence({ upstream: true }),
        NOW + CODE_TTL_MS + 1_000,
      ),
    ).toThrow('not found');
    await verifier.close();
  });
});

function createVerifier(databasePath: string): Verifier {
  return new Verifier(databasePath, APPLICATION_ID, CODE_TTL_MS, 'ws://unused');
}

function account(uri: string) {
  return new Keyring({ type: 'sr25519' }).addFromUri(uri);
}

function roleProof(code: string, candidate: ReturnType<typeof account>) {
  const proof = {
    version: 1 as const,
    discordApplicationId: APPLICATION_ID,
    verificationCode: code,
    operationalAccountId: candidate.address,
  };
  return { ...proof, signature: signDiscordRoleProof(candidate, proof) };
}

function roleUpdateProof(candidate: ReturnType<typeof account>, signedAt: number) {
  const proof = {
    version: 1 as const,
    discordApplicationId: APPLICATION_ID,
    signedAt,
    operationalAccountId: candidate.address,
  };
  return { ...proof, signature: signDiscordRoleUpdateProof(candidate, proof) };
}

function evidence(
  roles: { upstream?: boolean; candidateRegistered?: boolean; operational?: boolean },
  finalizedBlockNumber = 123_456,
): { candidate: IAccountEvidence; upstream: IAccountEvidence } {
  return {
    candidate: {
      isRegistered: roles.candidateRegistered === true,
      isOperationallyCertified: roles.operational === true,
      finalizedBlockNumber,
    },
    upstream: {
      isRegistered: roles.upstream === true,
      isOperationallyCertified: false,
      finalizedBlockNumber,
    },
  };
}

function complete(
  verifier: Verifier,
  upstream: ReturnType<typeof account>,
  candidate: ReturnType<typeof account>,
  accountEvidence: ReturnType<typeof evidence>,
) {
  const code = verifier.issueCode(DISCORD_USER_ID, NOW).code;
  return verifier.completeCode(
    roleProof(code, candidate),
    createOperationalAccessProof(upstream, candidate.address),
    accountEvidence,
    NOW + 1_000,
  );
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'argon-discord-verifier-'));
  temporaryDirectories.push(directory);
  return join(directory, 'verifier.sqlite');
}
