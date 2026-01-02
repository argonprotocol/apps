<template>
  <PopoverRoot v-model:open="isOpen">
    <PopoverTrigger>
      <button
        :class="
          twMerge('border-argon-600/50 text-argon-600/80 cursor-pointer rounded border px-3 font-bold', props.class)
        ">
        Move
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :sideOffset="-5"
        class="border-argon-600/30 z-50 max-w-[500px] rounded-md border bg-white px-6 py-4 text-sm font-medium text-gray-700 shadow-2xl">
        <div v-if="maxAmount < 10_000n && !isProcessing" class="flex flex-col">
          <div class="text-center text-gray-500">
            There are no funds to move from
            <template v-if="moveFromTitle[moveFrom].includes('Account')">your</template>
            <span class="font-bold">&nbsp;{{ moveFromTitle[moveFrom] }}.</span>
          </div>
        </div>
        <div v-else class="flex flex-col justify-between">
          <p class="mb-4">Choose how much you want to move and where to move it.</p>

          <div class="mt-3 flex flex-row items-start space-x-2">
            <div class="grow">
              <div>Move From</div>
              <div class="rounded-md border border-dashed border-slate-900/70 px-2 py-1 font-mono">
                {{ moveFromTitle[moveFrom] }}
              </div>
            </div>
            <div class="grow">
              <div>Amount</div>
              <InputArgon
                :min="0n"
                v-model="amountToMove"
                @update:modelValue="updateMoveAmount"
                class="w-full"
                :max="maxAmount"
                :disabled="pendingTxInfo !== null || !canSubmit" />
            </div>
          </div>

          <div class="mt-3">Move To</div>
          <InputMenu
            v-if="canChangeDestination"
            v-model="moveTo"
            :options="moveOptions"
            :selectFirst="true"
            class="w-full" />
          <div class="rounded-md border border-dashed border-slate-900/70 px-2 py-1 font-mono" v-else>
            {{ moveTo }} Account
          </div>
          <input
            v-if="moveTo === MoveTo.External"
            v-model="externalAddress"
            :disabled="pendingTxInfo !== null"
            type="text"
            class="mt-3 w-full rounded-md border border-slate-900/40 px-2 py-1.5 font-mono"
            placeholder="Address of Account" />
          <template v-else-if="moveTo === MoveTo.Vaulting && config.isVaultActivated">
            <div class="mt-5 flex flex-col gap-y-2 border-t border-dashed border-slate-600/30 pt-3">
              <p class="mb-2">
                You'll need to split these argons between bitcoin security and treasury bonds. We've set initial amounts
                based on your current config values, however, you can adjust below.
              </p>

              <VaultAllocation ref="vaultAllocation" :microgons-to-activate="amountToMove" />
            </div>
          </template>
        </div>
        <div
          v-if="transactionError"
          class="mt-5 min-h-5 w-full rounded-md border border-red-200 bg-red-50 p-2 text-red-600">
          <strong>Error</strong>
          {{ transactionError }}
        </div>
        <div
          v-else-if="!isProcessing && !canAfford && amountToMove > 10_000n"
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
        <div class="mt-5 flex flex-row items-start justify-end space-x-2 border-t border-slate-600/30 pt-3">
          <template v-if="isProcessing">
            <div class="w-2/3 flex-grow">
              <ProgressBar :progress="progressPct" :showLabel="true" class="h-7 w-full" />
              <div class="mt-2 text-center font-light text-gray-500">
                {{ progressLabel }}
              </div>
            </div>
            <button @click="cancel" class="cursor-pointer rounded border border-slate-600/60 px-5 py-1">Close</button>
          </template>
          <template v-else>
            <div class="flex-grow py-1 text-left text-xs text-slate-500" v-if="canSubmit">
              Transaction Fee = {{ currency.symbol }}{{ microgonToMoneyNm(txFee).format('0,0.[000000]') }}
            </div>
            <button @click="cancel" class="cursor-pointer rounded border border-slate-600/60 px-5 py-1">Cancel</button>
            <button
              @click="transfer"
              v-if="canSubmit"
              :disabled="!canSubmit || !canAfford"
              :class="[
                canSubmit && canAfford
                  ? 'border-argon-700 bg-argon-600 hover:bg-argon-700 cursor-pointer'
                  : 'border-argon-700/50 bg-argon-600/20 hover:bg-argon-700/20 cursor-default',
              ]"
              class="inner-button-shadow rounded border px-7 py-1 font-bold text-white">
              Send
            </button>
          </template>
        </div>
        <PopoverArrow :width="26" :height="12" class="stroke-argon-600/30 -mt-px fill-white" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script lang="ts">
