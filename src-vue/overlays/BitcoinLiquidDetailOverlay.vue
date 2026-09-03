<template>
  <OverlayBase
    :isOpen="true"
    title="Bitcoin Liquid Details"
    class="min-h-60 w-240"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
  >
    <template #default="{ floatingZIndex }">
      <div class="px-10 py-5">
        <div class="flex items-center gap-x-2">
          <h1 class="text-2xl font-bold text-slate-800">
            {{ satToBtcNm(liquid.satoshis).format('0,0.[00000000]') }} BTC Liquid
          </h1>
          <PopoverRoot>
            <PopoverTrigger as-child>
              <button class="cursor-pointer text-slate-400 hover:text-slate-600" title="View locked Bitcoin">
                <InformationCircleIcon class="size-5" />
              </button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent
                side="bottom"
                align="start"
                :alignOffset="-20"
                :sideOffset="8"
                :collisionPadding="24"
                :style="{ zIndex: floatingZIndex }"
                class="w-110 rounded-md border border-gray-800/20 bg-white px-5 py-4 text-sm text-slate-600 shadow-xl"
              >
                <h2 class="border-b border-slate-200 pb-2 font-bold text-slate-700">Locked Bitcoin</h2>
                <div>
                  <div
                    v-for="lockedBitcoin in lockedBitcoinRows"
                    :key="lockedBitcoin.utxoId"
                    class="flex items-center border-b border-slate-200 py-3 last:border-b-0"
                  >
                    <span class="grow">Cosigner: {{ lockedBitcoin.cosigner }}</span>
                    <span>{{ satToBtcNm(lockedBitcoin.satoshis).format('0,0.[00000000]') }} BTC</span>
                  </div>
                </div>
                <PopoverArrow :width="24" :height="12" class="-mt-px fill-white stroke-gray-400/30" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </div>

        <section class="border-argon-600/30 mt-6 rounded-md border">
          <div class="flex flex-row py-6 text-center">
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">LIQUIDITY RECEIVED</header>
              <div class="text-argon-600 py-1 text-2xl font-bold">
                {{ argonSymbol }}{{ microgonToArgonNm(liquid.receivedLiquidity).format('0,0.00') }}
              </div>
              <div v-if="liquid.pendingLiquidity" class="text-sm text-slate-500">
                {{ argonSymbol }}{{ microgonToArgonNm(liquid.pendingLiquidity).format('0,0.00') }} still minting
              </div>
              <div v-else class="text-sm text-slate-500">Added to your wallet</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">PROJECTED APR</header>
              <div class="text-argon-600 py-1 text-2xl font-bold">
                {{ numeral(vaultingStats.bitcoinAPR).format('0,0.[00]') }}%
              </div>
              <div class="text-sm text-slate-500">Modeled Over One Year</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">TOTAL FEES</header>
              <div v-if="financialPosition?.totalFees !== undefined" class="py-1 text-2xl font-bold text-slate-600">
                {{ argonSymbol }}{{ microgonToArgonNm(financialPosition.totalFees).format('0,0.00') }}
              </div>
              <div v-else class="py-1 text-2xl font-bold text-slate-400">&mdash;</div>
              <div
                v-if="financialPosition?.insuranceCost !== undefined && financialPosition.transactionFees !== undefined"
                class="text-sm text-slate-500"
              >
                {{ argonSymbol }}{{ microgonToArgonNm(financialPosition.insuranceCost).format('0,0.00') }} insurance
                &middot; {{ argonSymbol
                }}{{ microgonToArgonNm(financialPosition.transactionFees).format('0,0.00') }} transactions
              </div>
              <div v-else class="text-sm text-slate-500">Insurance and transaction costs</div>
            </div>
          </div>
        </section>

        <section class="mt-6 border-b border-slate-200">
          <div>
            <BitcoinLiquidHistoryRow
              v-if="closeHistoryEntry"
              :entry="closeHistoryEntry"
              :totalFissionCount="liquid.fissions.length"
              :zIndex="floatingZIndex"
              detailsMode="hover"
            />
            <article v-else class="py-3">
              <PopoverRoot v-model:open="ratchetPopoverOpen">
                <div class="flex items-start gap-x-5">
                  <div class="min-w-0 grow">
                    <div class="flex items-baseline gap-x-2">
                      <strong class="text-slate-700">
                        {{ argonSymbol }}{{ microgonToArgonNm(prospectiveLiquidity).format('0,0.00') }}
                      </strong>
                      <span class="text-sm text-slate-400">
                        (BTC {{ ratchetPercent > 0 ? '+' : '' }}{{ numeral(ratchetPercent).format('0,0.[00]') }}%)
                      </span>
                    </div>
                  </div>
                  <div v-if="ratchetPreview || ratchetTransaction.status !== 'idle'" class="text-right text-sm">
                    <div class="flex justify-end gap-x-2 font-semibold">
                      <span v-if="ratchetPreview?.amountToMint" class="text-slate-600">
                        Would unlock
                        {{ argonSymbol }}{{ microgonToArgonNm(ratchetPreview.amountToMint).format('0,0.00') }}
                      </span>
                      <span v-else-if="ratchetPocketed" class="text-slate-600">
                        Would pocket {{ argonSymbol }}{{ microgonToArgonNm(ratchetPocketed).format('0,0.00') }}
                      </span>
                      <span v-if="ratchetPreview?.amountToMint || ratchetPocketed" class="text-slate-400">
                        &middot;
                      </span>
                      <span v-if="ratchetQuoteState.status === 'loading'" class="font-normal text-slate-400">
                        Calculating fees...
                      </span>
                      <span v-else-if="ratchetQuote" class="font-normal text-slate-500">
                        {{ argonSymbol }}{{ microgonToArgonNm(ratchetQuote.feeMicrogons).format('0,0.00') }} fees
                      </span>
                      <span v-else-if="ratchetPreview" class="font-normal text-slate-500">Fees unavailable</span>
                    </div>
                    <PopoverPortal>
                      <PopoverContent
                        side="top"
                        align="end"
                        :sideOffset="10"
                        :collisionPadding="24"
                        :style="{ zIndex: floatingZIndex }"
                        class="border-argon-600/30 w-110 rounded-md border bg-white px-6 py-4 text-sm text-slate-700 shadow-2xl"
                      >
                        <template v-if="ratchetTransaction.status === 'pending'">
                          <h2 class="font-bold text-slate-700">Ratcheting Liquid</h2>
                          <ProgressBar :progress="ratchetTransaction.progressPct" class="mt-3" />
                          <div class="mt-2 text-sm text-slate-500">{{ ratchetTransaction.progressLabel }}</div>
                          <div class="mt-1 text-sm text-slate-400">
                            You can close this window without stopping the transaction.
                          </div>
                        </template>
                        <template v-else-if="ratchetTransaction.status === 'error'">
                          <h2 class="font-bold text-slate-700">Ratchet failed</h2>
                          <p class="mt-2 text-red-700">{{ ratchetTransaction.error }}</p>
                          <button
                            :disabled="!canSubmitRatchet"
                            class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                            @click="confirmRatchet"
                          >
                            Try Again
                          </button>
                        </template>
                        <template v-else-if="ratchetPreview">
                          <h2 class="font-bold text-slate-700">Review this ratchet</h2>
                          <p v-if="ratchetPreview.amountToMint" class="mt-2">
                            Unlock
                            <strong>
                              {{ argonSymbol }}{{ microgonToArgonNm(ratchetPreview.amountToMint).format('0,0.00') }}
                            </strong>
                            additional liquidity at the new Bitcoin price.
                          </p>
                          <p v-else-if="ratchetPocketed" class="mt-2">
                            Keep
                            <strong>{{ argonSymbol }}{{ microgonToArgonNm(ratchetPocketed).format('0,0.00') }}</strong>
                            and reset this Liquid to the lower Bitcoin floor.
                          </p>
                          <p v-if="ratchetPreview.amountToBurn" class="mt-3 text-slate-500">
                            A downward ratchet requires
                            <strong class="font-semibold text-slate-700">
                              {{ argonSymbol }}{{ microgonToArgonNm(ratchetPreview.amountToBurn).format('0,0.00') }}
                            </strong>
                            in your wallet to be burned and re-minted at the lower Liquid amount.
                          </p>
                          <p class="mt-3 text-slate-500">
                            <template v-if="ratchetQuote">
                              This ratchet costs
                              <strong class="font-semibold text-slate-700">
                                {{ argonSymbol }}{{ microgonToArgonNm(ratchetQuote.feeMicrogons).format('0,0.00') }}
                              </strong>
                              in fees.
                            </template>
                            <template v-else>Calculating transaction cost...</template>
                          </p>
                          <p v-if="ratchetQuoteState.status === 'error'" class="mt-3 text-red-700">
                            {{ ratchetQuoteState.error }}
                          </p>
                          <p v-if="ratchetWalletIsInsufficient" class="mt-3 text-red-700">
                            Your Internal App Wallet needs
                            {{ argonSymbol
                            }}{{ microgonToArgonNm(ratchetQuote!.requiredWalletBalanceMicrogons).format('0,0.00') }}
                            to continue. It currently has
                            {{ argonSymbol
                            }}{{ microgonToArgonNm(ratchetQuote!.availableWalletBalanceMicrogons).format('0,0.00') }}
                            available.
                          </p>
                          <p v-if="ratchetPreview.skippedFissionIds.length" class="mt-3 text-slate-500">
                            This ratchet uses only the locked Bitcoin that currently meets the minimum price change.
                          </p>
                          <p v-if="ratchetPreview.lockChanges.length" class="mt-3 text-slate-500">
                            {{ ratchetPreview.lockChanges.length }} lock{{
                              ratchetPreview.lockChanges.length === 1 ? '' : 's'
                            }}
                            will be resecuritized as part of this ratchet.
                          </p>
                          <button
                            :disabled="!canSubmitRatchet"
                            class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                            @click="confirmRatchet"
                          >
                            Confirm Ratchet
                          </button>
                        </template>
                        <PopoverArrow :width="26" :height="12" class="stroke-argon-600/15 -mt-px fill-white" />
                      </PopoverContent>
                    </PopoverPortal>
                  </div>
                </div>
                <div class="flex items-end gap-x-5" :class="ratchetPreview ? 'mt-1' : ''">
                  <p v-if="ratchetState.status === 'loading'" class="min-w-0 grow text-sm text-slate-500">
                    Checking the latest price, eligible locked Bitcoin, and cosigner capacity.
                  </p>
                  <p v-else-if="!isRatchetAvailable" class="min-w-0 grow text-sm text-slate-500">
                    {{ ratchetUnavailableReason }}
                  </p>
                  <p v-else-if="ratchetPercent > 0" class="min-w-0 grow text-sm text-slate-500">
                    Bitcoin's higher price lets the same locked Bitcoin unlock more liquidity.
                  </p>
                  <p v-else class="min-w-0 grow text-sm text-slate-500">
                    A lower floor lets you keep the difference and restores room for a future upward ratchet.
                  </p>
                  <TooltipProvider :delayDuration="100">
                    <TooltipRoot>
                      <TooltipTrigger as-child>
                        <span class="inline-flex">
                          <PopoverTrigger as-child>
                            <button
                              data-testid="BitcoinLiquidDetailOverlay.openRatchetReview"
                              :disabled="
                                (!isRatchetAvailable || !ratchetPreview) && ratchetTransaction.status !== 'pending'
                              "
                              class="border-argon-600 text-argon-600 hover:bg-argon-600/5 inline-flex cursor-pointer items-center gap-x-1 rounded border px-3 text-sm leading-5 font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-300"
                            >
                              {{ ratchetTransaction.status === 'pending' ? 'Ratcheting...' : 'Review Ratchet' }}
                              <InformationCircleIcon
                                v-if="!isRatchetAvailable && ratchetState.status !== 'loading'"
                                class="size-4"
                              />
                            </button>
                          </PopoverTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipPortal v-if="!isRatchetAvailable && ratchetState.status !== 'loading'">
                        <TooltipContent
                          side="top"
                          align="end"
                          :sideOffset="8"
                          :collisionPadding="24"
                          :style="{ zIndex: floatingZIndex }"
                          class="w-80 rounded-md border border-gray-800/20 bg-white px-4 py-3 text-sm text-slate-600 shadow-xl"
                        >
                          {{ ratchetUnavailableReason }}
                          <TooltipArrow :width="18" :height="9" class="-mt-px fill-white stroke-gray-400/30" />
                        </TooltipContent>
                      </TooltipPortal>
                    </TooltipRoot>
                  </TooltipProvider>
                </div>
              </PopoverRoot>
            </article>
            <BitcoinLiquidHistoryRow
              v-for="entry in recentHistory"
              :key="entry.key"
              :entry="entry"
              :totalFissionCount="liquid.fissions.length"
              :zIndex="floatingZIndex"
              detailsMode="hover"
            />
          </div>
        </section>

        <div v-if="liquid.history.length > 3 || !isClosed" class="mt-7 flex items-center justify-between gap-x-3">
          <PopoverRoot v-if="liquid.history.length > 3">
            <PopoverTrigger as-child>
              <button class="text-argon-600 cursor-pointer text-sm">Show full history</button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent
                side="top"
                align="start"
                :sideOffset="8"
                :collisionPadding="24"
                :style="{ zIndex: floatingZIndex }"
                class="max-h-[var(--reka-popover-content-available-height)] w-150 overflow-y-auto rounded-md border border-gray-800/20 bg-white px-6 py-4 shadow-xl"
              >
                <h2 class="border-b border-slate-200 pb-2 font-bold text-slate-700">Full history</h2>
                <BitcoinLiquidHistoryRow
                  v-for="entry in fullHistory"
                  :key="entry.key"
                  :entry="entry"
                  :totalFissionCount="liquid.fissions.length"
                  :zIndex="floatingZIndex + 1"
                  detailsMode="inline"
                />
                <PopoverArrow :width="24" :height="12" class="-mt-px fill-white stroke-gray-400/30" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
          <span v-else />
          <PopoverRoot v-if="!isClosed" v-model:open="closePopoverOpen">
            <PopoverTrigger as-child>
              <button
                data-testid="BitcoinLiquidDetailOverlay.openCloseReview"
                class="border-argon-600 text-argon-600 hover:bg-argon-600/5 cursor-pointer rounded-md border px-5 py-2 font-semibold whitespace-nowrap"
              >
                <template v-if="closeTransaction.status === 'pending'">Closing Liquid...</template>
                <template v-else>
                  Repay {{ argonSymbol }}{{ microgonToArgonNm(repaymentAmount).format('0,0.00') }} &amp; Close Liquid
                </template>
              </button>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent
                side="top"
                align="end"
                :sideOffset="10"
                :collisionPadding="24"
                :style="{ zIndex: floatingZIndex }"
                class="border-argon-600/30 w-110 rounded-md border bg-white px-6 py-4 text-sm text-slate-700 shadow-2xl"
              >
                <template v-if="closeTransaction.status === 'pending'">
                  <h2 class="font-bold text-slate-700">Closing Liquid</h2>
                  <ProgressBar :progress="closeTransaction.progressPct" class="mt-3" />
                  <div class="mt-2 text-sm text-slate-500">{{ closeTransaction.progressLabel }}</div>
                  <div class="mt-1 text-sm text-slate-400">
                    You can close this window without stopping the transaction.
                  </div>
                </template>
                <template v-else-if="closeTransaction.status === 'error'">
                  <h2 class="font-bold text-slate-700">Unable to close Liquid</h2>
                  <p class="mt-2 text-red-700">{{ closeTransaction.error }}</p>
                  <button
                    class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white"
                    @click="confirmClose"
                  >
                    Try Again
                  </button>
                </template>
                <template v-else>
                  <h2 class="font-bold text-slate-700">Close this Liquid</h2>
                  <p class="mt-2">
                    Repay {{ argonSymbol }}{{ microgonToArgonNm(repaymentAmount).format('0,0.00') }} to re-fuse this
                    Liquid. This unlocks your Bitcoin, which remains in your Bitcoin wallet.
                  </p>
                  <dl class="mt-3 grid grid-cols-[1fr_auto] gap-x-5 gap-y-1.5">
                    <dt>Estimated fees</dt>
                    <dd v-if="closeQuote">
                      {{ argonSymbol }}{{ microgonToArgonNm(closeQuote.feeMicrogons).format('0,0.00') }}
                    </dd>
                    <dd v-else>Calculating...</dd>
                  </dl>
                  <p v-if="closeQuoteState.status === 'error'" class="mt-3 text-red-700">
                    {{ closeQuoteState.error }}
                  </p>
                  <p v-if="closeWalletIsInsufficient" class="mt-3 text-red-700">
                    Your Internal App Wallet needs
                    {{ argonSymbol
                    }}{{ microgonToArgonNm(closeQuote!.requiredWalletBalanceMicrogons).format('0,0.00') }} to continue.
                    It currently has {{ argonSymbol
                    }}{{ microgonToArgonNm(closeQuote!.availableWalletBalanceMicrogons).format('0,0.00') }} available.
                  </p>
                  <button
                    :disabled="!canSubmitClose"
                    class="bg-argon-600 hover:bg-argon-700 mt-4 w-full cursor-pointer rounded-md px-5 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    @click="confirmClose"
                  >
                    Repay &amp; Close Liquid
                  </button>
                </template>
                <PopoverArrow :width="26" :height="12" class="stroke-argon-600/15 -mt-px fill-white" />
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </div>
      </div>
    </template>
  </OverlayBase>
