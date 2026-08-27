import { getOfflineRegistry, type GenericEvent } from '@argonprotocol/mainchain';
import { getTypeDef } from '@polkadot/types-create';
import { describe, expect, it } from 'vitest';
import * as events from '../src/events.ts';

describe('runtime events', () => {
  it('normalizes a metadata-decoded historical event into its native discriminated packet', () => {
    const registry = getOfflineRegistry();
    const accountId = new Uint8Array(32).fill(7);
    const data = registry.createType<GenericEvent['data']>('(PalletTreasuryBondProgramId,u64,AccountId32,u32)', [
      registry.createType('PalletTreasuryBondProgramId', { Vault: { vaultId: 4 } }),
      registry.createType('u64', 9),
      registry.createType('AccountId32', accountId),
      registry.createType('u32', 2),
    ]);
    Object.defineProperties(data, {
      names: { value: ['programId', 'bondLotId', 'accountId', 'bonds'] },
      typeDef: {
        value: [
          getTypeDef('PalletTreasuryBondProgramId'),
          getTypeDef('u64'),
          getTypeDef('AccountId32'),
          getTypeDef('u32'),
        ],
      },
    });

    const event = events.toHistoricalEvent({ section: 'treasury', method: 'BondLotPurchased', data });

    expect(event).toEqual({
      section: 'treasury',
      method: 'BondLotPurchased',
      data: {
        programId: { type: 'Vault', value: { vaultId: 4 } },
        bondLotId: 9,
        accountId: registry.createType('AccountId32', accountId).toString(),
        bonds: 2,
      },
    });
  });
});
