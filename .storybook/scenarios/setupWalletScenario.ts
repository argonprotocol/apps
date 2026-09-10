import * as Vue from 'vue';
import {
  BitcoinLock,
  MICROGONS_PER_ARGON,
  MICRONOTS_PER_ARGONOT,
  MoveToken,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { fn, mocked, spyOn } from 'storybook/test';
import type { IEthereumInboundTransferState } from '../../src-vue/interfaces/IEthereumInboundTransferTracker.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../src-vue/interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinLockSummary } from '../../src-vue/interfaces/IBitcoinLockSummary.ts';
import {
  BitcoinUtxoRole,
  BitcoinUtxoStatus,
  type IBitcoinUtxoRecord,
} from '../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import type { IWalletRecord } from '../../src-vue/lib/db/WalletsTable.ts';
import { ExtrinsicType } from '../../src-vue/interfaces/ITransactionRecord.ts';
import BitcoinLocks from '../../src-vue/lib/BitcoinLocks.ts';
import {
  completeInboundTransferProgress,
  completeOutboundTransferProgress,
  createCrosschainTransferProgress,
  formatCrosschainBlockStepDetail,
  getOutboundMintingAuthorizationWaitingDetail,
  INBOUND_TRANSFER_STEP_TITLES,
  OUTBOUND_TRANSFER_STEP_TITLES,
  setInboundArgonStepProgress,
  setInboundEthereumStepProgress,
  setInboundRelayStepProgress,
  setOutboundArgonStepProgress,
  setOutboundEthereumStepProgress,
  setOutboundMintingAuthorizationStepProgress,
  type ICrosschainTransferProgress,
} from '../../src-vue/lib/CrosschainTransferProgress.ts';
import {
  EthereumInboundTransferTracker,
  type IEthereumInboundActiveTransfer,
} from '../../src-vue/lib/EthereumInboundTransferTracker.ts';
import { loadEthereumChainConfig, type IEthereumChainConfig } from '../../src-vue/lib/EthereumClient.ts';
import {
  EthereumOutboundTransferTracker,
  type IEthereumOutboundActiveTransfer,
  type IEthereumOutboundTransferState,
} from '../../src-vue/lib/EthereumOutboundTransferTracker.ts';
import { defaultWalletData, type IWallet, type IWalletData, WalletType } from '../../src-vue/lib/Wallet.ts';
import {
  convertEthereumTokenBaseUnitsToRuntimeAmount,
  WalletForEthereum,
} from '../../src-vue/lib/WalletForEthereum.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../src-vue/stores/bitcoin.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getEthereumMoveTracker } from '../../src-vue/stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../src-vue/stores/moveToEthereum.ts';
import { getVaults } from '../../src-vue/stores/vaults.ts';
import { getWalletKeys, useWallets } from '../../src-vue/stores/wallets.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getMainchainClient } from '../../src-vue/stores/mainchain.ts';
import { createScenarioTransactionInfo } from './setupBitcoinOverlayScenario.ts';
import { createScenarioVault } from './createScenarioVault.ts';
import { setupAppScenario } from './setupAppScenario.ts';

export type WalletScenario =
  | 'defaultArgon'
  | 'pendingBitcoinFunding'
  | 'pendingBitcoinRelease'
  | 'bitcoinSend'
  | 'bitcoinSendLocked'
  | 'bitcoinWalletDetails'
  | 'bitcoinWalletInsurancePending'
  | 'bitcoinWalletInsuranceUnavailable'
  | 'bitcoinWalletInsurancePriceIncrease'
  | 'bitcoinWalletInsuranceSubmitting'
  | 'bitcoinWalletInsuranceError'
  | 'importReady'
  | 'importScanning'
  | 'importAccounts'
  | 'importUnavailable'
  | 'importFailure'
  | 'privateKeyError';

export type WalletTransferScenario =
  | 'inboundForm'
  | 'inboundEmpty'
  | 'inboundArgonOnly'
  | 'outboundForm'
  | 'outboundBitcoin'
  | 'feeLoading'
  | 'feeUnavailable'
  | 'insufficientEth'
  | 'existingInbound'
  | 'existingOutbound'
  | 'submittingInbound'
  | 'inboundEthereum'
  | 'inboundTransactionUnavailable'
  | 'inboundRelay'
  | 'inboundArgon'
  | 'submittingOutbound'
  | 'outboundArgon'
  | 'outboundAuthorization'
  | 'outboundEthereum'
  | 'attentionError'
  | 'completeInbound'
  | 'completeOutbound';

type WalletScenarioState = {
  cleanup?: () => void;
};

type EthereumBalanceScan = WalletForEthereum[];

const argon = BigInt(MICROGONS_PER_ARGON);
const argonot = BigInt(MICRONOTS_PER_ARGONOT);
const eth = 10n ** 18n;

type WalletTransferScenarioState = {
  cleanup?: () => void;
};

export function setupWalletScenario(state: WalletScenario): WalletScenarioState {
  const isBitcoinWalletDetails =
    state === 'bitcoinWalletDetails' ||
    state === 'bitcoinWalletInsurancePending' ||
    state === 'bitcoinWalletInsuranceUnavailable' ||
    state === 'bitcoinWalletInsurancePriceIncrease' ||
    state === 'bitcoinWalletInsuranceSubmitting' ||
    state === 'bitcoinWalletInsuranceError';
  const insuranceRateMicrogonsPerBtc = state === 'bitcoinWalletInsuranceUnavailable' ? 6_800_000_000n : 68_000_000_000n;
  const { wallets } = setupAppScenario({
    selectedTab: TopTab.Home,
    config: isBitcoinWalletDetails ? { hasExtensionTreasury: true } : undefined,
  });
  Object.assign(getVaults().operatorNamesByVaultId, { 7: 'Testing', 101: 'Testing', 102: 'Testing', 103: 'Testing' });
  const currency = getCurrency();
  const financials = useFinancials();
  const now = new Date('2026-08-16T12:00:00.000Z');

  spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const ethereumTreasury: IWalletRecord = {
    id: 41,
    walletType: 'ethereum',
    name: 'Ethereum Treasury',
    address: '0x1111111111111111111111111111111111111111',
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  };
  const ethereumSavings: IWalletRecord = {
    id: 42,
    walletType: 'ethereum',
    name: 'Ethereum Savings',
    address: '0x2222222222222222222222222222222222222222',
    sortOrder: 2,
    createdAt: now,
    updatedAt: now,
  };
  const importedWallet: IWalletRecord = {
    id: 43,
    walletType: 'ethereum',
    name: 'Imported Storybook',
    address: '0x3333333333333333333333333333333333333333',
    sortOrder: 3,
    createdAt: now,
    updatedAt: now,
  };
  const bitcoinChannels = Vue.reactive<IBitcoinLockRecord[]>([]);
  if (state === 'bitcoinSend') {
    bitcoinChannels.push(
      createBitcoinChannel('storybook-sendable-channel-one', 101, 1_000_000n),
      createBitcoinChannel('storybook-sendable-channel-two', 102, 2_000_000n),
      createBitcoinChannel('storybook-liquid-channel', 103, 5_000_000n, 4_000_000n),
    );
  } else if (state === 'bitcoinSendLocked') {
    bitcoinChannels.push(createBitcoinChannel('storybook-liquid-channel', 103, 5_000_000n, 4_000_000n));
  } else if (isBitcoinWalletDetails) {
    Object.assign(getVaults().operatorNamesByVaultId, { 101: 'Testing', 103: 'Backup' });
    bitcoinChannels.push(
      createBitcoinChannel('storybook-wallet-channel-one', 101, 1_000_000n),
      createBitcoinChannel('storybook-wallet-channel-two', 102, 2_000_000n, 0n, 101),
      createBitcoinChannel('storybook-wallet-partial-channel', 103, 5_000_000n, 4_000_000n),
      createBitcoinChannel('storybook-wallet-fully-allocated-channel', 104, 5_000_000n, 5_000_000n),
    );
    bitcoinChannels[0].securitizationCoverageMicrogons = 500n * argon;
    bitcoinChannels[1].securitizationCoverageMicrogons = 750n * argon;
    bitcoinChannels[2].securitizationCoverageMicrogons = 350n * argon;
    if (state === 'bitcoinWalletInsurancePriceIncrease') {
      bitcoinChannels[0].microgonsAtTargetPerBtc = 34_000_000_000n;
      bitcoinChannels[0].securitizationCoverageMicrogons = 340n * argon;
    }
  } else if (state === 'pendingBitcoinFunding' || state === 'pendingBitcoinRelease') {
    const isRelease = state === 'pendingBitcoinRelease';
    const fundingRecord: IBitcoinUtxoRecord = {
      id: 201,
      lockUtxoId: 101,
      txid: 'synthetic-pending-bitcoin-channel-funding',
      vout: 0,
      satoshis: 5_000_000n,
      network: 'bitcoin',
      role: isRelease ? BitcoinUtxoRole.Funding : undefined,
      status: isRelease ? BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin : BitcoinUtxoStatus.SeenOnMempool,
      firstSeenAt: new Date('2026-08-16T14:10:00.000Z'),
      firstSeenBitcoinHeight: 250_010,
      createdAt: new Date('2026-08-16T14:10:00.000Z'),
      updatedAt: new Date('2026-08-16T14:12:00.000Z'),
      releaseToDestinationAddress: isRelease ? `0014${'55'.repeat(20)}` : undefined,
      releaseBitcoinNetworkFee: isRelease ? 18_000n : undefined,
      releaseTxid: isRelease ? 'a'.repeat(64) : undefined,
      releaseFirstSeenAt: isRelease ? new Date('2026-08-16T14:11:00.000Z') : undefined,
      releaseFirstSeenBitcoinHeight: isRelease ? 250_011 : undefined,
      releaseLastConfirmationCheckAt: isRelease ? new Date('2026-08-16T14:12:00.000Z') : undefined,
    };
    bitcoinChannels.push({
      uuid: 'synthetic-pending-bitcoin-channel',
      utxoId: 101,
      status: isRelease ? BitcoinLockStatus.Releasing : BitcoinLockStatus.LockPendingFunding,
      securitizedSatoshis: 5_000_000n,
      securityFees: 0n,
      couponFeesPaid: 0n,
      fundHoldExtensionsByBitcoinExpirationHeight: {},
      utxos: [fundingRecord],
      fundedSatoshis: isRelease ? fundingRecord.satoshis : 0n,
      fundingUtxo: isRelease ? fundingRecord : undefined,
      cosignVersion: 'v1',
      network: 'bitcoin',
      hdPath: "m/84'/0'/0'/0/4",
      vaultId: 7,
      createdAt: new Date('2026-08-16T14:00:00.000Z'),
      updatedAt: fundingRecord.updatedAt,
    });
  }
  const bitcoinLocks: BitcoinLocks = Object.assign(Object.create(BitcoinLocks.prototype) as BitcoinLocks, {
    data: {
      bitcoinNetwork: BitcoinNetwork.Bitcoin,
      oracleBitcoinBlockHeight: 250_050,
    },
    utxoTracking: {
      getAllOrphanLifecycleUtxos: fn(() => []),
      getUnresolvedOrphanRecords: fn(() => []),
      getUtxosForLock: fn((lock: IBitcoinLockRecord) => lock.utxos),
      getObservedFundingRecord: fn((lock: IBitcoinLockRecord) => {
        return lock.utxos
          .filter(record => record.status === BitcoinUtxoStatus.SeenOnMempool)
          .sort((left, right) => left.firstSeenAt.getTime() - right.firstSeenAt.getTime())[0];
      }),
      isReleaseCompleteStatus: fn(() => false),
    },
    load: fn(async () => undefined),
    getAllLocks: fn(() => bitcoinChannels),
    hasObservedFundingSignal: fn((lock: IBitcoinLockRecord) => lock.utxos.length > 0),
    getLockProcessingDetails: fn(() => ({
      progressPct: 42,
      confirmations: 1,
      expectedConfirmations: 4,
      receivedSatoshis: 5_000_000n,
    })),
    getLockProcessingError: fn(() => ''),
    getAcceptedFundingRecord: fn((lock: IBitcoinLockRecord) => lock.fundingUtxo),
    argonLiquidityForSatoshis: fn((satoshis: bigint, microgonsAtTargetPerBtc = insuranceRateMicrogonsPerBtc) => {
      return (satoshis * microgonsAtTargetPerBtc) / 100_000_000n;
    }),
    isFundingWindowExpired: fn(() => false),
    createLockSummary: fn((lock: IBitcoinLockRecord): IBitcoinLockSummary => {
      const satoshis = lock.fundedSatoshis || lock.securitizedSatoshis;
      const valueOfBtc = currency.convertSatToMicrogon(satoshis);
      const securityFees = lock.securityFees - lock.couponFeesPaid;
      const unlockAmount = lock.securitizationCoverageMicrogons ?? 0n;
      return {
        uuid: lock.uuid,
        utxoId: lock.utxoId,
        status: lock.status,
        statusDetails: {
          hasObservedFundingSignal: true,
          showReadyForBitcoin: false,
          isFundingSeenInMempoolOnly: false,
        },
        lockProcessingDetails: {
          progressPct: 100,
          confirmations: 6,
          expectedConfirmations: 6,
          receivedSatoshis: satoshis,
        },
        lockProcessingError: '',
        satoshis,
        valueOfBtc,
        totalLiquidity: 0n,
        pendingLiquidity: 0n,
        receivedLiquidity: 0n,
        valueBeyondLiquidity: valueOfBtc,
        startingCapital: valueOfBtc,
        endingCapital: valueOfBtc - unlockAmount - securityFees,
        ratchetPercent: 0,
        totalReturn: 0,
        securityFees,
        transactionFees: 0n,
        totalFees: securityFees,
        unlockAmount,
        createdAt: lock.createdAt,
        record: lock,
      };
    }),
    getReleaseProcessingDetails: fn(() => ({
      progressPct: 42,
      confirmations: 1,
      expectedConfirmations: 4,
    })),
    getLockUnlockReleaseState: fn((lock: IBitcoinLockRecord) => ({
      isReleaseStatus: lock.status === BitcoinLockStatus.Releasing,
      isReleaseComplete: false,
      isWaitingForVaultCosign: false,
      isBitcoinReleaseProcessing: lock.status === BitcoinLockStatus.Releasing,
    })),
    isLockFunded: fn((lock: IBitcoinLockRecord) => lock.status === BitcoinLockStatus.LockFunded),
    getLockTermProgress: fn(() => 35),
    unlockDeadlineTime: fn(() => new Date('2026-10-16T12:00:00.000Z').getTime()),
    calculateBitcoinNetworkFee: fn(async () => 12_000n),
  });
  if (isBitcoinWalletDetails) {
    const insuranceVaults = Object.fromEntries(
      [101, 102, 103].map(vaultId => [vaultId, createScenarioVault({ vaultId })]),
    );
    Object.assign(getVaults(), {
      vaultsById: insuranceVaults,
      refreshVault: fn(async (vaultId: number) => insuranceVaults[vaultId]),
    });
    Object.assign(bitcoinLocks, {
      getTable: fn(async () => ({ updateFromCurrentLock: fn(async () => undefined) })),
      satoshisForArgonLiquidity: fn(
        async (microgons: bigint) => (microgons * 100_000_000n) / insuranceRateMicrogonsPerBtc,
      ),
    });
    currency.fetchMainchainRates = fn(async () => ({
      [UnitOfMeasurement.ARGNOT]: 14_000_000n,
      [UnitOfMeasurement.USD]: 1_000_000n,
      [UnitOfMeasurement.BTC]: insuranceRateMicrogonsPerBtc,
    }));
    mocked(getMainchainClient).mockResolvedValue({
      query: {
        bitcoinLocks: {
          microgonPerBtcHistory: fn(async () => [[10_000, insuranceRateMicrogonsPerBtc]]),
        },
        crosschainTransfer: {
          transferTotalsByAccount: fn(async () => ({ microgonsIn: 0n })),
        },
      },
    } as never);
    spyOn(BitcoinLock, 'get').mockImplementation(async (_client, utxoId) => {
      const record = bitcoinChannels.find(channel => channel.utxoId === utxoId);
      const scriptDetails = record?.scriptDetails;
      if (!record || !scriptDetails) return;

      return new BitcoinLock({
        utxoId,
        p2wshScriptHashHex: scriptDetails.p2wshScriptHashHex,
        vaultId: record.vaultId,
        securitizedSatoshis: record.securitizedSatoshis,
        microgonsAtTargetPerBtc: record.microgonsAtTargetPerBtc ?? insuranceRateMicrogonsPerBtc,
        securitizationCoverageMicrogons: record.securitizationCoverageMicrogons ?? 0n,
        securitizationTick: record.securitizationTick ?? 10_000,
        fundedSatoshis: record.fundedSatoshis,
        fissionedSatoshis: record.fissionedSatoshis ?? 0n,
        ownerAccount: record.ownerAccount ?? wallets.defaultArgonWallet.address,
        securitizationRatio: record.securitizationRatio ?? 1,
        securityFees: record.securityFees,
        couponFeesPaid: record.couponFeesPaid,
        vaultPubkey: scriptDetails.vaultPubkey,
        vaultClaimPubkey: scriptDetails.vaultClaimPubkey,
        ownerPubkey: scriptDetails.ownerPubkey,
        vaultXpubSources: scriptDetails.vaultXpubSources,
        vaultClaimHeight: scriptDetails.vaultClaimHeight,
        openClaimHeight: scriptDetails.openClaimHeight,
        createdAtHeight: scriptDetails.createdAtHeight,
        fundingExpirationHeight: record.fundingExpirationHeight!,
        isFlexible: record.isFlexible ?? false,
        fundHoldExtensionsByBitcoinExpirationHeight: record.fundHoldExtensionsByBitcoinExpirationHeight,
        createdAtArgonBlock: record.createdAtArgonBlock ?? 1,
      });
    });
  }
  const ethereumWallets = new Map<number, WalletForEthereum>([
    [
      ethereumTreasury.id,
      createEthereumWallet(ethereumTreasury, {
        ...defaultWalletData,
        type: WalletType.ethereum,
        address: ethereumTreasury.address,
        availableMicrogons: 175n * argon,
        availableMicronots: 48n * argonot,
        totalMicrogons: 175n * argon,
        totalMicronots: 48n * argonot,
        balanceUpdatedAt: now,
      }),
    ],
    [
      ethereumSavings.id,
      createEthereumWallet(ethereumSavings, {
        ...defaultWalletData,
        type: WalletType.ethereum,
        address: ethereumSavings.address,
        availableMicrogons: 75n * argon,
        availableMicronots: 18n * argonot,
        totalMicrogons: 75n * argon,
        totalMicronots: 18n * argonot,
        balanceUpdatedAt: now,
      }),
    ],
  ]);

  Object.assign(currency, { isLoaded: true });
  const ethereumBalanceScan = getScanEthereumWalletBalances(state, ethereumTreasury, ethereumSavings, ethereumWallets);
  Object.assign(financials, {
    savingsIsLoaded: true,
    savingsTotalValue: 900n * argon,
    bitcoinLiquidPendingMintMicrogons: 20n * argon,
    bitcoinWalletTotalSatoshis: bitcoinChannels.reduce(
      (total, lock) => total + lock.fundedSatoshis - (lock.fissionedSatoshis ?? 0n),
      0n,
    ),
  });
  if (state === 'privateKeyError') {
    getWalletKeys().exportDefaultArgonPrivateKey = fn(async () => {
      throw new Error('Synthetic private-key export failure.');
    });
  }
  Object.assign(wallets, {
    isLoaded: true,
    load: fn(async () => undefined),
    defaultArgonWallet: Vue.reactive<IWallet>({
      ...defaultWalletData,
      type: WalletType.argon,
      address: '5StorybookInternalArgonWallet',
      availableMicrogons: 880n * argon,
      availableMicronots: 300n * argonot,
      totalMicrogons: 900n * argon,
      totalMicronots: 300n * argonot,
    }),
    miningBotWallet: Vue.reactive<IWallet>({
      ...defaultWalletData,
      type: WalletType.miningBot,
      address: '5StorybookMiningWallet',
      availableMicrogons: 425n * argon,
      availableMicronots: 125n * argonot,
      totalMicrogons: 425n * argon,
      totalMicronots: 125n * argonot,
    }),
    ethereumWallets: {
      persistedWallets: [...ethereumWallets.values()],
      length: ethereumWallets.size,
      find: fn((recordId: number) => ethereumWallets.get(recordId)),
      findByAddress: fn((address: string) =>
        [...ethereumWallets.values()].find(wallet => wallet.address.toLowerCase() === address.toLowerCase()),
      ),
      importPrivateKey:
        state === 'importFailure'
          ? fn(async () => {
              throw new Error('Synthetic import service failure.');
            })
          : fn(async () => createEthereumWallet(importedWallet)),
      importMnemonic: fn(async () => createEthereumWallet(importedWallet)),
    },
  });
  wallets.argonWallets.defaultArgonWallet.data = wallets.defaultArgonWallet;
  Object.assign(wallets.bitcoinWallet, {
    getBitcoinLocks: () => bitcoinLocks,
    loadChannels: fn(async () => undefined),
    getChannelFundingAddress: fn((lock: IBitcoinLockRecord) => `bc1qstorybook${lock.utxoId}`),
  });
  WalletForEthereum.previewMnemonic = fn(async () => [
    { address: ethereumTreasury.address, derivationPath: "m/44'/60'/0'/0/0" },
    { address: ethereumSavings.address, derivationPath: "m/44'/60'/0'/0/1" },
  ]);
  WalletForEthereum.inspect = ethereumBalanceScan.mock;
  mocked(loadEthereumChainConfig).mockResolvedValue(undefined);
  mocked(getBitcoinLocks).mockReturnValue(bitcoinLocks);
  const pendingInsuranceTransaction =
    state === 'bitcoinWalletInsurancePending'
      ? createScenarioTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinResecuritize,
          metadata: {
            bitcoin: {
              utxoId: bitcoinChannels[0].utxoId!,
              vaultId: bitcoinChannels[0].vaultId,
              securitizedSatoshis: bitcoinChannels[0].fundedSatoshis,
              microgonsAtTargetPerBtc: 68_000_000_000n,
              securityFee: 4_500_000n,
            },
          },
          progress: { progressPct: 45, confirmations: 1, expectedConfirmations: 4 },
        })
      : undefined;
  mocked(getBitcoinTransactionOperations).mockReturnValue({
    bitcoinLockResecuritize: {
      getPendingResecuritizationTxInfo: fn((utxoId: number) =>
        pendingInsuranceTransaction?.tx.metadataJson.bitcoin.utxoId === utxoId
          ? pendingInsuranceTransaction
          : undefined,
      ),
      submit:
        state === 'bitcoinWalletInsuranceSubmitting'
          ? fn(() => new Promise(() => undefined))
          : state === 'bitcoinWalletInsuranceError'
            ? fn(async () => {
                throw new Error('Synthetic insurance transaction failure.');
              })
            : fn(async () => undefined),
    },
    bitcoinLockRelease: {
      prepare: fn(async () => ({
        canAfford: true,
        availableBalance: 880n * argon,
        txFeePlusTip: 125_000n,
      })),
      submit: fn(async () => undefined),
    },
  } as never);
  getWalletKeys().getLiquidLockingKeypair = fn(async () => ({ address: '5SyntheticLiquidLockingWallet' }) as never);
  mocked(getEthereumMoveTracker).mockReturnValue(createInboundTransferTracker());
  mocked(getEthereumOutboundTransferTracker).mockReturnValue(
    createOutboundTransferTracker(undefined, 'outboundForm').tracker,
  );

  const scenario: WalletScenarioState = {};

  if (ethereumBalanceScan.cleanup) scenario.cleanup = ethereumBalanceScan.cleanup;
  return scenario;
}