import { MoveFrom, MoveTo } from '@argonprotocol/apps-core/src/interfaces/ITransferSources.ts';

export { MoveFrom, MoveTo };

const moveFromTitle = {
  [MoveFrom.HoldingArgon]: 'Holding / ARGN',
  [MoveFrom.HoldingArgonot]: 'Holding / ARGNOT',
  [MoveFrom.MiningReserveArgon]: 'Mining / ARGN Available',
  [MoveFrom.MiningReserveArgonot]: 'Mining / ARGNOT Available',
  [MoveFrom.VaultingMintedArgon]: 'Vaulting / ARGN Minted',
  [MoveFrom.VaultingSecurityUnused]: 'Vaulting / ARGN Security',
  [MoveFrom.VaultingTreasuryUnused]: 'Vaulting / ARGN Treasury',
  [MoveFrom.VaultingUnusedArgon]: 'Vaulting Account',
};
</script>

<script setup lang="ts">
import { twMerge } from 'tailwind-merge';
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import InputMenu from '../components/InputMenu.vue';
import * as Vue from 'vue';
import InputArgon from '../components/InputArgon.vue';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { useMiningAssetBreakdown } from '../stores/miningAssetBreakdown.ts';
import { useVaultingAssetBreakdown } from '../stores/vaultingAssetBreakdown.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { getMyVault } from '../stores/vaults.ts';
import { isValidArgonAccountAddress, percentOf, bigIntMax } from '@argonprotocol/apps-core';
import { TransactionInfo } from '../lib/TransactionInfo.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { getTransactionTracker } from '../stores/transactions.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import ProgressBar from '../components/ProgressBar.vue';
import { getCurrency } from '../stores/currency.ts';
import { FIXED_U128_DECIMALS, SubmittableExtrinsic, toFixedNumber, TxSubmitter } from '@argonprotocol/mainchain';
import { IWallet } from '../lib/Wallet.ts';
import VaultAllocation from '../components/VaultAllocation.vue';
import { getConfig } from '../stores/config.ts';
import { MyVault } from '../lib/MyVault.ts';

const myVault = getMyVault();
const currency = getCurrency();
const config = getConfig();
const wallets = useWallets();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const props = withDefaults(
  defineProps<{
    class?: string;
    moveFrom?: MoveFrom;
    moveTo?: MoveTo;
  }>(),
  {
    moveFrom: MoveFrom.HoldingArgon,
  },
);

const miningBreakdown = useMiningAssetBreakdown();
const vaultingBreakdown = useVaultingAssetBreakdown();
const maxAmount = Vue.computed(() => {
  switch (props.moveFrom) {
    case MoveFrom.HoldingArgon:
      return wallets.holdingWallet.availableMicrogons;
    case MoveFrom.HoldingArgonot:
      return wallets.holdingWallet.availableMicronots;
    case MoveFrom.MiningReserveArgon:
      return miningBreakdown.unusedMicrogons;
    case MoveFrom.MiningReserveArgonot:
      return miningBreakdown.unusedMicronots;
    case MoveFrom.VaultingMintedArgon:
      return bigIntMax(0n, vaultingBreakdown.mintedValueInAccount - MyVault.OperationalReserves);
    case MoveFrom.VaultingSecurityUnused:
      return vaultingBreakdown.waitingSecuritization;
    case MoveFrom.VaultingTreasuryUnused:
      return vaultingBreakdown.pendingTreasuryPoolInvestment;
    case MoveFrom.VaultingUnusedArgon:
      return bigIntMax(0n, vaultingBreakdown.vaultingAvailableMicrogons - MyVault.OperationalReserves);
    default:
      return 0n;
  }
});
const vaultAllocation = Vue.ref<InstanceType<typeof VaultAllocation> | null>(null);
const moveOptions = Vue.computed(() => {
  const options = [];
  const walletFrom = getWalletFromType();
  if (walletFrom !== 'Holding') {
    options.push({ name: 'Holding Account', value: MoveTo.Holding });
  }
  if (walletFrom !== 'Mining') {
    options.push({ name: 'Mining Account', value: MoveTo.Mining });
  }
  if (walletFrom !== 'Vaulting' && isMovingArgons()) {
    options.push({ name: 'Vaulting Account', value: MoveTo.Vaulting });
  }
  options.push({ name: 'External Account', value: MoveTo.External });
  return options;
});

