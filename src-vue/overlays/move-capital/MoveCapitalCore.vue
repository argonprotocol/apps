<!-- prettier-ignore -->
<template>
  <div v-if="!hasTokensToMove && !isProcessing" class="flex flex-col">
    <div class="text-gray-500">
      There are no {{ moveTokenName[moveToken].toLowerCase() }}s ready to move from {{ moveFromName[moveFrom] }}.
    </div>
  </div>

  <div v-else-if="!isProcessing" class="flex flex-col justify-between">
    <div class="mt-3 flex flex-row items-start space-x-2">
      <div class="grow">
        <div class="mb-1">Move From</div>
        <div class="rounded-md border border-dashed border-slate-900/70 px-2 py-1 font-mono">
          {{ moveFromName[moveFrom] }}
        </div>
      </div>
      <div class="grow">
        <div class="mb-1">Amount</div>
        <InputToken
          :min="0n"
          v-model="amountToMove"
          @update:modelValue="updateMoveAmount"
          class="w-full"
          :max="maxAmount"
          :suffix="` ${moveToken}`"
          :disabled="pendingTxInfo !== null || !canSubmit" />
      </div>
    </div>

    <div class="mt-3 mb-1">Move To</div>
    <InputMenu v-if="canChangeDestination" v-model="moveTo" :options="moveOptions" :selectFirst="true" class="w-full" />
    <div v-else class="rounded-md border border-dashed border-slate-900/70 px-2 py-1 font-mono">
      {{ moveTo }} Account
    </div>
    <template v-if="moveTo === MoveTo.External">
      <input
        v-model="externalAddress"
        :disabled="pendingTxInfo !== null"
        type="text"
        class="mt-3 w-full rounded-md border border-slate-900/40 px-2 py-1.5 font-mono"
        placeholder="Address of Account" />
      <div class="mt-2 flex w-full justify-center gap-x-1 text-xs text-slate-500">
        <div>Send to an</div>
        <div class="" :class="[isMovingToEthereum ? 'text-argon-600 font-bold' : 'font-semibold text-slate-800']">
          Ethereum
        </div>
        <div>or</div>
        <div class="" :class="[isMovingToArgon ? 'text-argon-600 font-bold' : 'font-semibold text-slate-800']">
          Argon
        </div>
        <div>address</div>
      </div>
      <div v-if="addressWarning" class="mt-5 w-full rounded-md border p-2 text-yellow-600">
        {{ addressWarning }}
      </div>
    </template>
  </div>
  <div v-if="transactionError" class="mt-5 min-h-5 w-full rounded-md border border-red-200 bg-red-50 p-2 text-red-600">
    <strong>Error</strong>
    {{ transactionError }}
  </div>
  <div
    v-else-if="!isProcessing && !canAfford && hasTokensToMove && isLoaded"
    class="mt-5 min-h-5 w-full rounded-md border border-red-200 bg-red-50 p-2 text-red-600">
    <strong>Error</strong>
    Your wallet has insufficient funds for this transaction.
  </div>
  <div
    v-else-if="comingSoon"
    class="mt-5 min-h-5 w-full rounded-md border border-yellow-600 bg-yellow-50 p-2 text-yellow-600">
    <strong>Coming Soon</strong>
    {{ comingSoon }}
  </div>
  <div class="mt-2 -mb-4 w-full bg-slate-100 p-4 text-sm" v-if="isMovingToEthereum && isProcessing">
    Transfers to Ethereum can take 5-15 minutes to complete. This progress bar only shows the steps to confirm the
    transfer in Hyperbridge. You can follow the rest of the process
    <a
      v-if="moveToEthereumCommitment && hasHyperbridgeProcessedCommitment"
      @click="openHyperbridgeLink"
      class="!text-argon-600 hover:text-argon-800 cursor-pointer font-bold">
      here
    </a>
    <template v-else>
      <a class="!text-argon-600/70 hover:text-argon-800/70 cursor-not-allowed font-bold">here</a>
      once Hyperbridge has confirmed the request.
    </template>
  </div>
  <div class="mt-5 flex flex-row items-start justify-end space-x-2 pt-3">
    <template v-if="isProcessing">
      <div class="w-2/3 flex-grow">
        <ProgressBar :progress="progressPct" :showLabel="true" class="h-7 w-full" />
        <div class="mt-2 text-center font-light text-gray-500">
          {{ progressLabel }}
        </div>
      </div>
      <button @click="close" class="cursor-pointer rounded border border-slate-600/60 px-5 py-1">Close</button>
    </template>
    <template v-else-if="hasTokensToMove">
      <div v-if="canSubmit" class="flex-grow py-1 text-left text-xs text-slate-500">
        Transaction Fee = {{ currency.symbol }}{{ microgonToMoneyNm(txFee).format('0,0.[000000]') }}
      </div>
      <button @click="close" class="cursor-pointer rounded border border-slate-600/60 px-5 py-1">Cancel</button>
      <button
        v-if="canSubmit"
        @click="submitTransfer"
        :disabled="!canSubmit || !canAfford"
        :class="[
          canSubmit && canAfford
            ? 'border-argon-700 bg-argon-600 hover:bg-argon-700 cursor-pointer'
            : 'border-argon-700/50 bg-argon-600/20 hover:bg-argon-700/20 cursor-default',
        ]"
        class="inner-button-shadow rounded border px-7 py-1 font-bold text-white">
        <template v-if="addressWarning">Send Anyway</template>
        <template v-else>Send</template>
      </button>
    </template>
    <template v-else>
      <button
        @click="close"
        class="w-full cursor-pointer rounded border border-slate-600/60 px-5 py-1 focus:outline-none">
        Close
      </button>
    </template>
  </div>
