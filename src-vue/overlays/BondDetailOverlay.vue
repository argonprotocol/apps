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
          {{ programType === 'Argonot' ? 'Stake' : 'Bond' }} Details
        </span>
        <span
          v-if="displayContext === 'vault' && displayedLot?.isOwn"
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
          {{ numeral(bondCount).format('0,0') }} {{ programType === 'Argonot' ? 'Stakes' : 'Bonds' }}
        </h1>
        <template v-if="displayContext === 'portfolio' && programType === 'Vault'">
          <span class="text-2xl font-light text-slate-400">&middot;</span>
          <span class="text-2xl font-light text-slate-500">Vault: {{ bondVaultLabel }}</span>
        </template>
      </div>

      <div class="mt-1 flex items-center gap-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
        <template v-if="displayedLot?.isFlexible">
          <span data-testid="Bond.details.flexible">Flexible</span>
          <template v-if="isVaultOperator">
            <span>&middot;</span>
            <span data-testid="Bond.details.flexibleDisplacement">
              <template v-if="flexibleBondDisplacementPercent === undefined">Displacement unavailable</template>
              <template v-else>{{ numeral(flexibleBondDisplacementPercent).format('0,0.[0]') }}% displaced</template>
            </span>
            <Tooltip
              :asChild="true"
              content="Flexible bonds yield capacity to regular bonds. Current displacement applies when the next frame locks its earnings terms."
              side="top"
            >
              <button type="button" aria-label="Explain flexible bond displacement" class="cursor-help">
                <InformationCircleIcon class="size-3.5" />
              </button>
            </Tooltip>
          </template>
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
            <div data-testid="Bond.details.distributions" class="py-1 text-2xl font-bold text-slate-600">
              <template v-if="lifetimeEarnings !== undefined">
                {{ microgonToArgonNm(lifetimeEarnings).formatCurrency(argonSymbol) }}
              </template>
              <template v-else>&mdash;</template>
            </div>
            <div class="text-sm text-slate-500">
              <template v-if="position?.returnIsComplete !== true">Known earnings; history incomplete</template>
              <template v-else>Earnings to date</template>
            </div>
          </div>
          <div class="min-h-full min-w-px bg-slate-600/20" />
          <div class="w-1/3 px-3">
            <header class="text-sm font-bold opacity-40">RETURN TO DATE</header>
            <div data-testid="Bond.details.return" class="py-1 text-2xl font-bold text-slate-600">
              <template v-if="returnPercent !== undefined">{{ numeral(returnPercent).format('0,0.00') }}%</template>
              <template v-else>&mdash;</template>
            </div>
            <div class="text-sm text-slate-500">
              <template v-if="position?.returnIsComplete === false">History incomplete; run Find Missing Data</template>
              <template v-else>Since purchase</template>
            </div>
          </div>
        </div>
      </section>

      <div
        v-if="displayedLot?.isReleasing && releaseAtLabel"
        class="mt-3 flex flex-row items-start gap-6 text-sm text-slate-600"
      >
        <div class="text-amber-700">
          Returning
          <span class="font-semibold">
            <template v-if="programType === 'Argonot'">
              {{ micronotToArgonotNm(displayedLot.returningBondMicrogons).format('0,0.00') }} ARGNOT
            </template>
            <template v-else>
              {{ currency.symbol }}{{ microgonToMoneyNm(displayedLot.returningBondMicrogons).format('0,0.00') }}
            </template>
          </span>
          on {{ releaseAtLabel }}
        </div>
      </div>
      <p v-if="history" class="mt-3 text-sm text-slate-500">
        Archived
        <template v-if="history.releaseBlockTime">
          · Returned {{ dayjs(history.releaseBlockTime).format('M/D/YYYY [at] h:mm a') }}
        </template>
      </p>

      <section v-if="displayedLot?.isOwn || history" class="mt-6 border-t border-slate-200 pt-4">
        <h2 class="font-bold text-slate-700">Daily Earnings</h2>
        <p v-if="!earningsHistory.isComplete" class="mt-1 text-sm text-slate-500">
          Daily history is incomplete. Run Find Missing Data to recover available records.
        </p>
        <p v-if="!dailyEarnings.length" class="mt-3 text-sm text-slate-500">No daily earnings recorded yet.</p>
        <table v-else class="mt-3 w-full text-sm tabular-nums">
          <thead class="border-b border-slate-200 text-slate-500">
            <tr>
              <th class="py-2 text-left font-medium">Date</th>
              <th class="py-2 text-right font-medium">{{ programType === 'Argonot' ? 'Stakes' : 'Bonds' }}</th>
              <th v-if="isVaultOperator" class="py-2 text-right font-medium">
                <span class="inline-flex items-center gap-1">
                  Displaced Bonds
                  <Tooltip
                    :asChild="true"
                    content="Flexible bonds displaced by other bonds during this frame. Displaced bonds do not earn for that frame."
                    side="top"
                  >
                    <button type="button" aria-label="Explain displaced bonds" class="cursor-help">
                      <InformationCircleIcon class="size-3.5" />
                    </button>
                  </Tooltip>
                </span>
              </th>
              <th class="py-2 text-right font-medium">Earnings</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 text-slate-600">
            <tr
              v-for="record in showAllEarnings ? dailyEarnings : dailyEarnings.slice(0, 5)"
              :key="record.frameId"
              :data-testid="`Bond.earnings-${record.frameId}`"
            >
              <td class="py-2">{{ dayjs(miningFrames.getFrameDate(record.frameId)).format('M/D/YYYY') }}</td>
              <td class="py-2 text-right">
                <template v-if="record.bonds != null">{{ numeral(record.bonds).format('0,0') }}</template>
                <template v-else>&mdash;</template>
              </td>
              <td v-if="isVaultOperator" class="py-2 text-right">
                <template v-if="record.displacedMicrogons != null">
                  {{ microgonToArgonNm(record.displacedMicrogons).format('0,0.[0]') }}
                </template>
                <template v-else>&mdash;</template>
              </td>
              <td class="py-2 text-right">
                <template v-if="record.earningsMicrogons != null">
                  {{ argonSymbol }}{{ microgonToArgonNm(record.earningsMicrogons).format('0,0.00[0000]') }}
                </template>
                <template v-else>Unavailable</template>
              </td>
            </tr>
          </tbody>
        </table>
        <button
          v-if="dailyEarnings.length > 5"
          type="button"
          class="text-argon-600 mt-3 cursor-pointer text-sm"
          @click="showAllEarnings = !showAllEarnings"
        >
          {{ showAllEarnings ? 'Collapse earnings' : 'Show all earnings' }}
        </button>
      </section>
    </div>

    <div class="sticky bottom-0 z-10 shrink-0 bg-white">
      <div
        v-if="canLiquidate && !isLiquidating"
        class="flex items-start justify-between gap-4 border-t border-slate-200 px-10 py-4"
      >
        <div class="text-sm text-slate-500">
          Liquidate this {{ programType === 'Argonot' ? 'stake' : 'bond' }} lot to schedule its return.
        </div>
        <button
          type="button"
          class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded px-5 py-2 text-sm font-semibold text-white"
          @click="liquidateBondLot"
        >
          Liquidate {{ programType === 'Argonot' ? 'Stake' : 'Bond' }} Lot
        </button>
      </div>

      <div v-if="liquidationError" class="border-t border-slate-200 px-10 py-4">
        <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ liquidationError }}
        </div>
      </div>

      <div v-if="isLiquidating" class="space-y-3 border-t border-slate-200 px-10 py-5">
        <div class="text-sm font-medium text-slate-600">
          Liquidating {{ programType === 'Argonot' ? 'stake' : 'bond' }} lot...
        </div>
        <ProgressBar :progress="liquidationProgressPct" :hasError="!!liquidationError" />
        <div class="text-xs text-slate-500">{{ liquidationProgressLabel }}</div>
      </div>
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
import { BondLot, MICRONOTS_PER_ARGONOT } from '@argonprotocol/apps-core';
import { getWalletKeys } from '../stores/wallets.ts';
import { type TransactionInfo } from '../lib/TransactionInfo.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { getArgonBonds, getBondTransactionOperations } from '../stores/argonBonds.ts';
import { calculatePositionReturn } from '../lib/financials/index.ts';
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
    bondLot?: BondLot;
    position?: IBondFinancialPosition;
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
const showAllEarnings = Vue.ref(false);

