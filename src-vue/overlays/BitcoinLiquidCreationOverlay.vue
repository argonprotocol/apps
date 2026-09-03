<template>
  <OverlayBase
    :isOpen="true"
    title="Create a Bitcoin Liquid"
    class="w-240"
    @close="emit('close')"
    @pressEsc="emit('close')"
  >
    <div class="flex flex-col px-10 py-5">
      <div class="flex flex-col pt-3">
        <p class="leading-relaxed font-light">
          Fission your Bitcoin into a claim ticket for your BTC and its full market value in Argons. When you’re ready
          to unlock your Bitcoin, re-fuse the original Argon value and close the Liquid. Any price difference is yours
          to keep.
          <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`" target="_blank">
            Learn more.
          </a>
        </p>
        <div class="mt-5 border-b border-slate-200" />

        <div class="mt-5 flex flex-col">
          <div class="flex items-center">
            <label class="mb-2 grow font-bold text-gray-600/60">Liquid Amount</label>
            <span v-if="selectedSatoshis === props.minimumLiquidSatoshis" class="text-sm text-gray-600/60">
              You're At Min Amount
            </span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
              @click="selectSatoshis(props.minimumLiquidSatoshis)"
            >
              Min
            </button>
            <span class="mx-3 h-4 border-l border-gray-300" />
            <Tooltip
              v-if="!props.isTreasuryCertified && props.treasuryCertificationRequiredSatoshis"
              :asChild="true"
              content="Sets this Liquid to the Bitcoin amount still needed for Treasury Certification."
              side="top"
            >
              <span class="inline-flex cursor-help items-center gap-0.5 text-sm">
                <span v-if="selectedSatoshis === certificationSelectionSatoshis" class="text-gray-600/60">
                  Certification
                </span>
                <button
                  v-else
                  type="button"
                  class="text-argon-600 hover:text-argon-700 cursor-pointer"
                  @click="selectSatoshis(certificationSelectionSatoshis)"
                >
                  Certification
                </button>
                <InformationCircleIcon class="size-3.5 text-gray-400" />
              </span>
            </Tooltip>
            <span
              v-if="!props.isTreasuryCertified && props.treasuryCertificationRequiredSatoshis"
              class="mx-3 h-4 border-l border-gray-300"
            />
            <span v-if="selectedSatoshis === maximumLiquidSatoshis" class="text-sm text-gray-600/60">
              You're At Max Amount
            </span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
              @click="selectSatoshis(maximumLiquidSatoshis)"
            >
              Max
            </button>
            <Tooltip
              v-if="maximumLiquidSatoshis < availableSatoshis"
              :content="`Your wallet has ${satToBtcNm(availableSatoshis).format('0,0.[00000000]')} BTC available, but your cosigners can currently securitize ${satToBtcNm(maximumLiquidSatoshis).format('0,0.[00000000]')} BTC for this Liquid.`"
              side="top"
            >
              <InformationCircleIcon class="ml-1 size-3.5 cursor-help text-gray-400" />
            </Tooltip>
          </div>
          <InputNumber
            v-model="selectedBitcoin"
            :min="currency.convertSatToBtc(props.minimumLiquidSatoshis)"
            :max="currency.convertSatToBtc(maximumLiquidSatoshis)"
            :dragBy="0.001"
            :dragByMin="0.00000001"
            :minDecimals="1"
            :maxDecimals="8"
            :disabled="props.isSubmitting"
            suffix=" BTC"
            class="px-1 py-2 text-[17px]!"
          />
          <WalletFundingCallout v-if="!availableSatoshis" @open-wallet="openBitcoinWallet">
            <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
            You don't have Bitcoin available in your wallet. Add Bitcoin before creating a Liquid.
          </WalletFundingCallout>
          <div class="mt-2 text-sm text-gray-600/70">
            One-time fees:
            <template v-if="props.couponCreditMicrogons">
              <span class="line-through">
                {{ argonSymbol
                }}{{ microgonToArgonNm(props.feeMicrogons + props.couponCreditMicrogons).format('0,0.00') }}
              </span>
              {{ argonSymbol }}{{ microgonToArgonNm(props.feeMicrogons).format('0,0.00') }} · {{ argonSymbol
              }}{{ microgonToArgonNm(props.couponCreditMicrogons).format('0,0.00') }} gift from
              {{ props.feeGiftProvider ?? 'your upstream operator' }}
            </template>
            <template v-else>
              {{ argonSymbol }}{{ microgonToArgonNm(props.feeMicrogons).format('0,0.00') }} will be pulled from your
              Internal App Wallet.
            </template>
          </div>
          <WalletFundingCallout v-if="availableSatoshis && walletShortfallMicrogons" @open-wallet="openArgonWallet">
            <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
            Your wallet needs another {{ argonSymbol
            }}{{ microgonToArgonNm(walletShortfallMicrogons).format('0,0.00') }} to cover the one-time fees.
          </WalletFundingCallout>
          <div
            v-else-if="treasuryCertificationShortfallSatoshis"
            class="relative mt-3 flex items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-yellow-900"
          >
            <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
            This amount will not qualify you for Treasury certification. Select another
            {{ satToBtcNm(treasuryCertificationShortfallSatoshis).format('0,0.[00000000]') }} BTC to meet the
            requirement.
          </div>
        </div>

        <section class="border-argon-600/30 mt-6 rounded-md border">
          <div class="flex flex-row py-7 text-center">
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">
                YOU WILL RECEIVE
                <sup>&dagger;</sup>
              </header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                {{ argonSymbol }}{{ microgonToArgonNm(props.liquidityMicrogons).format('0,0.00') }}
              </div>
              <div class="text-sm font-light opacity-80">In Argon Liquidity</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">PROJECTED EARNINGS</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                +{{ argonSymbol }}{{ microgonToArgonNm(props.projectedEarningsMicrogons).format('0,0.00') }}
              </div>
              <div class="text-sm font-light opacity-80">Modeled Over One Year</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">
                REPAYMENT AMOUNT
                <sup>&dagger;</sup>
              </header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                {{ argonSymbol }}{{ microgonToArgonNm(props.liquidityMicrogons).format('0,0.00') }}
              </div>
              <div class="text-sm font-light opacity-80">Capped at Market Value</div>
            </div>
          </div>
          <div class="mx-2 border-t border-slate-600/30 px-2 py-3 text-sm font-light opacity-80">
            &dagger; The {{ argonSymbol }}{{ microgonToArgonNm(props.liquidityMicrogons).format('0,0.00') }} in Argon
            liquidity you receive is also your maximum repayment amount. If your Bitcoin's market value is lower when
            you close, you repay the lower amount.
            <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`" target="_blank">
              Learn more.
            </a>
          </div>
        </section>
      </div>

      <div class="mt-3 py-3">
        <div
          v-if="props.errorMessage && !props.isSubmitting"
          class="mb-3 flex items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-yellow-900"
        >
          <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
          {{ props.errorMessage }}
        </div>
        <div v-if="props.isSubmitting" class="space-y-2 text-sm text-slate-500">
          <div class="flex items-center gap-x-4">
            <div class="grow font-medium text-slate-600">Creating Liquid...</div>
            <div>{{ props.progressLabel || submissionProgressLabel }}</div>
          </div>
          <ProgressBar :progress="props.progressPct" />
          <div>You can close this window without stopping the transaction.</div>
        </div>
        <div v-else class="flex flex-row items-center justify-end gap-x-3">
          <button
            class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            :disabled="
              !availableSatoshis || !selectedSatoshis || !props.microgonsAtTargetPerBtc || !!walletShortfallMicrogons
            "
            class="bg-argon-button enabled:hover:bg-argon-button-hover cursor-pointer rounded-md px-10 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-40"
            @click="submit"
          >
            Create Liquid
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';