</template>

<script lang="ts">
import { MoveFrom, MoveTo, MoveToken } from '@argonprotocol/apps-core';

const moveFromName = {
  [MoveFrom.MiningHold]: 'Unused Holdings',
  [MoveFrom.MiningBot]: 'Mining Bids',
  [MoveFrom.VaultingHold]: 'Unused Holdings',
  [MoveFrom.VaultingSecurity]: 'Bitcoin Security',
  [MoveFrom.VaultingTreasury]: 'Treasury Bonds',
};

const moveTokenName = {
  [MoveToken.ARGN]: 'Argon',
  [MoveToken.ARGNOT]: 'Argonot',
};

const transactionsShownCompleted = new Set<number>();
</script>

<script setup lang="ts">
import ProgressBar from '../../components/ProgressBar.vue';
import InputMenu from '../../components/InputMenu.vue';
import InputToken from '../../components/InputToken.vue';
import { useMiningAssetBreakdown } from '../../stores/miningAssetBreakdown.ts';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import * as Vue from 'vue';
import { TransactionInfo } from '../../lib/TransactionInfo.ts';
import { IWallet, WalletType } from '../../lib/Wallet.ts';
import { isValidEthereumAddress } from '@argonprotocol/apps-core';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { ExtrinsicType } from '../../lib/db/TransactionsTable.ts';
import {
  getTokenGatewayClient,
  waitForGatewaySyncedToHeight,
} from '@argonprotocol/apps-core/src/TokenGatewayClient.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getWalletKeys, useWallets } from '../../stores/wallets.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { MoveCapital } from '../../lib/MoveCapital.ts';