function createBitcoinChannel(
  uuid: string,
  utxoId: number,
  fundedSatoshis: bigint,
  fissionedSatoshis = 0n,
  vaultId = utxoId,
): IBitcoinLockRecord {
  const now = new Date('2026-08-16T14:00:00.000Z');
  return {
    uuid,
    utxoId,
    status: BitcoinLockStatus.LockFunded,
    securitizedSatoshis: fundedSatoshis,
    fissionedSatoshis,
    securityFees: 0n,
    couponFeesPaid: 0n,
    scriptDetails: {
      p2wshScriptHashHex: `0020${utxoId.toString(16).padStart(64, '0')}`,
      vaultPubkey: `02${'22'.repeat(32)}`,
      vaultClaimPubkey: `02${'33'.repeat(32)}`,
      ownerPubkey: `02${'44'.repeat(32)}`,
      vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 0, claimHdIndex: 0 },
      vaultClaimHeight: 250_100,
      openClaimHeight: 250_200,
      createdAtHeight: 250_000,
    },
    fundingExpirationHeight: 250_006,
    fundHoldExtensionsByBitcoinExpirationHeight: {},
    utxos: [],
    fundedSatoshis,
    cosignVersion: 'v1',
    network: 'bitcoin',
    hdPath: `m/84'/0'/0'/0/${utxoId}`,
    vaultId,
    createdAt: now,
    updatedAt: now,
  };
}

