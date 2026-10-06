<template>
  <OverlayBase :isOpen="true" title="Configure Your Stabilization Vault" class="w-240" @close="cancelPanel">
    <div class="flex flex-col px-10 py-5">
      <div ref="editBoxParent" class="relative flex flex-col pt-3">
        <p class="leading-relaxed font-light">
          Vaults are special holding mechanisms that stabilize the Argon stablecoin and provide liquidity to the broader
          network. You can earn revenue by creating and managing these vaults.
          <a href="https://argon.network/docs/system-design/economic-drivers#Vaulting" target="_blank">Learn more.</a>
        </p>
        <div class="mt-5 border-b border-slate-200" />
        <div class="mt-5 flex flex-col gap-6">
          <div>
            <div class="flex items-center">
              <div class="mb-2 flex grow items-center gap-1 font-bold text-gray-600/60">
                <label>ARGN Securitization</label>
                <Tooltip as-child side="top">
                  <button type="button" class="inline-flex cursor-help" aria-label="ARGN securitization details">
                    <InformationCircleIcon class="size-3.5" />
                  </button>
                  <template #content>ARGN securitization supports Bitcoin locks and treasury bonds.</template>
                </Tooltip>
              </div>
              <button
                type="button"
                :disabled="isSaving"
                class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm"
                @click="rules.baseMicrogonCommitment = minimumSecuritization"
              >
                Min
              </button>
              <span class="mx-3 h-4 border-l border-gray-300" />
              <Tooltip as-child side="top">
                <span class="inline-flex cursor-help items-center gap-0.5 text-sm">
                  <button
                    type="button"
                    :disabled="isSaving"
                    class="text-argon-600 hover:text-argon-700 cursor-pointer"
                    @click="rules.baseMicrogonCommitment = certificationSecuritization"
                  >
                    Certification
                  </button>
                  <button type="button" class="inline-flex cursor-help" aria-label="Certification guidance">
                    <InformationCircleIcon class="size-3.5 text-gray-400" />
                  </button>
                </span>
                <template #content>Sets securitization to the amount needed for Treasury Certification.</template>
              </Tooltip>
              <span class="mx-3 h-4 border-l border-gray-300" />
              <button
                type="button"
                :disabled="isSaving || walletMaximum < minimumSecuritization"
                class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm disabled:text-gray-400"
                @click="rules.baseMicrogonCommitment = walletMaximum"
              >
                Max
              </button>
            </div>
            <InputToken
              data-testid="vault-create-argn"
              v-model="rules.baseMicrogonCommitment"
              :min="minimumSecuritization"
              :disabled="isSaving"
              suffix=" ARGN"
              :minDecimals="0"
              :maxDecimals="1"
              class="px-1 py-2 text-[17px]!"
            />
            <div class="mt-2 text-sm text-gray-600/70">
              Bitcoin Capacity:
              <template v-if="currency.isLoaded">
                {{
                  numeral(currency.convertMicrogonTo(bitcoinCapacityMicrogons, UnitOfMeasurement.BTC)).format(
                    '0,0.[0000]',
                  )
                }}
                BTC
              </template>
              <template v-else>&mdash;</template>
            </div>
          </div>
          <div>
            <div class="flex items-center">
              <div class="mb-2 flex grow items-center gap-1 font-bold text-gray-600/60">
                <label>ARGNOT Securitization</label>
                <Tooltip as-child side="top">
                  <button type="button" class="inline-flex cursor-help" aria-label="ARGNOT securitization details">
                    <InformationCircleIcon class="size-3.5" />
                  </button>
                  <template #content>ARGNOT securitization maximizes your vault’s share of network revenue.</template>
                </Tooltip>
              </div>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  :disabled="isSaving || maximumReturnsMicronots === undefined"
                  class="text-argon-600 hover:text-argon-700 cursor-pointer text-sm disabled:text-gray-400"
                  @click="rules.baseMicronotCommitment = maximumReturnsMicronots!"
                >
                  Max Returns
                </button>
                <Tooltip as-child side="top">
                  <button type="button" class="text-argon-600 inline-flex cursor-help" aria-label="ARGNOT guidance">
                    <InformationCircleIcon class="size-3.5" />
                  </button>
                  <template #content>
                    <template v-if="maximumReturnsMicronots !== undefined">
                      Lock {{ micronotToArgonotNm(maximumReturnsMicronots).format('0,0.[0]') }} ARGNOT to maximize your
                      vault’s earnings. ARGNOT securitization is optional.
                    </template>
                    <template v-else>Max Returns guidance is unavailable.</template>
                  </template>
                </Tooltip>
              </div>
            </div>
            <InputToken
              data-testid="vault-create-argnot"
              v-model="rules.baseMicronotCommitment"
              :min="0n"
              :disabled="isSaving"
              suffix=" ARGNOT"
              :minDecimals="0"
              :maxDecimals="1"
              class="px-1 py-2 text-[17px]!"
            />
            <div class="mt-2 text-sm text-gray-600/70">
              <template v-if="maximumReturnsMicronots !== undefined">
                {{ micronotToArgonotNm(maximumReturnsMicronots).format('0,0.[0]') }} ARGNOT for Max Returns
              </template>
              <template v-else>Max Returns guidance is unavailable.</template>
            </div>
          </div>
        </div>
        <div class="mt-5 border-b border-slate-200" />
        <div class="mt-5 flex items-center gap-2">
          <span class="inline-flex items-center gap-1 font-bold text-gray-600/60">
            Bitcoin Locking Fee:
            <Tooltip as-child side="top">
              <button type="button" class="inline-flex cursor-help" aria-label="Bitcoin locking fee details">
                <InformationCircleIcon class="size-3.5" />
              </button>
              <template #content>
                Paid to your vault when someone locks Bitcoin. Includes a flat ARGN fee and a percentage fee.
              </template>
            </Tooltip>
          </span>
          <span ref="feeEditAnchor" data-testid="fee-edit-preview" class="group inline-flex items-center">
            <button
              type="button"
              aria-label="Edit Bitcoin locking fee"
              :disabled="isSaving"
              @click="openFeeEditor"
              class="text-argon-700/80 inline-flex cursor-pointer items-center gap-2 font-mono text-lg font-bold"
            >
              {{ currency.symbol }}{{ microgonToMoneyNm(rules.btcFlatFee).format('0,0.00') }} +
              {{ numeral(rules.btcPctFee).format('0.[00]') }}%
              <EditIcon class="text-argon-600/50 h-4.5 w-4.5 opacity-0 group-hover:opacity-100" />
            </button>
          </span>
        </div>
        <section class="border-argon-600/30 mt-6 rounded-md border">
          <div class="flex flex-row py-7 text-center">
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">TERM</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">1 YEAR+</div>
              <div class="inline-flex items-center gap-1 text-sm font-light opacity-80">
                Requires Exit Notice
                <Tooltip as-child side="top">
                  <button type="button" class="inline-flex cursor-help" aria-label="Withdrawal notice details">
                    <InformationCircleIcon class="size-3.5" />
                  </button>
                  <template #content>
                    Withdrawals require a one year exit notice. ARGNOT above max rewards are available for immediate
                    withdrawal.
                  </template>
                </Tooltip>
              </div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">AVG VAULT RETURNS</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                <template v-if="projectionsReady">
                  {{ numeral(vaultingStats.averageAPR).format('0,0.0') }}% APR
                </template>
                <template v-else>&mdash;</template>
              </div>
              <div class="text-sm font-light opacity-80">Based on Past Performance</div>
            </div>
            <div class="min-h-full min-w-px bg-slate-600/20" />
            <div class="w-1/3 px-3">
              <header class="text-sm font-bold opacity-40">PROJECTED EARNINGS</header>
              <div class="text-argon-600 py-1 text-3xl font-bold">
                <template v-if="projectionsReady">
                  +{{ currency.symbol }}{{ microgonToMoneyNm(projectedEarningsMicrogons).format('0,0') }}
                </template>
                <template v-else>&mdash;</template>
              </div>
              <a
                href="https://argon.network/docs/system-design/economic-drivers#Vaulting"
                target="_blank"
                rel="noopener noreferrer"
                class="text-argon-600 inline-flex cursor-pointer items-center gap-1 text-sm font-light underline"
              >
                Modeled Over One Year
                <ArrowTopRightOnSquareIcon class="h-3 w-3" />
              </a>
            </div>
          </div>
        </section>
        <div v-if="projectionError" class="mt-2 text-sm text-slate-500">
          Returns are unavailable.
          <button type="button" class="text-argon-600 cursor-pointer underline" @click="retryProjections">Retry</button>
        </div>
        <EditBoxOverlay
          v-if="feeEditorPosition"
          id="btcLockingFees"
          :position="feeEditorPosition"
          @close="feeEditorPosition = undefined"
        />
      </div>
      <div v-if="savingError" class="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {{ savingError }}
      </div>
      <div class="mt-3 flex flex-row items-center justify-end gap-x-3 py-3">
        <button
          type="button"
          :disabled="isSaving"
          @click="cancelPanel"
          class="cursor-pointer rounded-md border border-slate-300 px-10 py-2 text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="isSaving || !!feeEditorPosition || rules.baseMicrogonCommitment < minimumSecuritization"
          @click="saveRules"
          class="bg-argon-button enabled:hover:bg-argon-button-hover cursor-pointer rounded-md px-10 py-2 font-semibold text-white disabled:opacity-40"
        >
          {{ isSaving ? 'Saving...' : 'Confirm Settings »' }}
        </button>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import BigNumber from 'bignumber.js';