function getWalletFrom(): IWallet {
  switch (getWalletFromType()) {
    case 'Vaulting':
      return wallets.vaultingWallet;
    case 'Mining':
      return wallets.miningWallet;
    case 'Holding':
      return wallets.holdingWallet;
  }
}

function getWalletFromType(): 'Vaulting' | 'Mining' | 'Holding' {
  switch (moveFrom.value) {
    case MoveFrom.VaultingMintedArgon:
    case MoveFrom.VaultingSecurityUnused:
    case MoveFrom.VaultingTreasuryUnused:
    case MoveFrom.VaultingUnusedArgon:
      return 'Vaulting';

    case MoveFrom.MiningReserveArgon:
    case MoveFrom.MiningReserveArgonot:
      return 'Mining';

    case MoveFrom.HoldingArgon:
    case MoveFrom.HoldingArgonot:
      return 'Holding';
  }
}

async function getSigner() {
  switch (getWalletFromType()) {
    case 'Vaulting':
      return await walletKeys.getVaultingKeypair();
    case 'Mining':
      return await walletKeys.getMiningKeypair();
    case 'Holding':
      return await walletKeys.getHoldingKeypair();
  }
}

function isMovingArgons(): boolean {
  return ![MoveFrom.HoldingArgonot, MoveFrom.MiningReserveArgonot].includes(moveFrom.value!);
}

const moveFrom = Vue.ref(props.moveFrom);
const moveTo = Vue.ref<MoveTo>(props.moveTo ?? moveOptions.value[0].value);
const externalAddress = Vue.ref('');
const canChangeDestination = Vue.computed(() => !pendingTxInfo.value);
const isOpen = Vue.ref(false);
const txFee = Vue.ref(0n);

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
  const isAlreadySpent = [MoveFrom.VaultingSecurityUnused, MoveFrom.VaultingTreasuryUnused].includes(moveFrom.value);
  const argonsOnTheMove = isMovingArgons() && !isAlreadySpent ? amountToMove.value : 0n;
  return fromWallet.availableMicrogons >= argonsOnTheMove + txFee.value;
});
const amountToMove = Vue.ref(maxAmount.value);

Vue.watch(maxAmount, async newMax => {
  if (pendingTxInfo.value) {
    return;
  }
  if (amountToMove.value > newMax) {
    await updateMoveAmount(newMax);
  }
});

Vue.watch(isOpen, async () => {
  if (isOpen.value) {
    await updateMoveAmount(maxAmount.value);
    if (moveFrom.value === MoveFrom.VaultingTreasuryUnused && maxAmount.value > 10_000n) {
      comingSoon.value = 'Withdrawing from treasury will be in a near-future release';
      return;
    }

    const pendingTx = pendingTxInfo.value;
    if (!pendingTx || pendingTx.isPostProcessed) {
      isProcessing.value = false;
      progressPct.value = 0;
      progressLabel.value = '';
      pendingTxInfo.value = null;
      transactionError.value = '';
    }
  }
});

Vue.watch(externalAddress, async value => {
  if (moveTo.value === MoveTo.External && isValidArgonAccountAddress(value)) {
    await updateFee();
  }
});

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

Vue.watch(moveTo, async () => {
  await updateFee();
});

const isProcessing = Vue.ref(false);
const progressPct = Vue.ref(0);
const transactionError = Vue.ref('');
const comingSoon = Vue.ref('');
const pendingTxInfo = Vue.ref<TransactionInfo | null>(null);