export function setupWalletTransferScenario(state: WalletTransferScenario): WalletTransferScenarioState {
  setupWalletScenario(state === 'outboundBitcoin' ? 'bitcoinSend' : 'defaultArgon');

  const inboundTransfer = createInboundTransfer(state);
  const outboundTransfer = createOutboundTransfer(state);
  const inboundTracker = createInboundTransferTracker(
    state === 'existingInbound' ? inboundTransfer : undefined,
    inboundTransfer,
  );
  const outbound = createOutboundTransferTracker(
    state === 'existingOutbound' ? outboundTransfer : undefined,
    state,
    outboundTransfer,
  );
  const wallets = useWallets();
  const ethereumWallet = wallets.ethereumWallets.find(41);
  if (!ethereumWallet) throw new Error('Ethereum Treasury story wallet is missing.');
  wallets.argonWallets.defaultArgonWallet.data.otherTokens = [];
  Object.assign(ethereumWallet.data, {
    ...defaultWalletData,
    type: WalletType.ethereum,
    address: '0x1111111111111111111111111111111111111111',
    availableMicrogons: state === 'inboundEmpty' ? 0n : 175n * argon,
    availableMicronots: state === 'inboundEmpty' || state === 'inboundArgonOnly' ? 0n : 48n * argonot,
    totalMicrogons: state === 'inboundEmpty' ? 0n : 175n * argon,
    totalMicronots: state === 'inboundEmpty' || state === 'inboundArgonOnly' ? 0n : 48n * argonot,
    otherTokens: [
      {
        symbol: 'ETH',
        decimals: 18,
        address: null,
        chain: 'ethereum',
        unitOfMeasurement: UnitOfMeasurement.ETH,
        value: state === 'insufficientEth' ? eth / 2_000n : 3n * eth,
      },
    ],
    balanceUpdatedAt: new Date('2026-08-16T12:00:00.000Z'),
  });

  mocked(loadEthereumChainConfig).mockResolvedValue({
    chainId: 1,
    gatewayAddress: '0x5555555555555555555555555555555555555555',
    argonTokenAddress: '0x6666666666666666666666666666666666666666',
    argonotTokenAddress: '0x7777777777777777777777777777777777777777',
  } satisfies IEthereumChainConfig);
  mocked(getEthereumMoveTracker).mockReturnValue(inboundTracker);
  mocked(getEthereumOutboundTransferTracker).mockReturnValue(outbound.tracker);

  const scenario: WalletTransferScenarioState = {};

  if (outbound.cleanup) scenario.cleanup = outbound.cleanup;
  return scenario;
}

