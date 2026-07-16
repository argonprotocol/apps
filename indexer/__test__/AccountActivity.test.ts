import { describe, expect, it } from 'vitest';
import { encodeAddress } from '@argonprotocol/mainchain';
import { AccountActivityDecoder, AccountActivityKind, classifyEvent } from '../src/AccountActivity.ts';
import { readHistoricalEventData } from '../src/HistoricalEventSpecs.ts';
import { historicalEventChanges } from '../src/HistoricalEventSpecs.generated.ts';
import { humanCodec } from './helpers/codecs.ts';
import { createHistoricalEventData } from './helpers/historicalEvents.ts';

const emptyEventData = Object.assign([], { names: [], typeDef: [] });

describe('AccountActivityDecoder', () => {
  it('classifies force-set balances as custody transfers without widening other balance activity', () => {
    const argonAccount = encodeAddress(new Uint8Array(32).fill(1));
    const argonotAccount = encodeAddress(new Uint8Array(32).fill(2));
    const mintedAccount = encodeAddress(new Uint8Array(32).fill(3));
    const balanceSet = {
      section: 'balances',
      method: 'BalanceSet',
      data: createHistoricalEventData(156, 'balances', 'BalanceSet', { who: argonAccount, free: 1_000 }),
    };
    const ownershipSet = {
      section: 'ownership',
      method: 'BalanceSet',
      data: createHistoricalEventData(156, 'ownership', 'BalanceSet', { who: argonotAccount, free: 2_000 }),
    };
    const minted = {
      section: 'balances',
      method: 'Minted',
      data: createHistoricalEventData(156, 'balances', 'Minted', { who: mintedAccount, amount: 3_000 }),
    };

    expect(
      new AccountActivityDecoder().decode({
        eventGroups: [
          { extrinsicIndex: 1, extrinsicEvents: [balanceSet] },
          { extrinsicIndex: 2, extrinsicEvents: [ownershipSet] },
          { extrinsicIndex: 3, extrinsicEvents: [minted] },
        ],
        specVersion: 156,
      }).accounts,
    ).toEqual([
      { address: argonAccount, mask: AccountActivityKind.Transfer },
      { address: argonotAccount, mask: AccountActivityKind.Transfer },
      { address: mintedAccount, mask: AccountActivityKind.AccountBalance },
    ]);
  });

  it('uses live metadata field names for a classified event beyond the copied spec catalog', () => {
    const from = encodeAddress(new Uint8Array(32).fill(1));
    const to = encodeAddress(new Uint8Array(32).fill(2));
    const event = {
      section: 'balances',
      method: 'Transfer',
      data: createHistoricalEventData(156, 'balances', 'Transfer', { from, to, amount: 1_000 }),
    };

    const success = { section: 'system', method: 'ExtrinsicSuccess', data: event.data };
    expect(
      new AccountActivityDecoder().decode({
        eventGroups: [{ extrinsicIndex: 2, extrinsicEvents: [event, success] }],
        specVersion: 157,
      }),
    ).toEqual({
      accounts: [
        { address: from, mask: AccountActivityKind.Transfer },
        { address: to, mask: AccountActivityKind.Transfer },
      ],
      vaults: [],
      vaultOwners: [],
      bitcoinLocks: [],
      bitcoinLockOwners: [],
    });
    expect(readHistoricalEventData(157, event)).toEqual([
      ['from', 'AccountId32', from],
      ['to', 'AccountId32', to],
      ['amount', 'u128', '1,000'],
    ]);
  });

  it('keeps a pallet balance movement out of custody transfer activity', () => {
    const from = encodeAddress(new Uint8Array(32).fill(1));
    const to = encodeAddress(new Uint8Array(32).fill(2));
    const transfer = {
      section: 'balances',
      method: 'Transfer',
      data: createHistoricalEventData(156, 'balances', 'Transfer', { from, to, amount: 1_000 }),
    };
    const collected = {
      section: 'vaults',
      method: 'VaultCollected',
      data: createHistoricalEventData(156, 'vaults', 'VaultCollected', { vaultId: 7, revenue: 1_000 }),
    };
    const success = { section: 'system', method: 'ExtrinsicSuccess', data: transfer.data };

    expect(
      new AccountActivityDecoder().decode({
        eventGroups: [{ extrinsicIndex: 2, extrinsicEvents: [collected, transfer, success] }],
        specVersion: 156,
      }),
    ).toMatchObject({
      accounts: [
        { address: from, mask: AccountActivityKind.AccountBalance },
        { address: to, mask: AccountActivityKind.AccountBalance },
      ],
      vaults: [{ vaultId: 7, mask: AccountActivityKind.VaultRevenue }],
    });

    const itemCompleted = { section: 'utility', method: 'ItemCompleted', data: transfer.data };
    const batchCompleted = { section: 'utility', method: 'BatchCompleted', data: transfer.data };
    expect(
      new AccountActivityDecoder().decode({
        eventGroups: [
          {
            extrinsicIndex: 2,
            extrinsicEvents: [collected, itemCompleted, transfer, itemCompleted, batchCompleted, success],
          },
        ],
        specVersion: 156,
      }).accounts,
    ).toEqual([
      { address: from, mask: AccountActivityKind.Transfer },
      { address: to, mask: AccountActivityKind.Transfer },
    ]);
  });

  it('keeps bond lifecycle activity without indexing frame earnings', () => {
    expect(classifyEvent({ section: 'treasury', method: 'BondLotPurchased', data: emptyEventData } as any)).toBe(
      AccountActivityKind.BondPosition,
    );
    expect(
      classifyEvent({ section: 'treasury', method: 'FrameEarningsDistributed', data: emptyEventData } as any),
    ).toBe(0);
  });

  it('preserves classification for every copied historical vault event', () => {
    const expectedKinds = new Map<string, number>();
    for (const method of vaultRevenueMethods) expectedKinds.set(method, AccountActivityKind.VaultRevenue);
    for (const method of vaultBitcoinMethods) {
      expectedKinds.set(method, AccountActivityKind.VaultPosition | AccountActivityKind.BitcoinLock);
    }
    for (const method of vaultPositionMethods) expectedKinds.set(method, AccountActivityKind.VaultPosition);

    const historicalVaultMethods = new Set(
      historicalEventChanges.filter(change => change.section === 'vaults').map(change => change.method),
    );
    expect([...expectedKinds.keys(), ...ignoredVaultMethods].sort()).toEqual([...historicalVaultMethods].sort());
    for (const [method, kind] of expectedKinds) {
      expect(classifyEvent({ section: 'vaults', method, data: emptyEventData } as any), method).toBe(kind);
    }
    for (const method of ignoredVaultMethods) {
      expect(classifyEvent({ section: 'vaults', method, data: emptyEventData } as any), method).toBe(0);
    }
  });

  it('falls back to copied declarations when historical event names are unavailable', () => {
    const data = Object.assign(
      [
        humanCodec({ Vault: { vaultId: 7 } }),
        humanCodec(12),
        humanCodec(encodeAddress(new Uint8Array(32).fill(3))),
        humanCodec(20),
      ],
      { names: null, typeDef: [] },
    );
    const event = {
      section: 'treasury',
      method: 'BondLotPurchased',
      data,
    } as any;

    expect(readHistoricalEventData(156, event)?.map(([name]) => name)).toEqual([
      'programId',
      'bondLotId',
      'accountId',
      'bonds',
    ]);
  });

  it('retains Bitcoin lock ownership for lifecycle events that only name the UTXO', () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(4));
    const created = {
      section: 'bitcoinLocks',
      method: 'BitcoinLockCreated',
      data: createHistoricalEventData(156, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 9,
        vaultId: 7,
        liquidityPromised: 1_000,
        securitization: 1_000,
        lockedTargetPrice: 900,
        accountId,
        securityFee: 10,
      }),
    };
    const released = {
      section: 'bitcoinLocks',
      method: 'BitcoinSpentAfterRelease',
      data: createHistoricalEventData(156, 'bitcoinLocks', 'BitcoinSpentAfterRelease', {
        utxoId: 9,
        vaultId: 7,
      }),
    };
    const decoder = new AccountActivityDecoder();

    expect(
      decoder.decode({ eventGroups: [{ extrinsicIndex: 2, extrinsicEvents: [created] }], specVersion: 156 }),
    ).toMatchObject({
      bitcoinLocks: [{ utxoId: 9, mask: AccountActivityKind.BitcoinLock }],
      bitcoinLockOwners: [{ utxoId: 9, address: accountId }],
    });
    expect(
      decoder.decode({ eventGroups: [{ extrinsicIndex: 2, extrinsicEvents: [released] }], specVersion: 156 }),
    ).toMatchObject({
      accounts: [],
      bitcoinLocks: [{ utxoId: 9, mask: AccountActivityKind.BitcoinLock }],
      bitcoinLockOwners: [],
    });
  });

  it('learns Bitcoin lock ownership from later lifecycle events that identify the account', () => {
    const accountId = encodeAddress(new Uint8Array(32).fill(4));
    const ratcheted = {
      section: 'bitcoinLocks',
      method: 'BitcoinLockRatcheted',
      data: createHistoricalEventData(156, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 9,
        vaultId: 7,
        liquidityPromised: 1_000,
        oldTargetPrice: 900,
        securityFee: 10,
        newTargetPrice: 950,
        amountBurned: 50,
        accountId,
      }),
    };

    expect(
      new AccountActivityDecoder().decode({
        eventGroups: [{ extrinsicIndex: 2, extrinsicEvents: [ratcheted] }],
        specVersion: 156,
      }),
    ).toMatchObject({
      accounts: [{ address: accountId, mask: AccountActivityKind.BitcoinLock }],
      bitcoinLocks: [{ utxoId: 9, mask: AccountActivityKind.BitcoinLock }],
      bitcoinLockOwners: [{ utxoId: 9, address: accountId }],
    });
  });

  it('ignores global Bitcoin UTXO observations that do not identify an account lifecycle', () => {
    const event = {
      section: 'bitcoinUtxos',
      method: 'UtxoVerified',
      data: createHistoricalEventData(156, 'bitcoinUtxos', 'UtxoVerified', {
        utxoId: 9,
        satoshisReceived: 10_000,
      }),
    };

    expect(classifyEvent(event)).toBe(0);
    expect(
      new AccountActivityDecoder().decode({ eventGroups: [{ extrinsicEvents: [event] }], specVersion: 156 }),
    ).toEqual({
      accounts: [],
      vaults: [],
      vaultOwners: [],
      bitcoinLocks: [],
      bitcoinLockOwners: [],
    });
  });

  it('does not classify a legacy bond without Bitcoin backing as Bitcoin activity', () => {
    const createBondData = (utxoId: number | null) =>
      Object.assign([humanCodec(`0x${'33'.repeat(32)}`), humanCodec(utxoId), humanCodec(1_000)], {
        names: ['accountId', 'utxoId', 'amount'],
      });

    expect(classifyEvent({ section: 'bonds', method: 'BondCreated', data: createBondData(null) } as any)).toBe(0);
    expect(classifyEvent({ section: 'bonds', method: 'BondCreated', data: createBondData(9) } as any)).toBe(
      AccountActivityKind.BitcoinLock,
    );
  });
});

