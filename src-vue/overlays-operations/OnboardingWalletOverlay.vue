<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-9/12">
    <template #title>
      <div class="text-2xl font-bold inline-block relative">
        Add Funds to Your {{ walletName }} Wallet
        <AlertCalloutButton
          v-if="[OperationalStepId.ActivateVault, OperationalStepId.FirstMiningSeat].includes(controller.activeGuideId as any)"
          :showArrow="false"
          label="Critical Alert"
          guidance="In order to count towards your bonus, these funds must be sent over Hyperbridge from a Uniswap or Coinbase transaction. This helps the system limit fraud."
          class="absolute top-1/2 -right-3 -translate-y-1/2 translate-x-full z-50 -mt-0.5"
        />
      </div>
    </template>

    <div class="flex flex-row items-stretch w-full pt-3 pb-5 px-5 gap-x-5">
      <div class="flex flex-col grow pt-2 text-md pr-8">
        <div >
          <p class="font-light">
            You can use any polkadot/substrate compatible wallet to add funds to your account. Just scan the
            QR code shown on the right, or copy and paste the address that's printed below it.
          </p>

          <div class="flex flex-col my-4 border border-slate-400 border-dashed rounded px-2 py-2">
            <div v-if="showJurisdictionAlert">
              <AlertIcon class="w-5 h-5 inline-block mr-1.5 text-red-600" /> Uh oh... Instructions for acquiring tokens
              is only available to those outside the United States. It seems
              <span @click="openJurisdictionOverlay" class="text-argon-800/80 cursor-pointer hover:text-argon-600 hover:font-bold underline decoration-dashed">your chosen jurisdiction</span> is not yet supported.
            </div>
            <div v-else @click="openUniswapInstructions" class="flex flex-row gap-x-2 items-center cursor-pointer text-argon-800/60 hover:text-argon-600">
              <InstructionsIcon class="w-6 h-6 inline-block" />
              View Step-by-Step Instructions for Acquiring Argons and Argonots
            </div>
          </div>


          <p class="mt-3 text-md leading-5 text-slate-600 border-b border-dashed border-slate-300/50 pb-5">
            {{ fundingPlanDescription }}
          </p>

          <div v-if="showOnboardingFundingBreakdown" class="px-1 py-1">
            <div class="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">ARGN</div>

            <div class="mt-2 space-y-2 text-sm">
              <div class="flex items-center justify-between gap-x-4">
                <Tooltip
                  v-if="walletId === WalletType.miningHold"
                  asChild
                  side="top"
                  content="This is the amount needed to win mining bids given your configured Mining preferences.">
                  <span class="inline-flex min-w-0 cursor-help items-center gap-x-2 text-slate-700">
                    <span class="flex h-4 w-4 shrink-0 items-center justify-center opacity-70">
                      <span class="origin-center scale-[0.57]">
                        <CheckboxGray :isChecked="true" />
                      </span>
                    </span>
                    <span>Mining bids</span>
                  </span>
                </Tooltip>

                <Tooltip v-else
                  asChild
                  side="top"
                  content="This is the amount you configured in your Vault Setup to allocate to Bitcoin Security. Bitcoin Security is the market value of the amount of bitcoin that can be locked into your Vault.">
                  <span class="inline-flex min-w-0 cursor-help items-center gap-x-2 text-slate-700">
                    <span class="flex h-4 w-4 shrink-0 items-center justify-center opacity-70">
                      <span class="origin-center scale-[0.57]">
                        <CheckboxGray :isChecked="true" />
                      </span>
                    </span>
                    <span>Bitcoin Security</span>
                  </span>
                </Tooltip>
                <span class="shrink-0 font-mono text-slate-900">
                  {{ microgonToArgonNm(baseMinimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN
                </span>
              </div>

              <Tooltip
                asChild
                side="top"
                :content="`Each transaction on the network costs a small amount of ARGN. This budget helps ensure your ${walletId === WalletType.miningHold ? 'Mining Bot' : 'Vault'} can remain healthy and operational without needing to transfer in more argons.`">
                <div class="flex cursor-help items-center justify-between gap-x-4">
                  <span class="inline-flex min-w-0 items-center gap-x-2 text-slate-600">
                    <span class="flex h-4 w-4 shrink-0 items-center justify-center opacity-70">
                      <span class="origin-center scale-[0.57]">
                        <CheckboxGray :isChecked="true" />
                      </span>
                    </span>
                    <span>Transaction fees budget</span>
                  </span>
                  <span class="shrink-0 font-mono text-slate-900">
                    +{{ microgonToArgonNm(futureTransactionFeeBudgetMicrogons).format('0,0') }} ARGN
                  </span>
                </div>
              </Tooltip>

              <button
                v-if="showVaultTreasuryBondSuggestion"
                @click="includeVaultTreasuryBondSuggestion = !includeVaultTreasuryBondSuggestion"
                class="flex w-full items-center justify-between gap-x-4 text-left">
                <Tooltip
                  asChild
                  side="top"
                  content="Treasury Bonds are issued by the Argon Treasury and represent a claim on future network revenue. Acquiring bonds is a required step to achieve operational certification. Keep this checked to avoid having to transfer in more funds later.">
                  <span class="inline-flex min-w-0 cursor-help items-center gap-x-2 text-slate-600">
                    <Checkbox :isChecked="includeVaultTreasuryBondSuggestion" :size="4" class="shrink-0" />
                    <span>Treasury bonds (for full operator certification)</span>
                  </span>
                </Tooltip>
                <span class="shrink-0 font-mono text-slate-900">
                  +{{ microgonToArgonNm(vaultTreasuryBondSuggestionMicrogons).format('0,0') }} ARGN
                </span>
              </button>
            </div>

            <div class="mt-3 border-t border-slate-300/60 pt-2">
              <div class="flex items-center justify-between gap-x-4 text-sm font-semibold text-slate-900">
                <span class="inline-flex items-center gap-x-2">
                  <span>{{ microgonNeededLabel }}</span>
                  <span v-if="microgonFundingStatus.dotClass" :class="microgonFundingStatus.dotClass"></span>
                  <span v-if="microgonFundingStatus.label" :class="microgonFundingStatus.badgeClass">
                    {{ microgonFundingStatus.label }}
                  </span>
                </span>
                <span
                  data-testid="WalletOverlay.microgonsNeeded"
                  :data-value="displayedMicrogonsNeeded"
                  class="shrink-0 font-mono">
                  {{ microgonToArgonNm(displayedMicrogonsNeeded).format('0,0.[00000000]') }} ARGN
                </span>
              </div>
            </div>

            <template v-if="minimumMicronotsNeeded > 0n">
              <div class="mt-4 pt-4">
                <div class="text-xs font-semibold uppercase tracking-wide text-slate-500">ARGNOT</div>
                <div class="mt-2 flex items-center justify-between gap-x-4 text-sm">
                  <Tooltip
                    v-if="walletId === WalletType.miningHold"
                    asChild
                    side="top"
                    content="Mining bids require a set number of argonots per bid to be held during a mining term. Once complete, they are released back into your custody.">
                    <span class="inline-flex min-w-0 cursor-help items-center gap-x-2 text-slate-700">
                      <span class="flex h-4 w-4 shrink-0 items-center justify-center opacity-70">
                        <span class="origin-center scale-[0.57]">
                          <CheckboxGray :isChecked="true" />
                        </span>
                      </span>
                      <span>Mining Bids</span>
                    </span>
                  </Tooltip>
                </div>

                <div class="mt-3 border-t border-slate-300/60 pt-2">
                  <div class="flex items-center justify-between gap-x-4 text-sm font-semibold text-slate-900">
                    <span class="inline-flex items-center gap-x-2">
                      <span>{{ micronotNeededLabel }}</span>
                      <span v-if="micronotFundingStatus.dotClass" :class="micronotFundingStatus.dotClass"></span>
                      <span v-if="micronotFundingStatus.label" :class="micronotFundingStatus.badgeClass">
                        {{ micronotFundingStatus.label }}
                      </span>
                    </span>
                    <span
                      data-testid="WalletOverlay.micronotsNeeded"
                      :data-value="displayedMicronotsNeeded"
                      class="shrink-0 font-mono">
                      {{ micronotToArgonotNm(displayedMicronotsNeeded).format('0,0.[00000000]') }} ARGNOT
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div v-else-if="showStandardFundingBreakdown" class="px-1 py-1">
            <div class="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">ARGN</div>

            <div class="mt-2 flex items-center justify-between gap-x-4 text-sm">
              <span class="text-slate-700">Required</span>
              <span
                data-testid="WalletOverlay.microgonsNeeded"
                :data-value="minimumMicrogonsNeeded"
                class="shrink-0 font-mono text-slate-900">
                  {{ microgonToArgonNm(minimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN
              </span>
            </div>

            <div class="mt-3 border-t border-slate-300/60 pt-2">
              <div class="flex items-center justify-between gap-x-4 text-sm font-semibold text-slate-900">
                <span class="inline-flex items-center gap-x-2">
                  <span>{{ microgonNeededLabel }}</span>
                  <span v-if="microgonFundingStatus.dotClass" :class="microgonFundingStatus.dotClass"></span>
                  <span v-if="microgonFundingStatus.label" :class="microgonFundingStatus.badgeClass">
                    {{ microgonFundingStatus.label }}
                  </span>
                </span>
                <span
                  data-testid="WalletOverlay.microgonsNeeded"
                  :data-value="displayedMicrogonsNeeded"
                  class="shrink-0 font-mono">
                  {{ microgonToArgonNm(displayedMicrogonsNeeded).format('0,0.[00000000]') }} ARGN
                </span>
              </div>
            </div>

            <template v-if="minimumMicronotsNeeded > 0n">
              <div class="mt-4 pt-4">
                <div class="text-xs font-semibold uppercase tracking-wide text-slate-500">ARGNOT</div>
                <div class="mt-2 flex items-center justify-between gap-x-4 text-sm">
                  <Tooltip
                    v-if="walletId === WalletType.miningHold"
                    asChild
                    side="top"
                    content="Mining bids require a set number of argonots per bid to be held during a mining term. Once complete, they are released back into your custody.">
                    <span class="inline-flex min-w-0 cursor-help items-center gap-x-2 text-slate-700">
                      <span class="flex h-4 w-4 shrink-0 items-center justify-center opacity-70">
                        <span class="origin-center scale-[0.57]">
                          <CheckboxGray :isChecked="true" />
                        </span>
                      </span>
                      <span>Mining Bids</span>
                    </span>
                  </Tooltip>
                </div>

                <div class="mt-3 border-t border-slate-300/60 pt-2">
                  <div class="flex items-center justify-between gap-x-4 text-sm font-semibold text-slate-900">
                    <span class="inline-flex items-center gap-x-2">
                      <span>{{ micronotNeededLabel }}</span>
                      <span v-if="micronotFundingStatus.dotClass" :class="micronotFundingStatus.dotClass"></span>
                      <span v-if="micronotFundingStatus.label" :class="micronotFundingStatus.badgeClass">
                        {{ micronotFundingStatus.label }}
                      </span>
                    </span>
                    <span
                      data-testid="WalletOverlay.micronotsNeeded"
                      :data-value="displayedMicronotsNeeded"
                      class="shrink-0 font-mono">
                      {{ micronotToArgonotNm(displayedMicronotsNeeded).format('0,0.[00000000]') }} ARGNOT
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div v-else class="px-1 py-1">
            <div class="mt-5 flex items-center gap-x-2 text-sm font-semibold text-slate-900">
              <span class="inline-block h-2.5 w-2.5 rounded-full bg-green-500"></span>
              <span>No additional funding needed</span>
            </div>

            <div class="mt-5 border-t border-slate-300/60 pt-4 space-y-3 text-sm">
              <div class="flex items-center justify-between gap-x-4">
                <span class="text-slate-700">ARGN required</span>
                <span class="shrink-0 font-mono text-slate-900">
                  {{ microgonToArgonNm(minimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN
                </span>
              </div>

              <div v-if="minimumMicronotsNeeded > 0n" class="flex items-center justify-between gap-x-4">
                <span class="text-slate-700">ARGNOT required</span>
                <span class="shrink-0 font-mono text-slate-900">
                  {{ micronotToArgonotNm(minimumMicronotsNeeded).format('0,0.[00000000]') }} ARGNOT
                </span>
              </div>
            </div>
          </div>

          <button
            @click="closeOverlay"
            :class="walletIsFullyFunded ? 'bg-argon-600 hover:bg-argon-700 border-argon-700 text-white' : 'bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 text-slate-900'"
            class="w-full mt-8 inner-button-shadow px-4 py-2 rounded-lg focus:outline-none cursor-pointer"
          >
            Close Wallet
          </button>

        </div>
      </div>

      <div class="-mt-3 -mb-5 -mr-5 flex w-1/4 shrink-0 self-stretch border-l border-slate-200/70 bg-slate-50">
        <div class="w-full px-5 pt-4 pb-6 text-md">
          <div class="space-y-3 font-mono ">
            <div class="flex items-center justify-between gap-x-4 mt-3">
              <div class="min-w-0">
                <div class="  font-semibold text-slate-900">ARGN</div>
                <div v-if="lockedMicrogons > 0n" class="mt-1 text-xs text-slate-500">
                  locked
                  <span class=" text-slate-700">
                    {{ microgonToArgonNm(lockedMicrogons).format('0,0.[00000000]') }}
                  </span>
                </div>
              </div>
              <div class="   text-slate-900 text-right">
                {{ microgonToArgonNm(availableMicrogons).format('0,0.[00000000]') }}
              </div>
            </div>

            <div class="flex items-center justify-between gap-x-4 py-3">
              <div class="min-w-0">
                <div class="  font-semibold text-slate-900">ARGNOT</div>
                <div v-if="lockedMicronots > 0n" class="mt-1 text-xs text-slate-500">
                  locked
                  <span class="font-mono text-slate-700">
                    {{ micronotToArgonotNm(lockedMicronots).format('0,0.[00000000]') }}
                  </span>
                </div>
              </div>
              <div class="text-slate-900 text-right">
                {{ micronotToArgonotNm(availableMicronots).format('0,0.[00000000]') }}
              </div>
            </div>
          </div>

          <img
            :src="qrCode"
            :alt="`QR code for ${walletName} wallet address`"
            class="mt-5 w-full p-3 border-t pt-8 border-slate-300"
          />
          <CopyToClipboard
            data-testid="walletAddress"
            :content="wallet.address"
            class="relative cursor-pointer py-1">
            <div class="text-center">
              <div class="inline-flex max-w-full items-center gap-x-2 text-sm text-slate-700">
                <span class="truncate">
                  {{ abbreviateAddress(wallet.address, 6) }}
                </span>
                <span class="inline-flex shrink-0 items-center text-argon-600">
                  <CopyIcon class="h-4 w-4" />
                </span>
              </div>
            </div>
            <template #copied>
              <div class="absolute inset-0 flex items-center justify-center bg-slate-50/95">
                <div class="inline-flex max-w-full items-center gap-x-2 text-sm text-slate-700">
                  <span class="truncate">
                    {{ abbreviateAddress(wallet.address, 6) }}
                  </span>
                  <span class="inline-flex shrink-0 items-center text-argon-600">
                    <CopyIcon class="h-4 w-4" />
                  </span>
                </div>
              </div>
            </template>
          </CopyToClipboard>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import QRCode from 'qrcode';
import { getConfig } from '../stores/config';
import { useWallets } from '../stores/wallets';
import { getCurrency } from '../stores/currency';
import { abbreviateAddress } from '../lib/Utils';
import OverlayBase from '../overlays-shared/OverlayBase.vue';
import CopyIcon from '../assets/copy.svg?component';
import CopyToClipboard from '../components/CopyToClipboard.vue';
import AlertIcon from '../assets/alert.svg?component';
import { createNumeralHelpers } from '../lib/numeral';
import Checkbox from '../components/Checkbox.vue';
import CheckboxGray from '../components/CheckboxGray.vue';
import Tooltip from '../components/Tooltip.vue';
import { bigIntMax, MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import { getBiddingCalculator } from '../stores/mainchain.ts';
import basicEmitter from '../emitters/basicEmitter';
import { OperationalStepId, useOperationsController } from '../stores/operationsController.ts';
import { WalletType } from '../lib/Wallet.ts';
import { MiningSetupStatus, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import InstructionsIcon from '../assets/instructions.svg?component';
import { open as tauriOpen } from '@tauri-apps/plugin-shell';
import AlertCalloutButton from '../components/AlertCalloutButton.vue';
import { useBasics } from '../stores/basics.ts';

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

const walletId: Vue.Ref<WalletType.miningHold | WalletType.vaulting> = Vue.ref(WalletType.miningHold);

const config = getConfig();
const basics = useBasics();
const wallets = useWallets();
const currency = getCurrency();
const controller = useOperationsController();
const calculator = getBiddingCalculator();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const qrCode = Vue.ref('');
const requiredMicrogonsForGoal = Vue.ref(0n);
const requiredMicronotsForGoal = Vue.ref(0n);
const showJurisdictionAlert = Vue.ref(false);
const includeVaultTreasuryBondSuggestion = Vue.ref(true);

const futureTransactionFeeBudgetMicrogons = 2n * BigInt(MICROGONS_PER_ARGON);
const treasuryBondSuggestionIncrementMicrogons = 100n * BigInt(MICROGONS_PER_ARGON);

const showSuggestedFundingAdditions = Vue.computed(() => {
  return (
    (walletId.value === WalletType.vaulting && config.vaultingSetupStatus !== VaultingSetupStatus.Finished) ||
    (walletId.value === WalletType.miningHold && config.miningSetupStatus !== MiningSetupStatus.Finished)
  );
});

const vaultTreasuryBondSuggestionMicrogons = Vue.computed(() => {
  const suggestedMicrogons = (config.vaultingRules?.baseMicrogonCommitment ?? 0n) / 20n;
  if (suggestedMicrogons <= 0n) return 0n;

  return (
    ((suggestedMicrogons + treasuryBondSuggestionIncrementMicrogons - 1n) / treasuryBondSuggestionIncrementMicrogons) *
    treasuryBondSuggestionIncrementMicrogons
  );
});

const showVaultTreasuryBondSuggestion = Vue.computed(() => {
  return (
    walletId.value === WalletType.vaulting &&
    config.vaultingSetupStatus !== VaultingSetupStatus.Finished &&
    vaultTreasuryBondSuggestionMicrogons.value > 0n
  );
});

const onboardingAdditionalMicrogons = Vue.computed(() => {
  if (!showSuggestedFundingAdditions.value) {
    return 0n;
  }

  return (
    futureTransactionFeeBudgetMicrogons +
    (showVaultTreasuryBondSuggestion.value && includeVaultTreasuryBondSuggestion.value
      ? vaultTreasuryBondSuggestionMicrogons.value
      : 0n)
  );
});

const baseMinimumMicrogonsNeeded = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    const baseAmountNeeded = requiredMicrogonsForGoal.value;
    return baseAmountNeeded + (config.biddingRules?.sidelinedMicrogons ?? 0n);
  } else if (walletId.value === 'vaulting') {
    return config.vaultingRules?.baseMicrogonCommitment || 0n;
  }
  return 0n;
});

const fundingPlanDescription = Vue.computed(() => {
  if (isFundingCompleteView.value) {
    if (walletId.value === WalletType.vaulting) {
      return 'This wallet is fully funded for your current vault configuration.';
    }

    return 'This wallet is fully funded for your current mining configuration.';
  }

  if (walletId.value === WalletType.vaulting) {
    return 'These are the funding requirements for your vault. The total lines show what is still needed.';
  }

  return 'These are the funding requirements for your mining wallet. The total lines show what is still needed.';
});

const minimumMicrogonsNeeded = Vue.computed(() => {
  return baseMinimumMicrogonsNeeded.value + onboardingAdditionalMicrogons.value;
});

const minimumMicronotsNeeded = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    const baseAmountNeeded = requiredMicronotsForGoal.value;
    return baseAmountNeeded + (config.biddingRules?.sidelinedMicronots ?? 0n);
  } else if (walletId.value === 'vaulting') {
    return config.vaultingRules?.baseMicronotCommitment || 0n;
  }
  return 0n;
});

const lockedMicrogons = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    const sidelined = config.biddingRules?.sidelinedMicrogons ?? 0n;
    return wallets.miningBidMicrogons + wallets.miningSeatMicrogons + sidelined;
  } else {
    return wallets.vaultingWallet.reservedMicrogons || 0n;
  }
});

const lockedMicronots = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    const sidelined = config.biddingRules?.sidelinedMicronots ?? 0n;
    return wallets.miningBidMicronots + wallets.miningSeatMicronots + sidelined;
  } else {
    return wallets.vaultingWallet.reservedMicronots || 0n;
  }
});

