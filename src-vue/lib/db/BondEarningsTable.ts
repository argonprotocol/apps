import type { BondLot } from '@argonprotocol/apps-core';
import { convertFromSqliteFields, toSqlParams } from '../Utils.ts';
import { BaseTable } from './BaseTable.ts';

export interface IBondEarningsRecord {
  accountId: string;
  programType: BondLot['programType'];
  bondLotId: number;
  frameId: number;
  /** The earning frame's quantity, before displacement; unknown when its snapshot is unavailable. */
  bonds?: number | null;
  isFlexible?: boolean | null;
  /** ARGN microgons excluded from this frame's earnings, including fractional bonds. */
  displacedMicrogons?: bigint | null;
  /** Actual credited earnings. Absence means missing evidence, not a zero payout. */
  earningsMicrogons?: bigint | null;
  earningsDestination: 'Owner' | 'Vault';
  payoutBlockNumber: number;
  payoutBlockHash: string;
}

export class BondEarningsTable extends BaseTable {
  public async fetchAll(accountId: string): Promise<IBondEarningsRecord[]> {
    const rows = await this.db.select<IBondEarningsRecord[]>(
      'SELECT * FROM BondEarnings WHERE accountId = ? ORDER BY frameId, bondLotId',
      [accountId],
    );
    return convertFromSqliteFields(rows, {
      bigint: ['displacedMicrogons', 'earningsMicrogons'],
      boolean: ['isFlexible'],
    });
  }

  public async upsert(record: IBondEarningsRecord): Promise<void> {
    const fields = Object.keys(record);
    await this.db.execute(
      `INSERT INTO BondEarnings (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})
       ON CONFLICT(accountId, programType, bondLotId, frameId) DO UPDATE SET
         bonds = COALESCE(excluded.bonds, BondEarnings.bonds),
         isFlexible = COALESCE(excluded.isFlexible, BondEarnings.isFlexible),
         displacedMicrogons = COALESCE(excluded.displacedMicrogons, BondEarnings.displacedMicrogons),
         earningsMicrogons = COALESCE(excluded.earningsMicrogons, BondEarnings.earningsMicrogons)`,
      toSqlParams(Object.values(record)),
    );
  }
}