function getScanEthereumWalletBalances(
  state: WalletScenario,
  ethereumTreasury: IWalletRecord,
  ethereumSavings: IWalletRecord,
  ethereumWallets: Map<number, WalletForEthereum>,
) {
  if (state === 'importScanning') {
    let resolveScan: ((balances: EthereumBalanceScan) => void) | undefined;
    return {
      mock: fn(
        () =>
          new Promise<EthereumBalanceScan>(resolve => {
            resolveScan = resolve;
          }),
      ),
      cleanup: () => resolveScan?.([]),
    };
  }

  return {
    mock: fn(async () => {
      const unavailable = state === 'importUnavailable';
      return [
        unavailable
          ? createEthereumWallet(ethereumTreasury, {
              ...defaultWalletData,
              type: WalletType.ethereum,
              address: ethereumTreasury.address,
              fetchErrorMsg: 'Synthetic network error.',
            })
          : ethereumWallets.get(ethereumTreasury.id)!,
        ethereumWallets.get(ethereumSavings.id)!,
      ];
    }),
  };
}

function createEthereumWallet(record: IWalletRecord, data?: IWalletData<WalletType.ethereum>): WalletForEthereum {
  const wallet = new WalletForEthereum(record.address, undefined, record);
  if (data) wallet.data = Vue.reactive(data);
  return wallet;
}

