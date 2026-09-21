<template>
  <OverlayBase
    :isOpen="true"
    class="BondDetailOverlay min-h-60 w-240"
    data-testid="BondDetailOverlay"
    @close="emit('close')"
    @pressEsc="emit('close')"
  >
    <template #title>
      <div class="mr-6 flex min-w-0 grow items-center justify-start gap-2">
        <span class="text-xl font-bold text-slate-800/80">
          {{ bondLot.programType === 'Argonot' ? 'Stake' : 'Bond' }} Details
        </span>
        <span
          v-if="displayContext === 'vault' && bondLot.isOwn"
          class="bg-argon-600 inline-block rounded px-1.5 pb-px align-middle text-sm text-white"
        >
          YOURS
        </span>
        <span
          v-else-if="displayContext === 'vault'"
          class="inline-block rounded bg-slate-500 px-1.5 pb-px align-middle text-sm text-white"
        >
          {{ externalMemberName ?? 'EXTERNAL' }}
        </span>
      </div>
    </template>

    <div class="px-10 py-5">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <h1 class="text-2xl font-bold text-slate-700">
          {{ numeral(bondLot.bonds).format('0,0') }} {{ bondLot.programType === 'Argonot' ? 'Stakes' : 'Bonds' }}
        </h1>
        <template v-if="displayContext === 'portfolio' && bondLot.programType === 'Vault'">
          <span class="text-2xl font-light text-slate-400">&middot;</span>
          <span class="text-2xl font-light text-slate-500">Vault: {{ bondVaultLabel }}</span>
        </template>
      </div>

      <div class="mt-1 flex items-center gap-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
        <template v-if="bondLot.isFlexible">
          <span data-testid="Bond.details.flexible">Flexible</span>
          <span>&middot;</span>
          <span data-testid="Bond.details.flexibleDisplacement">
            <template v-if="flexibleBondDisplacementPercent === undefined">Displacement unavailable</template>
            <template v-else>{{ numeral(flexibleBondDisplacementPercent).format('0,0.[00]') }}% displaced</template>
          </span>
          <Tooltip
            :asChild="true"
            content="Flexible bonds yield capacity to standard bonds. The displaced portion does not earn rewards this frame."
            side="top"
          >
            <button type="button" aria-label="Explain flexible bond displacement" class="cursor-help">
              <InformationCircleIcon class="size-3.5" />
            </button>
          </Tooltip>
          <span>&middot;</span>
        </template>
        <span>Purchased {{ purchasedAtLabel }}</span>
      </div>

      <section class="border-argon-600/30 mt-6 rounded-md border">
        <div class="flex flex-row py-6 text-center">
          <div class="w-1/3 px-3">
            <header class="text-sm font-bold opacity-40">COST BASIS</header>
            <div data-testid="Bond.details.costBasis" class="py-1 text-2xl font-bold text-slate-600">
              <template v-if="position?.investedCost !== undefined">
                {{ argonSymbol }}{{ microgonToArgonNm(position.investedCost).format('0,0.00') }}
              </template>
              <template v-else>&mdash;</template>
            </div>
            <div class="text-sm text-slate-500">At purchase</div>
          </div>
          <div class="min-h-full min-w-px bg-slate-600/20" />
          <div class="w-1/3 px-3">
            <header class="text-sm font-bold opacity-40">LIFETIME DISTRIBUTIONS</header>
            <template v-if="bondLot.isFlexible">
              <div class="py-1 text-2xl font-bold text-slate-600">Vault earnings</div>
              <div class="text-sm text-slate-500">Collected with your vault</div>
            </template>
            <template v-else>
              <div class="py-1 text-2xl font-bold text-slate-600">
                {{ argonSymbol }}{{ microgonToArgonNm(bondLot.lifetimeEarnings).format('0,0.00') }}
              </div>
              <div class="text-sm text-slate-500">Paid to the bond owner</div>
            </template>
          </div>
          <div class="min-h-full min-w-px bg-slate-600/20" />
          <div class="w-1/3 px-3">
            <header class="text-sm font-bold opacity-40">RETURN TO DATE</header>
            <template v-if="bondLot.isFlexible">
              <div data-testid="Bond.details.return" class="py-1 text-2xl font-bold text-slate-600">Rolled up</div>
              <div class="text-sm text-slate-500">Included in your vault return</div>
            </template>
            <template v-else>
              <div data-testid="Bond.details.return" class="py-1 text-2xl font-bold text-slate-600">
                <template v-if="returnPercent !== undefined">{{ numeral(returnPercent).format('0,0.00') }}%</template>
                <template v-else>&mdash;</template>
              </div>
              <div class="text-sm text-slate-500">
                <template v-if="position?.returnIsComplete === false">
                  History incomplete; run Find Missing Data
                </template>
                <template v-else>Since this bond was purchased</template>
              </div>
            </template>
          </div>
        </div>
      </section>

      <div
        v-if="bondLot.isReleasing && releaseAtLabel"
        class="mt-3 flex flex-row items-start gap-6 text-sm text-slate-600"
      >
        <div class="text-amber-700">
          Returning
          <span class="font-semibold">
            <template v-if="bondLot.programType === 'Argonot'">
              {{ micronotToArgonotNm(bondLot.returningBondMicrogons).format('0,0.00') }} ARGNOT
            </template>
            <template v-else>
              {{ currency.symbol }}{{ microgonToMoneyNm(bondLot.returningBondMicrogons).format('0,0.00') }}
            </template>
          </span>
          on {{ releaseAtLabel }}
        </div>
      </div>
    </div>

    <div
      v-if="canLiquidate && !isLiquidating"
      class="flex items-start justify-between gap-4 border-t border-slate-200 px-10 py-4"
    >
      <div class="text-sm text-slate-500">
        Liquidate this {{ bondLot.programType === 'Argonot' ? 'stake' : 'bond' }} lot to schedule its return.
      </div>
      <button
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded px-5 py-2 text-sm font-semibold text-white"
        @click="liquidateBondLot"
      >
        Liquidate {{ bondLot.programType === 'Argonot' ? 'Stake' : 'Bond' }} Lot
      </button>
    </div>

    <div v-if="liquidationError" class="border-t border-slate-200 px-10 py-4">
      <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {{ liquidationError }}
      </div>
    </div>

    <div v-if="isLiquidating" class="space-y-3 border-t border-slate-200 px-10 py-5">
      <div class="text-sm font-medium text-slate-600">
        Liquidating {{ bondLot.programType === 'Argonot' ? 'stake' : 'bond' }} lot...
      </div>
      <ProgressBar :progress="liquidationProgressPct" :hasError="!!liquidationError" />
      <div class="text-xs text-slate-500">{{ liquidationProgressLabel }}</div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { InformationCircleIcon } from '@heroicons/vue/24/outline';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import OverlayBase from './OverlayBase.vue';
