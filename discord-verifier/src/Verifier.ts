import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getClient, type ArgonClient } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import {
  DISCORD_ROLE_ORDER,
  verifyDiscordRoleProof,
  verifyDiscordRoleUpdateProof,
  verifyTreasuryMemberSeal,
  type DiscordEarnedRole,
  type IDiscordRoleProof,
  type IDiscordRoleSubmission,
  type IDiscordRoleUpdateProof,
} from '../../core/src/DiscordVerification.ts';
import { verifyOperationalAccessProof, type IOperationalAccessProof } from '../../core/src/OperationalAccessProof.ts';

export interface IOperationalAccountEvidence {
  isRegistered: boolean;
  isOperationallyCertified: boolean;
  finalizedBlockNumber: number;
}

export interface IRoleVerification {
  discordUserId: string;
  roles: DiscordEarnedRole[];
}

export interface IVaultDelegate {
  accountId: string;
  genesisHash: string;
}

export class VaultDelegateNotFoundError extends Error {}

interface ILegacySubmittedRoleProof extends IDiscordRoleProof {
  signature: string;
  accessProof?: IOperationalAccessProof;
}

interface ISubmittedRoleUpdateProof extends IDiscordRoleUpdateProof {
  signature: string;
}

export class Verifier {
  private readonly db: DatabaseSync;
  private readonly codes = new Map<string, { discordUserId: string; expiresAt: number }>();
  private clientPromise?: Promise<ArgonClient>;

