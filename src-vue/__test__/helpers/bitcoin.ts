import type { IBitcoinLock, IBitcoinLockConfig } from '@argonprotocol/mainchain';
import { type BlockWatch, type Currency } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { createHistoricalEventData } from '../../../indexer/__test__/helpers/historicalEvents.ts';
import { numberCodec } from '../../../core/__test__/helpers/codecs.ts';
import BitcoinLocks from '../../lib/BitcoinLocks.ts';
import type { Db } from '../../lib/Db.ts';
import type { TransactionTracker } from '../../lib/TransactionTracker.ts';
import type { UpstreamOperatorClient } from '../../lib/UpstreamOperatorClient.ts';
import type { WalletKeys } from '../../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';

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
    lockSatoshiAllowedVariance: 1_000,
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
    upstreamOperatorClient?: UpstreamOperatorClient;
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
    fetchMainchainRatesAtBlock: async () => ({ BTC: 4_000_000n, ARGNOT: 1_000_000n, USD: 1_000_000n }),
  }) as Currency;
  const transactionTracker =
    options.transactionTracker ??
    (Object.assign(Object.create(null), {
      load: async () => undefined,
      pendingBlockTxInfosAtLoad: [],
      data: { txInfos: [], txInfosByType: {} },
    }) as TransactionTracker);

  return new BitcoinLocks(
    Promise.resolve(options.db ?? (Object.create(null) as Db)),
    options.walletKeys ?? (Object.create(null) as WalletKeys),
    blockWatch,
    currency,
    transactionTracker,
    undefined,
    options.upstreamOperatorClient,
  );
}

export function createLock(args: {
  uuid: string;
  utxoId?: number;
  status: BitcoinLockStatus;
  createdAt: string;
}): IBitcoinLockRecord {
  return {
    uuid: args.uuid,
    utxoId: args.utxoId,
    status: args.status,
    satoshis: 10_000n,
    liquidityPromised: 0n,
    lockedTargetPrice: 0n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails: {
      p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
      ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      createdAtHeight: 100,
      vaultClaimHeight: 200,
    } as IBitcoinLockRecord['lockDetails'],
    fundingUtxoRecordId: null,
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
}): IBitcoinLock {
  return {
    utxoId: 7,
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    vaultId: 1,
    isFlexible: false,
    lockedTargetPrice: args.lockedTargetPrice ?? 1_000n,
    liquidityPromised: args.liquidityPromised,
    ownerAccount: args.accountId,
    securitizationRatio: 1,
    satoshis: 10_000n,
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
    isFunded: true,
    createdAtArgonBlock: 151,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
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
) {
  return {
    event: {
      section,
      method,
      data: createHistoricalEventData(specVersion, section, method, values),
    },
    phase: { isApplyExtrinsic: true, asApplyExtrinsic: numberCodec(extrinsicIndex) },
  };
}
