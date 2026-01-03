<template>
  <div v-if="!hasTokensToMove && !isProcessing" class="flex flex-col">
    <div class="text-gray-500">
      There are no {{ moveFromOption[moveFrom].token.toLowerCase() }}s ready to move from
      {{ moveFromOption[moveFrom].name }}.
    </div>
  </div>

  <div v-else-if="!isProcessing" class="flex flex-col justify-between">
    <div class="mt-3 flex flex-row items-start space-x-2">
      <div class="grow">
        <div class="mb-1">Move From</div>
        <div class="rounded-md border border-dashed border-slate-900/70 px-2 py-1 font-mono">
          {{ moveFromOption[moveFrom].name }}
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
          :suffix="` ${moveFromOption[moveFrom].tokenSymbol}`"
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
      <div v-if="addressWarn" class="mt-5 w-full rounded-md border p-2 text-yellow-600">
        {{ addressWarn }}
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
      <button @click="cancel" class="cursor-pointer rounded border border-slate-600/60 px-5 py-1">Close</button>
    </template>
    <template v-else-if="hasTokensToMove">
      <div v-if="canSubmit" class="flex-grow py-1 text-left text-xs text-slate-500">
        Transaction Fee = {{ currency.symbol }}{{ microgonToMoneyNm(txFee).format('0,0.[000000]') }}
      </div>
      <button @click="cancel" class="cursor-pointer rounded border border-slate-600/60 px-5 py-1">Cancel</button>
      <button
        v-if="canSubmit"
        @click="submitTransfer(!addressWarn)"
        :disabled="!canSubmit || !canAfford"
        :class="[
          canSubmit && canAfford
            ? 'border-argon-700 bg-argon-600 hover:bg-argon-700 cursor-pointer'
            : 'border-argon-700/50 bg-argon-600/20 hover:bg-argon-700/20 cursor-default',
        ]"
        class="inner-button-shadow rounded border px-7 py-1 font-bold text-white">
        <template v-if="addressWarn">Send Anyway</template>
        <template v-else>Send</template>
      </button>
    </template>
    <template v-else>
      <button
        @click="cancel"
        class="w-full cursor-pointer rounded border border-slate-600/60 px-5 py-1 focus:outline-none">
        Close
      </button>
    </template>
  </div>
</template>

<script lang="ts">
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core';

export enum TokenSymbol {
  ARGN = 'ARGN',
  ARGNOT = 'ARGNOT',
}

export enum TokenName {
  Argon = 'Argon',
  Argonot = 'Argonot',
}

const moveFromOption = {
  [MoveFrom.MiningSidelinedArgon]: { name: 'Unused Holdings', tokenSymbol: TokenSymbol.ARGN, token: TokenName.Argon },
  [MoveFrom.MiningSidelinedArgonot]: {
    name: 'Unused Holdings',
    tokenSymbol: TokenSymbol.ARGNOT,
    token: TokenName.Argonot,
  },
  [MoveFrom.MiningAuctionArgon]: { name: 'Bidding Bot', tokenSymbol: TokenSymbol.ARGN, token: TokenName.Argon },
  [MoveFrom.MiningAuctionArgonot]: { name: 'Bidding Bot', tokenSymbol: TokenSymbol.ARGNOT, token: TokenName.Argonot },

  [MoveFrom.VaultingSidelinedArgon]: { name: 'Unused Holdings', tokenSymbol: TokenSymbol.ARGN, token: TokenName.Argon },
  [MoveFrom.VaultingSidelinedArgonot]: {
    name: 'Unused Holdings',
    tokenSymbol: TokenSymbol.ARGNOT,
    token: TokenName.Argonot,
  },
  [MoveFrom.VaultingSecurityArgon]: { name: 'Bitcoin Security', tokenSymbol: TokenSymbol.ARGN, token: TokenName.Argon },
  [MoveFrom.VaultingSecurityArgonot]: {
    name: 'Bitcoin Security',
    tokenSymbol: TokenSymbol.ARGNOT,
    token: TokenName.Argonot,
  },
  [MoveFrom.VaultingTreasuryArgon]: { name: 'Treasury Bonds', tokenSymbol: TokenSymbol.ARGN, token: TokenName.Argon },
};
</script>