const props = withDefaults(
  defineProps<{
    class?: string;
    moveFrom?: MoveFrom;
    moveTo?: MoveTo;
    moveToken?: MoveToken;
    isOpen: boolean;
    side?: 'top' | 'right' | 'bottom' | 'left';
  }>(),
  {
    moveFrom: MoveFrom.MiningHold,
    moveToken: MoveToken.ARGN,
  },
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const myVault = getMyVault();
const currency = getCurrency();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const moveCapital = new MoveCapital(walletKeys, transactionTracker, myVault);

const miningBreakdown = useMiningAssetBreakdown();
const vaultingBreakdown = useVaultingAssetBreakdown();

const maxAmount = Vue.computed(() => {
  if (props.moveFrom === MoveFrom.MiningHold && props.moveToken === MoveToken.ARGN) {
    return wallets.miningHoldWallet.availableMicrogons;
  } else if (props.moveFrom === MoveFrom.MiningHold && props.moveToken === MoveToken.ARGNOT) {
    return wallets.miningHoldWallet.availableMicronots;
  } else if (props.moveFrom === MoveFrom.MiningBot && props.moveToken === MoveToken.ARGN) {
    return miningBreakdown.auctionMicrogonsUnused;
  } else if (props.moveFrom === MoveFrom.MiningBot && props.moveToken === MoveToken.ARGNOT) {
    return miningBreakdown.auctionMicronotsUnused;
  } else if (props.moveFrom === MoveFrom.VaultingHold && props.moveToken === MoveToken.ARGN) {
    return vaultingBreakdown.sidelinedMicrogons;
  } else if (props.moveFrom === MoveFrom.VaultingHold && props.moveToken === MoveToken.ARGNOT) {
    return vaultingBreakdown.sidelinedMicronots;
  } else if (props.moveFrom === MoveFrom.VaultingSecurity && props.moveToken === MoveToken.ARGN) {
    return vaultingBreakdown.securityMicrogonsUnused;
  } else if (props.moveFrom === MoveFrom.VaultingSecurity && props.moveToken === MoveToken.ARGNOT) {
    return vaultingBreakdown.securityMicronotsUnused;
  } else if (props.moveFrom === MoveFrom.VaultingTreasury && props.moveToken === MoveToken.ARGN) {
    return vaultingBreakdown.treasuryMicrogonsUnused;
  } else {
    return 0n;
  }
});

const moveOptions = Vue.computed(() => {
  const options = [];
  const walletFrom = moveCapital.getWalletTypeFromMove(moveFrom.value);
  if (walletFrom === WalletType.miningHold) {
    options.push({ name: 'Mining Bids', value: MoveTo.MiningBot });
  } else if (walletFrom === WalletType.miningBot) {
    options.push({ name: 'Unused Holdings', value: MoveTo.MiningHold });
  } else if (moveFrom.value === MoveFrom.VaultingHold) {
    options.push({ name: 'Bitcoin Security', value: MoveTo.VaultingSecurity });
    options.push({ name: 'Treasury Bonds', value: MoveTo.VaultingTreasury });
  } else if (moveFrom.value === MoveFrom.VaultingSecurity) {
    options.push({ name: 'Unused Holdings', value: MoveTo.VaultingHold });
    options.push({ name: 'Treasury Bonds', value: MoveTo.VaultingTreasury });
  } else if (moveFrom.value === MoveFrom.VaultingTreasury) {
    options.push({ name: 'Unused Holdings', value: MoveTo.VaultingHold });
    options.push({ name: 'Bitcoin Security', value: MoveTo.VaultingSecurity });
  }

  if (walletFrom !== WalletType.miningHold && walletFrom !== WalletType.miningBot) {
    options.push({ name: 'Mining Account', value: MoveTo.MiningHold, divider: true });
  } else if ([WalletType.miningHold, WalletType.miningBot].includes(walletFrom)) {
    options.push({ name: 'Vaulting Account', value: MoveTo.VaultingHold });
  }

  options.push({ name: 'External Account', value: MoveTo.External });
  return options;
});

const moveFrom = Vue.ref(props.moveFrom);
const moveTo = Vue.ref<MoveTo>(props.moveTo ?? moveOptions.value[0].value);
const amountToMove = Vue.ref(maxAmount.value);

const externalAddress = Vue.ref('');
const canChangeDestination = Vue.computed(() => !pendingTxInfo.value);
const txFee = Vue.ref(0n);

const isLoaded = Vue.ref(false);
const isProcessing = Vue.ref(false);
const progressPct = Vue.ref(0);
const transactionError = Vue.ref('');
const addressWarning = Vue.ref('');
const isMovingToEthereum = Vue.ref(false);
const isMovingToArgon = Vue.ref(false);
const moveToEthereumCommitment = Vue.ref('');
const comingSoon = Vue.ref('');
const pendingTxInfo = Vue.ref<TransactionInfo | null>(null);
const hasHyperbridgeProcessedCommitment = Vue.ref(false);

const progressLabel = Vue.ref('');

const hasTokensToMove = Vue.computed(() => {
  return maxAmount.value >= 10_000n;
});

const canSubmit = Vue.computed(() => {
  return (
    (amountToMove.value > 10_000n || amountToMove.value <= maxAmount.value) &&
    !isProcessing.value &&
    !pendingTxInfo.value &&
    comingSoon.value === ''
  );
});

const canAfford = Vue.computed(() => {
  const fromWallet = getWalletFrom();
  const isAlreadySpent = [MoveFrom.VaultingSecurity, MoveFrom.VaultingTreasury].includes(moveFrom.value);
  const argonsOnTheMove = props.moveToken === MoveToken.ARGN && !isAlreadySpent ? amountToMove.value : 0n;
  return fromWallet.availableMicrogons >= argonsOnTheMove + txFee.value;
});

function getWalletFrom(): IWallet {
  const walletType = moveCapital.getWalletTypeFromMove(moveFrom.value);
  switch (walletType) {
    case WalletType.miningHold:
      return wallets.miningHoldWallet;
    case WalletType.miningBot:
      return wallets.miningBotWallet;
    case WalletType.vaulting:
      return wallets.vaultingWallet;
    default:
      throw new Error(`WalletType not known: ${walletType}`);
  }
}

function getToAddress() {
  return {
    [MoveTo.MiningHold]: wallets.miningHoldWallet.address,
    [MoveTo.MiningBot]: wallets.miningBotWallet.address,
    [MoveTo.VaultingHold]: wallets.vaultingWallet.address,
    [MoveTo.VaultingSecurity]: wallets.vaultingWallet.address,
    [MoveTo.VaultingTreasury]: wallets.vaultingWallet.address,
    [MoveTo.External]: externalAddress.value || wallets.vaultingWallet.address,
  }[moveTo.value];
}

async function updateMoveAmount(microgons: bigint, tries = 3) {
  if (tries <= 0) {
    amountToMove.value = 0n;
    return;
  }
  amountToMove.value = microgons;
  await updateFee();
  const isMovingArgonToken = props.moveToken === MoveToken.ARGN;

  if (isMovingArgonToken && amountToMove.value + txFee.value > maxAmount.value) {
    const newAmount = maxAmount.value - txFee.value;
    if (newAmount < 0n) {
      amountToMove.value = 0n;
      return;
    }
    await updateMoveAmount(newAmount, tries - 1);
  }
}

async function openHyperbridgeLink() {
  const url = `https://explorer.hyperbridge.network/messages/${moveToEthereumCommitment.value}`;
  await tauriOpenUrl(url);
}

async function updateFee() {
  if (!canSubmit.value) {
    txFee.value = 0n;
    return;
  }
  const fromWallet = getWalletFrom();
  const toAddress = getToAddress();
  const assetsToMove = {
    [MoveToken.ARGN]: props.moveToken === MoveToken.ARGN ? amountToMove.value : 0n,
    [MoveToken.ARGNOT]: props.moveToken === MoveToken.ARGNOT ? amountToMove.value : 0n,
  };
  txFee.value = await moveCapital.calculateFee(moveFrom.value, moveTo.value, assetsToMove, fromWallet, toAddress);
  transactionError.value = moveCapital.transactionError;
}

function checkExternalAddress() {
  const meta = moveCapital.checkAddressType(externalAddress.value || '');
  isMovingToEthereum.value = meta.isEthereumAddress;
  isMovingToArgon.value = meta.isArgonAddress;
  addressWarning.value = meta.addressWarning;
}

async function submitTransfer() {
  const force = addressWarning.value;

  let isMoveToEthereum = false;
  if (moveTo.value === MoveTo.External) {
    checkExternalAddress();
    const isEthereumAddress = isValidEthereumAddress(externalAddress.value);
    isMoveToEthereum = isEthereumAddress.valid;
    if (!force && !isEthereumAddress.checksum) {
      return;
    }
  }

  // ensure fee is up to date
  await updateFee();
  if (transactionError.value) {
    return;
  }

  try {
    isProcessing.value = true;
    transactionError.value = '';
    progressLabel.value = 'Preparing Transaction...';
    progressPct.value = 0;

    const fromWallet = getWalletFrom();
    const toAddress = getToAddress();
    const assetsToMove = {
      [MoveToken.ARGN]: props.moveToken === MoveToken.ARGN ? amountToMove.value : 0n,
      [MoveToken.ARGNOT]: props.moveToken === MoveToken.ARGNOT ? amountToMove.value : 0n,
    };
    const txInfo = await moveCapital.move(moveFrom.value, moveTo.value, assetsToMove, fromWallet, toAddress);

    if (moveTo.value === MoveTo.External && isMoveToEthereum) {
      void watchTeleport(txInfo);
    }

    trackTxInfo(txInfo);
    pendingTxInfo.value = txInfo;
  } catch (err) {
    console.error('Error during transfer: %o', err);
    transactionError.value = 'This transfer failed, please try again';
    isProcessing.value = false;
  }
}

async function watchTeleport(txInfo: TransactionInfo) {
  hasHyperbridgeProcessedCommitment.value = false;
  await txInfo.txResult.waitForFinalizedBlock;
  const client = await getMainchainClient(false);

  for (const event of txInfo.txResult.events) {
    if (client.events.tokenGateway.AssetTeleported.is(event)) {
      const { commitment } = event.data;
      moveToEthereumCommitment.value = commitment.toHex();
      break;
    }
  }

  tokenGatewayClient ??= await getTokenGatewayClient();
  const result = await waitForGatewaySyncedToHeight({
    gatewayClient: tokenGatewayClient,
    targetHeight: txInfo.txResult.blockNumber!,
    onProgress(progress) {
      if (progress < 100) {
        progressLabel.value = `Waiting for Hyperbridge to confirm request.`;
        progressPct.value = 50 + progress / 2;
      } else {
        progressLabel.value = `Hyperbridge has confirmed the request.`;
        progressPct.value = 100;
      }
    },
  });
  blockWatchUnsubscribe = result.unsubscribe;
  await result.complete;
  hasHyperbridgeProcessedCommitment.value = true;
}

let blockWatchUnsubscribe: (() => void) | null = null;
let tokenGatewayClient: Awaited<ReturnType<typeof getTokenGatewayClient>> | undefined;

function trackTxInfo(txInfo: TransactionInfo) {
  txInfo.subscribeToProgress(async (args, error) => {
    if (isMovingToEthereum.value) {
      progressLabel.value = `Submitted to Argon Miners: ${args.progressMessage}`;
      progressPct.value = args.progressPct / 2;
    } else {
      progressLabel.value = args.progressMessage;
      progressPct.value = args.progressPct;
    }
    if (args.progressPct === 100 && error) {
      isProcessing.value = false;
      pendingTxInfo.value = null;
      transactionError.value = error.message;
      console.error('Error during transfer: %o', error);
    }
  });
}

function close() {
  emit('close');
  if (pendingTxInfo.value && pendingTxInfo.value.txResult.isFinalized) {
    transactionsShownCompleted.add(pendingTxInfo.value.tx.id);
  }
}

Vue.watch(externalAddress, async () => {
  checkExternalAddress();
  await updateFee();
});

Vue.watch(maxAmount, async newMax => {
  if (pendingTxInfo.value) return;
  if (amountToMove.value > newMax) {
    await updateMoveAmount(newMax);
  }
});

Vue.watch(
  () => props.isOpen,
  async () => {
    if (props.isOpen) {
      isLoaded.value = false;
      await updateMoveAmount(maxAmount.value);
      if (moveFrom.value === MoveFrom.VaultingTreasury && maxAmount.value > 10_000n) {
        comingSoon.value = 'Withdrawing from treasury will be in a near-future release';
        isLoaded.value = true;
        return;
      }

      const pendingTx = pendingTxInfo.value;
      if (!pendingTx || (pendingTx.isPostProcessed && pendingTx.txResult.isFinalized)) {
        isProcessing.value = false;
        progressPct.value = 0;
        progressLabel.value = '';
        pendingTxInfo.value = null;
        transactionError.value = '';
      }
      isLoaded.value = true;
    }
  },
);

Vue.watch(moveTo, async () => {
  await updateFee();
});

Vue.onMounted(async () => {
  await transactionTracker.load();
  for (const txInfo of transactionTracker.pendingBlockTxInfosAtLoad) {
    if (transactionsShownCompleted.has(txInfo.tx.id)) {
      continue;
    }
    if (txInfo.tx.extrinsicType === ExtrinsicType.Transfer && txInfo.tx.metadataJson.moveFrom === props.moveFrom) {
      pendingTxInfo.value = txInfo;
      isProcessing.value = true;
      amountToMove.value = txInfo.tx.metadataJson.amount;
      moveTo.value = txInfo.tx.metadataJson.moveTo;
      externalAddress.value = txInfo.tx.metadataJson.externalAddress || '';
      checkExternalAddress();
      console.log('Resuming pending transfer: %o', txInfo, isMovingToEthereum.value);

      if (txInfo.tx.metadataJson.moveTo === MoveTo.External && isMovingToEthereum.value) {
        void watchTeleport(txInfo);
      }
      trackTxInfo(txInfo);
      break;
    }
  }
});

Vue.onUnmounted(async () => {
  if (blockWatchUnsubscribe) {
    blockWatchUnsubscribe();
    blockWatchUnsubscribe = null;
  }
  tokenGatewayClient?.disconnect();
});
</script>