import { ArrowTopRightOnSquareIcon, InformationCircleIcon } from '@heroicons/vue/24/outline';
import { bigIntMax, bigNumberToBigInt, JsonExt, TreasuryBonds, UnitOfMeasurement } from '@argonprotocol/apps-core';
import EditIcon from '../assets/edit.svg?component';
import InputToken from '../components/InputToken.vue';
import Tooltip from '../components/Tooltip.vue';
import type { IVaultingRules } from '../interfaces/IVaultingRules.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import EditBoxOverlay from '../overlays/EditBoxOverlay.vue';
import OverlayBase from '../overlays/OverlayBase.vue';
import { getArgonBonds } from '../stores/argonBonds.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import { getCurrency } from '../stores/currency.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { useWallets } from '../stores/wallets.ts';
import { MyVault } from '../lib/MyVault.ts';

const emit = defineEmits<{ close: [] }>();
const config = getConfig();
const currency = getCurrency();
const wallets = useWallets();
const controller = useCertificationController();
const argonBonds = getArgonBonds();
const vaultingStats = useVaultingStats();
const { micronotToArgonotNm, microgonToMoneyNm } = createNumeralHelpers(currency);
const rules = Vue.computed(() => config.vaultingRules as IVaultingRules);
const previousRules = JsonExt.stringify(rules.value);
const minimumSecuritization = 2_000_000_000n;
const certificationSecuritization = Vue.computed(() =>
  bigIntMax(minimumSecuritization, controller.rewardConfig.operationalMinimumVaultSecuritization),
);
const walletMaximum = Vue.computed(() =>
  bigIntMax(0n, wallets.defaultArgonWallet.availableMicrogons - MyVault.setupFeeBudgetMicrogons),
);
const bitcoinCapacityMicrogons = Vue.computed(() =>
  bigNumberToBigInt(BigNumber(rules.value.baseMicrogonCommitment).div(rules.value.securitizationRatio)),
);
const maximumReturnsMicronots = Vue.computed(() =>
  TreasuryBonds.getVaultArgonotSecuritizationTarget({
    securitizationMicrogons: rules.value.baseMicrogonCommitment,
    averageMicrogonsPerArgonot: argonBonds.data.averageMicrogonsPerArgonot,
  }),
);
const projectedEarningsMicrogons = Vue.computed(() =>
  bigNumberToBigInt(BigNumber(rules.value.baseMicrogonCommitment).times(vaultingStats.averageAPR).div(100)),
);