let unsubscribeLiquidationProgress: VoidFunction | undefined;

const displayedLot = Vue.computed(() => props.bondLot ?? props.position?.bondLot);
const history = Vue.computed(() => props.position?.history);
const lifetimeEarnings = Vue.computed(() => props.position?.paidIncome ?? displayedLot.value?.cumulativeEarnings);
const returnPercent = Vue.computed(() => {
  if (props.position) return calculatePositionReturn([props.position]).percent;
});
const lotId = Vue.computed(() => displayedLot.value?.id ?? history.value!.bondLotId);
const programType = Vue.computed(() => displayedLot.value?.programType ?? history.value!.programType);
const vaultId = Vue.computed(() => displayedLot.value?.vaultId ?? history.value?.vaultId);
const isVaultOperator = Vue.computed(() => vaultId.value != null && vaultId.value === myVault.vaultId);
const bondCount = Vue.computed(() => {
  if (displayedLot.value) return displayedLot.value.bonds;
  if (programType.value === 'Argonot') return Number(history.value!.nativePrincipal / BigInt(MICRONOTS_PER_ARGONOT));
  return BondLot.microgonsToWholeBonds(history.value!.nativePrincipal);
});
const earningsHistory = Vue.computed(() => argonBonds.getEarningsHistory(lotId.value));
const dailyEarnings = Vue.computed(() => earningsHistory.value.records.toSorted((a, b) => b.frameId - a.frameId));

