<template>
  <OverlayBase :isOpen="true" class="BondDetailOverlay min-h-48 w-180" @close="emit('close')" @pressEsc="emit('close')">
    <template #title>
      <span class="text-xl font-bold text-slate-800/80">Bond Details</span>
    </template>

    <div class="flex flex-row gap-8 px-10 pt-6 pb-8">
      <div class="relative w-28 shrink-0 pt-1">
        <BondIcon class="w-28 opacity-50" />
      </div>

      <div class="grow">
        <div class="flex items-baseline gap-2">
          <span class="text-argon-600 font-mono text-2xl font-bold">
            <template v-if="bondLot.programType === 'Argonot'">
              {{ micronotToArgonotNm(bondLot.bondMicrogons).format('0,0.00') }} ARGNOT
            </template>
            <template v-else>
              {{ currency.symbol }}{{ microgonToMoneyNm(bondLot.bondMicrogons).format('0,0.00') }}
            </template>
          </span>
          <span class="text-sm text-slate-500">{{ numeral(bondLot.bonds).format('0,0') }} bonds</span>
        </div>

        <div class="mt-1 text-sm font-light text-slate-400">Purchased {{ purchasedAtLabel }}</div>

        <div class="mt-4 grid grid-cols-3 gap-4 rounded-lg bg-slate-50 px-4 py-3 text-sm">
          <div>
            <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Program</div>
            <div class="mt-1 text-slate-700">{{ bondProgramLabel }}</div>
          </div>

          <div>
            <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Created</div>
            <div class="mt-1 text-slate-700">Frame {{ bondLot.createdFrame }}</div>
          </div>

          <div>
            <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Last Paid</div>
            <div class="mt-1 text-slate-700">
              {{ bondLot.lastEarningsFrame == null ? 'Not yet' : `Frame ${bondLot.lastEarningsFrame}` }}
            </div>
          </div>

          <div>
            <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Purchase Price</div>
            <div class="mt-1 font-medium text-slate-700">
              <template v-if="bondLot.programType === 'Argonot'">
                {{ micronotToArgonotNm(bondLot.bondMicrogons).format('0,0.00') }} ARGNOT
              </template>
              <template v-else>
                {{ currency.symbol }}{{ microgonToMoneyNm(bondLot.bondMicrogons).format('0,0.00') }}
              </template>
            </div>
          </div>

          <div>
            <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Lifetime Distributions</div>
            <div class="mt-1 font-medium text-slate-700">
              {{ currency.symbol }}{{ microgonToMoneyNm(bondLot.lifetimeEarnings).format('0,0.00') }}
            </div>
          </div>

          <div v-if="bondLot.programType === 'Vault'">
            <div class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Lifetime Return</div>
            <div class="mt-1 font-medium text-slate-700">{{ numeral(lifetimeReturnPct).format('0,0.00') }}%</div>
          </div>
        </div>

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
    </div>

    <div
      v-if="canLiquidate && !isLiquidating"
      class="flex items-start justify-between gap-4 border-t border-slate-200 px-10 py-4"
    >
      <div class="text-sm text-slate-500">Liquidate this bond lot to schedule its return from Treasury Bonds.</div>
      <button
        type="button"
        class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded px-5 py-2 text-sm font-semibold text-white"
        @click="liquidateBondLot"
      >
        Liquidate Bond Lot
      </button>
    </div>

    <div v-if="liquidationError" class="border-t border-slate-200 px-10 py-4">
      <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {{ liquidationError }}
      </div>
    </div>

    <div v-if="isLiquidating" class="space-y-3 border-t border-slate-200 px-10 py-5">
      <div class="text-sm font-medium text-slate-600">Liquidating bond lot...</div>
      <ProgressBar :progress="liquidationProgressPct" :hasError="!!liquidationError" />
      <div class="text-xs text-slate-500">{{ liquidationProgressLabel }}</div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import OverlayBase from '../../overlays/OverlayBase.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import BondIcon from '../../assets/bond.svg?component';
import { getCurrency } from '../../stores/currency.ts';
import { getMainchainClient, getMiningFrames } from '../../stores/mainchain.ts';
import { getVaults } from '../../stores/vaults.ts';
import { BondLot, TreasuryBonds } from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { getWalletKeys } from '../../stores/wallets.ts';
import { getTransactionTracker } from '../../stores/transactions.ts';
import { ExtrinsicType, TransactionStatus } from '../../lib/db/TransactionsTable.ts';
import { type TransactionInfo } from '../../lib/TransactionInfo.ts';
import { generateProgressLabel } from '../../lib/Utils.ts';
import { getArgonBonds } from '../../stores/argonBonds.ts';

