import {
  type BlockWatch,
  Currency,
  type IBitcoinLock,
  type IBitcoinLockConfig,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core';
import { toHistoricalEvent } from '@argonprotocol/runtime-client/events';
import BigNumber from 'bignumber.js';
import { createHistoricalEventData } from '../../../indexer/__test__/helpers/historicalEvents.ts';
import BitcoinLocks from '../../lib/BitcoinLocks.ts';
import type { Db } from '../../lib/Db.ts';
import type { TransactionTracker } from '../../lib/TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../../lib/UpstreamOperatorClient.ts';
import type { WalletKeys } from '../../lib/WalletKeys.ts';
import { BitcoinLockStatus } from '../../lib/db/BitcoinLocksTable.ts';
import type { IHistoricalBitcoinLock } from '../../lib/recovery/BitcoinLockHistory.ts';
import type { IHistoricalBitcoinLockRecord } from '../../lib/recovery/BitcoinLockReplay.ts';

export function createBitcoinLockConfig(overrides: Partial<IBitcoinLockConfig> = {}): IBitcoinLockConfig {
  const defaults = buildDefaultBitcoinLockConfig();
  return {
    ...defaults,
    ...overrides,
    bitcoinNetwork: overrides.bitcoinNetwork ?? defaults.bitcoinNetwork,
  };
}

export const DEFAULT_BITCOIN_LOCK_CONFIG = createBitcoinLockConfig();

function buildDefaultBitcoinLockConfig(): IBitcoinLockConfig {
  return {
    lockReleaseCosignDeadlineFrames: 1,
    pendingConfirmationExpirationBlocks: 6,
    tickDurationMillis: 1_000,
    bitcoinNetwork: buildDefaultBitcoinNetwork(),
  };
}

function buildDefaultBitcoinNetwork(): IBitcoinLockConfig['bitcoinNetwork'] {
  return {
    isBitcoin: true,
    isTestnet: false,
    isSignet: false,
    isRegtest: false,
    type: 'Bitcoin',
  } as IBitcoinLockConfig['bitcoinNetwork'];
}

export function createStore(
  options: {
    blockWatch?: BlockWatch;
    db?: Db;
    transactionTracker?: TransactionTracker;
    walletKeys?: WalletKeys;
  } = {},
): BitcoinLocks {
  const blockWatch =
    options.blockWatch ??
    (Object.assign(Object.create(null), {
      start: async () => undefined,
      events: { on: () => () => undefined },
      bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    }) as BlockWatch);
  const currency = Object.assign(Object.create(null), {
    isLoadedPromise: Promise.resolve(),
    load: async () => undefined,
    priceIndex: { btcUsdPrice: BigNumber(1), getSatoshiPriceInTargetMicrogons: () => 2_000n },
    convertSatToBtc: () => 0,
    convertBtcToMicrogon: () => 0n,
    fetchPriceIndex: (api: Parameters<typeof Currency.fetchPriceIndex>[0]) => Currency.fetchPriceIndex(api),
    fetchMainchainRatesAtBlock: async () => ({ BTC: 4_000_000n, ARGNOT: 1_000_000n, USD: 1_000_000n }),
  }) as Currency;
  const transactionTracker =
    options.transactionTracker ??
    (Object.assign(Object.create(null), {
      load: async () => undefined,
      findLatestTxInfo: () => undefined,
      pendingBlockTxInfosAtLoad: [],
      data: { txInfos: [], txInfosByType: {} },
    }) as TransactionTracker);

  const db =
    options.db ??
    (Object.assign(Object.create(null), {
      bitcoinSecuritizationHistoryTable: {
        getPublishedSnapshot: async () => undefined,
        createSnapshot: async () => ({ ownerAccount: '', snapshotId: '', asOfBlock: 0 }),
        publishSnapshot: async () => undefined,
      },
    }) as Db);

  return new BitcoinLocks(
    Promise.resolve(db),
    options.walletKeys ?? ({ defaultArgonAddress: '5owner' } as WalletKeys),
    blockWatch,
    currency,
    transactionTracker,
    undefined,
  );
}

export function createLock(args: {
  uuid: string;
  utxoId?: number;
  status: BitcoinLockStatus;
  createdAt: string;
}): IHistoricalBitcoinLockRecord {
  const ownerAccount = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
  const lockDetails = {
    ...createHistoricalLock({ accountId: ownerAccount, liquidityPromised: 0n, lockedTargetPrice: 0n }),
    utxoId: args.utxoId ?? 0,
  };
  return {
    uuid: args.uuid,
    utxoId: args.utxoId,
    status: args.status,
    securitizedSatoshis: 10_000n,
    ownerAccount,
    securityFees: 0n,
    couponFeesPaid: 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
    utxos: [],
    fundedSatoshis: 0n,
    satoshis: 10_000n,
    liquidityPromised: 0n,
    lockedTargetPrice: 0n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails,
    scriptDetails: {
      p2wshScriptHashHex: lockDetails.p2wshScriptHashHex,
      vaultPubkey: lockDetails.vaultPubkey,
      vaultClaimPubkey: lockDetails.vaultClaimPubkey,
      ownerPubkey: lockDetails.ownerPubkey,
      vaultXpubSources: lockDetails.vaultXpubSources,
      vaultClaimHeight: lockDetails.vaultClaimHeight,
      openClaimHeight: lockDetails.openClaimHeight,
      createdAtHeight: lockDetails.createdAtHeight,
    },
    fundingExpirationHeight: lockDetails.fundingExpirationHeight,
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: 1,
    createdAt: new Date(args.createdAt),
    updatedAt: new Date(args.createdAt),
  };
}

export function createHistoricalLock(args: {
  accountId: string;
  liquidityPromised: bigint;
  lockedTargetPrice?: bigint;
}): IHistoricalBitcoinLock {
  return {
    utxoId: 7,
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    vaultId: 1,
    isFlexible: false,
    lockedTargetPrice: args.lockedTargetPrice ?? 1_000n,
    liquidityPromised: args.liquidityPromised,
    ownerAccount: args.accountId,
    securitizationRatio: 1,
    securitizedSatoshis: 10_000n,
    fundedSatoshis: 10_000n,
    vaultPubkey: `02${'11'.repeat(32)}`,
    securityFees: 20n,
    couponFeesPaid: 0n,
    vaultClaimPubkey: `02${'22'.repeat(32)}`,
    ownerPubkey: `02${'33'.repeat(32)}`,
    vaultXpubSources: {
      parentFingerprint: new Uint8Array(4),
      cosignHdIndex: 0,
      claimHdIndex: 0,
    },
    vaultClaimHeight: 700,
    openClaimHeight: 800,
    createdAtHeight: 500,
    fundingExpirationHeight: 506,
    createdAtArgonBlock: 151,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
  };
}

export function createCurrentLock(overrides: Partial<IBitcoinLock> = {}): IBitcoinLock {
  return {
    utxoId: 7,
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    vaultId: 1,
    securitizedSatoshis: 10_000n,
    microgonsAtTargetPerBtc: 1_000n,
    securitizationCoverageMicrogons: 10_000n,
    securitizationTick: 500,
    fundedSatoshis: 10_000n,
    fissionedSatoshis: 0n,
    ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    securitizationRatio: 1,
    securityFees: 20n,
    couponFeesPaid: 0n,
    vaultPubkey: `02${'11'.repeat(32)}`,
    vaultClaimPubkey: `02${'22'.repeat(32)}`,
    ownerPubkey: `02${'33'.repeat(32)}`,
    vaultXpubSources: {
      parentFingerprint: new Uint8Array(4),
      cosignHdIndex: 0,
      claimHdIndex: 0,
    },
    vaultClaimHeight: 700,
    openClaimHeight: 800,
    createdAtHeight: 500,
    fundingExpirationHeight: 506,
    isFlexible: false,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
    createdAtArgonBlock: 159,
    ...overrides,
  };
}

export function historyBlock(blockNumber: number) {
  return {
    blockNumber,
    blockHash: `0x${blockNumber}`,
    blockTime: new Date('2026-01-01T00:00:00Z').getTime(),
    parentHash: `0x${blockNumber - 1}`,
    author: 'test',
    tick: blockNumber,
    isFinalized: true,
  };
}

export function historyEvent(
  specVersion: number,
  section: string,
  method: string,
  values: Readonly<Record<string, unknown>>,
  extrinsicIndex = 2,
): RuntimeSystemEventRecord {
  const event = toHistoricalEvent({
    section,
    method,
    data: createHistoricalEventData(specVersion, section, method, values),
  });
  if (!event) throw new Error(`${section}.${method} is not a historical event`);

  return {
    event,
    phase: { type: 'ApplyExtrinsic', value: extrinsicIndex },
    topics: [],
  };
}
