import { describe, expect, it } from 'vitest';
import {
  getHistoricalEventFieldAlternatives,
  getHistoricalEventFields,
  historicalEventSpecSources,
  supportedHistoricalEventSpecs,
} from '../src/HistoricalEventSpecs.ts';
import { historicalEventChanges } from '../src/HistoricalEventSpecs.generated.ts';

describe('HistoricalEventSpecs', () => {
  it('covers every published-chain runtime spec', () => {
    expect(supportedHistoricalEventSpecs).toEqual(Array.from({ length: 57 }, (_, index) => index + 100));
    expect(historicalEventSpecSources[100]).toBe('@argonprotocol/mainchain@0.0.25');
    expect(historicalEventSpecSources[124]).toBe('argonprotocol/mainchain@1fd3a9e9');
    expect(historicalEventSpecSources[149]).toBe('@argonprotocol/mainchain@1.4.2-dev.9a289267');
    expect(historicalEventSpecSources[152]).toBe('@argonprotocol/mainchain@1.4.6');
  });

  it('stores only changes from the preceding spec', () => {
    expect(
      historicalEventChanges.some(change => {
        return Number(change.spec) === 101 && change.section === 'balances' && change.method === 'BalanceSet';
      }),
    ).toBe(false);
    expect(
      historicalEventChanges.some(change => {
        return change.spec === 110 && change.section === 'bonds' && change.method === 'BondCreated' && !change.fields;
      }),
    ).toBe(true);
  });

  it('declares event fields from the early Bitcoin bond runtime', () => {
    expect(getHistoricalEventFields(109, 'bonds', 'BondCreated')).toEqual([
      'vaultId',
      'bondId',
      'bondType',
      'bondedAccountId',
      'utxoId',
      'amount',
      'expiration',
    ]);
    expect(getHistoricalEventFields(110, 'bonds', 'BondCreated')).toBeUndefined();
    expect(getHistoricalEventFields(110, 'bitcoinLocks', 'BitcoinLockCreated')).toEqual([
      'utxoId',
      'vaultId',
      'obligationId',
      'lockPrice',
      'accountId',
    ]);
  });

  it('preserves the unpublished spec 124 field names', () => {
    expect(getHistoricalEventFields(123, 'miningSlot', 'NewMiners')).toContain('cohortId');
    expect(getHistoricalEventFields(124, 'miningSlot', 'NewMiners')).toContain('cohortFrameId');
    expect(getHistoricalEventFields(125, 'miningSlot', 'NewMiners')).toContain('frameId');
  });

  it('declares the vault field changes at spec 147', () => {
    expect(getHistoricalEventFields(146, 'vaults', 'VaultModified')).toEqual([
      'vaultId',
      'securitization',
      'securitizationRatio',
    ]);
    expect(getHistoricalEventFields(147, 'vaults', 'VaultModified')).toEqual([
      'vaultId',
      'securitization',
      'securitizationTarget',
      'securitizationRatio',
    ]);
    expect(getHistoricalEventFields(146, 'vaults', 'FundsReleased')).toEqual(['vaultId', 'amount']);
    expect(getHistoricalEventFields(147, 'vaults', 'FundsReleased')).toEqual(['vaultId', 'securitization']);
  });

  it('keeps only event-level alternatives for packages that reused a spec version', () => {
    expect(historicalEventSpecSources[116]).toContain('@argonprotocol/mainchain@1.1.0-rc.1');

    expect(getHistoricalEventFieldAlternatives(116, 'vaults', 'VaultCreated').map(Object.keys)).toEqual([
      [
        'vaultId',
        'lockedBitcoinArgons',
        'bondedBitcoinArgons',
        'addedSecuritizationPercent',
        'operatorAccountId',
        'activationTick',
      ],
      ['vaultId', 'securitization', 'securitizationRatio', 'operatorAccountId', 'openedTick'],
    ]);

    expect(getHistoricalEventFields(148, 'bitcoinLocks', 'BitcoinSpentAfterRelease')).toBeDefined();
  });

  it('declares treasury bond events only after they exist', () => {
    expect(getHistoricalEventFields(150, 'treasury', 'BondLotPurchased')).toBeUndefined();
    expect(getHistoricalEventFields(151, 'treasury', 'BondLotPurchased')).toEqual([
      'vaultId',
      'bondLotId',
      'accountId',
      'bonds',
    ]);
    expect(getHistoricalEventFields(156, 'treasury', 'BondLotPurchased')).toEqual([
      'programId',
      'bondLotId',
      'accountId',
      'bonds',
    ]);
  });

  it('rejects runtime specs outside the copied catalog', () => {
    expect(() => getHistoricalEventFields(99, 'vaults', 'VaultCreated')).toThrow('runtime spec 99');
    expect(() => getHistoricalEventFields(157, 'vaults', 'VaultCreated')).toThrow('runtime spec 157');
  });
});