const progressLabel = Vue.ref('');

async function buildTransaction(useExternalAddressPlaceHolder = false) {
  const client = await getMainchainClient(false);

  const toAddress = {
    [MoveTo.Holding]: wallets.holdingWallet.address,
    [MoveTo.Mining]: wallets.miningWallet.address,
    [MoveTo.Vaulting]: wallets.vaultingWallet.address,
    [MoveTo.External]: externalAddress.value || (useExternalAddressPlaceHolder ? wallets.vaultingWallet.address : ''),
  }[moveTo.value];

  const txs: SubmittableExtrinsic[] = [];
  /// 1. Reduce funding / withdraw from vaulting as needed
  if (moveFrom.value === MoveFrom.VaultingSecurityUnused) {
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
  } else if (moveFrom.value === MoveFrom.VaultingTreasuryUnused) {
    console.warn('Withdrawing from treasury is not yet supported');
  }

  /// 2. Transfer the argons / argonots
  if (isMovingArgons()) {
    txs.push(client.tx.balances.transferAllowDeath(toAddress, amountToMove.value));
  } else {
    txs.push(client.tx.ownership.transferAllowDeath(toAddress, amountToMove.value));
  }

  const metadata = {
    moveTo: moveTo.value,
    moveFrom: moveFrom.value,
    externalAddress: moveTo.value === MoveTo.External ? toAddress : undefined,
    amount: amountToMove.value,
    utxoId: myVault.metadata?.personalUtxoId,
    vaultAllocation: undefined as
      | {
          addedTreasuryMicrogons: bigint;
          addedSecuritizationMicrogons: bigint;
        }
      | undefined,
  };

  if (moveTo.value === MoveTo.Vaulting) {
    metadata.vaultAllocation = vaultAllocation.value?.getAllocation();
  }

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

async function transfer() {
  if (moveTo.value === MoveTo.External && !isValidArgonAccountAddress(externalAddress.value)) {
    transactionError.value = 'This External Account is not an Argon address.';
    return;
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
    const { tx, metadata } = await buildTransaction();
    const signer = await getSigner();

    const txInfo = await transactionTracker.submitAndWatch({
      tx,
      signer,
      metadata,
      extrinsicType: ExtrinsicType.Transfer,
    });
    pendingTxInfo.value = txInfo;
    if (metadata.moveTo === MoveTo.Vaulting) {
      const followOnIntent = transactionTracker.createIntentForFollowOnTx(txInfo);
      void myVault
        .increaseVaultAllocations(metadata.vaultAllocation!)
        .then(followOnIntent.resolve, followOnIntent.reject);
    }
    // NOTE: only track this here, as the bitcoin module is handling recovering from startup.
    if (metadata.moveFrom === MoveFrom.VaultingMintedArgon) {
      void myVault.onTransferOutOfMint(txInfo);
    }
    trackTxInfo(txInfo);
  } catch (err) {
    console.error('Error during transfer: %o', err);
    transactionError.value = 'This transfer failed, please try again';
    isProcessing.value = false;
  }
}

function trackTxInfo(txInfo: TransactionInfo) {
  txInfo.subscribeToProgress(async (args, error) => {
    progressPct.value = args.progressPct;
    progressLabel.value = args.progressMessage;
    if (args.progressPct === 100 && error) {
      isProcessing.value = false;
      pendingTxInfo.value = null;
      transactionError.value = error.message;
      console.error('Error during transfer: %o', error);
    }
  });
}

function cancel() {
  isOpen.value = false;
}

Vue.onMounted(async () => {
  await transactionTracker.load();
  for (const txInfo of transactionTracker.pendingBlockTxInfosAtLoad) {
    if (txInfo.tx.extrinsicType === ExtrinsicType.Transfer && txInfo.tx.metadataJson.moveFrom === props.moveFrom) {
      pendingTxInfo.value = txInfo;
      isProcessing.value = true;
      amountToMove.value = txInfo.tx.metadataJson.amount;
      moveTo.value = txInfo.tx.metadataJson.moveTo;
      externalAddress.value = txInfo.tx.metadataJson.externalAddress;
      trackTxInfo(txInfo);
      break;
    }
  }
});
</script>
