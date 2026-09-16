import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Keyring } from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  signDiscordRoleProof,
  signDiscordRoleUpdateProof,
  signTreasuryMemberSeal,
} from '../../core/src/DiscordVerification.ts';
import { createOperationalAccessProof } from '../../core/src/OperationalAccessProof.ts';
import { Verifier, type IOperationalAccountEvidence } from '../src/Verifier.ts';

const NOW = 1_788_000_000_000;
const CODE_TTL_MS = 5 * 60_000;
const APPLICATION_ID = '123456789012345678';
const DISCORD_USER_ID = '456789012345678901';
const SECOND_DISCORD_USER_ID = '567890123456789012';
const GENESIS_HASH = `0x${'11'.repeat(32)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('role proofs', () => {
  it('grants Treasury roles from matching member and Discord proofs', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');
    const code = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    const proof = treasuryProof(code, delegate, operational);

    const verification = verifier.completeCode(proof, evidence({ registered: true }), NOW, {
      vaultDelegate: vaultDelegate(delegate),
    });

    expect(verification).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified'],
    });
    await verifier.close();
  });

  it('continues accepting v1 access proofs during the rollout', async () => {
    const upstream = account('//UpstreamOperator');
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');
    const code = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    const proof = {
      version: 1 as const,
      discordApplicationId: APPLICATION_ID,
      verificationCode: code,
      operationalAccountId: operational.address,
    };

    const verification = verifier.completeCode(
      {
        ...proof,
        signature: signDiscordRoleProof(operational, proof),
        accessProof: createOperationalAccessProof(upstream, operational.address),
      },
      evidence({}),
      NOW,
      { upstreamAccount: evidence({ registered: true }) },
    );

    expect(verification).toEqual({ discordUserId: DISCORD_USER_ID, roles: ['treasuryUser'] });
    await verifier.close();
  });

  it('rejects a Treasury proof from another Argon genesis', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');
    const code = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    const proof = treasuryProof(code, delegate, operational);

    expect(() =>
      verifier.completeCode(proof, evidence({}), NOW, {
        vaultDelegate: {
          accountId: delegate.address,
          genesisHash: `0x${'22'.repeat(32)}`,
        },
      }),
    ).toThrow('Treasury membership proof genesis is invalid');
    await verifier.close();
  });

  it('grants cumulative roles from Treasury membership and finalized operational account state', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');

    const firstCode = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    const treasuryUser = verifier.completeCode(
      treasuryProof(firstCode, delegate, operational),
      evidence({}),
      NOW + 1_000,
      { vaultDelegate: vaultDelegate(delegate) },
    );
    expect(treasuryUser).toEqual({ discordUserId: DISCORD_USER_ID, roles: ['treasuryUser'] });

    const secondCode = verifier.issueCode(DISCORD_USER_ID, NOW + 2_000).code;
    const certified = verifier.completeCode(
      roleProof(secondCode, operational),
      evidence({ registered: true, certified: true }, 123_457),
      NOW + 3_000,
    );
    expect(certified).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified', 'operationallyCertified'],
    });
    await verifier.close();
  });

  it('preserves earned roles across restart and later lower evidence', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const databasePath = temporaryDatabasePath();
    const first = createVerifier(databasePath);
    completeTreasuryMember(first, delegate, operational, evidence({ registered: true, certified: true }));
    await first.close();

    const restarted = createVerifier(databasePath);
    const code = restarted.issueCode(DISCORD_USER_ID, NOW + 2_000).code;
    restarted.completeCode(treasuryProof(code, delegate, operational), evidence({}, 123_457), NOW + 3_000, {
      vaultDelegate: vaultDelegate(delegate),
    });

    expect(restarted.getVerification(DISCORD_USER_ID)).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified', 'operationallyCertified'],
    });
    await restarted.close();
  });

  it('updates roles through a permanent binding after restart without another Discord code', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const databasePath = temporaryDatabasePath();
    const first = createVerifier(databasePath);
    completeTreasuryMember(first, delegate, operational);
    await first.close();

    const restarted = createVerifier(databasePath);
    const updated = restarted.completeUpdate(
      roleUpdateProof(operational, NOW + 2_000),
      evidence({ registered: true, certified: true }, 123_457),
      NOW + 3_000,
    );

    expect(updated).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified', 'operationallyCertified'],
    });
    await restarted.close();
  });

  it('updates a permanent binding through any SS58 encoding of its operational account', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');
    completeTreasuryMember(verifier, delegate, operational);

    const updated = verifier.completeUpdate(
      roleUpdateProof(operational, NOW + 2_000, encodeAddress(operational.publicKey, 0)),
      evidence({ registered: true }, 123_457),
      NOW + 3_000,
    );

    expect(updated).toEqual({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified'],
    });
    await verifier.close();
  });

  it('rejects a role update for an operational account without a Discord binding', async () => {
    const candidate = account('//DiscordCandidate');
    const verifier = createVerifier(':memory:');

    expect(() =>
      verifier.completeUpdate(roleUpdateProof(candidate, NOW), evidence({ registered: true }), NOW + 1_000),
    ).toThrow('not connected');
    await verifier.close();
  });

  it('rejects a stale signed role update', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');
    completeTreasuryMember(verifier, delegate, operational);

    expect(() =>
      verifier.completeUpdate(roleUpdateProof(operational, NOW), evidence({ registered: true }), NOW + CODE_TTL_MS + 1),
    ).toThrow('expired');
    await verifier.close();
  });

  it('requires a valid operational signature and finalized role state', async () => {
    const operational = account('//DiscordOperational');
    const other = account('//OtherOperational');
    const verifier = createVerifier(':memory:');

    const invalidOwnershipCode = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    expect(() =>
      verifier.completeCode(
        {
          ...roleProof(invalidOwnershipCode, operational),
          signature: roleProof(invalidOwnershipCode, other).signature,
        },
        evidence({ registered: true }),
        NOW + 1_000,
      ),
    ).toThrow('signature is invalid');

    const unregisteredCode = verifier.issueCode(DISCORD_USER_ID, NOW + 2_000).code;
    expect(() => verifier.completeCode(roleProof(unregisteredCode, operational), evidence({}), NOW + 3_000)).toThrow(
      'No Argon role could be proven',
    );
    await verifier.close();
  });

  it('does not let a second Discord account claim an already-bound operational account', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');
    completeTreasuryMember(verifier, delegate, operational);
    const secondCode = verifier.issueCode(SECOND_DISCORD_USER_ID, NOW + 2_000).code;

    expect(() =>
      verifier.completeCode(roleProof(secondCode, operational), evidence({ registered: true }), NOW + 3_000),
    ).toThrow('already bound');
    await verifier.close();
  });

  it('does not let SS58 aliases bind one operational account to multiple Discord accounts', async () => {
    const candidate = account('//DiscordCandidate');
    const verifier = createVerifier(':memory:');
    const firstCode = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    verifier.completeCode(roleProof(firstCode, candidate), evidence({ registered: true }), NOW + 1_000);
    const secondCode = verifier.issueCode(SECOND_DISCORD_USER_ID, NOW + 2_000).code;
    const aliasedAddress = encodeAddress(candidate.publicKey, 0);

    expect(() =>
      verifier.completeCode(
        roleProof(secondCode, candidate, aliasedAddress),
        evidence({ registered: true }),
        NOW + 3_000,
      ),
    ).toThrow('already bound');
    await verifier.close();
  });

  it('canonicalizes existing bindings before enforcing account uniqueness', async () => {
    const candidate = account('//DiscordCandidate');
    const databasePath = temporaryDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE VerifiedUsers (
        discordUserId TEXT PRIMARY KEY,
        operationalAccountId TEXT NOT NULL UNIQUE,
        roles TEXT NOT NULL CHECK (json_valid(roles) AND json_type(roles) = 'array'),
        finalizedBlockNumber INTEGER NOT NULL
      );
    `);
    database
      .prepare(
        `INSERT INTO VerifiedUsers (discordUserId, operationalAccountId, roles, finalizedBlockNumber)
         VALUES (?, ?, ?, ?)`,
      )
      .run(DISCORD_USER_ID, encodeAddress(candidate.publicKey, 0), '["treasuryCertified"]', 123_456);
    database.close();

    const verifier = createVerifier(databasePath);
    const secondCode = verifier.issueCode(SECOND_DISCORD_USER_ID, NOW).code;

    expect(() =>
      verifier.completeCode(roleProof(secondCode, candidate), evidence({ registered: true }), NOW + 1_000),
    ).toThrow('already bound');
    await verifier.close();
  });

  it('fails closed before canonicalizing conflicting legacy SS58 bindings', () => {
    const candidate = account('//DiscordCandidate');
    const firstAlias = encodeAddress(candidate.publicKey, 0);
    const secondAlias = encodeAddress(candidate.publicKey, 2);
    const databasePath = temporaryDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE VerifiedUsers (
        discordUserId TEXT PRIMARY KEY,
        operationalAccountId TEXT NOT NULL UNIQUE,
        roles TEXT NOT NULL CHECK (json_valid(roles) AND json_type(roles) = 'array'),
        finalizedBlockNumber INTEGER NOT NULL
      );
    `);
    const insert = database.prepare(
      `INSERT INTO VerifiedUsers (discordUserId, operationalAccountId, roles, finalizedBlockNumber)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run(DISCORD_USER_ID, firstAlias, '["treasuryCertified"]', 123_456);
    insert.run(SECOND_DISCORD_USER_ID, secondAlias, '["treasuryCertified"]', 123_456);
    database.close();

    const closeDatabase = vi.spyOn(DatabaseSync.prototype, 'close');
    try {
      expect(() => createVerifier(databasePath)).toThrow(
        'VerifiedUsers contains conflicting Discord bindings for one operational account',
      );
      expect(closeDatabase).toHaveBeenCalledOnce();
    } finally {
      closeDatabase.mockRestore();
    }

    const unchanged = new DatabaseSync(databasePath);
    expect(
      unchanged.prepare(`SELECT discordUserId, operationalAccountId FROM VerifiedUsers ORDER BY discordUserId`).all(),
    ).toEqual([
      { discordUserId: DISCORD_USER_ID, operationalAccountId: firstAlias },
      { discordUserId: SECOND_DISCORD_USER_ID, operationalAccountId: secondAlias },
    ]);
    unchanged.close();
  });

  it('persists the operational proof used for Treasury verification across restart', async () => {
    const delegate = account('//TreasuryDelegate');
    const operational = account('//DiscordOperational');
    const databasePath = temporaryDatabasePath();
    const verifier = createVerifier(databasePath);
    const code = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    const proof = treasuryProof(code, delegate, operational);
    verifier.completeCode(proof, evidence({}), NOW, { vaultDelegate: vaultDelegate(delegate) });
    await verifier.close();

    const restarted = createVerifier(databasePath);
    expect(
      restarted.completeUpdate(
        roleUpdateProof(operational, NOW + 1_000),
        evidence({ registered: true }, 123_457),
        NOW + 2_000,
      ),
    ).toEqual({ discordUserId: DISCORD_USER_ID, roles: ['treasuryUser', 'treasuryCertified'] });
    await restarted.close();
  });

  it('does not let a Discord account replace the operational account behind permanent grants', async () => {
    const delegate = account('//TreasuryDelegate');
    const firstOperational = account('//DiscordOperational');
    const secondOperational = account('//SecondDiscordOperational');
    const verifier = createVerifier(':memory:');
    completeTreasuryMember(verifier, delegate, firstOperational, evidence({ registered: true }));
    const secondCode = verifier.issueCode(DISCORD_USER_ID, NOW + 2_000).code;

    expect(() =>
      verifier.completeCode(
        roleProof(secondCode, secondOperational),
        evidence({ registered: true, certified: true }),
        NOW + 3_000,
      ),
    ).toThrow('Discord account is already bound');
    await verifier.close();
  });

  it('rejects expired and replayed codes', async () => {
    const operational = account('//DiscordOperational');
    const verifier = createVerifier(':memory:');
    const expired = verifier.issueCode(DISCORD_USER_ID, NOW).code;
    expect(() =>
      verifier.completeCode(roleProof(expired, operational), evidence({ registered: true }), NOW + CODE_TTL_MS),
    ).toThrow('expired');

    const code = verifier.issueCode(DISCORD_USER_ID, NOW + CODE_TTL_MS).code;
    const proof = roleProof(code, operational);
    verifier.completeCode(proof, evidence({ registered: true }), NOW + CODE_TTL_MS + 1_000);
    expect(() => verifier.completeCode(proof, evidence({ registered: true }), NOW + CODE_TTL_MS + 1_000)).toThrow(
      'not found',
    );
    await verifier.close();
  });
});