function createInboundTransfer(state: WalletTransferScenario): IEthereumInboundActiveTransfer | undefined {
  let progress = createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES);
  let isSubmitting = false;
  let hasPersistedTransfer = true;
  let needsAttention = false;
  let isComplete = false;
  let error = '';

  switch (state) {
    case 'submittingInbound':
      isSubmitting = true;
      hasPersistedTransfer = false;
      progress = setInboundEthereumStepProgress(progress, {
        progressPct: 0,
        detail: 'Preparing Ethereum transfer...',
      });
      break;
    case 'inboundEthereum':
    case 'existingInbound':
      progress = setInboundEthereumStepProgress(progress, {
        progressPct: 42,
        detail: formatCrosschainBlockStepDetail({
          blockType: 'Ethereum',
          confirmations: 5,
          expectedConfirmations: 12,
        }),
        confirmations: 5,
        expectedConfirmations: 12,
      });
      break;
    case 'inboundTransactionUnavailable':
      needsAttention = true;
      error =
        'Ethereum transaction 0x9595959595959595959595959595959595959595959595959595959595959595 could not be found after the expected confirmation window. It may have been dropped or replaced. Check your Ethereum wallet activity before retrying.';
      progress = setInboundEthereumStepProgress(progress, {
        progressPct: 0,
        detail: 'Submitted to Ethereum. Waiting for confirmation...',
      });
      break;
    case 'inboundRelay':
      progress = setInboundRelayStepProgress(progress, {
        progressPct: 58,
        detail: 'Waiting for Argon proof of 18 Ethereum blocks',
      });
      break;
    case 'inboundArgon':
      progress = setInboundArgonStepProgress(progress, {
        progressPct: 50,
        detail: formatCrosschainBlockStepDetail({
          blockType: 'Argon',
          confirmations: 1,
          expectedConfirmations: 4,
        }),
        hint: 'Argon is finalizing this transfer now.',
      });
      break;
    case 'completeInbound':
      hasPersistedTransfer = false;
      isComplete = true;
      progress = completeInboundTransferProgress(progress, 'Confirmed on Argon.');
      break;
    default:
      return;
  }

  return {
    id: 'storybook-inbound-transfer',
    moveToken: MoveToken.ARGN,
    sourceAddress: '0x1111111111111111111111111111111111111111',
    transferState: {
      isSubmitting,
      hasPersistedTransfer,
      needsAttention,
      isComplete,
      amount: 175n * argon,
      targetWalletType: WalletType.argon,
      progress: stabilizeProgress(progress),
      error,
    } satisfies IEthereumInboundTransferState,
  };
}