const purchasedAtLabel = Vue.computed(() => {
  const createdFrame = displayedLot.value?.createdFrameId ?? history.value?.createdFrame;
  const purchase = argonBonds.data.bondHistory.find(record => record.bondLotId === lotId.value);
  const date = purchase?.purchaseBlockTime ?? props.position?.startedAt;
  if (!date && !createdFrame) return 'before frame tracking started';
  return dayjs
    .utc(date ?? miningFrames.getFrameDate(createdFrame!))
    .local()
    .format('M/D/YYYY [at] h:mm a');
});

Vue.watch(lotId, () => {
  showAllEarnings.value = false;
});

const externalMemberName = Vue.computed(() => {
  return controller.operationalInvites.find(invite => invite.defaultAccountId === displayedLot.value?.owner)?.name;
});

const bondVaultLabel = Vue.computed(() => {
  if (vaultId.value === myVault.vaultId) return 'Yours';
  if (vaultId.value == null) return 'Unknown';
  return vaults.operatorNamesByVaultId[vaultId.value] ?? `#${vaultId.value}`;
});

const releaseAtLabel = Vue.computed(() => {
  if (displayedLot.value?.releaseFrameId == null) return '';
  return dayjs
    .utc(miningFrames.getFrameDate(displayedLot.value?.releaseFrameId))
    .local()
    .format('M/D/YYYY [at] h:mm a');
});

const flexibleBondDisplacementPercent = Vue.computed(() => {
  if (!displayedLot.value?.isFlexible || vaultId.value == null) return;
  return argonBonds.getFlexibleBondDisplacementPercent(vaultId.value);
});

const canLiquidate = Vue.computed(() => {
  return props.bondLot?.canRelease && !props.bondLot.isReleasing;
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
  if (!props.bondLot || !canLiquidate.value || isLiquidating.value) return;

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
  if (!props.bondLot?.isOwn) return;
  const lotId = props.bondLot.id;
  await bondLotRelease.load();
  if (props.bondLot?.id !== lotId) return;
  const liquidationAddress =
    props.liquidationAccount === 'vaulting' ? walletKeys.vaultingAddress : walletKeys.defaultArgonAddress;

  const pendingLiquidationTxInfo = bondLotRelease.getPendingForLot(lotId, liquidationAddress);

  if (pendingLiquidationTxInfo) {
    trackLiquidationTxInfo(pendingLiquidationTxInfo);
  }
});

Vue.onUnmounted(() => {
  unsubscribeLiquidationProgress?.();
});
</script>
