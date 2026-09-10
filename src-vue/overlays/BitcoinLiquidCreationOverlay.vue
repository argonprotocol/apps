<template>
  <OverlayBase
    :isOpen="true"
    title="Create a Bitcoin Liquid"
    class="w-240"
    @close="emit('close')"
    @pressEsc="emit('close')"
  >
    <template #title>
      <StepsHeader :isLoading="false" :hasError="false" :icon="BitcoinIcon" :items="stepItems" />
    </template>
    <div v-if="props.state.stage === 'complete'" data-testid="BitcoinLiquidCreationOverlay.collectArgons">
      <div v-if="props.liquid" class="flex flex-col items-center px-10 py-8 text-center">
        <BitcoinFissionVaultIllustration class="text-argon-600 h-28 w-86" role="img" aria-label="Liquid created" />

        <h1 class="mt-5 text-2xl font-bold">Your Bitcoin Liquid Is Active</h1>
        <p class="mt-2 text-lg text-slate-700">
          Your {{ satToBtcNm(props.liquid.satoshis).format('0,0.[00000000]') }} BTC Liquid is now collecting Argons.
        </p>

        <section class="mt-7 w-full rounded-md border border-slate-300 bg-slate-50 px-8 py-6">
          <h2 class="text-argon-600 text-xl font-bold">Collect Argons Daily</h2>
          <p
            v-if="props.liquid.estimatedMintFramesRemaining === 1"
            class="mt-2 leading-relaxed font-light text-slate-700"
          >
            At the current schedule, the remaining {{ argonSymbol
            }}{{ microgonToArgonNm(props.liquid.pendingLiquidity).format('0,0.00') }} is expected in the next daily
            payout to your Internal App Wallet.
          </p>
          <p
            v-else-if="props.liquid.estimatedMintFramesRemaining"
            class="mt-2 leading-relaxed font-light text-slate-700"
          >
            At the current schedule, {{ argonSymbol
            }}{{ microgonToArgonNm(props.liquid.expectedMintPerFrame).format('0,0.00') }} is expected in each daily
            payout. The remaining {{ argonSymbol
            }}{{ microgonToArgonNm(props.liquid.pendingLiquidity).format('0,0.00') }} should reach your Internal App
            Wallet by about {{ estimatedMintCompletionDate }}.
          </p>
          <p v-else class="mt-2 leading-relaxed font-light text-slate-700">
            Argons will be deposited into your Internal App Wallet as network minting capacity becomes available.
          </p>
          <p v-if="props.liquid.pendingLiquidity" class="mt-4 border-t border-slate-200 pt-3 text-sm text-slate-500">
            Network minting capacity can delay payouts.
          </p>
        </section>

        <div class="mt-7 flex w-full justify-end border-t border-slate-200 pt-4">
          <button
            type="button"
            data-testid="BitcoinLiquidCreationOverlay.done"
            class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded-md px-6 py-2 font-semibold text-white"
            @click="emit('close')"
          >
            Done
          </button>
        </div>
      </div>
      <div v-else class="flex min-h-60 flex-col items-center justify-center gap-4 px-10 py-8 text-center">
        <AlertIcon class="h-12 text-yellow-700" />
        <h1 class="text-xl font-bold text-slate-800">Your Bitcoin Liquid Is Active</h1>
        <p class="max-w-150 text-slate-600">{{ props.state.errorMessage }}</p>
        <button
          type="button"
          data-testid="BitcoinLiquidCreationOverlay.done"
          class="cursor-pointer rounded-md border border-slate-300 px-6 py-2 text-slate-600 hover:bg-slate-50"
          @click="emit('close')"
        >
          Done
        </button>
      </div>
    </div>
    <div v-else-if="props.state.stage === 'vaults'" class="flex flex-col px-10 py-5">
      <p class="pt-3 leading-relaxed font-light">
        Your Bitcoin Liquid helps stabilize the Argon stablecoin while giving you your Bitcoin’s full market value in
        unencumbered Argons. Use these Argons to make a profit on Bitcoin's price volatility. Your Bitcoin will remain
        securely locked on the Argon mainchain and is yours to release when you desire.
        <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`" target="_blank">Learn more.</a>
      </p>
      <div class="mt-5 border-b border-slate-200" />
      <p class="mt-5 text-sm font-medium text-slate-600">Select the vaults to use for this Liquid.</p>
      <SelectAVault
        v-model:selectedVaultIds="selectedVaultIds"
        multiple
        :vaultIds="vaultIds"
        :vaultNamesById="vaultNamesById"
        :eligibleSatoshisByVaultId="eligibleSatoshisByVaultId"
      />
      <div class="flex justify-end gap-3 border-t border-slate-200 pt-4">
        <button
          class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          :disabled="!selectedVaultIds.length"
          class="bg-argon-button enabled:hover:bg-argon-button-hover cursor-pointer rounded-md px-10 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-40"
          @click="emit('vaultsSelected', { vaultIds: selectedVaultIds })"
        >
          Select Vaults
        </button>
      </div>
    </div>
    <div v-else-if="props.state.stage === 'creating'" class="px-6 py-5">
      <div class="space-y-5">
        <div class="space-y-3">
          <div class="text-sm font-medium text-slate-600">Creating Liquid...</div>
          <ProgressBar :progress="props.state.progressPct" :hasError="!!props.state.errorMessage" />
          <div class="text-xs text-slate-500">{{ props.state.progressLabel || 'Preparing transaction...' }}</div>
          <div
            v-if="props.state.errorMessage"
            class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {{ props.state.errorMessage }}
          </div>
        </div>

        <div v-if="props.state.errorMessage" class="flex flex-row justify-end gap-3 pt-1">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
            @click="emit('retry')"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
    <div v-else class="flex flex-col px-10 py-5">
      <div class="flex flex-col pt-3">
        <p class="leading-relaxed font-light">
          Your Bitcoin Liquid helps stabilize the Argon stablecoin while giving you your Bitcoin’s full market value in
          unencumbered Argons. Use these Argons to make a profit on Bitcoin's price volatility. Your Bitcoin will remain
          securely locked on the Argon mainchain and is yours to release when you desire.
          <a :href="`${NetworkConfig.websiteHost}/docs/assets-and-entities/bitcoin-locks`" target="_blank">
            Learn more.
          </a>
        </p>
        <div class="mt-5 border-b border-slate-200" />

        <div class="mt-5 flex flex-col">
          <div class="flex items-center">
            <label class="mb-2 grow font-bold text-gray-600/60">Liquid Amount</label>
            <span v-if="selectedSatoshis === minimumLiquidSatoshis" class="text-sm text-gray-600/60">
              You're At Min Amount
            </span>
            <button
              v-else
              type="button"
              class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
              @click="selectSatoshis(minimumLiquidSatoshis)"
            >
              Min
            </button>
            <span class="mx-3 h-4 border-l border-gray-300" />
            <Tooltip
              v-if="!isTreasuryCertified && props.state.treasuryCertificationRequiredSatoshis"
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
              v-if="!isTreasuryCertified && props.state.treasuryCertificationRequiredSatoshis"
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
              :content="`Your wallet has ${satToBtcNm(availableSatoshis).format('0,0.[00000000]')} BTC available, but ${selectedVaults.capacitySubject} can currently securitize ${satToBtcNm(maximumLiquidSatoshis).format('0,0.[00000000]')} BTC for this Liquid.`"
              side="top"
            >
              <InformationCircleIcon class="ml-1 size-3.5 cursor-help text-gray-400" />
            </Tooltip>
          </div>
          <InputNumber
            v-model="selectedBitcoin"
            :min="currency.convertSatToBtc(bigIntMin(minimumLiquidSatoshis, maximumLiquidSatoshis))"
            :max="currency.convertSatToBtc(maximumLiquidSatoshis)"
            :dragBy="0.001"
            :dragByMin="0.00000001"
            :minDecimals="1"
            :maxDecimals="8"
            :disabled="props.state.isSubmitting"
            suffix=" BTC"
            class="px-1 py-2 text-[17px]!"
          />
          <WalletFundingCallout v-if="!availableSatoshis" @open-wallet="openBitcoinWallet">
            <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
            You don't have Bitcoin available in your wallet. Add Bitcoin before creating a Liquid.
          </WalletFundingCallout>
          <div class="mt-2 text-sm text-gray-600/70">
            One-time fees:
            <template v-if="couponCreditMicrogons">
              <span class="line-through">
                {{ argonSymbol }}{{ microgonToArgonNm(feeMicrogons + couponCreditMicrogons).format('0,0.00') }}
              </span>
              {{ argonSymbol }}{{ microgonToArgonNm(feeMicrogons).format('0,0.00') }} · {{ argonSymbol
              }}{{ microgonToArgonNm(couponCreditMicrogons).format('0,0.00') }} gift from
              {{ config.upstreamOperator?.name ?? 'your upstream operator' }}
            </template>
            <template v-else>
              {{ argonSymbol }}{{ microgonToArgonNm(feeMicrogons).format('0,0.00') }} will be pulled from your Internal
              App Wallet.
            </template>
          </div>
          <div
            v-if="availableSatoshis && !props.state.preview && !props.state.errorMessage"
            class="mt-2 text-sm text-slate-500"
          >
            Checking available securitization…
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
                {{ argonSymbol }}{{ microgonToArgonNm(liquidityMicrogons).format('0,0.00') }}
              </div>
              <div class="text-sm font-light opacity-80">In Argon Liquidity</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">PROJECTED EARNINGS</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                +{{ argonSymbol }}{{ microgonToArgonNm(projectedEarningsMicrogons).format('0,0.00') }}
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
                {{ argonSymbol }}{{ microgonToArgonNm(liquidityMicrogons).format('0,0.00') }}
              </div>
              <div class="text-sm font-light opacity-80">Capped at Market Value</div>
            </div>
          </div>
          <div class="mx-2 border-t border-slate-600/30 px-2 py-3 text-sm font-light opacity-80">
            &dagger; The {{ argonSymbol }}{{ microgonToArgonNm(liquidityMicrogons).format('0,0.00') }} in Argon
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
          v-if="props.state.errorMessage"
          class="mb-3 flex items-center rounded border border-yellow-400/70 bg-yellow-100 px-3 py-3 text-yellow-900"
        >
          <AlertIcon class="mr-2 h-4 shrink-0 text-yellow-700" />
          {{ props.state.errorMessage }}
        </div>
        <div class="flex flex-row items-center justify-end gap-x-3">
          <button
            class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            :disabled="
              props.state.isSubmitting ||
              !availableSatoshis ||
              !selectedSatoshis ||
              !props.state.preview?.microgonsAtTargetPerBtc ||
              !!walletShortfallMicrogons
            "
            class="bg-argon-button enabled:hover:bg-argon-button-hover cursor-pointer rounded-md px-10 py-2 font-semibold text-white disabled:cursor-default disabled:opacity-40"
            @click="submit"
          >
            {{ props.state.isSubmitting ? 'Submitting...' : 'Create Liquid' }}
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { bigIntMin, bigNumberToBigInt, NetworkConfig, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import dayjs from 'dayjs';

import AlertIcon from '../assets/alert.svg?component';
import BitcoinIcon from '../assets/wallets/tokens/bitcoin.svg?component';
import BitcoinFissionVaultIllustration from '../components/BitcoinFissionVaultIllustration.vue';
import InputNumber from '../components/InputNumber.vue';
import ProgressBar from '../components/ProgressBar.vue';
import SelectAVault from '../components/SelectAVault.vue';
import StepsHeader, { type IStepHeaderItem } from '../components/StepsHeader.vue';
import Tooltip from '../components/Tooltip.vue';
import WalletFundingCallout from '../components/WalletFundingCallout.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import type { BitcoinLiquid } from '../lib/BitcoinLiquid.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { OperationalStepId, useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import { useWallets } from '../stores/wallets.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import OverlayBase from './OverlayBase.vue';
import type { BitcoinLiquidCreationState } from './BitcoinLiquidCreationState.ts';

const props = defineProps<{
  state: BitcoinLiquidCreationState;
  liquid?: BitcoinLiquid;
}>();

const emit = defineEmits<{
  close: [];
  retry: [];
  chooseVaults: [];
  vaultsSelected: [{ vaultIds: number[] }];
  submit: [{ satoshis: bigint }];
  amountChanged: [{ satoshis: bigint }];
}>();

const currency = getCurrency();
const config = getConfig();
const certification = useCertificationController();
const wallets = useWallets();
const vaultingStats = useVaultingStats();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;
const minimumLiquidSatoshis = 100_000n;
const selectedVaultIds = Vue.ref([...props.state.selectedVaultIds]);
const vaultIds = Vue.computed(() => [
  ...new Set(props.state.sources.filter(source => source.unallocatedSatoshis > 0n).map(source => source.vaultId)),
]);
const vaultNamesById = Vue.computed(() =>
  Object.fromEntries(props.state.sources.map(source => [source.vaultId, source.vaultName])),
);
const eligibleSatoshisByVaultId = Vue.computed(() =>
  Object.fromEntries(
    vaultIds.value.map(vaultId => [
      vaultId,
      props.state.sources
        .filter(source => source.vaultId === vaultId)
        .reduce((total, source) => total + source.unallocatedSatoshis, 0n),
    ]),
  ),
);
const selectedSourceVaultIds = Vue.computed(() => new Set(props.state.selectedVaultIds));
const feeMicrogons = Vue.computed(() => props.state.preview?.securityFeeMicrogons ?? 0n);
const couponCreditMicrogons = Vue.computed(() => props.state.preview?.couponCreditMicrogons ?? 0n);
const liquidityMicrogons = Vue.computed(() => props.state.preview?.liquidityMicrogons ?? 0n);
const projectedEarningsMicrogons = Vue.computed(() =>
  bigNumberToBigInt(
    BigNumber(liquidityMicrogons.value.toString()).multipliedBy(vaultingStats.bitcoinAPR).dividedBy(100),
  ),
);
const isTreasuryCertified = Vue.computed(() => certification.isCertificationStepComplete(OperationalStepId.LiquidLock));
const availableSatoshis = Vue.computed(() =>
  props.state.sources.reduce(
    (total, source) => total + (selectedSourceVaultIds.value.has(source.vaultId) ? source.unallocatedSatoshis : 0n),
    0n,
  ),
);
const maximumLiquidSatoshis = Vue.computed(() =>
  props.state.sources.reduce(
    (total, source) => total + (selectedSourceVaultIds.value.has(source.vaultId) ? source.maximumLiquidSatoshis : 0n),
    0n,
  ),
);
const selectedBitcoin = Vue.ref(
  currency.convertSatToBtc(props.state.sources.reduce((total, source) => total + source.selectedSatoshis, 0n)),
);
const selectedSatoshis = Vue.computed(() => BigInt(Math.round(selectedBitcoin.value * 100_000_000)));
const selectedVaults = Vue.computed(() => {
  const currentSelectedVaultIds =
    props.state.stage === 'vaults' ? selectedVaultIds.value : props.state.selectedVaultIds;
  const names = [
    ...new Set(
      currentSelectedVaultIds.flatMap(vaultId => {
        const source = props.state.sources.find(candidate => candidate.vaultId === vaultId);
        return source ? [source.vaultName] : [];
      }),
    ),
  ];
  return {
    label: props.state.stage === 'vaults' ? 'Choose Vaults' : names.length === 1 ? 'Vault' : 'Vaults',
    value: names.length === 1 ? names[0] : names.length + ' selected',
    tooltip: names.length ? 'Selected vaults: ' + new Intl.ListFormat('en').format(names) + '.' : 'No vaults selected.',
    capacitySubject: names.length === 1 ? names[0] : 'the selected vaults',
  };
});
const certificationSelectionSatoshis = Vue.computed(() => {
  return props.state.treasuryCertificationRequiredSatoshis < maximumLiquidSatoshis.value
    ? props.state.treasuryCertificationRequiredSatoshis
    : maximumLiquidSatoshis.value;
});
const walletShortfallMicrogons = Vue.computed(() => {
  return feeMicrogons.value > wallets.defaultArgonSpendableMicrogons
    ? feeMicrogons.value - wallets.defaultArgonSpendableMicrogons
    : 0n;
});
const treasuryCertificationShortfallSatoshis = Vue.computed(() => {
  if (isTreasuryCertified.value) return 0n;
  return props.state.treasuryCertificationRequiredSatoshis > selectedSatoshis.value
    ? props.state.treasuryCertificationRequiredSatoshis - selectedSatoshis.value
    : 0n;
});
const estimatedMintCompletionDate = Vue.computed(() =>
  dayjs()
    .add(props.liquid?.estimatedMintFramesRemaining ?? 0, 'day')
    .format('MMM D'),
);
const stepItems = Vue.computed<IStepHeaderItem[]>(() => [
  {
    label: selectedVaults.value.label,
    value: selectedVaults.value.value,
    tooltip: selectedVaults.value.tooltip,
    isActive: () => props.state.stage === 'vaults',
    click: vaultIds.value.length > 0 && props.state.stage === 'form' ? () => emit('chooseVaults') : undefined,
  },
  {
    label: '',
    tooltip: 'Your Channel allocation determines which vaults are used.',
    isActive: () => false,
  },
  {
    label: 'Choose Amount',
    value:
      props.liquid || props.state.stage === 'creating'
        ? `${satToBtcNm(props.liquid?.satoshis ?? selectedSatoshis.value).format('0,0.[00000000]')} BTC`
        : undefined,
    tooltip: 'Choose how much Bitcoin to use for this Liquid.',
    isActive: () => props.state.stage === 'form',
  },
  {
    label: '',
    tooltip: 'Your Liquid settles directly on the blockchain.',
    isActive: () => props.state.stage === 'creating',
  },
  {
    label: 'Collect Argons',
    tooltip: 'Collect the Argons minted by this Liquid.',
    isActive: () => props.state.stage === 'complete',
  },
]);

function selectSatoshis(satoshis: bigint): void {
  selectedBitcoin.value = currency.convertSatToBtc(satoshis);
}

Vue.watch(maximumLiquidSatoshis, maximum => {
  if (selectedSatoshis.value > maximum) selectSatoshis(maximum);
});

Vue.watch(
  () => props.state.selectedVaultIds,
  vaultIds => {
    selectedVaultIds.value = [...vaultIds];
  },
);

Vue.watch(selectedSatoshis, satoshis => emit('amountChanged', { satoshis }));

function openBitcoinWallet(): void {
  basicEmitter.emit('openWalletOverlay', { wallet: wallets.bitcoinWallet });
}

function openArgonWallet(): void {
  basicEmitter.emit('openWalletOverlay', { wallet: wallets.argonWallets.defaultArgonWallet });
}

function submit(): void {
  if (props.state.isSubmitting) return;
  emit('submit', { satoshis: selectedSatoshis.value });
}
</script>