<script setup lang="ts">
import ProgressBar from '../../components/ProgressBar.vue';
import InputMenu from '../../components/InputMenu.vue';
import InputToken from '../../components/InputToken.vue';
import { useMiningAssetBreakdown } from '../../stores/miningAssetBreakdown.ts';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import * as Vue from 'vue';
import { TransactionInfo } from '../../lib/TransactionInfo.ts';
import { IWallet } from '../../lib/Wallet.ts';
import { ethAddressToH256, isValidArgonAccountAddress, isValidEthereumAddress } from '@argonprotocol/apps-core';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { getMainchainClient } from '../../stores/mainchain.ts';
import { FIXED_U128_DECIMALS, SubmittableExtrinsic, toFixedNumber } from '@argonprotocol/mainchain';
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

const props = withDefaults(
  defineProps<{
    class?: string;
    moveFrom?: MoveFrom;
    moveTo?: MoveTo;
    isOpen: boolean;
    side?: 'top' | 'right' | 'bottom' | 'left';
  }>(),
  {
    moveFrom: MoveFrom.MiningSidelinedArgon,
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

const miningBreakdown = useMiningAssetBreakdown();
const vaultingBreakdown = useVaultingAssetBreakdown();

const maxAmount = Vue.computed(() => {
  switch (props.moveFrom) {
    case MoveFrom.MiningSidelinedArgon:
      return wallets.miningWallet.availableMicrogons;
    case MoveFrom.MiningSidelinedArgonot:
      return wallets.miningWallet.availableMicronots;

    case MoveFrom.MiningAuctionArgon:
      return miningBreakdown.auctionMicrogonsUnused;
    case MoveFrom.MiningAuctionArgonot:
      return miningBreakdown.auctionMicronotsUnused;

    case MoveFrom.VaultingSidelinedArgon:
      return vaultingBreakdown.sidelinedMicrogons;
    case MoveFrom.VaultingSidelinedArgonot:
      return vaultingBreakdown.sidelinedMicronots;

    case MoveFrom.VaultingSecurityArgon:
      return vaultingBreakdown.securityMicrogonsUnused;
    case MoveFrom.VaultingSecurityArgonot:
      return vaultingBreakdown.securityMicronotsUnused;

    case MoveFrom.VaultingTreasuryArgon:
      return vaultingBreakdown.treasuryMicrogonsUnused;
    default:
      return 0n;
  }
});

const moveOptions = Vue.computed(() => {
  const options = [];
  const walletFrom = getWalletFromType();
  if (walletFrom === 'Vaulting') {
    options.push({ name: 'Bitcoin Security', value: MoveTo.VaultingSecurity });
    options.push({ name: 'Treasury Bonds', value: MoveTo.VaultingTreasury });
  } else if (walletFrom === 'Mining') {
    options.push({ name: 'Bidding Bot', value: MoveTo.MiningBot });
  } else if (walletFrom === 'MiningBot') {
    options.push({ name: 'Unused Holdings', value: MoveTo.Mining });
  }
  if (walletFrom !== 'Mining' && walletFrom !== 'MiningBot') {
    options.push({ name: 'Mining Account', value: MoveTo.Mining });
  }
  if (walletFrom !== 'Vaulting' && isMovingArgons()) {
    options.push({ name: 'Vaulting Account', value: MoveTo.Vaulting });
  }
  options.push({ name: 'External Account', value: MoveTo.External });
  return options;
});

const moveFrom = Vue.ref(props.moveFrom);
const moveTo = Vue.ref<MoveTo>(props.moveTo ?? moveOptions.value[0].value);
const externalAddress = Vue.ref('');
const canChangeDestination = Vue.computed(() => !pendingTxInfo.value);
const txFee = Vue.ref(0n);

const isLoaded = Vue.ref(false);
const isProcessing = Vue.ref(false);
const progressPct = Vue.ref(0);
const transactionError = Vue.ref('');
const addressWarn = Vue.ref('');
const isMovingToEthereum = Vue.ref(false);
const isMovingToArgon = Vue.ref(false);
const moveToEthereumCommitment = Vue.ref('');
const comingSoon = Vue.ref('');
const pendingTxInfo = Vue.ref<TransactionInfo | null>(null);
const hasHyperbridgeProcessedCommitment = Vue.ref(false);

const hasTokensToMove = Vue.computed(() => {
  return maxAmount.value >= 10_000n;
});

const progressLabel = Vue.ref('');

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
  const isAlreadySpent = [MoveFrom.VaultingSecurityArgon, MoveFrom.VaultingTreasuryArgon].includes(moveFrom.value);
  const argonsOnTheMove = isMovingArgons() && !isAlreadySpent ? amountToMove.value : 0n;
  return fromWallet.availableMicrogons >= argonsOnTheMove + txFee.value;
});