import Tooltip from '../components/Tooltip.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { getCurrency } from '../stores/currency.ts';
import { UnitOfMeasurement } from '../lib/Currency.ts';
import { getMiningFrames } from '../stores/mainchain.ts';
import { getMyVault, getVaults } from '../stores/vaults.ts';
import { BondLot } from '@argonprotocol/apps-core';
import { getWalletKeys } from '../stores/wallets.ts';
import { type TransactionInfo } from '../lib/TransactionInfo.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { getArgonBonds, getBondTransactionOperations } from '../stores/argonBonds.ts';
import type { IBondFinancialPosition } from '../interfaces/IFinancialPosition.ts';
import { useCertificationController } from '../stores/certificationController.ts';

dayjs.extend(utc);

const currency = getCurrency();
const miningFrames = getMiningFrames();
const myVault = getMyVault();
const vaults = getVaults();
const walletKeys = getWalletKeys();
const bondLotRelease = getBondTransactionOperations().bondLotRelease;
const argonBonds = getArgonBonds();
const controller = useCertificationController();

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);
const argonSymbol = currency.recordsByKey[UnitOfMeasurement.ARGN].symbol;

const props = withDefaults(
  defineProps<{
    bondLot: BondLot;
    position?: IBondFinancialPosition;
    returnPercent?: number;
    displayContext?: 'portfolio' | 'vault';
    liquidationAccount?: 'default' | 'vaulting';
  }>(),
  {
    displayContext: 'portfolio',
    liquidationAccount: 'default',
  },
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'submitted'): void;
}>();