function createVerifier(databasePath: string): Verifier {
  return new Verifier(databasePath, APPLICATION_ID, CODE_TTL_MS, 'ws://unused');
}

function account(uri: string) {
  return new Keyring({ type: 'sr25519' }).addFromUri(uri);
}

function roleProof(code: string, candidate: ReturnType<typeof account>, operationalAccountId = candidate.address) {
  const claim = {
    discordApplicationId: APPLICATION_ID,
    verificationCode: code,
    operationalAccountId,
  };
  return {
    version: 2 as const,
    ...claim,
    signature: signDiscordRoleProof(candidate, { version: 1, ...claim }),
  };
}

function roleUpdateProof(
  candidate: ReturnType<typeof account>,
  signedAt: number,
  operationalAccountId = candidate.address,
) {
  const proof = {
    version: 1 as const,
    discordApplicationId: APPLICATION_ID,
    signedAt,
    operationalAccountId,
  };
  return { ...proof, signature: signDiscordRoleUpdateProof(candidate, proof) };
}

function treasuryProof(code: string, delegate: ReturnType<typeof account>, operational: ReturnType<typeof account>) {
  const proof = roleProof(code, operational);
  const treasuryMemberSeal = signTreasuryMemberSeal(delegate, proof, {
    genesisHash: GENESIS_HASH,
    vaultId: 12,
  });

  return {
    ...proof,
    treasuryMemberSeal,
  };
}

function vaultDelegate(delegate: ReturnType<typeof account>) {
  return {
    accountId: delegate.address,
    genesisHash: GENESIS_HASH,
  };
}

function evidence(
  roles: { registered?: boolean; certified?: boolean },
  finalizedBlockNumber = 123_456,
): IOperationalAccountEvidence {
  return {
    isRegistered: roles.registered === true,
    isOperationallyCertified: roles.certified === true,
    finalizedBlockNumber,
  };
}

function completeTreasuryMember(
  verifier: Verifier,
  delegate: ReturnType<typeof account>,
  operational: ReturnType<typeof account>,
  operationalAccount = evidence({}),
) {
  const code = verifier.issueCode(DISCORD_USER_ID, NOW).code;
  return verifier.completeCode(treasuryProof(code, delegate, operational), operationalAccount, NOW + 1_000, {
    vaultDelegate: vaultDelegate(delegate),
  });
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'argon-discord-verifier-'));
  temporaryDirectories.push(directory);
  return join(directory, 'verifier.sqlite');
}