const isSaving = Vue.ref(false);
const savingError = Vue.ref('');
const projectionsReady = Vue.ref(false);
const projectionError = Vue.ref(false);
const editBoxParent = Vue.ref<HTMLElement>();
const feeEditAnchor = Vue.ref<HTMLElement>();
const feeEditorPosition = Vue.ref<{ top: number; left: number; width: number }>();

function cancelPanel() {
  if (isSaving.value || feeEditorPosition.value) return;
  config.vaultingRules = JsonExt.parse<IVaultingRules>(previousRules);
  emit('close');
}

async function saveRules() {
  if (isSaving.value || feeEditorPosition.value || rules.value.baseMicrogonCommitment < minimumSecuritization) return;
  isSaving.value = true;
  savingError.value = '';
  try {
    await config.saveVaultingRules();
    emit('close');
  } catch (error) {
    savingError.value = error instanceof Error ? error.message : 'Unable to save vault settings.';
  } finally {
    isSaving.value = false;
  }
}

function openFeeEditor() {
  const parent = editBoxParent.value!.getBoundingClientRect();
  const anchor = feeEditAnchor.value!.getBoundingClientRect();
  feeEditorPosition.value = { top: anchor.top - parent.top, left: anchor.left - parent.left, width: parent.width / 2 };
}

async function retryProjections() {
  projectionError.value = false;
  try {
    await vaultingStats.update();
    projectionsReady.value = true;
  } catch {
    projectionError.value = true;
  }
}

void vaultingStats.isLoadedPromise
  .then(() => {
    projectionsReady.value = true;
  })
  .catch(() => {
    projectionError.value = true;
  });
</script>