</template>

<script setup lang="ts">
import { bigIntMax, SATOSHIS_PER_BITCOIN, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui';
import * as Vue from 'vue';

import BitcoinLiquidHistoryRow from '../components/BitcoinLiquidHistoryRow.vue';
import ProgressBar from '../components/ProgressBar.vue';
import type { IBitcoinLiquidFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import type { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import type { IBitcoinLiquidRatchetPreview } from '../lib/txs/BitcoinLiquid.ratchet.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import numeral from '../lib/numeral.ts';
import { getCurrency } from '../stores/currency.ts';
import { useFinancials } from '../stores/financials.ts';
import { getBitcoinFissions, getBitcoinTransactionOperations } from '../stores/bitcoin.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getVaults } from '../stores/vaults.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import OverlayBase from './OverlayBase.vue';

type LiquidDetailsLoadState<Value> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: Value }
  | { status: 'error'; error: string };

type LiquidDetailsTransactionState =
  | { status: 'idle' }
  | { status: 'pending'; progressPct: number; progressLabel: string }
  | { status: 'error'; error: string };

interface BitcoinLiquidRatchetDetails {
  rate: bigint;
  preview: IBitcoinLiquidRatchetPreview;
}

interface BitcoinLiquidTransactionQuote {
  feeMicrogons: bigint;
  requiredWalletBalanceMicrogons: bigint;
  availableWalletBalanceMicrogons: bigint;
}

const props = defineProps<{
  liquid: BitcoinLiquid;
}>();

const emit = defineEmits<{
  close: [];
}>();

const currency = getCurrency();
const financials = useFinancials();
const bitcoinFissions = getBitcoinFissions();
const { bitcoinLiquidClose, bitcoinLiquidRatchet } = getBitcoinTransactionOperations();
const vaults = getVaults();
const vaultingStats = useVaultingStats();
const walletKeys = getWalletKeys();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
const liquid = Vue.computed(() => props.liquid);
const isClosed = Vue.computed(() => liquid.value.isClosed);
const closeHistoryEntry = Vue.computed(() => liquid.value.closeHistoryEntry);
const ratchetState = Vue.ref<LiquidDetailsLoadState<BitcoinLiquidRatchetDetails>>({ status: 'idle' });
const ratchetQuoteState = Vue.ref<LiquidDetailsLoadState<BitcoinLiquidTransactionQuote>>({ status: 'idle' });
const ratchetTransaction = Vue.ref<LiquidDetailsTransactionState>({ status: 'idle' });
const closeQuoteState = Vue.ref<LiquidDetailsLoadState<BitcoinLiquidTransactionQuote>>({ status: 'idle' });
const closeTransaction = Vue.ref<LiquidDetailsTransactionState>({ status: 'idle' });
const ratchetPopoverOpen = Vue.ref(false);
const closePopoverOpen = Vue.ref(false);
let loadId = 0;
let timeout: ReturnType<typeof setTimeout> | undefined;
let transactionCleanupFns: VoidFunction[] = [];
const financialPosition = Vue.computed(() =>
  financials.financialPositionAggregate.groupSummaries.bitcoin.positions.find(
    (position): position is IBitcoinLiquidFinancialPosition =>
      position.kind === 'bitcoin-liquid' && position.liquidId === liquid.value.liquidId,
  ),
);
const lockSummaries = Vue.computed(() => {
  const utxoIds = new Set(liquid.value.fissions.map(fission => fission.utxoId));
  return financials.bitcoinLockDisplayRecords.filter(
    summary => summary.utxoId !== undefined && utxoIds.has(summary.utxoId),
  );
});
const repaymentAmount = Vue.computed(() => liquid.value.getRepaymentAmount(currency.priceIndex));
const ratchetDetails = Vue.computed(() =>
  ratchetState.value.status === 'ready' ? ratchetState.value.value : undefined,
);
const ratchetPreview = Vue.computed(() => ratchetDetails.value?.preview);
const ratchetQuote = Vue.computed(() =>
  ratchetQuoteState.value.status === 'ready' ? ratchetQuoteState.value.value : undefined,
);
const closeQuote = Vue.computed(() =>
  closeQuoteState.value.status === 'ready' ? closeQuoteState.value.value : undefined,
);
const ratchetRate = Vue.computed(() => {
  if (ratchetDetails.value) return ratchetDetails.value.rate;
  if (!currency.priceIndex.btcUsdPrice) return 0n;
  return currency.priceIndex.getSatoshiPriceInTargetMicrogons(SATOSHIS_PER_BITCOIN);
});
const ratchetPercent = Vue.computed(() =>
  ratchetRate.value
    ? liquid.value.getRatchetStatus({
        microgonsAtTargetPerBtc: ratchetRate.value,
        minimumRatchetPercent: bitcoinFissions.data.minimumRatchetPercent,
      }).percent
    : 0,
);
const isRatchetAvailable = Vue.computed(() => ratchetPreview.value?.canRatchet ?? false);
const ratchetUnavailableReason = Vue.computed(() => {
  const error =
    ratchetState.value.status === 'error'
      ? ratchetState.value.error
      : ratchetState.value.status === 'ready' && !ratchetState.value.value.preview.canRatchet
        ? (ratchetState.value.value.preview.errors[0] ??
          `No locked Bitcoin has reached the minimum ${bitcoinFissions.data.minimumRatchetPercent}% price change.`)
        : '';
  return error;
});

const lockedBitcoinRows = Vue.computed(() => {
  const byUtxoId = new Map<number, { utxoId: number; satoshis: bigint; cosigner: string }>();

  for (const fission of liquid.value.fissions) {
    const existing = byUtxoId.get(fission.utxoId);
    if (existing) {
      existing.satoshis += fission.satoshis;
      continue;
    }

    const vaultId = lockSummaries.value.find(summary => summary.utxoId === fission.utxoId)?.record.vaultId;
    byUtxoId.set(fission.utxoId, {
      utxoId: fission.utxoId,
      satoshis: fission.satoshis,
      cosigner:
        vaultId === undefined ? 'Unknown cosigner' : (vaults.operatorNamesByVaultId[vaultId] ?? `Vault ${vaultId}`),
    });
  }

  return [...byUtxoId.values()];
});

const fullHistory = Vue.computed(() => [...liquid.value.history].reverse());
const recentHistory = Vue.computed(() => fullHistory.value.slice(0, 3));
const ratchetPocketed = Vue.computed(() => {
  const preview = ratchetPreview.value;
  if (!preview || preview.newLiquidity >= preview.sourceLiquidity) return 0n;

  return preview.sourceLiquidity - preview.newLiquidity;
});
const prospectiveLiquidity = Vue.computed(() => ratchetPreview.value?.newLiquidity ?? liquid.value.liquidityPromised);
const ratchetQuoteIsReady = Vue.computed(() => ratchetQuoteState.value.status === 'ready');
const ratchetWalletIsInsufficient = Vue.computed(
  () =>
    ratchetQuoteIsReady.value &&
    ratchetQuote.value!.availableWalletBalanceMicrogons < ratchetQuote.value!.requiredWalletBalanceMicrogons,
);
const canSubmitRatchet = Vue.computed(
  () =>
    isRatchetAvailable.value &&
    !!ratchetPreview.value?.canRatchet &&
    ratchetQuoteIsReady.value &&
    !ratchetWalletIsInsufficient.value,
);
const closeQuoteIsReady = Vue.computed(() => closeQuoteState.value.status === 'ready');
const closeWalletIsInsufficient = Vue.computed(
  () =>
    closeQuoteIsReady.value &&
    closeQuote.value!.availableWalletBalanceMicrogons < closeQuote.value!.requiredWalletBalanceMicrogons,
);
const canSubmitClose = Vue.computed(() => closeQuoteIsReady.value && !closeWalletIsInsufficient.value);

Vue.watch(
  () => ratchetTransaction.value.status,
  status => {
    if (status !== 'idle') ratchetPopoverOpen.value = true;
  },
);
Vue.watch(
  () => closeTransaction.value.status,
  status => {
    if (status !== 'idle') closePopoverOpen.value = true;
  },
);

function confirmRatchet(): void {
  if (!canSubmitRatchet.value) return;
  void submitRatchet();
}

function confirmClose(): void {
  if (!canSubmitClose.value) return;
  void submitClose();
}

function initializeActions(): void {
  stopTracking();
  if (liquid.value.isClosed) return;

  const pendingClose = bitcoinLiquidClose.getPendingLiquidTxInfo(liquid.value.liquidId);
  if (pendingClose) {
    trackTransaction(pendingClose, closeTransaction);
    return;
  }

  const pendingRatchet = bitcoinLiquidRatchet.getPendingRatchetTxInfo(liquid.value.liquidId);
  if (pendingRatchet) {
    trackTransaction(pendingRatchet, ratchetTransaction);
    return;
  }

  ratchetState.value = { status: 'loading' };
  closeQuoteState.value = { status: 'loading' };
  const currentLiquid = liquid.value;
  const currentLoadId = ++loadId;
  void loadRatchet(currentLiquid, currentLoadId);
  void loadCloseQuote(currentLiquid, currentLoadId);

  timeout = setTimeout(() => {
    if (currentLoadId !== loadId) return;
    if (ratchetState.value.status === 'loading') {
      ratchetState.value = { status: 'error', error: 'The latest ratchet availability check did not respond.' };
    }
    if (ratchetQuoteState.value.status === 'loading') {
      ratchetQuoteState.value = { status: 'error', error: 'The ratchet transaction quote did not respond.' };
    }
    if (closeQuoteState.value.status === 'loading') {
      closeQuoteState.value = { status: 'error', error: 'The close transaction quote did not respond.' };
    }
  }, 10_000);
}

async function submitRatchet(): Promise<void> {
  const currentLiquid = liquid.value;
  const ratchetDetailsValue = ratchetState.value.status === 'ready' ? ratchetState.value.value : undefined;
  if (!ratchetDetailsValue?.preview.canRatchet || ratchetTransaction.value.status === 'pending') return;

  ratchetTransaction.value = { status: 'pending', progressPct: 0, progressLabel: 'Preparing transaction...' };
  try {
    const txInfo = await bitcoinLiquidRatchet.submit({
      liquidId: currentLiquid.liquidId,
      microgonsAtTargetPerBtc: ratchetDetailsValue.rate,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    trackTransaction(txInfo, ratchetTransaction);
  } catch (error) {
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    ratchetTransaction.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to ratchet this Liquid.',
    };
  }
}

async function submitClose(): Promise<void> {
  const currentLiquid = liquid.value;
  if (closeTransaction.value.status === 'pending') return;

  closeTransaction.value = { status: 'pending', progressPct: 0, progressLabel: 'Preparing transaction...' };
  try {
    const txInfo = await bitcoinLiquidClose.submit({
      liquidId: currentLiquid.liquidId,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    trackTransaction(txInfo, closeTransaction);
  } catch (error) {
    if (liquid.value.liquidId !== currentLiquid.liquidId) return;
    closeTransaction.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to close this Liquid.',
    };
  }
}

async function loadRatchet(currentLiquid: BitcoinLiquid, currentLoadId: number): Promise<void> {
  try {
    const client = await getMainchainClient(false);
    const rates = await client.query.bitcoinLocks.microgonPerBtcHistory();
    const rate = rates.at(-1)?.[1];
    if (rate === undefined) throw new Error('Network Bitcoin pricing is currently unavailable.');

    const preview = await bitcoinLiquidRatchet.previewRatchet(currentLiquid.liquidId, rate, client);
    if (!isCurrent(currentLiquid, currentLoadId)) return;

    ratchetState.value = { status: 'ready', value: { rate, preview } };
    if (!preview.canRatchet) return;

    ratchetQuoteState.value = { status: 'loading' };
    await loadRatchetQuote(currentLiquid, rate, preview, currentLoadId);
  } catch (error) {
    if (!isCurrent(currentLiquid, currentLoadId)) return;
    ratchetState.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to check ratchet availability.',
    };
  }
}

async function loadRatchetQuote(
  currentLiquid: BitcoinLiquid,
  rate: bigint,
  preview: IBitcoinLiquidRatchetPreview,
  currentLoadId: number,
): Promise<void> {
  try {
    const prepared = await bitcoinLiquidRatchet.prepare({
      liquidId: currentLiquid.liquidId,
      microgonsAtTargetPerBtc: rate,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    if (!isCurrent(currentLiquid, currentLoadId)) return;

    const unavailableBalance = prepared.unavailableBalance ?? 0n;
    const existentialDeposit = prepared.includeExistentialDeposit
      ? prepared.client.consts.balances.existentialDeposit.toBigInt()
      : 0n;
    ratchetQuoteState.value = {
      status: 'ready',
      value: {
        feeMicrogons: bigIntMax(unavailableBalance - preview.amountToBurn, 0n) + prepared.txFeePlusTip,
        requiredWalletBalanceMicrogons: unavailableBalance + prepared.txFeePlusTip + existentialDeposit,
        availableWalletBalanceMicrogons: prepared.availableBalance,
      },
    };
  } catch (error) {
    if (!isCurrent(currentLiquid, currentLoadId)) return;
    ratchetQuoteState.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to quote this ratchet.',
    };
  }
}

async function loadCloseQuote(currentLiquid: BitcoinLiquid, currentLoadId: number): Promise<void> {
  try {
    const prepared = await bitcoinLiquidClose.prepare({
      liquidId: currentLiquid.liquidId,
      txSigner: await walletKeys.getLiquidLockingKeypair(),
    });
    if (!isCurrent(currentLiquid, currentLoadId)) return;

    closeQuoteState.value = {
      status: 'ready',
      value: {
        feeMicrogons: prepared.txFeePlusTip,
        requiredWalletBalanceMicrogons: (prepared.unavailableBalance ?? 0n) + prepared.txFeePlusTip,
        availableWalletBalanceMicrogons: prepared.availableBalance,
      },
    };
  } catch (error) {
    if (!isCurrent(currentLiquid, currentLoadId)) return;
    closeQuoteState.value = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to quote closing this Liquid.',
    };
  }
}

function trackTransaction<Metadata>(
  txInfo: TransactionInfo<Metadata>,
  state: Vue.Ref<LiquidDetailsTransactionState>,
): void {
  state.value = { status: 'pending', progressPct: 0, progressLabel: 'Preparing transaction...' };
  const unsubscribe = txInfo.subscribeToProgress((progress, error) => {
    state.value = error
      ? { status: 'error', error: error.message }
      : { status: 'pending', progressPct: progress.progressPct, progressLabel: progress.progressMessage };
  });
  transactionCleanupFns.push(unsubscribe);

  let isCurrentTransaction = true;
  transactionCleanupFns.push(() => {
    isCurrentTransaction = false;
  });
  void txInfo.waitForPostProcessing.then(
    () => {
      if (!isCurrentTransaction) return;
      const error = txInfo.getStatus().error;
      if (error) {
        state.value = { status: 'error', error: error.message };
        return;
      }
      closeOverlay();
    },
    error => {
      if (!isCurrentTransaction) return;
      state.value = {
        status: 'error',
        error: error instanceof Error ? error.message : 'The transaction did not complete.',
      };
    },
  );
}

function stopTracking(): void {
  loadId += 1;
  if (timeout) clearTimeout(timeout);
  timeout = undefined;
  transactionCleanupFns.forEach(cleanup => cleanup());
  transactionCleanupFns = [];
  ratchetState.value = { status: 'idle' };
  ratchetQuoteState.value = { status: 'idle' };
  ratchetTransaction.value = { status: 'idle' };
  closeQuoteState.value = { status: 'idle' };
  closeTransaction.value = { status: 'idle' };
}

function isCurrent(currentLiquid: BitcoinLiquid, currentLoadId: number): boolean {
  return loadId === currentLoadId && liquid.value.liquidId === currentLiquid.liquidId;
}

function closeOverlay(): void {
  stopTracking();
  emit('close');
}

Vue.watch(
  () => liquid.value.liquidId,
  () => initializeActions(),
);
Vue.watch(isClosed, closed => {
  if (closed) stopTracking();
});
Vue.onMounted(initializeActions);
Vue.onUnmounted(stopTracking);
</script>
