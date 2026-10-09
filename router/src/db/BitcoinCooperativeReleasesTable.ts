import {
  JsonExt,
  type IBitcoinCooperativeReleaseMailboxPage,
  type IBitcoinCooperativeReleaseMailboxRecord,
  type IBitcoinCooperativeReleaseRequest,
  type IBitcoinCooperativeReleaseResponse,
} from '@argonprotocol/apps-core';
import { BaseTable } from './BaseTable.ts';
import { RouterError } from '../RouterError.ts';

type SqlRecord = {
  requestJson: string;
  vaultSignatureHex: string | null;
  operatorError: string | null;
  createdAt: number;
  updatedAt: number;
};

export class BitcoinCooperativeReleasesTable extends BaseTable {
  public insert(request: IBitcoinCooperativeReleaseRequest): IBitcoinCooperativeReleaseMailboxRecord {
    return this.db.transaction(() => {
      const { releaseId, ownerAccount, vaultId, utxoRef } = request;
      const requestJson = JsonExt.stringify(request);
      const existing = this.fetch(releaseId);
      if (existing) {
        const { removalBlockNumber: knownRemoval, ...approvedTerms } = existing.request;
        const { removalBlockNumber, ...submittedTerms } = request;
        if (JsonExt.stringify(approvedTerms) !== JsonExt.stringify(submittedTerms)) {
          throw new RouterError('This cooperative release already exists with different terms.', 409);
        }
        if (knownRemoval && removalBlockNumber && knownRemoval !== removalBlockNumber) {
          throw new RouterError('The removal block evidence is already supplied.', 409);
        }

        // A waiting request can acquire its known removal block without changing approved terms.
        if (!knownRemoval && removalBlockNumber && !existing.vaultSignatureHex && !existing.operatorError) {
          this.db.sql
            .prepare('UPDATE BitcoinCooperativeReleases SET requestJson = ?, updatedAt = ? WHERE releaseId = ?')
            .run(requestJson, Date.now(), releaseId);
          return this.fetch(releaseId)!;
        }
        return existing;
      }

      const bound = this.db.sql
        .prepare(
          'SELECT releaseId FROM BitcoinCooperativeReleases WHERE ownerAccount = ? AND utxoTxid = ? AND utxoOutputIndex = ?',
        )
        .get(ownerAccount, utxoRef.txid, utxoRef.outputIndex);
      if (bound) {
        throw new RouterError('This deposit already has an approved return request.', 409);
      }

      const count = this.db.sql
        .prepare(
          'SELECT COUNT(*) AS count FROM BitcoinCooperativeReleases WHERE ownerAccount = ? AND vaultSignatureHex IS NULL AND operatorError IS NULL',
        )
        .get(ownerAccount) as { count: number };
      if (count.count >= 1_000) {
        throw new RouterError('Too many pending Bitcoin return requests.', 429);
      }

      const now = Date.now();
      this.db.sql
        .prepare(
          `INSERT INTO BitcoinCooperativeReleases (releaseId, ownerAccount, vaultId, utxoTxid, utxoOutputIndex, requestJson, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(releaseId, ownerAccount, vaultId, utxoRef.txid, utxoRef.outputIndex, requestJson, now, now);

      return this.fetch(releaseId)!;
    });
  }

  public fetch(releaseId: string): IBitcoinCooperativeReleaseMailboxRecord | undefined {
    const record = this.db.sql
      .prepare('SELECT * FROM BitcoinCooperativeReleases WHERE releaseId = ?')
      .get(releaseId) as SqlRecord | undefined;
    if (record) return this.map(record);
  }

  public pending(vaultId: number, cursor?: string): IBitcoinCooperativeReleaseMailboxPage {
    let after: { createdAt: number; releaseId: string } = { createdAt: 0, releaseId: '' };
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!Number.isSafeInteger(after.createdAt) || typeof after.releaseId !== 'string') {
          throw new Error('Invalid cursor');
        }
      } catch {
        throw new RouterError('Invalid Bitcoin return cursor.', 400);
      }
    }

    const records = this.db.sql
      .prepare(
        `SELECT * FROM BitcoinCooperativeReleases WHERE vaultId = ?
      AND vaultSignatureHex IS NULL AND operatorError IS NULL AND (createdAt > ? OR (createdAt = ? AND releaseId > ?))
      ORDER BY createdAt, releaseId LIMIT 101`,
      )
      .all(vaultId, after.createdAt, after.createdAt, after.releaseId) as SqlRecord[];

    const requests = records.slice(0, 100).map(record => this.map(record));
    const page: IBitcoinCooperativeReleaseMailboxPage = { requests };
    if (records.length > 100) {
      const last = requests.at(-1)!;
      page.nextCursor = Buffer.from(
        JSON.stringify({ createdAt: last.createdAt.getTime(), releaseId: last.request.releaseId }),
      ).toString('base64url');
    }

    return page;
  }

  public respond(
    releaseId: string,
    response: IBitcoinCooperativeReleaseResponse,
  ): IBitcoinCooperativeReleaseMailboxRecord {
    return this.db.transaction(() => {
      const current = this.fetch(releaseId);
      if (!current) {
        throw new RouterError('Bitcoin return request not found.', 404);
      }
      if (current.vaultSignatureHex || current.operatorError) {
        return current;
      }

      if ('vaultSignatureHex' in response) {
        this.db.sql
          .prepare(
            'UPDATE BitcoinCooperativeReleases SET vaultSignatureHex = ?, operatorError = NULL, updatedAt = ? WHERE releaseId = ?',
          )
          .run(response.vaultSignatureHex, Date.now(), releaseId);
      } else {
        this.db.sql
          .prepare('UPDATE BitcoinCooperativeReleases SET operatorError = ?, updatedAt = ? WHERE releaseId = ?')
          .run(response.error, Date.now(), releaseId);
      }

      return this.fetch(releaseId)!;
    });
  }

  private map(record: SqlRecord): IBitcoinCooperativeReleaseMailboxRecord {
    const result: IBitcoinCooperativeReleaseMailboxRecord = {
      request: JsonExt.parse(record.requestJson),
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
    if (record.vaultSignatureHex) result.vaultSignatureHex = record.vaultSignatureHex;
    if (record.operatorError) result.operatorError = record.operatorError;
    return result;
  }
}