const walletAllocatedMicrogons = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    return wallets.totalMiningMicrogons || 0n;
  } else if (walletId.value === 'vaulting') {
    return wallets.totalVaultingMicrogons || 0n;
  }
  return 0n;
});

const walletAllocatedMicronots = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    return wallets.totalMiningMicronots || 0n;
  } else if (walletId.value === 'vaulting') {
    return wallets.vaultingWallet.reservedMicronots || 0n;
  }
  return 0n;
});

const remainingMicrogonsNeeded = Vue.computed(() => {
  return bigIntMax(0n, minimumMicrogonsNeeded.value - walletAllocatedMicrogons.value);
});

const remainingMicronotsNeeded = Vue.computed(() => {
  return bigIntMax(0n, minimumMicronotsNeeded.value - walletAllocatedMicronots.value);
});

const displayedMicrogonsNeeded = Vue.computed(() => {
  return getNeededDisplayAmount(
    minimumMicrogonsNeeded.value,
    walletAllocatedMicrogons.value,
    remainingMicrogonsNeeded.value,
  );
});

const displayedMicronotsNeeded = Vue.computed(() => {
  return getNeededDisplayAmount(
    minimumMicronotsNeeded.value,
    walletAllocatedMicronots.value,
    remainingMicronotsNeeded.value,
  );
});

