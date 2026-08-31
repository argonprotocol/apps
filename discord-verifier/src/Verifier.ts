import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getClient, type ArgonClient } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import {
  DISCORD_ROLE_ORDER,
  verifyDiscordRoleProof,
  verifyDiscordRoleUpdateProof,
  type DiscordEarnedRole,
  type IDiscordRoleProof,
  type IDiscordRoleUpdateProof,
} from '../../core/src/DiscordVerification.ts';
import { verifyOperationalAccessProof, type IOperationalAccessProof } from '../../core/src/OperationalAccessProof.ts';

export interface IAccountEvidence {
  isRegistered: boolean;
  isOperationallyCertified: boolean;
  finalizedBlockNumber: number;
}

export interface IRoleVerification {
  discordUserId: string;
  roles: DiscordEarnedRole[];
}

export interface IRoleEvidence {
  candidate: IAccountEvidence;
  upstream?: IAccountEvidence;
}

interface ISubmittedRoleProof extends IDiscordRoleProof {
  signature: string;
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
    proof: ISubmittedRoleProof,
    accessProof: IOperationalAccessProof | undefined,
    { candidate, upstream }: IRoleEvidence,
    now = Date.now(),
  ): IRoleVerification {
    const { verificationCode, discordApplicationId, operationalAccountId, signature } = proof;
    const { discordUserId } = this.getCode(verificationCode, now);
    if (discordApplicationId !== this.discordApplicationId) {
      throw new Error('Discord role proof application is invalid.');
    }
    if (!verifyDiscordRoleProof(proof, signature)) {
      throw new Error('Discord role proof signature is invalid.');
    }

    const roles: DiscordEarnedRole[] = [];
    if (accessProof && verifyOperationalAccessProof(accessProof, operationalAccountId) && upstream?.isRegistered) {
      roles.push('treasuryUser');
    }
    if (candidate.isRegistered) roles.push('treasuryCertified');
    if (candidate.isOperationallyCertified) roles.push('operationallyCertified');
    if (!roles.length) throw new Error('No Argon role could be proven from finalized state.');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentUser = this.db
        .prepare(`SELECT operationalAccountId, roles FROM VerifiedUsers WHERE discordUserId = ?`)
        .get(discordUserId) as { operationalAccountId: string; roles: string } | undefined;
      const { operationalAccountId: boundAccountId, roles: currentRoles = '[]' } = currentUser ?? {};
      if (boundAccountId && boundAccountId !== operationalAccountId) {
        throw new Error('Discord account is already bound to another operational account.');
      }
      const existing = this.db
        .prepare(`SELECT discordUserId FROM VerifiedUsers WHERE operationalAccountId = ?`)
        .get(operationalAccountId) as { discordUserId: string } | undefined;
      const { discordUserId: boundDiscordUserId } = existing ?? {};
      if (boundDiscordUserId && boundDiscordUserId !== discordUserId) {
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
          operationalAccountId,
          JSON.stringify(DISCORD_ROLE_ORDER.filter(role => granted.has(role))),
          candidate.finalizedBlockNumber,
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
    candidate: IAccountEvidence,
    now = Date.now(),
  ): IRoleVerification {
    const { discordUserId } = this.getUpdateBinding(proof, now);
    const user = this.db.prepare(`SELECT roles FROM VerifiedUsers WHERE discordUserId = ?`).get(discordUserId) as {
      roles: string;
    };
    const granted = new Set<DiscordEarnedRole>(JSON.parse(user.roles) as DiscordEarnedRole[]);
    if (candidate.isRegistered) granted.add('treasuryCertified');
    if (candidate.isOperationallyCertified) granted.add('operationallyCertified');
    const roles = DISCORD_ROLE_ORDER.filter(role => granted.has(role));
    this.db
      .prepare(`UPDATE VerifiedUsers SET roles = ?, finalizedBlockNumber = ? WHERE discordUserId = ?`)
      .run(JSON.stringify(roles), candidate.finalizedBlockNumber, discordUserId);
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
      .get(operationalAccountId) as { discordUserId: string } | undefined;
    if (!user) throw new Error('Discord account is not connected. Run /connect-desktop-app first.');
    return user;
  }

  public async checkRoleEvidence(candidateAccountId: string, upstreamAccountId?: string): Promise<IRoleEvidence> {
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
      const candidate = await finalizedClient.query.operationalAccounts.operationalAccounts(candidateAccountId);
      const candidateEvidence = {
        isRegistered: candidate !== null,
        isOperationallyCertified: candidate?.isOperationallyCertified ?? candidate?.isOperational ?? false,
        finalizedBlockNumber,
      };
      if (!upstreamAccountId) return { candidate: candidateEvidence };

      const upstream = await finalizedClient.query.operationalAccounts.operationalAccounts(upstreamAccountId);
      return {
        candidate: candidateEvidence,
        upstream: {
          isRegistered: upstream !== null,
          isOperationallyCertified: upstream?.isOperationallyCertified ?? upstream?.isOperational ?? false,
          finalizedBlockNumber,
        },
      };
    } catch (error) {
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
}