function createOutboundTransfer(state: WalletTransferScenario): IEthereumOutboundActiveTransfer | undefined {
  let progress = createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES);
  let isSubmitting = false;
  let hasPersistedTransfer = true;
  let needsAttention = false;
  let isComplete = false;
  let error = '';

  switch (state) {
    case 'submittingOutbound':
      isSubmitting = true;
      hasPersistedTransfer = false;
      progress = setOutboundArgonStepProgress(progress, {
        progressPct: 0,
        detail: 'Submitting to Argon miners...',
      });
      break;
    case 'outboundArgon':
    case 'existingOutbound':
      progress = setOutboundArgonStepProgress(progress, {
        progressPct: 67,
        detail: formatCrosschainBlockStepDetail({
          blockType: 'Argon',
          confirmations: 2,
          expectedConfirmations: 4,
        }),
        confirmations: 2,
        expectedConfirmations: 4,
      });
      break;
    case 'outboundAuthorization':
      progress = setOutboundMintingAuthorizationStepProgress(progress, {
        progressPct: 45,
        detail: getOutboundMintingAuthorizationWaitingDetail({ approvalPercent: 45 }),
        approvalPercent: 45,
        remainingMintingAuthorizationMicrogons: 115n * argon,
      });
      break;
    case 'outboundEthereum':
      progress = setOutboundEthereumStepProgress(progress, {
        progressPct: 75,
        detail: formatCrosschainBlockStepDetail({
          blockType: 'Ethereum',
          confirmations: 8,
          expectedConfirmations: 12,
        }),
        confirmations: 8,
        expectedConfirmations: 12,
      });
      break;
    case 'attentionError':
      needsAttention = true;
      error = 'Ethereum submission needs attention. The transfer remains recorded for recovery.';
      progress = setOutboundMintingAuthorizationStepProgress(progress, {
        progressPct: 62,
        detail: getOutboundMintingAuthorizationWaitingDetail({ approvalPercent: 62 }),
        approvalPercent: 62,
      });
      break;
    case 'completeOutbound':
      hasPersistedTransfer = false;
      isComplete = true;
      progress = completeOutboundTransferProgress(progress, 'Confirmed on Ethereum.');
      break;
    default:
      return;
  }

  return {
    id: 'storybook-outbound-transfer',
    moveToken: MoveToken.ARGN,
    destinationAddress: '0x1111111111111111111111111111111111111111',
    transferState: {
      isSubmitting,
      hasPersistedTransfer,
      needsAttention,
      isComplete,
      amount: 875n * argon,
      sourceWalletType: WalletType.argon,
      progress: stabilizeProgress(progress),
      error,
    } satisfies IEthereumOutboundTransferState,
  };
}