const amountToMove = Vue.ref(maxAmount.value);

function getWalletFrom(): IWallet {
  switch (getWalletFromType()) {
    case 'Mining':
      return wallets.miningWallet;
    case 'MiningBot':
      return wallets.miningBotWallet;
    case 'Vaulting':
      return wallets.vaultingWallet;
  }
}

function getWalletFromType(): 'Mining' | 'MiningBot' | 'Vaulting' {
  switch (moveFrom.value) {
    case MoveFrom.MiningSidelinedArgon:
    case MoveFrom.MiningSidelinedArgonot:
      return 'Mining';

    case MoveFrom.MiningAuctionArgon:
    case MoveFrom.MiningAuctionArgonot:
      return 'MiningBot';

    case MoveFrom.VaultingSidelinedArgon:
    case MoveFrom.VaultingSidelinedArgonot:
    case MoveFrom.VaultingSecurityArgon:
    case MoveFrom.VaultingSecurityArgonot:
    case MoveFrom.VaultingTreasuryArgon:
      return 'Vaulting';

    default:
      throw new Error(`Unknown wallet type from getWalletFromType(): ${moveFrom.value}`);
  }
}

async function getSigner() {
  switch (getWalletFromType()) {
    case 'Mining':
      return await walletKeys.getMiningKeypair();
    case 'MiningBot':
      return await walletKeys.getMiningBotKeypair();
    case 'Vaulting':
      return await walletKeys.getVaultingKeypair();
  }
}

function isMovingArgons(): boolean {
  return ![
    MoveFrom.MiningSidelinedArgonot,
    MoveFrom.MiningAuctionArgonot,
    MoveFrom.VaultingSidelinedArgonot,
    MoveFrom.VaultingSecurityArgonot,
  ].includes(moveFrom.value!);
}

async function checkExternalAddress() {
  isMovingToEthereum.value = false;
  isMovingToArgon.value = false;
  addressWarn.value = '';

  const trimmedAddress = externalAddress.value.trim();
  if (!trimmedAddress) {
    return;
  }

  isMovingToArgon.value = isValidArgonAccountAddress(trimmedAddress);
  const ethereumAddressValidation = isValidEthereumAddress(trimmedAddress);
  isMovingToEthereum.value = ethereumAddressValidation.valid;

  if (ethereumAddressValidation.valid) {
    addressWarn.value = ethereumAddressValidation.checksum
      ? ''
      : "Warning: Ethereum address can't be validated - use a check-summed address to be safer.";
  } else if (!isMovingToArgon.value) {
    addressWarn.value = 'The address entered is not a valid Argon or Ethereum address.';
  }
}