const isLiquidating = Vue.ref(false);
const liquidationError = Vue.ref('');
const liquidationProgressPct = Vue.ref(0);
const liquidationProgressLabel = Vue.ref('');

let unsubscribeLiquidationProgress: VoidFunction | undefined;

const purchasedAtLabel = Vue.computed(() => {
  if (!props.bondLot.createdFrame) return 'before frame tracking started';
  return dayjs.utc(miningFrames.getFrameDate(props.bondLot.createdFrame)).local().format('M/D/YYYY [at] h:mm a');
});

const externalMemberName = Vue.computed(() => {
  return controller.operationalInvites.find(invite => invite.defaultAccountId === props.bondLot.accountId)?.name;
});

const bondVaultLabel = Vue.computed(() => {
  if (props.bondLot.vaultId === myVault.vaultId) return 'Yours';
  return props.bondLot.vaultId == null
    ? 'Unknown'
    : (vaults.operatorNamesByVaultId[props.bondLot.vaultId] ?? `#${props.bondLot.vaultId}`);
});

const releaseAtLabel = Vue.computed(() => {
  if (props.bondLot.releaseFrame == null) return '';
  return dayjs.utc(miningFrames.getFrameDate(props.bondLot.releaseFrame)).local().format('M/D/YYYY [at] h:mm a');
});

const flexibleBondDisplacementPercent = Vue.computed(() => {
  if (!props.bondLot.isFlexible || props.bondLot.vaultId == null) return;
  return argonBonds.getFlexibleBondDisplacementPercent(props.bondLot.vaultId);
});

const canLiquidate = Vue.computed(() => {
  return props.bondLot.isOwn && props.bondLot.canRelease && !props.bondLot.isReleasing;
});

function trackLiquidationTxInfo(info: TransactionInfo) {
  unsubscribeLiquidationProgress?.();
  isLiquidating.value = true;

  unsubscribeLiquidationProgress = info.subscribeToProgress((args, error) => {
    liquidationProgressPct.value = args.progressPct;
    liquidationProgressLabel.value = generateProgressLabel(args.confirmations, args.expectedConfirmations);

    if (error) {
      liquidationError.value = error.message || 'Unable to liquidate bond lot.';
      isLiquidating.value = false;
      return;
    }

    if (args.progressPct >= 100) {
      emit('submitted');
      emit('close');
    }
  });
}

async function liquidateBondLot() {
  if (!canLiquidate.value || isLiquidating.value) return;

  liquidationError.value = '';
  liquidationProgressPct.value = 0;
  liquidationProgressLabel.value = 'Submitting transaction...';
  isLiquidating.value = true;

  try {
    const signer =
      props.liquidationAccount === 'vaulting'
        ? await walletKeys.getVaultingKeypair()
        : await walletKeys.getDefaultArgonKeypair();
    const info = await bondLotRelease.submit({
      bondLot: props.bondLot,
      txSigner: signer,
    });
    trackLiquidationTxInfo(info);
  } catch (error) {
    liquidationError.value = error instanceof Error ? error.message : 'Unable to liquidate bond lot.';
    liquidationProgressPct.value = 0;
    liquidationProgressLabel.value = '';
    isLiquidating.value = false;
  }
}

Vue.onMounted(async () => {
  await bondLotRelease.load();
  const liquidationAddress =
    props.liquidationAccount === 'vaulting' ? walletKeys.vaultingAddress : walletKeys.defaultArgonAddress;

  const pendingLiquidationTxInfo = bondLotRelease.getPendingForLot(props.bondLot.id, liquidationAddress);

  if (pendingLiquidationTxInfo) {
    trackLiquidationTxInfo(pendingLiquidationTxInfo);
  }
});

Vue.onUnmounted(() => {
  unsubscribeLiquidationProgress?.();
});
</script>