const microgonNeededLabel = Vue.computed(() => {
  return getNeededLineLabel(minimumMicrogonsNeeded.value, walletAllocatedMicrogons.value);
});

const micronotNeededLabel = Vue.computed(() => {
  return getNeededLineLabel(minimumMicronotsNeeded.value, walletAllocatedMicronots.value);
});

const microgonFundingStatus = Vue.computed(() => {
  return getFundingStatusLabel(minimumMicrogonsNeeded.value, walletAllocatedMicrogons.value, availableMicrogons.value);
});

const micronotFundingStatus = Vue.computed(() => {
  return getFundingStatusLabel(minimumMicronotsNeeded.value, walletAllocatedMicronots.value, availableMicronots.value);
});

const walletName = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    return 'Mining';
  } else if (walletId.value === 'vaulting') {
    return 'Vaulting';
  }
});

const wallet = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    return wallets.miningHoldWallet;
  } else {
    return wallets.vaultingWallet;
  }
});

const availableMicrogons = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    return wallets.miningHoldSpendableMicrogons + wallets.miningBotWallet.availableMicrogons;
  } else {
    return wallets.vaultingWallet.availableMicrogons;
  }
});

const availableMicronots = Vue.computed(() => {
  if (walletId.value === 'miningHold') {
    return wallets.miningHoldWallet.availableMicronots + wallets.miningBotWallet.availableMicronots;
  } else {
    return wallets.vaultingWallet.availableMicronots;
  }
});

