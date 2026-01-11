<!-- prettier-ignore -->
<template>
  <div v-if="!isProcessing" class="flex flex-col justify-between">
    <div v-if="!hasTokensToMove" class="text-red-500 flex flex-row items-center border-b border-slate-400/20 pb-3">
      <AlertIcon class="w-5 mr-2" />
      <div></div>
      There are no
      {{ (moveTokenName[moveToken || ''] || '').toLowerCase() }}s to move from {{ moveFromName[moveFrom].toLowerCase() }}.
    </div>
    <form :class="!hasTokensToMove && !showInputMenus ? 'opacity-50 pointer-events-none' : ''">
      <div class="mt-3 flex flex-row items-end space-x-2">
        <div class="grow">
          <div class="mb-1">Move From</div>
          <InputMenu
            v-if="showInputMenus"
            v-model="moveFrom"
            @change="updatedMoveFrom"
            :options="moveFromOptions"
            :selectFirst="true"
            class="w-full"
          />
          <div v-else class="rounded-md border border-dashed border-slate-900/70 px-2 py-1 font-mono">
            {{ moveFromName[moveFrom] }}
          </div>
        </div>
        <div class="grow">
          <div class="mb-1">Amount</div>
          <InputToken
            v-model="amountToMove"
            @change="updatedAmountToMove"
            :min="0n"
            :max="maxAmountToMove"
            :suffix="showInputMenus ? '' : ` ${moveToken}`"
            :disabled="pendingTxInfo !== null || !canSubmit"
            class="w-full"
          />
        </div>
        <div v-if="showInputMenus">
          <InputMenu
            v-model="moveToken"
            @change="updatedMoveToken"
            :options="moveTokenOptions"
            :selectFirst="true"
          />
        </div>
      </div>

      <div class="mt-3 mb-1">Move To</div>
      <InputMenu v-if="canChangeDestination" v-model="moveTo" :options="moveToOptions" :selectFirst="true" class="w-full" />
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
    </form>
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
  <div class="mt-5  text-md">
    <div v-if="isProcessing" class="flex flex-row items-start justify-end space-x-2">
      <div class="w-2/3 flex-grow pr-1">
        <ProgressBar :progress="progressPct" :showLabel="true" class="h-7 w-full" />
        <div class="mt-2 text-center font-light text-gray-500">
          {{ progressLabel }}
        </div>
      </div>
      <button @click="close" class="cursor-pointer rounded-md border border-slate-600/60 px-5 py-1">Close</button>
    </div>
    <div v-else-if="hasTokensToMove || showInputMenus" class="flex flex-row items-center justify-end space-x-2 pt-3 border-t border-slate-400/20">
      <div v-if="canSubmit && hasTokensToMove" class="flex-grow py-1 text-left text-xs text-slate-500">
        Transaction Fee = {{ currency.symbol }}{{ microgonToMoneyNm(txFee).format('0,0.[000000]') }}
      </div>
      <button @click="close" class="cursor-pointer rounded-md border border-slate-600/60 px-7 py-1.5">Cancel</button>
      <button
        v-if="canSubmit"
        @click="submitTransfer"
        :class="[
          !canSubmit || !canAfford || !hasTokensToMove
            ? 'border-argon-700/50 bg-argon-600/20 cursor-default pointer-events-none opacity-50'
            : 'border-argon-700 bg-argon-600 hover:bg-argon-700 cursor-pointer'
        ]"
        class="inner-button-shadow rounded-md border px-10 py-1.5 font-bold text-white"
      >
        <template v-if="addressWarning">Send Anyway</template>
        <template v-else>Send</template>
      </button>
    </div>
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
import { bigIntMax, isValidEthereumAddress } from '@argonprotocol/apps-core';
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
import AlertIcon from '../../assets/alert.svg?component';

const props = withDefaults(
  defineProps<{
    class?: string;
    walletType?: WalletType.miningHold | WalletType.vaulting;
    moveFrom?: MoveFrom;
    showInputMenus?: boolean;
    moveTo?: MoveTo;
    moveToken?: MoveToken;
    isOpen: boolean;
    side?: 'top' | 'right' | 'bottom' | 'left';
  }>(),
  {
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

const moveFrom = Vue.ref(
  props.moveFrom || (props.walletType === WalletType.vaulting ? MoveFrom.VaultingHold : MoveFrom.MiningHold),
);
const moveToken = Vue.ref(props.moveToken);
const amountToMove = Vue.ref<bigint>(0n);

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
  return maxAmountToMove.value >= 10_000n;
});