async function updateMoveAmount(microgons: bigint, tries = 3) {
  if (tries <= 0) {
    amountToMove.value = 0n;
    return;
  }
  amountToMove.value = microgons;
  await updateFee();
  if (isMovingArgons() && amountToMove.value + txFee.value > maxAmount.value) {
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

async function buildTransaction(useExternalAddressPlaceHolder = false) {
  const client = await getMainchainClient(false);

  const toAddress = {
    [MoveTo.Mining]: wallets.miningWallet.address,
    [MoveTo.MiningBot]: wallets.miningBotWallet.address,
    [MoveTo.Vaulting]: wallets.vaultingWallet.address,
    [MoveTo.VaultingSecurity]: wallets.vaultingWallet.address,
    [MoveTo.VaultingTreasury]: wallets.vaultingWallet.address,
    [MoveTo.External]: externalAddress.value || (useExternalAddressPlaceHolder ? wallets.vaultingWallet.address : ''),
  }[moveTo.value];

  const txs: SubmittableExtrinsic[] = [];
  /// 1. Reduce funding / withdraw from vaulting as needed
  if (moveFrom.value === MoveFrom.VaultingSecurityArgon) {
    const vault = myVault.createdVault;
    if (!vault) {
      throw new Error('No vault created');
    }
    if (vault.securitization < amountToMove.value) {
      throw new Error('Not enough securitization available to withdraw');
    }

    txs.push(
      client.tx.vaults.modifyFunding(
        vault.vaultId,
        vault.securitization - amountToMove.value,
        toFixedNumber(vault.securitizationRatio, FIXED_U128_DECIMALS),
      ),
    );
  } else if (moveFrom.value === MoveFrom.VaultingTreasuryArgon) {
    console.warn('Withdrawing from treasury is not yet supported');
  }

  /// 2. Transfer the argons / argonots
  const ARGON_ASSET_ID = 0;
  const ARGONOT_ASSET_ID = 1;
  await checkExternalAddress();
  if (isMovingToEthereum.value) {
    const assetId = isMovingArgons() ? ARGON_ASSET_ID : ARGONOT_ASSET_ID;
    const recipient = ethAddressToH256(toAddress);
    txs.push(
      client.tx.tokenGateway.teleport({
        assetId,
        destination: { Evm: 1 },
        recepient: recipient, // NOTE: field name 'recepient' is misspelled in the on-chain API and must remain as-is
        timeout: 0,
        relayerFee: 0n,
        amount: amountToMove.value,
        redeem: false,
        tokenGateway: '0xFd413e3AFe560182C4471F4d143A96d3e259B6dE',
      }),
    );
  } else if (isMovingArgons()) {
    txs.push(client.tx.balances.transferAllowDeath(toAddress, amountToMove.value));
  } else {
    txs.push(client.tx.ownership.transferAllowDeath(toAddress, amountToMove.value));
  }

  const metadata = {
    moveTo: moveTo.value,
    moveFrom: moveFrom.value,
    externalAddress: moveTo.value === MoveTo.External ? toAddress : undefined,
    isMovingToEthereum: isMovingToEthereum.value,
    amount: amountToMove.value,
    utxoId: myVault.metadata?.personalUtxoId,
  };

  const tx = txs.length === 1 ? txs[0] : client.tx.utility.batch(txs);
  return { tx, metadata };
}

async function updateFee() {
  try {
    if (!canSubmit.value) {
      txFee.value = 0n;
      return;
    }
    const { tx } = await buildTransaction(true);
    const fromWallet = getWalletFrom();
    const fee = await tx.paymentInfo(fromWallet.address);
    txFee.value = fee.partialFee.toBigInt();
    if (txFee.value > fromWallet.availableMicrogons) {
      transactionError.value = `Your wallet has insufficient funds for this transaction.`;
    } else {
      transactionError.value = '';
    }
  } catch (err) {
    console.error('Error calculating transaction fee: %o', err);
    txFee.value = 0n;
  }
}

async function submitTransfer(force = false) {
  let isMoveToEthereum = false;
  if (moveTo.value === MoveTo.External) {
    await checkExternalAddress();
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

    if ([MoveTo.VaultingSecurity, MoveTo.VaultingTreasury].includes(moveTo.value)) {
      const allocations = {
        addedSecuritizationMicrogons: 0n,
        addedTreasuryMicrogons: 0n,
      };
      if (moveTo.value === MoveTo.VaultingSecurity) {
        allocations.addedSecuritizationMicrogons = amountToMove.value;
      } else if (moveTo.value === MoveTo.VaultingTreasury) {
        allocations.addedTreasuryMicrogons = amountToMove.value;
      }
      const txInfo = await myVault.increaseVaultAllocations(allocations);
      trackTxInfo(txInfo);
      pendingTxInfo.value = txInfo;
    } else {
      const { tx, metadata } = await buildTransaction();
      const signer = await getSigner();
      const txInfo = await transactionTracker.submitAndWatch({
        tx,
        signer,
        metadata,
        extrinsicType: ExtrinsicType.Transfer,
      });

      if (metadata.moveTo === MoveTo.External && isMoveToEthereum) {
        void watchTeleport(txInfo);
      }

      trackTxInfo(txInfo);
      pendingTxInfo.value = txInfo;
    }
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

function cancel() {
  emit('close');
}

Vue.watch(externalAddress, async () => {
  await checkExternalAddress();
  await updateFee();
});

Vue.watch(maxAmount, async newMax => {
  if (pendingTxInfo.value) {
    return;
  }
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
      if (moveFrom.value === MoveFrom.VaultingTreasuryArgon && maxAmount.value > 10_000n) {
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
    if (txInfo.tx.extrinsicType === ExtrinsicType.Transfer && txInfo.tx.metadataJson.moveFrom === props.moveFrom) {
      pendingTxInfo.value = txInfo;
      isProcessing.value = true;
      amountToMove.value = txInfo.tx.metadataJson.amount;
      moveTo.value = txInfo.tx.metadataJson.moveTo;
      externalAddress.value = txInfo.tx.metadataJson.externalAddress;
      await checkExternalAddress();
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