  constructor(
    databasePath: string,
    private readonly discordApplicationId: string,
    private readonly codeTtlMs: number,
    private readonly rpcUrl: string,
  ) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (databasePath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS VerifiedUsers (
          discordUserId TEXT PRIMARY KEY,
          operationalAccountId TEXT NOT NULL UNIQUE,
          roles TEXT NOT NULL CHECK (json_valid(roles) AND json_type(roles) = 'array'),
          finalizedBlockNumber INTEGER NOT NULL
        );
      `);
      this.canonicalizeOperationalAccountIds();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  public issueCode(discordUserId: string, now = Date.now()): { code: string; expiresAt: number } {
    for (const [code, { discordUserId: pendingUserId, expiresAt }] of this.codes) {
      if (pendingUserId === discordUserId || expiresAt <= now) this.codes.delete(code);
    }
    const code = `ARGON-${randomBytes(16).toString('hex')}`;
    const expiresAt = now + this.codeTtlMs;
    this.codes.set(code, { discordUserId, expiresAt });
    return { code, expiresAt };
  }

  public getCode(code: string, now = Date.now()): { discordUserId: string; expiresAt: number } {
    const pending = this.codes.get(code);
    if (!pending) throw new Error('Discord verification code was not found.');
    const { expiresAt } = pending;
    if (expiresAt <= now) {
      this.codes.delete(code);
      throw new Error('Discord verification code has expired.');
    }
    return pending;
  }

  public completeCode(
    proof: ILegacySubmittedRoleProof | IDiscordRoleSubmission,
    operationalAccount: IOperationalAccountEvidence,
    now = Date.now(),
    authority: {
      upstreamAccount?: IOperationalAccountEvidence;
      vaultDelegate?: IVaultDelegate;
    } = {},
  ): IRoleVerification {
    const { verificationCode, discordApplicationId, operationalAccountId, signature } = proof;
    const { discordUserId } = this.getCode(verificationCode, now);

    if (discordApplicationId !== this.discordApplicationId) {
      throw new Error('Discord role proof application is invalid.');
    }

    const operationalProof =
      proof.version === 1
        ? proof
        : {
            version: 1 as const,
            discordApplicationId,
            verificationCode,
            operationalAccountId,
          };
    if (!verifyDiscordRoleProof(operationalProof, signature)) {
      throw new Error('Discord role proof signature is invalid.');
    }

    const roles: DiscordEarnedRole[] = [];
    if (
      proof.version === 1 &&
      proof.accessProof &&
      verifyOperationalAccessProof(proof.accessProof, operationalAccountId) &&
      authority.upstreamAccount?.isRegistered
    ) {
      roles.push('treasuryUser');
    }
    if (proof.version === 2 && proof.treasuryMemberSeal) {
      const { treasuryMemberSeal } = proof;
      const { vaultDelegate } = authority;
      if (!vaultDelegate || treasuryMemberSeal.genesisHash.toLowerCase() !== vaultDelegate.genesisHash.toLowerCase()) {
        throw new Error('Treasury membership proof genesis is invalid.');
      }
      if (!verifyTreasuryMemberSeal(proof, treasuryMemberSeal, vaultDelegate.accountId)) {
        throw new Error('Treasury membership proof is invalid.');
      }
      roles.push('treasuryUser');
    }
    if (operationalAccount.isRegistered) roles.push('treasuryCertified');
    if (operationalAccount.isOperationallyCertified) roles.push('operationallyCertified');
    if (!roles.length) throw new Error('No Argon role could be proven from finalized state.');

    const canonicalOperationalAccountId = canonicalizeAccountId(operationalAccountId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentUser = this.db
        .prepare(`SELECT operationalAccountId, roles FROM VerifiedUsers WHERE discordUserId = ?`)
        .get(discordUserId) as { operationalAccountId: string; roles: string } | undefined;
      const { operationalAccountId: boundAccountId, roles: currentRoles = '[]' } = currentUser ?? {};

      if (boundAccountId && boundAccountId !== canonicalOperationalAccountId) {
        throw new Error('Discord account is already bound to another operational account.');
      }

      const existing = this.db
        .prepare(`SELECT discordUserId FROM VerifiedUsers WHERE operationalAccountId = ?`)
        .get(canonicalOperationalAccountId) as { discordUserId: string } | undefined;

      if (existing && existing.discordUserId !== discordUserId) {
        throw new Error('Operational account is already bound to another Discord account.');
      }

      const granted = new Set<DiscordEarnedRole>(JSON.parse(currentRoles) as DiscordEarnedRole[]);
      for (const role of roles) granted.add(role);

      this.db
        .prepare(
          `INSERT INTO VerifiedUsers
             (discordUserId, operationalAccountId, roles, finalizedBlockNumber)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(discordUserId) DO UPDATE SET
             roles = excluded.roles,
             finalizedBlockNumber = excluded.finalizedBlockNumber`,
        )
        .run(
          discordUserId,
          canonicalOperationalAccountId,
          JSON.stringify(DISCORD_ROLE_ORDER.filter(role => granted.has(role))),
          operationalAccount.finalizedBlockNumber,
        );

      this.db.exec('COMMIT');
      this.codes.delete(verificationCode);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.getVerification(discordUserId)!;
  }

  public getVerification(discordUserId: string): IRoleVerification | undefined {
    const user = this.db.prepare(`SELECT roles FROM VerifiedUsers WHERE discordUserId = ?`).get(discordUserId) as
      | { roles: string }
      | undefined;
    if (!user) return;
    const { roles } = user;
    const granted = new Set(JSON.parse(roles) as DiscordEarnedRole[]);
    return { discordUserId, roles: DISCORD_ROLE_ORDER.filter(role => granted.has(role)) };
  }

  public completeUpdate(
    proof: ISubmittedRoleUpdateProof,
    operationalAccount: IOperationalAccountEvidence,
    now = Date.now(),
  ): IRoleVerification {
    const { discordUserId } = this.getUpdateBinding(proof, now);
    const user = this.db.prepare(`SELECT roles FROM VerifiedUsers WHERE discordUserId = ?`).get(discordUserId) as {
      roles: string;
    };
    const granted = new Set<DiscordEarnedRole>(JSON.parse(user.roles) as DiscordEarnedRole[]);

    if (operationalAccount.isRegistered) granted.add('treasuryCertified');
    if (operationalAccount.isOperationallyCertified) granted.add('operationallyCertified');

    const roles = DISCORD_ROLE_ORDER.filter(role => granted.has(role));
    this.db
      .prepare(`UPDATE VerifiedUsers SET roles = ?, finalizedBlockNumber = ? WHERE discordUserId = ?`)
      .run(JSON.stringify(roles), operationalAccount.finalizedBlockNumber, discordUserId);

    return { discordUserId, roles };
  }

  public getUpdateBinding(proof: ISubmittedRoleUpdateProof, now = Date.now()): { discordUserId: string } {
    const { discordApplicationId, signedAt, operationalAccountId, signature } = proof;
    if (discordApplicationId !== this.discordApplicationId) {
      throw new Error('Discord role update application is invalid.');
    }
    if (!verifyDiscordRoleUpdateProof(proof, signature)) {
      throw new Error('Discord role update signature is invalid.');
    }
    if (signedAt > now || now - signedAt >= this.codeTtlMs) {
      throw new Error('Discord role update proof has expired.');
    }

    const user = this.db
      .prepare(`SELECT discordUserId FROM VerifiedUsers WHERE operationalAccountId = ?`)
      .get(canonicalizeAccountId(operationalAccountId)) as { discordUserId: string } | undefined;
    if (!user) throw new Error('Discord account is not connected. Run /connect-desktop-app first.');
    return user;
  }

  public async loadOperationalAccount(operationalAccountId: string): Promise<IOperationalAccountEvidence> {
    this.clientPromise ??= getClient(this.rpcUrl, { throwOnConnect: true }).catch(error => {
      this.clientPromise = undefined;
      throw error;
    });

    const connection = this.clientPromise;
    const client = await connection;

    try {
      const finalizedBlockHash = await client.rpc.chain.getFinalizedHead();
      const [finalizedClient, header] = await Promise.all([
        runtimeClient(client).at(finalizedBlockHash),
        client.rpc.chain.getHeader(finalizedBlockHash),
      ]);

      const finalizedBlockNumber = header.number.toNumber();
      const account = await finalizedClient.query.operationalAccounts.operationalAccounts(operationalAccountId);
      return {
        isRegistered: account !== null,
        isOperationallyCertified: account?.isOperationallyCertified ?? account?.isOperational ?? false,
        finalizedBlockNumber,
      };
    } catch (error) {
      if (this.clientPromise === connection) this.clientPromise = undefined;
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  public async loadRoleEvidence(
    operationalAccountId: string,
    authority: { upstreamAccountId?: string; vaultId?: number },
  ): Promise<{
    operationalAccount: IOperationalAccountEvidence;
    upstreamAccount?: IOperationalAccountEvidence;
    vaultDelegate?: IVaultDelegate;
  }> {
    this.clientPromise ??= getClient(this.rpcUrl, { throwOnConnect: true }).catch(error => {
      this.clientPromise = undefined;
      throw error;
    });

    const connection = this.clientPromise;
    const client = await connection;

    try {
      const finalizedBlockHash = await client.rpc.chain.getFinalizedHead();
      const [finalizedClient, header] = await Promise.all([
        runtimeClient(client).at(finalizedBlockHash),
        client.rpc.chain.getHeader(finalizedBlockHash),
      ]);
      const [operationalAccount, upstreamAccount, vault] = await Promise.all([
        finalizedClient.query.operationalAccounts.operationalAccounts(operationalAccountId),
        authority.upstreamAccountId
          ? finalizedClient.query.operationalAccounts.operationalAccounts(authority.upstreamAccountId)
          : undefined,
        authority.vaultId === undefined ? undefined : finalizedClient.query.vaults.vaultsById(authority.vaultId),
      ]);

      if (authority.vaultId !== undefined && !vault) {
        throw new VaultDelegateNotFoundError('Treasury vault was not found.');
      }

      const finalizedBlockNumber = header.number.toNumber();
      let vaultDelegate: IVaultDelegate | undefined;
      if (vault) {
        const { delegateAccountId } = vault;
        if (!delegateAccountId) {
          throw new VaultDelegateNotFoundError('Treasury vault delegate was not found.');
        }
        vaultDelegate = {
          accountId: delegateAccountId,
          genesisHash: client.genesisHash.toHex(),
        };
      }

      return {
        operationalAccount: {
          isRegistered: operationalAccount !== null,
          isOperationallyCertified:
            operationalAccount?.isOperationallyCertified ?? operationalAccount?.isOperational ?? false,
          finalizedBlockNumber,
        },
        upstreamAccount: authority.upstreamAccountId
          ? {
              isRegistered: upstreamAccount !== null,
              isOperationallyCertified:
                upstreamAccount?.isOperationallyCertified ?? upstreamAccount?.isOperational ?? false,
              finalizedBlockNumber,
            }
          : undefined,
        vaultDelegate,
      };
    } catch (error) {
      if (error instanceof VaultDelegateNotFoundError) throw error;
      if (this.clientPromise === connection) this.clientPromise = undefined;
      await client.disconnect().catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> {
    const connection = this.clientPromise;
    this.clientPromise = undefined;
    await connection?.then(client => client.disconnect()).catch(() => undefined);
    this.db.close();
  }

  private canonicalizeOperationalAccountIds(): void {
    const bindings = this.db.prepare(`SELECT discordUserId, operationalAccountId FROM VerifiedUsers`).all() as {
      discordUserId: string;
      operationalAccountId: string;
    }[];
    const boundAccounts = new Set<string>();
    let requiresCanonicalization = false;
    const canonicalBindings = bindings.map(binding => {
      const operationalAccountId = canonicalizeAccountId(binding.operationalAccountId);
      if (boundAccounts.has(operationalAccountId)) {
        throw new Error(
          'VerifiedUsers contains conflicting Discord bindings for one operational account. ' +
            'Remove all but the correct binding before restarting the verifier.',
        );
      }
      boundAccounts.add(operationalAccountId);
      requiresCanonicalization ||= binding.operationalAccountId !== operationalAccountId;
      return { discordUserId: binding.discordUserId, operationalAccountId };
    });
    if (!requiresCanonicalization) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(`UPDATE VerifiedUsers SET operationalAccountId = ? WHERE discordUserId = ?`);
      for (const binding of canonicalBindings) {
        update.run(binding.operationalAccountId, binding.discordUserId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function canonicalizeAccountId(accountId: string): string {
  return encodeAddress(decodeAddress(accountId));
}