const vaultRevenueMethods = [
  'BidPoolDistributed',
  'CouldNotAllocateNextBidPool',
  'CouldNotBurnBidPool',
  'CouldNotDistributeBidPool',
  'LiquidityPoolRecordingError',
  'NextBidPoolAllocated',
  'TreasuryRecordingError',
  'VaultCollected',
  'VaultRevenueUncollected',
];
const vaultBitcoinMethods = [
  'FundLockCanceled',
  'FundsLocked',
  'LostBitcoinCompensated',
  'ObligationBaseFeeMaturationError',
  'ObligationCanceled',
  'ObligationCompleted',
  'ObligationCompletionError',
  'ObligationCreated',
  'ObligationModified',
];
const vaultPositionMethods = [
  'CommittedArgonotsSet',
  'FundsReleased',
  'FundsScheduledForRelease',
  'VaultBondedArgonsChangeScheduled',
  'VaultBondedArgonsIncreased',
  'VaultClosed',
  'VaultCreated',
  'VaultMiningBondsChangeScheduled',
  'VaultMiningBondsIncreased',
  'VaultModified',
];
const ignoredVaultMethods = [
  'FundsReleasedError',
  'VaultBitcoinXpubChange',
  'VaultTermsChangeScheduled',
  'VaultTermsChanged',
];
