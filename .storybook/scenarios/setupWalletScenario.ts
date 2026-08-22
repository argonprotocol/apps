import * as Vue from 'vue';
import { MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, MoveToken, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import type { IEthereumInboundTransferState } from '../../src-vue/interfaces/IEthereumInboundTransferTracker.ts';
import type { IWalletRecord } from '../../src-vue/lib/db/WalletsTable.ts';
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
import { defaultWalletData, type IWallet, WalletType } from '../../src-vue/lib/Wallet.ts';
import { convertEthereumTokenBaseUnitsToRuntimeAmount } from '../../src-vue/lib/WalletForEthereum.ts';
import { getCurrency } from '../../src-vue/stores/currency.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getEthereumMoveTracker } from '../../src-vue/stores/moveFromEthereum.ts';
import { getEthereumOutboundTransferTracker } from '../../src-vue/stores/moveToEthereum.ts';
import { getWalletKeys, useWallets } from '../../src-vue/stores/wallets.ts';
import { TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { setupAppScenario } from './setupAppScenario.ts';

export type WalletScenario =
  | 'defaultArgon'
  | 'importReady'
  | 'importScanning'
  | 'importAccounts'
  | 'importUnavailable'
  | 'importFailure'
  | 'privateKeyError';

export type WalletTransferScenario =
  | 'inboundForm'
  | 'outboundForm'
  | 'feeLoading'
  | 'feeUnavailable'
  | 'insufficientEth'
  | 'submittingInbound'
  | 'inboundEthereum'
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

type EthereumBalanceScan = Awaited<ReturnType<ReturnType<typeof useWallets>['scanEthereumWalletBalances']>>;

const argon = BigInt(MICROGONS_PER_ARGON);
const argonot = BigInt(MICRONOTS_PER_ARGONOT);
const eth = 10n ** 18n;

type WalletTransferScenarioState = {
  cleanup?: () => void;
};

export function setupWalletScenario(state: WalletScenario): WalletScenarioState {
  const { wallets } = setupAppScenario({ selectedTab: TopTab.Home });
  const currency = getCurrency();
  const financials = useFinancials();
  const now = new Date('2026-08-16T12:00:00.000Z');
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
  const ethereumWallets = new Map<number, IWallet>([
    [
      ethereumTreasury.id,
      Vue.reactive<IWallet>({
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
      Vue.reactive<IWallet>({
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
    savingsTotalPending: 20n * argon,
  });
  if (state === 'privateKeyError') {
    getWalletKeys().exportDefaultArgonPrivateKey = fn(async () => {
      throw new Error('Synthetic private-key export failure.');
    });
  }
  Object.assign(wallets, {
    isLoaded: true,
    load: fn(async () => undefined),
    walletRecords: [ethereumTreasury, ethereumSavings],
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
    getEthereumWalletRecord: fn((recordId: number) => {
      const wallet = ethereumWallets.get(recordId);
      if (!wallet) throw new Error(`Ethereum wallet record not found: ${recordId}`);
      return wallet;
    }),
    refreshEthereumWalletRecord: fn(async () => undefined),
    previewExternalEthereumMnemonic: fn(async () => [
      { address: ethereumTreasury.address, derivationPath: "m/44'/60'/0'/0/0" },
      { address: ethereumSavings.address, derivationPath: "m/44'/60'/0'/0/1" },
    ]),
    importExternalEthereumPrivateKey:
      state === 'importFailure'
        ? fn(async () => {
            throw new Error('Synthetic import service failure.');
          })
        : fn(async () => importedWallet),
    importExternalEthereumMnemonic: fn(async () => importedWallet),
    scanEthereumWalletBalances: ethereumBalanceScan.mock,
  });
  mocked(loadEthereumChainConfig).mockResolvedValue(undefined);
  mocked(getEthereumMoveTracker).mockReturnValue(createInboundTransferTracker());
  mocked(getEthereumOutboundTransferTracker).mockReturnValue(
    createOutboundTransferTracker(undefined, 'outboundForm').tracker,
  );

  const scenario: WalletScenarioState = {};

  if (ethereumBalanceScan.cleanup) scenario.cleanup = ethereumBalanceScan.cleanup;
  return scenario;
}

export function setupWalletTransferScenario(state: WalletTransferScenario): WalletTransferScenarioState {
  setupWalletScenario('defaultArgon');

  const inboundTransfer = createInboundTransfer(state);
  const outboundTransfer = createOutboundTransfer(state);
  const inboundTracker = createInboundTransferTracker(inboundTransfer);
  const outbound = createOutboundTransferTracker(outboundTransfer, state);
  const wallets = useWallets();
  const ethereumWallet = Vue.reactive<IWallet>({
    ...defaultWalletData,
    type: WalletType.ethereum,
    address: '0x1111111111111111111111111111111111111111',
    availableMicrogons: 175n * argon,
    availableMicronots: 48n * argonot,
    totalMicrogons: 175n * argon,
    totalMicronots: 48n * argonot,
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

  Object.assign(wallets, {
    ethereumWallet,
    getEthereumWalletRecord: fn(() => ethereumWallet),
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
  ethereumWallets: Map<number, IWallet>,
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
        {
          address: ethereumTreasury.address,
          wallet: unavailable
            ? Vue.reactive<IWallet>({
                ...defaultWalletData,
                type: WalletType.ethereum,
                address: ethereumTreasury.address,
                fetchErrorMsg: 'Synthetic network error.',
              })
            : ethereumWallets.get(ethereumTreasury.id)!,
        },
        {
          address: ethereumSavings.address,
          wallet: ethereumWallets.get(ethereumSavings.id)!,
        },
      ];
    }),
  };
}

function createInboundTransfer(state: WalletTransferScenario): IEthereumInboundActiveTransfer | undefined {
  let progress = createCrosschainTransferProgress(INBOUND_TRANSFER_STEP_TITLES);
  let isSubmitting = false;
  let hasPersistedTransfer = true;
  let isComplete = false;

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
      needsAttention: false,
      isComplete,
      amount: 175n * argon,
      targetWalletType: WalletType.argon,
      progress: stabilizeProgress(progress),
      error: '',
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
): EthereumInboundTransferTracker {
  const tracker = Object.create(EthereumInboundTransferTracker.prototype) as EthereumInboundTransferTracker;
  tracker.data = Vue.reactive({
    transfersById: initialTransfer ? { [initialTransfer.id]: initialTransfer } : {},
    latestTransferIdByToken: initialTransfer ? { [initialTransfer.moveToken]: initialTransfer.id } : {},
  });
  tracker.estimateFeeWei = fn(async () => eth / 1_000n);
  tracker.startMove = fn(async args => {
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
): { tracker: EthereumOutboundTransferTracker; cleanup?: () => void } {
  const tracker = Object.create(EthereumOutboundTransferTracker.prototype) as EthereumOutboundTransferTracker;
  tracker.data = Vue.reactive({
    transfersById: initialTransfer ? { [initialTransfer.id]: initialTransfer } : {},
    latestTransferIdByToken: initialTransfer ? { [initialTransfer.moveToken]: initialTransfer.id } : {},
  });
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
    tracker.estimateFeeRangeWei = fn(async () => undefined);
  } else {
    tracker.estimateFeeRangeWei = fn(async () => [2n * (eth / 1_000n), 4n * (eth / 1_000n)] as const);
  }

  tracker.startMove = fn(async args => {
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