const walletIsFullyFunded = Vue.computed(() => {
  if (walletAllocatedMicronots.value < minimumMicronotsNeeded.value) return false;
  if (walletAllocatedMicrogons.value < minimumMicrogonsNeeded.value) return false;
  return true;
});

const isFundingCompleteView = Vue.computed(() => {
  return !showSuggestedFundingAdditions.value && walletIsFullyFunded.value;
});

const showOnboardingFundingBreakdown = Vue.computed(() => {
  return showSuggestedFundingAdditions.value;
});

const showStandardFundingBreakdown = Vue.computed(() => {
  return !showSuggestedFundingAdditions.value && !isFundingCompleteView.value;
});

async function openUniswapInstructions() {
  if (config.isValidJurisdiction) {
    await tauriOpen('https://argon.network/documentation/from-uniswap');
  } else {
    showJurisdictionAlert.value = !showJurisdictionAlert.value;
  }
}

function openJurisdictionOverlay() {
  closeOverlay();
  basicEmitter.emit('openJurisdictionOverlay');
}

let calculatorIsSubscribed = false;
let calculatorLoadSubscription: { unsubscribe: () => void } | null = null;

async function load() {
  try {
    await loadQRCode();
  } catch (error) {
    console.error('Failed to load onboarding wallet QR code', error);
  }

  if (walletId.value === 'miningHold' && !calculatorIsSubscribed) {
    calculatorIsSubscribed = true;
    await config.isLoadedPromise;

    calculatorLoadSubscription = calculator.onLoad(() => {
      const projections = calculator.runProjections(config.biddingRules, 'maximum');
      requiredMicrogonsForGoal.value = projections.microgonRequirement;
      requiredMicronotsForGoal.value = projections.micronotRequirement;
    });

    await calculator.load();
  }
}