const maxAmountToMove = Vue.computed(() => {
  let max = 0n;

  if (moveFrom.value === MoveFrom.MiningHold) {
    if (moveToken.value === MoveToken.ARGN) {
      max = wallets.miningHoldWallet.availableMicrogons;
    } else if (moveToken.value === MoveToken.ARGNOT) {
      max = wallets.miningHoldWallet.availableMicronots;
    }
  } else if (moveFrom.value === MoveFrom.MiningBot) {
    if (moveToken.value === MoveToken.ARGN) {
      max = miningBreakdown.auctionMicrogonsUnused;
    } else if (moveToken.value === MoveToken.ARGNOT) {
      max = miningBreakdown.auctionMicronotsUnused;
    }
  } else if (moveFrom.value === MoveFrom.VaultingHold) {
    if (moveToken.value === MoveToken.ARGN) {
      max = vaultingBreakdown.sidelinedMicrogons;
    } else if (moveToken.value === MoveToken.ARGNOT) {
      max = vaultingBreakdown.sidelinedMicronots;
    }
  } else if (moveFrom.value === MoveFrom.VaultingSecurity) {
    if (moveToken.value === MoveToken.ARGN) {
      max = vaultingBreakdown.securityMicrogonsUnused;
    } else if (moveToken.value === MoveToken.ARGNOT) {
      max = vaultingBreakdown.securityMicronotsUnused;
    }
  } else if (moveFrom.value === MoveFrom.VaultingTreasury) {
    if (moveToken.value === MoveToken.ARGN) {
      max = vaultingBreakdown.treasuryMicrogonsUnused;
    }
  }

  return max;
});

const moveFromOptions = Vue.computed(() => {
  if (props.walletType === WalletType.miningHold) {
    return [
      { name: 'Unused Holdings', value: MoveFrom.MiningHold },
      { name: 'Mining Bids', value: MoveFrom.MiningBot },
    ];
  } else if (props.walletType === WalletType.vaulting) {
    return [
      { name: 'Unused Holdings', value: MoveFrom.VaultingHold },
      { name: 'Bitcoin Security', value: MoveFrom.VaultingSecurity },
      { name: 'Treasury Bonds', value: MoveFrom.VaultingTreasury },
    ];
  }
  return [];
});

const moveTokenOptions = Vue.computed(() => {
  const hasArgonots = [
    MoveFrom.MiningHold,
    MoveFrom.MiningBot,
    MoveFrom.VaultingHold,
    MoveFrom.VaultingSecurity,
  ].includes(moveFrom.value);
  const options = [{ name: MoveToken.ARGN, value: MoveToken.ARGN }];
  if (hasArgonots) {
    options.push({ name: MoveToken.ARGNOT, value: MoveToken.ARGNOT });
  }
  return options;
});

const moveToOptions = Vue.computed(() => {
  const options = [];
  const walletFrom = moveCapital.getWalletTypeFromMove(moveFrom.value!);
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

const canSubmit = Vue.computed(() => {
  return (
    (amountToMove.value > 10_000n || amountToMove.value <= maxAmountToMove.value) &&
    !isProcessing.value &&
    !pendingTxInfo.value &&
    comingSoon.value === ''
  );
});

const canAfford = Vue.computed(() => {
  const fromWallet = getWalletFrom();
  const isAlreadySpent = [MoveFrom.VaultingSecurity, MoveFrom.VaultingTreasury].includes(moveFrom.value);
  const argonsOnTheMove = moveToken.value === MoveToken.ARGN && !isAlreadySpent ? amountToMove.value : 0n;
  return fromWallet.availableMicrogons >= argonsOnTheMove + txFee.value;
});

const moveTo = Vue.ref<MoveTo>(props.moveTo ?? moveToOptions.value[0].value);

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

async function updatedAmountToMove(microgons: bigint, tries = 3) {
  if (tries <= 0) {
    amountToMove.value = 0n;
    return;
  }
  amountToMove.value = microgons;
  await updateFee();
  const isMovingArgonToken = moveToken.value === MoveToken.ARGN;

  if (isMovingArgonToken && amountToMove.value + txFee.value > maxAmountToMove.value) {
    const newAmount = maxAmountToMove.value - txFee.value;
    if (newAmount < 0n) {
      amountToMove.value = 0n;
      return;
    }
    await updatedAmountToMove(newAmount, tries - 1);
  }
}

async function updatedMoveFrom() {
  await updatedAmountToMove(maxAmountToMove.value);
}

async function updatedMoveToken() {
  await updatedAmountToMove(maxAmountToMove.value);
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
    [MoveToken.ARGN]: moveToken.value === MoveToken.ARGN ? amountToMove.value : 0n,
    [MoveToken.ARGNOT]: moveToken.value === MoveToken.ARGNOT ? amountToMove.value : 0n,
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
  const hasAddressWarning = !!addressWarning.value;

  let isMoveToEthereum = false;
  if (moveTo.value === MoveTo.External) {
    checkExternalAddress();
    const isEthereumAddress = isValidEthereumAddress(externalAddress.value);
    isMoveToEthereum = isEthereumAddress.valid;
    if (hasAddressWarning && !isEthereumAddress.checksum) {
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
      [MoveToken.ARGN]: moveToken.value === MoveToken.ARGN ? amountToMove.value : 0n,
      [MoveToken.ARGNOT]: moveToken.value === MoveToken.ARGNOT ? amountToMove.value : 0n,
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

Vue.watch(maxAmountToMove, async newMax => {
  if (pendingTxInfo.value) return;
  if (amountToMove.value > newMax) {
    await updatedAmountToMove(newMax);
  }
});

Vue.watch(
  () => props.isOpen,
  async () => {
    if (props.isOpen) {
      isLoaded.value = false;
      await updatedAmountToMove(maxAmountToMove.value);
      if (moveFrom.value === MoveFrom.VaultingTreasury && maxAmountToMove.value > 10_000n) {
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
  { immediate: true },
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
    if (txInfo.tx.extrinsicType === ExtrinsicType.Transfer && txInfo.tx.metadataJson.moveFrom === moveFrom.value) {
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