function createInboundTransferTracker(
  initialTransfer?: IEthereumInboundActiveTransfer,
  submittedTransfer?: IEthereumInboundActiveTransfer,
): EthereumInboundTransferTracker {
  const tracker = Object.create(EthereumInboundTransferTracker.prototype) as EthereumInboundTransferTracker;
  tracker.data = Vue.reactive({
    transfersById: initialTransfer ? { [initialTransfer.id]: initialTransfer } : {},
    latestTransferIdByToken: initialTransfer ? { [initialTransfer.moveToken]: initialTransfer.id } : {},
  });
  tracker.load = fn(async () => undefined);
  tracker.estimateFeeWei = fn(async () => eth / 1_000n);
  tracker.startMove = fn(async args => {
    if (submittedTransfer) {
      tracker.data.transfersById[submittedTransfer.id] = submittedTransfer;
      tracker.data.latestTransferIdByToken[submittedTransfer.moveToken] = submittedTransfer.id;
      return submittedTransfer;
    }

    const transfer: IEthereumInboundActiveTransfer = {
      id: 'storybook-inbound-submission',
      moveToken: args.moveToken,
      transferState: {
        isSubmitting: true,
        hasPersistedTransfer: false,
        needsAttention: false,
        isComplete: false,
        amount: convertEthereumTokenBaseUnitsToRuntimeAmount(args.amountBaseUnits),
        targetWalletType: args.targetWalletType,
        progress: stabilizeProgress(
          setInboundEthereumStepProgress(createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES), {
            progressPct: 0,
            detail: 'Preparing Ethereum transfer...',
          }),
        ),
        error: '',
      },
    };

    tracker.data.transfersById[transfer.id] = transfer;
    tracker.data.latestTransferIdByToken[transfer.moveToken] = transfer.id;
    return transfer;
  });
  tracker.dismissFailedTransfer = fn(async id => {
    discardScenarioTransfer(tracker.data, id);
  });
  tracker.clearCompletedTransfer = fn(id => {
    discardScenarioTransfer(tracker.data, id);
  });
  return tracker;
}