Vue.onUnmounted(() => {
  calculatorLoadSubscription?.unsubscribe();
});

async function loadQRCode() {
  let address = '';
  if (walletId.value === 'miningHold') {
    address = wallets.miningHoldWallet.address;
  } else if (walletId.value === 'vaulting') {
    address = wallets.vaultingWallet.address;
  }
  qrCode.value = await QRCode.toDataURL(address, {
    margin: 0,
    color: {
      dark: '#0f172a',
      light: '#0000',
    },
  });
}

function closeOverlay() {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

basicEmitter.on('openWalletOverlay', async data => {
  if (data.screen !== 'receive-onboarding') return;

  walletId.value = data.walletType;
  await load();
  isOpen.value = true;
  isLoaded.value = true;
  showJurisdictionAlert.value = false;
  basics.overlayIsOpen = true;
});

function getFundingStatusLabel(amountNeeded: bigint, walletAllocated: bigint, available: bigint) {
  if (!amountNeeded) {
    return {
      label: '',
      badgeClass: '',
      dotClass: '',
    };
  }

  if (walletAllocated >= amountNeeded) {
    return {
      label: '',
      badgeClass: '',
      dotClass: 'inline-block h-2.5 w-2.5 rounded-full bg-green-500',
    };
  }

  if (available > 0n) {
    return {
      label: 'partially funded',
      badgeClass:
        'fade-in-out rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-red-700',
      dotClass: '',
    };
  }

  return {
    label: 'waiting',
    badgeClass:
      'fade-in-out rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-red-700',
    dotClass: '',
  };
}

function getNeededLineLabel(amountNeeded: bigint, walletAllocated: bigint) {
  if (!amountNeeded) {
    return 'Total Needed';
  }

  if (walletAllocated >= amountNeeded) {
    return 'Fully Funded';
  }

  if (walletAllocated > 0n && walletAllocated < amountNeeded) {
    return 'Still Needed';
  }

  return 'Total Needed';
}

function getNeededDisplayAmount(amountNeeded: bigint, walletAllocated: bigint, remainingNeeded: bigint) {
  if (amountNeeded && walletAllocated >= amountNeeded) {
    return amountNeeded;
  }

  return remainingNeeded;
}
</script>

<style scoped>
@reference "../main.css";

span[tag] {
  @apply ml-1 rounded-full px-2 text-xs font-bold text-white uppercase;
}

.fade-in-out {
  animation: fadeInOut 1s ease-in-out infinite;
  animation-delay: 0s;
}

@keyframes fadeInOut {
  0% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.3;
  }
}
</style>
