<template>
  <div class="flex grow flex-col py-4">
    <div class="flex grow flex-col items-center justify-center pb-[5%]">
      <p v-if="props.isSyncMode" class="text-argon-600/80 mt-5 text-center font-light">
        Click the Move arrow to transfer tokens {{ props.direction }} the
        <br />
        Ethereum Network.
        <a href="https://argon.network/" target="_blank" class="text-argon-600 underline">Learn more</a>
        .
      </p>
      <div v-else class="mt-5 text-center">
        <p class="font-light">
          Click the transfer icon above (
          <PortalIcon class="relative -top-px inline-block w-4" />
          ) to move
          <br />
          tokens between Argon and Ethereum.
        </p>
        <AlertCalloutButton
          v-if="
            [OperationalStepId.ActivateVault, OperationalStepId.FirstMiningSeat].includes(
              controller?.activeGuideId as any,
            )
          "
          :showArrow="false"
          label="Critical Alert"
          guidance="In order to count towards your bonus, these funds must originate as a Uniswap or Coinbase transaction from Ethereum. This helps the system limit fraud."
          class="mt-3 inline-block"
        />
      </div>
    </div>

    <div
      v-if="showGuidance && [WalletType.vaulting, WalletType.miningHold].includes(walletType)"
      class="text-argon-700/80 mt-5 rounded-md border border-[#CFA3EC] bg-[#FEF2FF] px-1 text-center"
    >
      <div class="border-argon-600/20 border-b py-5 text-lg font-bold">
        <div v-if="guidanceIsFullyFunded" class="flex flex-row items-center justify-center">
          <CheckBadgeIcon class="mr-1 inline-block w-8" />
          Your {{ walletType === WalletType.vaulting ? 'Vaulting' : 'Mining' }} Operations Are Fully Funded
        </div>
        <template v-else>
          {{ microgonToArgonNm(minimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN and
          {{ microgonToArgonNm(minimumMicronotsNeeded).format('0,0.[00000000]') }} ARGNOT Are Needed to
          <br />
          Launch Your {{ walletType === WalletType.vaulting ? 'Vaulting' : 'Mining' }} Operations
        </template>
      </div>
      <ul class="flex flex-row items-stretch py-1 text-center">
        <li class="hover:bg-argon-400/10 flex w-1/2 cursor-pointer flex-row items-center justify-center rounded">
          <TooltipProvider>
            <TooltipRoot :openDelay="0" :closeDelay="100" :disableClosingTrigger="true">
              <TooltipTrigger class="block w-full flex-row items-center py-1">
                <ReceiptIcon class="mr-2 inline-block w-4" />
                View Breakdown
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent
                  side="top"
                  align="start"
                  :sideOffset="-2"
                  :alignOffset="0"
                  class="data-[state=delayed-open]:data-[side=top]:animate-slideDownAndFade data-[state=delayed-open]:data-[side=right]:animate-slideLeftAndFade data-[state=delayed-open]:data-[side=left]:animate-slideRightAndFade data-[state=delayed-open]:data-[side=bottom]:animate-slideUpAndFade text-md pointer-events-none z-[2000] w-88 rounded-md border border-gray-800/20 bg-white px-4 pt-3 pb-1 text-left leading-5.5 text-gray-600 shadow-xl will-change-[transform,opacity] select-none"
                >
                  <p>
                    Your {{ walletType === WalletType.vaulting ? 'vault' : 'mining' }} operations have the following
                    funding requirements.
                  </p>
                  <table v-if="walletType === WalletType.vaulting" class="mt-4 w-full">
                    <tbody>
                      <tr>
                        <td>
                          <span class="h-4 w-4 shrink-0 opacity-70">
                            <span class="origin-center scale-[0.57]">
                              <CheckboxGray :isChecked="true" :size="4" />
                            </span>
                          </span>
                        </td>
                        <td>Bitcoin Security</td>
                        <td>{{ microgonToArgonNm(baseMinimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN</td>
                      </tr>
                      <tr>
                        <td>
                          <span class="origin-center scale-[0.57]">
                            <CheckboxGray :isChecked="true" :size="4" class="shrink-0" />
                          </span>
                        </td>
                        <td>Transactional Fees</td>
                        <td>{{ microgonToArgonNm(futureTransactionFeeBudgetMicrogons).format('0,0') }} ARGN</td>
                      </tr>
                      <tr>
                        <td>
                          <span class="origin-center scale-[0.57]">
                            <Checkbox :isChecked="includeVaultTreasuryBondSuggestion" :size="4" class="shrink-0" />
                          </span>
                        </td>
                        <td>Treasury Bonds</td>
                        <td>{{ microgonToArgonNm(vaultTreasuryBondSuggestionMicrogons).format('0,0') }} ARGN</td>
                      </tr>
                      <tr Total class="font-bold">
                        <td colspan="2">TOTAL</td>
                        <td>{{ microgonToArgonNm(minimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN</td>
                      </tr>
                    </tbody>
                  </table>
                  <table v-if="walletType === WalletType.miningHold" class="mt-4 w-full">
                    <tbody>
                      <tr>
                        <td>Mining Seats</td>
                        <td>{{ microgonToArgonNm(baseMinimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN</td>
                      </tr>
                      <tr>
                        <td>Transactional Fees</td>
                        <td>{{ microgonToArgonNm(futureTransactionFeeBudgetMicrogons).format('0,0') }} ARGN</td>
                      </tr>
                      <tr Total class="font-bold">
                        <td>TOTAL</td>
                        <td>{{ microgonToArgonNm(minimumMicrogonsNeeded).format('0,0.[00000000]') }} ARGN</td>
                      </tr>
                      <tr>
                        <td></td>
                        <td></td>
                      </tr>
                      <tr>
                        <td>Mining Seats</td>
                        <td>{{ micronotToArgonotNm(displayedMicronotsNeeded).format('0,0.[00000000]') }} ARGNOT</td>
                      </tr>
                      <tr Total class="font-bold">
                        <td>TOTAL</td>
                        <td>{{ micronotToArgonotNm(minimumMicronotsNeeded).format('0,0.[00000000]') }} ARGNOT</td>
                      </tr>
                    </tbody>
                  </table>
                  <TooltipArrow :width="24" :height="12" class="fill-white stroke-gray-400/30 shadow-xl/50" />
                </TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
          </TooltipProvider>
        </li>
        <li class="bg-argon-600/20 mx-1 w-px"></li>
        <li
          @click="openTransferGuide"
          class="hover:bg-argon-400/10 flex w-1/2 cursor-pointer flex-row items-center justify-center rounded py-1"
        >
          Open Transfer Guide
          <ExternalIcon class="ml-2 inline-block w-3.5" />
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { open as tauriOpen } from '@tauri-apps/plugin-shell';
import { CheckBadgeIcon } from '@heroicons/vue/24/outline';
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import PortalIcon from '../../../assets/portal.svg';
import ReceiptIcon from '../../../assets/receipt.svg';
import ExternalIcon from '../../../assets/external.svg';
import { IWallet, WalletType } from '../../../lib/Wallet.ts';
import { getConfig } from '../../../stores/config.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import CheckboxGray from '../../../components/CheckboxGray.vue';
import Checkbox from '../../../components/Checkbox.vue';
import { MiningSetupStatus, VaultingSetupStatus } from '../../../interfaces/IConfig.ts';
import { useWallets } from '../../../stores/wallets.ts';
import { bigIntMax } from '@argonprotocol/apps-core';
import { OperationalStepId, useOperationsController } from '../../../stores/operationsController.ts';
import AlertCalloutButton from '../../../components/AlertCalloutButton.vue';
import { IS_OPERATIONS_APP } from '../../../lib/Env.ts';
import { getBiddingCalculator } from '../../../stores/mainchain.ts';

const props = defineProps<{
  direction: 'from' | 'to';
  walletType: WalletType;
  isSyncMode?: boolean;
  showGuidance?: boolean;
}>();

const config = getConfig();
const currency = getCurrency();
const wallets = useWallets();
const controller = IS_OPERATIONS_APP ? useOperationsController() : null;
const calculator = getBiddingCalculator();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const futureTransactionFeeBudgetMicrogons = 2n * BigInt(MICROGONS_PER_ARGON);
const treasuryBondSuggestionIncrementMicrogons = 100n * BigInt(MICROGONS_PER_ARGON);
const includeVaultTreasuryBondSuggestion = Vue.ref(true);
const requiredMicrogonsForGoal = Vue.ref(0n);
const requiredMicronotsForGoal = Vue.ref(0n);

const guidanceIsFullyFunded = Vue.computed<boolean>(() => {
  if (wallet.value.availableMicrogons < minimumMicrogonsNeeded.value) {
    return false;
  } else if (wallet.value.availableMicronots < minimumMicronotsNeeded.value) {
    return false;
  }
  return true;
});

const showSuggestedFundingAdditions = Vue.computed(() => {
  return (
    (props.walletType === WalletType.vaulting && config.vaultingSetupStatus !== VaultingSetupStatus.Finished) ||
    (props.walletType === WalletType.miningHold && config.miningSetupStatus !== MiningSetupStatus.Finished)
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

const showVaultTreasuryBondSuggestion = Vue.computed(() => {
  return (
    props.walletType === WalletType.vaulting &&
    config.vaultingSetupStatus !== VaultingSetupStatus.Finished &&
    vaultTreasuryBondSuggestionMicrogons.value > 0n
  );
});

const minimumMicrogonsNeeded = Vue.computed(() => {
  return baseMinimumMicrogonsNeeded.value + onboardingAdditionalMicrogons.value;
});

const minimumMicronotsNeeded = Vue.computed(() => {
  if (props.walletType === 'miningHold') {
    const baseAmountNeeded = requiredMicronotsForGoal.value;
    return baseAmountNeeded + (config.biddingRules?.sidelinedMicronots ?? 0n);
  } else if (props.walletType === 'vaulting') {
    return config.vaultingRules?.baseMicronotCommitment || 0n;
  }
  return 0n;
});

const displayedMicronotsNeeded = Vue.computed(() => {
  return getNeededDisplayAmount(
    minimumMicronotsNeeded.value,
    walletAllocatedMicronots.value,
    remainingMicronotsNeeded.value,
  );
});

const remainingMicronotsNeeded = Vue.computed(() => {
  return bigIntMax(0n, minimumMicronotsNeeded.value - walletAllocatedMicronots.value);
});

const wallet = Vue.computed<IWallet>(() => {
  if (props.walletType === 'miningHold') {
    return wallets.miningHoldWallet;
  } else if (props.walletType === 'vaulting') {
    return wallets.vaultingWallet;
  } else {
    throw new Error(`Unsupported wallet: ${props.walletType}`);
  }
});

const walletAllocatedMicronots = Vue.computed(() => {
  if (props.walletType === 'miningHold') {
    return wallets.totalMiningMicronots || 0n;
  } else if (props.walletType === 'vaulting') {
    return wallets.vaultingWallet.reservedMicronots || 0n;
  }
  return 0n;
});

const vaultTreasuryBondSuggestionMicrogons = Vue.computed(() => {
  const suggestedMicrogons = (config.vaultingRules?.baseMicrogonCommitment ?? 0n) / 20n;
  if (suggestedMicrogons <= 0n) return 0n;

  return (
    ((suggestedMicrogons + treasuryBondSuggestionIncrementMicrogons - 1n) / treasuryBondSuggestionIncrementMicrogons) *
    treasuryBondSuggestionIncrementMicrogons
  );
});

const baseMinimumMicrogonsNeeded = Vue.computed(() => {
  if (props.walletType === WalletType.miningHold) {
    const baseAmountNeeded = requiredMicrogonsForGoal.value;
    return baseAmountNeeded + (config.biddingRules?.sidelinedMicrogons ?? 0n);
  } else if (props.walletType === WalletType.vaulting) {
    return config.vaultingRules?.baseMicrogonCommitment || 0n;
  }
  return 0n;
});

async function openTransferGuide() {
  await tauriOpen('https://argon.network/documentation/transfer-guide');
}

function getNeededDisplayAmount(amountNeeded: bigint, walletAllocated: bigint, remainingNeeded: bigint) {
  if (amountNeeded && walletAllocated >= amountNeeded) {
    return amountNeeded;
  }

  return remainingNeeded;
}

let calculatorIsSubscribed = false;
let calculatorLoadSubscription: { unsubscribe: () => void } | null = null;

async function load() {
  if (props.walletType === 'miningHold' && !calculatorIsSubscribed) {
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

Vue.onMounted(() => {
  void load();
});

Vue.onUnmounted(() => {
  calculatorLoadSubscription?.unsubscribe();
});
</script>

<style scoped>
@reference "../../../main.css";

td {
  @apply border-b border-slate-400/20 py-2;
  &:last-child {
    text-align: right;
  }
}
tr:first-child td {
  @apply border-t border-t-slate-500/20;
}
tr[Total] td {
  @apply border-b-0;
}
</style>