function createOutboundTransferTracker(
  initialTransfer: IEthereumOutboundActiveTransfer | undefined,
  state: WalletTransferScenario,
  submittedTransfer?: IEthereumOutboundActiveTransfer,
): { tracker: EthereumOutboundTransferTracker; cleanup?: () => void } {
  const tracker = Object.create(EthereumOutboundTransferTracker.prototype) as EthereumOutboundTransferTracker;
  tracker.data = Vue.reactive({
    transfersById: initialTransfer ? { [initialTransfer.id]: initialTransfer } : {},
    latestTransferIdByToken: initialTransfer ? { [initialTransfer.moveToken]: initialTransfer.id } : {},
  });
  tracker.load = fn(async () => undefined);
  tracker.getTransfer = fn((id: string) => tracker.data.transfersById[id]);
  tracker.getPendingAmount = fn(() => 0n);
  tracker.getMaximumTransferOutAmount = fn(async () => 875n * argon);
  tracker.getTransferOutUnavailableReason = fn(async () => undefined);
  tracker.estimateArgonFees = fn(async () => ({
    transactionFeeMicrogons: 25_000n,
    mintingAuthorityTip: 50_000n,
  }));

  let cleanup: (() => void) | undefined;
  if (state === 'feeLoading') {
    const pendingEstimates = new Set<(estimate: readonly [bigint, bigint] | undefined) => void>();
    tracker.estimateFeeRangeWei = fn(
      () =>
        new Promise<readonly [bigint, bigint] | undefined>(resolve => {
          pendingEstimates.add(resolve);
        }),
    );
    cleanup = () => {
      for (const resolveEstimate of pendingEstimates) {
        resolveEstimate(undefined);
      }
      pendingEstimates.clear();
    };
  } else if (state === 'feeUnavailable') {
    tracker.estimateFeeRangeWei = fn(async () => {
      throw new Error('Unable to estimate network fees.');
    });
  } else {
    tracker.estimateFeeRangeWei = fn(async () => [2n * (eth / 1_000n), 4n * (eth / 1_000n)] as const);
  }

  tracker.startMove = fn(async args => {
    if (submittedTransfer) {
      tracker.data.transfersById[submittedTransfer.id] = submittedTransfer;
      tracker.data.latestTransferIdByToken[submittedTransfer.moveToken] = submittedTransfer.id;
      return submittedTransfer;
    }

    const transfer: IEthereumOutboundActiveTransfer = {
      id: 'storybook-outbound-submission',
      moveToken: args.moveToken,
      transferState: {
        isSubmitting: true,
        hasPersistedTransfer: false,
        needsAttention: false,
        isComplete: false,
        amount: args.amount,
        sourceWalletType: args.sourceWalletType,
        progress: stabilizeProgress(
          setOutboundArgonStepProgress(createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES), {
            progressPct: 0,
            detail: 'Submitting to Argon miners...',
          }),
        ),
        error: '',
      },
    };

    tracker.data.transfersById[transfer.id] = transfer;
    tracker.data.latestTransferIdByToken[transfer.moveToken] = transfer.id;
    return transfer;
  });
  tracker.dismissFailedTransfer = fn(async id => {
    discardScenarioTransfer(tracker.data, id);
  });
  tracker.clearCompletedTransfer = fn(id => {
    discardScenarioTransfer(tracker.data, id);
  });
  return cleanup ? { tracker, cleanup } : { tracker };
}

function stabilizeProgress(progress: ICrosschainTransferProgress): ICrosschainTransferProgress {
  for (const step of progress.steps) {
    step.startedAt = undefined;
    step.estimatedDurationMs = undefined;
  }

  return progress;
}

function discardScenarioTransfer(
  data: EthereumInboundTransferTracker['data'] | EthereumOutboundTransferTracker['data'],
  id: string,
) {
  const transfer = data.transfersById[id];
  if (!transfer) return;

  delete data.transfersById[id];
  if (data.latestTransferIdByToken[transfer.moveToken] === id) {
    delete data.latestTransferIdByToken[transfer.moveToken];
  }
}