dayjs.extend(utc);

const currency = getCurrency();
const miningFrames = getMiningFrames();
const vaults = getVaults();
const walletKeys = getWalletKeys();
const transactionTracker = getTransactionTracker();
const argonBonds = getArgonBonds();

const { microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const props = defineProps<{
  bondLot: BondLot;
}>();

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

const releaseAtLabel = Vue.computed(() => {
  if (props.bondLot.releaseFrame == null) return '';
  return dayjs.utc(miningFrames.getFrameDate(props.bondLot.releaseFrame)).local().format('M/D/YYYY [at] h:mm a');
});

const bondProgramLabel = Vue.computed(() => {
  if (props.bondLot.programType === 'Argonot') {
    return 'ARGNOT-backed Argon Bond';
  }

  const vaultId = props.bondLot.vaultId;
  if (vaultId == null) {
    return 'Vault Bond';
  }

  const vault = vaults.vaultsById[vaultId];
  const name = vault?.name?.trim();
  return name ? `${name} Vault` : `Vault #${vaultId}`;
});

const lifetimeReturnPct = Vue.computed(() => {
  if (props.bondLot.bondMicrogons <= 0n) return 0;

  return BigNumber(props.bondLot.lifetimeEarnings).dividedBy(props.bondLot.bondMicrogons).multipliedBy(100).toNumber();
});

const canLiquidate = Vue.computed(() => {
  return props.bondLot.isOwn && props.bondLot.canRelease && !props.bondLot.isReleasing;
});

function trackLiquidationTxInfo(info: TransactionInfo) {
  unsubscribeLiquidationProgress?.();
  isLiquidating.value = true;
  let didSaveLiquidation = false;

  unsubscribeLiquidationProgress = info.subscribeToProgress(async (args, error) => {
    liquidationProgressPct.value = args.progressPct;
    liquidationProgressLabel.value = generateProgressLabel(args.confirmations, args.expectedConfirmations);

    if (error) {
      liquidationError.value = error.message || 'Unable to liquidate bond lot.';
      isLiquidating.value = false;
      return;
    }

    if (args.progressPct >= 100 && !didSaveLiquidation) {
      didSaveLiquidation = true;
      try {
        await argonBonds.saveBondLiquidation(props.bondLot, info);
      } catch (saveError) {
        console.error('Unable to save finalized bond liquidation history', saveError);
      }
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
    const client = await getMainchainClient(false);
    const signer = await walletKeys.getDefaultArgonKeypair();
    const tx = await TreasuryBonds.buildReleaseBondLotTx({ client, bondLotId: props.bondLot.id });
    const info = await transactionTracker.submitAndWatch({
      tx,
      txSigner: signer,
      extrinsicType: ExtrinsicType.TreasuryReleaseBondLot,
      metadata: {
        bondLotId: props.bondLot.id,
        releasedBondMicrogons: props.bondLot.bondMicrogons,
      },
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
  await transactionTracker.load();

  const pendingLiquidationTxInfo = transactionTracker.findLatestTxInfo<{
    bondLotId?: number;
    releasedBondMicrogons?: bigint;
  }>(candidate => {
    if (candidate.tx.extrinsicType !== ExtrinsicType.TreasuryReleaseBondLot) return false;
    if (candidate.tx.accountAddress !== walletKeys.defaultArgonAddress) return false;
    if (candidate.tx.metadataJson?.bondLotId !== props.bondLot.id) return false;
    if ((candidate.tx.metadataJson?.releasedBondMicrogons ?? 0n) <= 0n) return false;
    if (candidate.tx.submissionErrorJson || candidate.tx.blockExtrinsicErrorJson) return false;
    return candidate.tx.status === TransactionStatus.Submitted || candidate.tx.status === TransactionStatus.InBlock;
  });

  if (pendingLiquidationTxInfo) {
    trackLiquidationTxInfo(pendingLiquidationTxInfo);
  }
});

Vue.onUnmounted(() => {
  unsubscribeLiquidationProgress?.();
});
</script>