import AlertIcon from '../assets/alert.svg?component';
import InputNumber from '../components/InputNumber.vue';
import ProgressBar from '../components/ProgressBar.vue';
import Tooltip from '../components/Tooltip.vue';
import WalletFundingCallout from '../components/WalletFundingCallout.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import type { IBitcoinLiquidSource } from '../interfaces/IBitcoinLiquidSource.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { getCurrency } from '../stores/currency.ts';
import { useWallets } from '../stores/wallets.ts';
import OverlayBase from './OverlayBase.vue';

const props = withDefaults(
  defineProps<{
    sources: IBitcoinLiquidSource[];
    feeMicrogons: bigint;
    liquidityMicrogons: bigint;
    projectedEarningsMicrogons: bigint;
    couponCreditMicrogons?: bigint;
    feeGiftProvider?: string;
    isSubmitting?: boolean;
    progressPct?: number;
    confirmations?: number;
    expectedConfirmations?: number;
    availableWalletMicrogons?: bigint;
    isTreasuryCertified?: boolean;
    treasuryCertificationRequiredSatoshis?: bigint;
    minimumLiquidSatoshis?: bigint;
    microgonsAtTargetPerBtc?: bigint;
    errorMessage?: string;
    progressLabel?: string;
  }>(),
  {
    couponCreditMicrogons: () => 0n,
    isSubmitting: false,
    progressPct: 0,
    confirmations: -1,
    expectedConfirmations: 4,
    isTreasuryCertified: false,
    treasuryCertificationRequiredSatoshis: () => 0n,
    minimumLiquidSatoshis: () => 100_000n,
    errorMessage: '',
    progressLabel: '',
  },
);

const emit = defineEmits<{
  close: [];
  submit: [{ satoshis: bigint }];
  amountChanged: [{ satoshis: bigint }];
}>();

const currency = getCurrency();
const wallets = useWallets();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
const availableSatoshis = Vue.computed(() =>
  props.sources.reduce((total, source) => total + source.unallocatedSatoshis, 0n),
);
const maximumLiquidSatoshis = Vue.computed(() =>
  props.sources.reduce((total, source) => total + source.maximumLiquidSatoshis, 0n),
);
const selectedBitcoin = Vue.ref(
  currency.convertSatToBtc(props.sources.reduce((total, source) => total + source.selectedSatoshis, 0n)),
);
const selectedSatoshis = Vue.computed(() => BigInt(Math.round(selectedBitcoin.value * 100_000_000)));
const certificationSelectionSatoshis = Vue.computed(() => {
  return props.treasuryCertificationRequiredSatoshis < maximumLiquidSatoshis.value
    ? props.treasuryCertificationRequiredSatoshis
    : maximumLiquidSatoshis.value;
});
const submissionProgressLabel = Vue.computed(() =>
  generateProgressLabel(props.confirmations, props.expectedConfirmations, { blockType: 'Argon' }),
);
const walletShortfallMicrogons = Vue.computed(() => {
  const available = props.availableWalletMicrogons ?? props.feeMicrogons;
  return props.feeMicrogons > available ? props.feeMicrogons - available : 0n;
});
const treasuryCertificationShortfallSatoshis = Vue.computed(() => {
  if (props.isTreasuryCertified) return 0n;
  return props.treasuryCertificationRequiredSatoshis > selectedSatoshis.value
    ? props.treasuryCertificationRequiredSatoshis - selectedSatoshis.value
    : 0n;
});

function selectSatoshis(satoshis: bigint): void {
  selectedBitcoin.value = currency.convertSatToBtc(satoshis);
}

Vue.watch(maximumLiquidSatoshis, maximum => {
  if (selectedSatoshis.value > maximum) selectSatoshis(maximum);
});

Vue.watch(selectedSatoshis, satoshis => emit('amountChanged', { satoshis }));

function openBitcoinWallet(): void {
  basicEmitter.emit('openWalletOverlay', { wallet: wallets.bitcoinWallet });
}

function openArgonWallet(): void {
  basicEmitter.emit('openWalletOverlay', { wallet: wallets.argonWallets.defaultArgonWallet });
}

function submit(): void {
  if (props.isSubmitting) return;
  emit('submit', { satoshis: selectedSatoshis.value });
}
</script>
