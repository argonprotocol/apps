<!-- Legacy reference component. Not imported by the current app. Kept for historical/design reference only. -->
<!-- prettier-ignore -->
<template>
  <section
    class="grow flex flex-col"
    data-testid="PersonalBitcoin"
    :data-lock-state="lockState"
    :data-lock-utxo-id="personalLock?.utxoId ?? ''"
    :data-is-locked="isLockedStatus ? 'true' : 'false'">
    <div v-if="!lockStatus" class="grow flex flex-row items-center justify-start px-[3%] py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-col items-start justify-center grow pr-16 text-argon-800/70">
        <div class="text-xl font-bold opacity-60">No Bitcoin Attached to this Vault</div>
        <div class="font-light">
          Vaults need Bitcoin to operate and generate revenue.<br/>
          Click the button to add one.
        </div>
      </div>
      <div class="flex flex-col items-center justify-center">
        <button @click="showLockingOverlay" class="bg-argon-600 text-white whitespace-nowrap text-lg font-bold px-12 py-2 rounded-md cursor-pointer">Add a Bitcoin</button>
      </div>
    </div>
    <div v-else-if="lockStatus === BitcoinLockStatus.LockIsProcessingOnArgon" @click="showLockingOverlay" class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] py-5! border-[1.5px] border-dashed border-slate-900/30 hover:bg-white/30! cursor-pointer m-0.5">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 opacity-60 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center mr-5">
          <div class="opacity-60 w-fit pr-10">Your lock request is being processed on Argon...</div>
          <div class="flex flex-row items-center justify-start w-full mt-2">
            <ProgressBar :progress="lockProcessingStep.progressPct" :showLabel="false" class="h-4" />
          </div>
        </div>
        <div class="flex flex-row space-x-2 items-center justify-end grow">
          <button @click="showLockingOverlay" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">
            View Details
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="showCheckingFundingStatus" class="grow flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 relative top-px opacity-70" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-60 border-b border-argon-600/20 pb-1.5 mb-1.5">
          Checking Your Bitcoin Deposit Status
        </div>
        <div class="flex flex-row items-center gap-2 text-argon-700/80 pt-0.5 font-bold text-md">
          <Spinner class="h-4 w-4" />
          <span>Confirming the latest Bitcoin funding state</span>
        </div>
      </div>
      <div class="flex flex-col items-center justify-center">
        <div class="opacity-40 italic mt-2.5">
          Expires in
          <CountdownClock :time="lockInitializeExpirationTime" v-slot="{ days, hours, minutes }">
            <template v-if="days > 0">
              {{ days }} day{{days === 1 ? '' : 's'}}
            </template>
            <template v-else>
              {{ hours }}h {{ minutes }}m
            </template>
          </CountdownClock>
        </div>
      </div>
    </div>
    <div v-else-if="showReadyForBitcoin" class="grow flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 relative top-px fade-in-out" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-60 border-b border-argon-600/20 pb-1.5 mb-1.5">Your
          {{ numeral(currency.convertSatToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Is Ready to
          Lock</div>
        <div class="relative text-argon-700/80 pt-0.5 font-bold text-md pointer-events-none fade-in-out">Watching for your Bitcoin deposit</div>
      </div>
      <div class="flex flex-col items-center justify-center">
        <button @click="showLockingOverlay" class="whitespace-nowrap bg-argon-600 text-white text-lg font-bold px-5 lg:px-10 py-2 rounded-md cursor-pointer relative top-1">
          Finish Locking
        </button>
        <div class="opacity-40 italic mt-2.5">
          Expires in
          <CountdownClock :time="lockInitializeExpirationTime" v-slot="{ days, hours, minutes }">
            <template v-if="days > 0">
              {{ days }} day{{days === 1 ? '' : 's'}}
            </template>
            <template v-else>
              {{ hours }}h {{ minutes }}m
            </template>
          </CountdownClock>
        </div>
      </div>
    </div>
    <div v-else-if="showMismatchAccept" @click="showLockingOverlay" class="grow cursor-pointer hover:bg-white/50 row flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 opacity-80 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow pr-5">
          <div class="text-xl font-bold opacity-70 pb-1.5">
            Updating Lock on Argon
          </div>
          <ProgressBar :progress="mismatchAcceptStep.progressPct" />
          <div v-if="mismatchAcceptStep.error" class="mt-2 text-sm font-semibold text-red-600">
            {{ mismatchAcceptStep.error }}
          </div>
        </div>
        <div class="flex flex-row space-x-2 items-center justify-end">
          <button @click="showLockingOverlay" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">
            View Status
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="showFundingMismatch" @click="handleMismatchCardClick" class="grow cursor-pointer hover:bg-white/50 row flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon
          class="w-22 inline-block mr-7 -rotate-24 relative top-px"
          :class="mismatchCanAct ? 'opacity-80 fade-in-out' : 'opacity-65'" />
        <div class="flex flex-col items-start justify-center grow pr-5">
          <div class="text-xs font-light tracking-wide text-argon-700 uppercase">{{ mismatchCardEyebrow }}</div>
          <div class="text-xl font-bold pb-1" :class="mismatchCanAct ? 'text-argon-700' : 'text-slate-800/70'">
            {{ mismatchCardTitle }}
          </div>
          <div v-if="mismatchDepositReturned" class="text-slate-700/90">
            Returned <span class="font-mono font-semibold text-slate-900">{{ mismatchObservedBtcLabel }} BTC</span>.
          </div>
          <div v-else class="text-slate-700/90">
            Expected <span class="font-mono font-semibold text-slate-900">{{ mismatchReservedBtcLabel }} BTC</span>.
            Received <span class="font-mono font-semibold text-slate-900">{{ mismatchObservedBtcLabel }} BTC</span>.
          </div>
          <div v-if="mismatchDifferenceSummary && !mismatchDepositReturned" class="mt-1 text-sm text-slate-600">
            <span class="font-mono font-semibold text-argon-700">{{ mismatchDifferenceSummary }}</span>.
            {{ mismatchNextStepText }}
          </div>
          <div v-else-if="mismatchDepositReturned" class="mt-1 text-sm text-slate-600">
            {{ mismatchNextStepText }}
          </div>
          <div v-if="mismatchError" class="mt-1 text-sm font-semibold text-red-700">
            {{ mismatchError }}
          </div>
          <div v-if="showMismatchReturnProgress" class="mt-2 w-full pr-5">
            <ProgressBar :progress="mismatchReturnProgress.progressPct" :showLabel="false" class="h-3.5" />
            <div v-if="mismatchReturnProgress.error" class="mt-1 text-xs font-semibold text-red-700">
              {{ mismatchReturnProgress.error }}
            </div>
            <div v-else class="mt-1 text-xs text-slate-500">{{ mismatchReturnProgress.label }}</div>
          </div>
          <div
            v-else-if="!mismatchCanAct && !showFundingReadyToResume && !mismatchDepositReturned"
            class="mt-2 w-full pr-5">
            <ProgressBar
              v-if="showMismatchConfirmationProgress"
              :progress="lockProcessingStep.progressPct"
              :showLabel="false"
              class="h-3.5" />
            <div v-if="showMismatchConfirmationProgress" class="mt-1 text-xs text-slate-500">{{ mismatchConfirmationLabel }}</div>
            <div v-else class="mt-1 flex items-center gap-2 text-xs text-slate-500">
              <Spinner class="h-4 w-4" />
              <span>{{ mismatchConfirmationLabel }}</span>
            </div>
          </div>
        </div>
        <div class="flex flex-row space-x-2 items-center justify-end">
          <button @click.stop="handleMismatchCardClick" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 whitespace-nowrap py-2 rounded-md cursor-pointer">
            {{ mismatchCardCtaLabel }}
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="showFundingExpired" class="grow flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 relative top-px opacity-65" />
      <div class="flex flex-col items-start justify-center grow pr-5">
        <div class="text-xs font-light tracking-wide text-argon-700 uppercase">
          {{ mismatchDepositReturned ? 'Return Complete' : 'Funding Expired' }}
        </div>
        <div class="text-xl font-bold pb-1 text-slate-800/70">
          {{ mismatchDepositReturned ? 'Mismatch Bitcoin Deposit Returned' : 'Bitcoin Funding Window Expired' }}
        </div>
        <div class="text-slate-700/90">
          {{
            mismatchDepositReturned
              ? `Returned ${mismatchObservedBtcLabel} BTC after this funding request expired.`
              : 'No Bitcoin was confirmed before this lock expired.'
          }}
        </div>
        <div class="mt-1 text-sm text-slate-600">
          {{ mismatchDepositReturned ? 'This notice can be cleared now.' : 'Review the details, then clear this notice when you are ready.' }}
        </div>
      </div>
      <div class="flex flex-row space-x-2 items-center justify-end">
        <button
          @click="acknowledgeExpiredNotice"
          class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">
          Clear Notice
        </button>
      </div>
    </div>
    <div v-else-if="showFundingReadyToResume" @click="showLockingOverlay" class="grow cursor-pointer hover:bg-white/50 row flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 relative top-px opacity-80" />
        <div class="flex flex-col items-start justify-center grow pr-5">
          <div class="text-xs font-light tracking-wide text-argon-700 uppercase">Return Complete</div>
          <div class="text-xl font-bold pb-1 text-argon-700">Mismatch Bitcoin Deposit Returned</div>
          <div class="text-slate-700/90">Your mismatch Bitcoin deposit was returned. Resume funding when you're ready.</div>
        </div>
        <div class="flex flex-row space-x-2 items-center justify-end">
          <button @click="showLockingOverlay" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">
            Resume Lock Funding
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="showFundingBitcoinProcessing" @click="showLockingOverlay" class="grow cursor-pointer hover:bg-white/50 row flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 opacity-80 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow pr-5">
          <div class="text-xl font-bold opacity-60 pb-1.5">
            <template v-if="isFundingSeenInMempoolOnly">
              Your
              {{ numeral(currency.convertSatToBtc(personalLock?.lockDetails?.satoshis ?? personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }}
              BTC deposit was seen in Bitcoin's mempool
            </template>
            <template v-else>
              Your {{ numeral(currency.convertSatToBtc(personalLock?.lockDetails?.satoshis ?? personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC
              deposit is being confirmed on Bitcoin
            </template>
          </div>
          <div v-if="isFundingSeenInMempoolOnly" class="flex flex-row items-center gap-2 text-slate-500">
            <Spinner class="h-4 w-4" />
            <span>Waiting for the first Bitcoin block...</span>
          </div>
          <ProgressBar v-else :progress="lockProcessingStep.progressPct" />
        </div>
      </div>
    </div>
    <div v-else-if="isLockedStatus" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5">
      <BitcoinIcon class="w-22 inline-block mr-5 -rotate-24 opacity-60" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-60">
          {{ numeral(currency.convertSatToBtc(fundingUtxoRecord?.satoshis ?? personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Locked
          (Value = {{ currency.symbol }}{{ microgonToMoneyNm(btcMarketRate).format('0,0.[00]') }})
        </div>
        <div class="opacity-40">
          {{ currency.symbol}}{{ microgonToMoneyNm(personalLock?.liquidityPromised ?? 0n).format('0,0.[00]') }} Liquidity {{ lockStatus === BitcoinLockStatus.LockedAndIsMinting ? 'Promised' : 'Received'}}
          /
          {{ currency.symbol }}{{ microgonToMoneyNm(unlockPrice).format('0,0.[00]') }} to Unlock
        </div>
      </div>
      <div class="flex flex-col gap-x-3 xl:flex-row-reverse items-center justify-center whitespace-nowrap">
        <div class="flex flex-row space-x-2 items-center justify-center">
          <button @click="showReleaseOverlay" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">Unlock Bitcoin</button>
          <!-- <span class="opacity-40">or</span>
          <button class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">Ratchet</button> -->
        </div>
        <div class="opacity-40 italic mt-1">
          Expires in
          <CountdownClock :time="lockExpirationTime" v-slot="{ hours, minutes, days }">
            <template v-if="days === 0">
              {{ hours }}h {{ minutes }}m
            </template>
            <template v-else>
              {{ days }} Day{{ days > 1 ? 's' : '' }}
            </template>
          </CountdownClock>
        </div>
      </div>
    </div>
    <div v-else-if="isReleasingOnArgon && !isWaitingForVaultCosign" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full fade-in-out">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.convertSatToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]')
            }} BTC <span class="font-light opacity-60">(Step 1 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-start w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-80 font-bold text-argon-600">Requesting Release from Argon Network</div>
          </div>
          <div class="flex flex-row items-center justify-start w-full pr-5 mt-2">
            <ProgressBar :progress="bitcoinLockProgress.getUnlockProgressPct(lockStatus)" :showLabel="false" class="h-4" />
          </div>
          <div v-if="argonReleaseStep.error" class="mt-2 text-sm font-semibold text-red-600">
            {{ argonReleaseStep.error }}
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="isWaitingForVaultCosign" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 opacity-60 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center mr-5">
          <div class="opacity-60 w-fit pr-20">
            Your Unlocking Request Is Being Processed on Argon...
          </div>
          <div class="flex flex-row items-center justify-start w-full mt-2">
            <ProgressBar :progress="bitcoinLockProgress.getUnlockProgressPct(lockStatus)" :showLabel="false" class="h-4" />
          </div>
          <div v-if="vaultCosignStep.error" class="mt-2 text-sm font-semibold text-red-600">
            {{ vaultCosignStep.error }}
          </div>
        </div>
        <div class="flex flex-row space-x-2 items-center justify-end grow">
          <button @click="showReleaseOverlay" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">
            View Details
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="hasReleaseError" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full fade-in-out" v-if="!fundingUtxoRecord?.statusError">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.convertSatToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]')
            }} BTC <span class="font-light opacity-60">(Step 3 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-start w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-80 font-bold text-argon-600">Submitting Transfer to Bitcoin Network</div>
          </div>
        </div>
      </div>
      <div class="w-full flex flex-row items-center justify-center" v-else>
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
        <div class="flex flex-col items-start justify-center grow opacity-80 font-bold" v-if="fundingUtxoRecord?.statusError">
          <div class="text-xl">Unlocking Needs Attention.</div>
          <div class="text-md font-normal mt-1 text-red-700">
            Open details to retry this unlock step.
          </div>
          <div class="text-md font-normal mt-2 text-red-700">
            Technical details: {{ fundingUtxoRecord.statusError }}
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="isReleasingOnBitcoin" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/70 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.convertSatToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]')
            }} BTC <span class="font-light opacity-60">(Step 4 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-center w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-60">Finalizing On Bitcoin</div>
            <ProgressBar :progress="bitcoinLockProgress.getUnlockProgressPct(lockStatus)" class="!h-6 mt-0.5" />
          </div>
          <div v-if="bitcoinReleaseStep.error" class="mt-2 text-sm font-semibold text-red-600">
            {{ bitcoinReleaseStep.error }}
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Overlays -->

  <BitcoinLockingOverlay
    v-if="doShowLockingOverlay"
    :personalLock="lockingOverlayLock"
    :vault="myVault.createdVault!"
    @close="closeLockingOverlay"
  />

  <BitcoinUnlockingOverlay
    v-if="doShowReleaseOverlay && personalLock"
    :personalLock="personalLock"
    @close="closeReleaseOverlay"
  />

</template>

<script lang="ts">
import * as Vue from 'vue';
</script>

<script setup lang="ts">
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import { getCurrency } from '../../../stores/currency';
import numeral, { createNumeralHelpers } from '../../../lib/numeral';
import { getMyVault, getVaults } from '../../../stores/vaults.ts';
import CountdownClock from '../../../components/CountdownClock.vue';
import { getBitcoinLocks } from '../../../stores/bitcoin.ts';
import BitcoinLockingOverlay from '../../../overlays-operations/BitcoinLockingOverlay.vue';
import BitcoinUnlockingOverlay from '../../../overlays-operations/BitcoinUnlockingOverlay.vue';
import BitcoinIcon from '../../../assets/wallets/bitcoin-thin.svg?component';
import { BitcoinLockStatus } from '../../../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../../../lib/db/BitcoinUtxosTable.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { IStepProgress, useBitcoinLockProgress } from '../../../stores/bitcoinLockProgress.ts';
import Spinner from '../../../components/Spinner.vue';
import { generateProgressLabel } from '../../../lib/Utils.ts';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const myVault = getMyVault();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const bitcoinLockProgress = useBitcoinLockProgress();

const shouldStartLockingOverlayAtBeginning = Vue.ref(false);
const hasInitializedLockProgress = Vue.ref(false);

const lockingOverlayLock = Vue.computed(() => {
  if (shouldStartLockingOverlayAtBeginning.value) return undefined;
  return personalLock.value;
});

function showLockingOverlay() {
  shouldStartLockingOverlayAtBeginning.value = false;
  doShowReleaseOverlay.value = false;
  doShowLockingOverlay.value = true;
}

function startNewLocking() {
  shouldStartLockingOverlayAtBeginning.value = true;
  doShowReleaseOverlay.value = false;
  doShowLockingOverlay.value = true;
}

async function acknowledgeExpiredNotice() {
  const lock = personalLock.value;
  if (!lock) return;
  await bitcoinLocks.acknowledgeExpiredWaitingForFunding(lock).catch(() => undefined);
}

function handleMismatchCardClick() {
  if (mismatchDepositReturned.value && fundingWindowExpired.value) {
    void acknowledgeExpiredNotice();
    return;
  }
  showLockingOverlay();
}

function showReleaseOverlay() {
  doShowLockingOverlay.value = false;
  doShowReleaseOverlay.value = true;
}

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const personalLock = Vue.computed(() => {
  return bitcoinLocks.getActiveLocks()[0];
});

const lockExpirationTime = Vue.ref(dayjs.utc());
const lockInitializeExpirationTime = Vue.ref(dayjs.utc().add(1, 'day'));

const lockStatus = Vue.computed(() => {
  if (!personalLock.value || bitcoinLocks.isInactiveForVaultDisplay(personalLock.value)) {
    return null;
  }
  return personalLock.value.status;
});

const fundingUtxoRecord = Vue.computed(() => {
  if (!personalLock.value) return undefined;
  return bitcoinLocks.getAcceptedFundingRecord(personalLock.value);
});

const lockPendingFunding = Vue.computed(() => lockStatus.value === BitcoinLockStatus.LockPendingFunding);
const lockExpiredWaitingForFunding = Vue.computed(() => {
  return lockStatus.value === BitcoinLockStatus.LockExpiredWaitingForFunding;
});
const lockExpiredWaitingForFundingAcknowledged = Vue.computed(() => {
  return lockStatus.value === BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged;
});
const fundingWindowExpired = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return false;
  return bitcoinLocks.isFundingWindowExpired(lock);
});
const showFundingExpired = Vue.computed(() => {
  return (
    (lockExpiredWaitingForFunding.value || lockExpiredWaitingForFundingAcknowledged.value) && !showFundingMismatch.value
  );
});
const mismatchView = Vue.computed(() => {
  if (!personalLock.value) return undefined;
  return bitcoinLocks.getMismatchViewState(personalLock.value);
});
const showFundingReadyToResume = Vue.computed(() => mismatchView.value?.phase === 'readyToResume');
const showMismatchAccept = Vue.computed(() => mismatchView.value?.phase === 'accepting');
const showFundingMismatch = Vue.computed(() => {
  return ['review', 'returningOnArgon', 'returningOnBitcoin', 'returned', 'error'].includes(
    mismatchView.value?.phase ?? 'none',
  );
});
const hasCachedLockProgress = Vue.computed(() => {
  const utxoId = personalLock.value?.utxoId;
  return utxoId != null && bitcoinLockProgress.lock?.utxoId === utxoId;
});
const hasLockProgressReady = Vue.computed(() => {
  return hasInitializedLockProgress.value || hasCachedLockProgress.value;
});
const hasObservedFundingSignal = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return false;
  return bitcoinLocks.hasObservedFundingSignal(lock);
});
const showCheckingFundingStatus = Vue.computed(() => {
  if (!lockPendingFunding.value || !personalLock.value) return false;
  if (showFundingMismatch.value || showMismatchAccept.value) return false;
  return !hasLockProgressReady.value;
});
const showReadyForBitcoin = Vue.computed(() => {
  if (!lockPendingFunding.value || !personalLock.value) return false;
  if (showFundingMismatch.value || showMismatchAccept.value) return false;
  if (!hasLockProgressReady.value) return false;
  if (hasObservedFundingSignal.value) return false;
  return lockProcessingStep.value.confirmations < 0;
});
const showFundingBitcoinProcessing = Vue.computed(() => {
  if (!lockPendingFunding.value || !personalLock.value) return false;
  if (showFundingMismatch.value || showMismatchAccept.value) return false;
  if (!hasLockProgressReady.value) return false;
  return hasObservedFundingSignal.value || lockProcessingStep.value.confirmations >= 0;
});
const isFundingSeenInMempoolOnly = Vue.computed(() => {
  return hasObservedFundingSignal.value && lockProcessingStep.value.confirmations < 0;
});
const isLockedStatus = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return false;
  return bitcoinLocks.isLockedStatus(lock);
});

const lockState = Vue.computed(() => {
  if (!lockStatus.value) return 'None';
  return lockStatus.value;
});

const argonReleaseStep = Vue.computed<IStepProgress>(() => bitcoinLockProgress.argonRelease);

const vaultCosignStep = Vue.computed<IStepProgress>(() => bitcoinLockProgress.vaultCosign);

const lockProcessingStep = Vue.computed<IStepProgress>(() => bitcoinLockProgress.lockProcessing);
const mismatchCandidates = Vue.computed(() => mismatchView.value?.candidates ?? []);
const nextMismatchCandidate = Vue.computed(() => mismatchView.value?.nextCandidate);
const mismatchReturnRecord = Vue.computed(() => nextMismatchCandidate.value?.returnRecord);
const mismatchCandidateForDisplay = Vue.computed(
  () => nextMismatchCandidate.value?.record ?? mismatchCandidates.value[0]?.record ?? mismatchReturnRecord.value,
);
const mismatchDepositReturned = Vue.computed(
  () => mismatchView.value?.phase === 'returned' || mismatchView.value?.phase === 'readyToResume',
);
const mismatchObservedSatoshis = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return undefined;
  return (
    nextMismatchCandidate.value?.observedSatoshis ??
    mismatchCandidateForDisplay.value?.satoshis ??
    bitcoinLocks.getReceivedFundingSatoshis(lock)
  );
});
const mismatchCanAct = Vue.computed(() => {
  return (
    !!nextMismatchCandidate.value && (nextMismatchCandidate.value.canAccept || nextMismatchCandidate.value.canReturn)
  );
});
const isMismatchReturningOnArgon = Vue.computed(() => mismatchView.value?.phase === 'returningOnArgon');
const isMismatchReturningOnBitcoin = Vue.computed(() => mismatchView.value?.phase === 'returningOnBitcoin');
const showMismatchReturnProgress = Vue.computed(() => {
  return isMismatchReturningOnArgon.value || isMismatchReturningOnBitcoin.value;
});
const mismatchReturnProgress = Vue.computed(() => {
  if (isMismatchReturningOnArgon.value) {
    return {
      progressPct: bitcoinLockProgress.orphanedReturnArgon.progressPct,
      label: generateProgressLabel(
        bitcoinLockProgress.orphanedReturnArgon.confirmations,
        bitcoinLockProgress.orphanedReturnArgon.expectedConfirmations,
        {
          blockType: 'Argon',
        },
      ),
      error: bitcoinLockProgress.orphanedReturnArgon.error,
    };
  }

  if (isMismatchReturningOnBitcoin.value) {
    return {
      progressPct: bitcoinLockProgress.orphanedReturnBitcoin.progressPct,
      label: generateProgressLabel(
        bitcoinLockProgress.orphanedReturnBitcoin.confirmations,
        bitcoinLockProgress.orphanedReturnBitcoin.expectedConfirmations,
        {
          blockType: 'Bitcoin',
        },
      ),
      error: bitcoinLockProgress.orphanedReturnBitcoin.error,
    };
  }

  return {
    progressPct: 0,
    label: '',
    error: '',
  };
});
const mismatchCardEyebrow = Vue.computed(() => {
  if (showFundingReadyToResume.value) return 'Return Complete';
  if (mismatchDepositReturned.value) return 'Return Complete';
  if (showMismatchReturnProgress.value) return 'Return In Progress';
  if (fundingWindowExpired.value) {
    return 'Funding Expired';
  }
  return mismatchCanAct.value ? 'Decision Needed' : 'Mismatch Detected';
});
const mismatchCardTitle = Vue.computed(() => {
  if (showFundingReadyToResume.value || mismatchDepositReturned.value) {
    return 'Mismatch Bitcoin Deposit Returned';
  }
  if (showMismatchReturnProgress.value) {
    return 'Returning Mismatch Bitcoin Deposit';
  }
  if (fundingWindowExpired.value) {
    return mismatchCanAct.value ? 'Recovery Options Ready' : 'Preparing Recovery Options';
  }
  return 'Bitcoin Funding Mismatch';
});
const mismatchCardCtaLabel = Vue.computed(() => {
  if (showFundingReadyToResume.value) return 'Resume Funding';
  if (mismatchDepositReturned.value && fundingWindowExpired.value) return 'Clear Notice';
  if (mismatchDepositReturned.value) return 'Open Details';
  if (showMismatchReturnProgress.value) return 'View Status';
  return mismatchCanAct.value ? 'Review Options' : 'Open Details';
});
const mismatchNextStepText = Vue.computed(() => {
  if (showFundingReadyToResume.value) return 'Resume lock funding when you are ready.';
  if (mismatchDepositReturned.value) {
    return fundingWindowExpired.value
      ? 'Clear this notice when you are ready.'
      : 'Review the completed return details.';
  }
  if (isMismatchReturningOnArgon.value) {
    return 'Argon is finalizing your return request before the Bitcoin transfer is sent.';
  }
  if (isMismatchReturningOnBitcoin.value) {
    return 'The return transaction is waiting for Bitcoin confirmations.';
  }
  if (fundingWindowExpired.value) {
    return mismatchCanAct.value
      ? 'Review how to recover this Bitcoin deposit.'
      : 'We’re preparing the recovery options.';
  }
  return mismatchCanAct.value
    ? 'Choose whether to keep this Bitcoin deposit or return it.'
    : 'Once Bitcoin confirmations finish, choose whether to keep this Bitcoin deposit or return it.';
});
const mismatchConfirmationState = Vue.computed(() => {
  const candidate = mismatchCandidateForDisplay.value;
  if (!candidate) {
    return {
      showProgress: false,
      label: 'Waiting for the Bitcoin deposit to appear...',
    };
  }
  if (lockProcessingStep.value.confirmations < 0) {
    if (
      candidate.mempoolObservation &&
      !candidate.mempoolObservation.isConfirmed &&
      candidate.firstSeenBitcoinHeight <= 0
    ) {
      return {
        showProgress: false,
        label: 'Waiting for the first Bitcoin block...',
      };
    }
    if (candidate.firstSeenBitcoinHeight > 0 || candidate.mempoolObservation?.isConfirmed === true) {
      return {
        showProgress: false,
        label: 'Waiting for this Bitcoin deposit to be recognized...',
      };
    }
    return {
      showProgress: false,
      label: 'Waiting for the first Bitcoin block...',
    };
  }
  return {
    showProgress: true,
    label: generateProgressLabel(
      lockProcessingStep.value.confirmations,
      lockProcessingStep.value.expectedConfirmations,
      {
        blockType: 'Bitcoin',
      },
    ),
  };
});
const showMismatchConfirmationProgress = Vue.computed(() => mismatchConfirmationState.value.showProgress);
const mismatchConfirmationLabel = Vue.computed(() => mismatchConfirmationState.value.label);
const mismatchDifferenceSatoshis = Vue.computed(() => {
  return nextMismatchCandidate.value?.differenceSatoshis ?? undefined;
});
const mismatchReservedBtcLabel = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return '0';
  return formatCompactBtc(lock.satoshis);
});
const mismatchObservedBtcLabel = Vue.computed(() => {
  const observed = mismatchObservedSatoshis.value;
  if (observed === undefined) return '0';
  return formatCompactBtc(observed);
});
const mismatchDifferenceSummary = Vue.computed(() => {
  const diff = mismatchDifferenceSatoshis.value;
  if (diff === undefined) return '';
  return formatSatsDifference(diff);
});
const mismatchError = Vue.computed(() => mismatchView.value?.error ?? '');
const bitcoinReleaseStep = Vue.computed<IStepProgress>(() => bitcoinLockProgress.bitcoinRelease);
const mismatchAcceptStep = Vue.computed<IStepProgress>(() => bitcoinLockProgress.mismatchAcceptArgon);

const isReleasingOnArgon = Vue.computed(() => {
  const releaseStatus = fundingUtxoRecord.value?.status;
  if (hasReleaseError.value) return false;
  if (releaseStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) return true;
  if (releaseStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) return false;
  return lockStatus.value === BitcoinLockStatus.Releasing;
});
const isReleasingOnBitcoin = Vue.computed(() => {
  return fundingUtxoRecord.value?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin && !hasReleaseError.value;
});
const hasReleaseError = Vue.computed(() => {
  return !!fundingUtxoRecord.value?.statusError;
});
const isWaitingForVaultCosign = Vue.computed(() => {
  return isReleasingOnArgon.value && bitcoinLockProgress.requestReleaseByVaultProgress > 0;
});

const btcMarketRate = Vue.ref(0n);
const unlockPrice = Vue.ref(0n);

const doShowReleaseOverlay = Vue.ref(false);
const doShowLockingOverlay = Vue.ref(false);

let loadedUtxoId = 0;
async function loadPersonalUtxo() {
  const lock = personalLock.value;
  if (!lock || !lock.utxoId) return;

  if (loadedUtxoId !== lock.utxoId) {
    loadedUtxoId = lock.utxoId!;
    bitcoinLocks.confirmAddress(lock);
    lockInitializeExpirationTime.value = dayjs.utc(bitcoinLocks.verifyExpirationTime(lock!));
    const expirationMillis = bitcoinLocks.unlockDeadlineTime(lock);
    lockExpirationTime.value = dayjs.utc(expirationMillis);
  }
}

async function updateBitcoinUnlockPrices() {
  const lock = personalLock.value;
  if (!lock) return;

  const fundingSatoshis = fundingUtxoRecord.value?.satoshis ?? lock.satoshis;
  btcMarketRate.value = await vaults.getMarketRateInMicrogons(fundingSatoshis).catch(() => 0n);

  if (!isLockedStatus.value) {
    unlockPrice.value = 0n;
    return;
  }
  const liquidLockingAddress = getWalletKeys().liquidLockingAddress;
  const unlockFee = await bitcoinLocks.estimatedReleaseArgonTxFee({ lock: lock, liquidLockingAddress }).catch(() => 0n);
  unlockPrice.value = (await vaults.getRedemptionRate(lock).catch(() => 0n)) + unlockFee;
}

function closeLockingOverlay(shouldStartNewLocking = false) {
  if (shouldStartNewLocking) {
    shouldStartLockingOverlayAtBeginning.value = true;
    return;
  }
  doShowLockingOverlay.value = false;
  shouldStartLockingOverlayAtBeginning.value = false;
}

function closeReleaseOverlay() {
  doShowReleaseOverlay.value = false;
}

function formatCompactBtc(satoshis: bigint): string {
  const btc = currency.convertSatToBtc(satoshis);
  const absBtc = Math.abs(btc);
  const format = absBtc >= 0.1 ? '0,0.[000]' : absBtc >= 0.001 ? '0,0.[000000]' : '0,0.[00000000]';
  return numeral(btc).format(format);
}

function formatSatsDifference(satoshis: bigint): string {
  const absoluteSatoshis = satoshis < 0n ? -satoshis : satoshis;
  const formatted = absoluteSatoshis.toLocaleString('en-US');
  if (satoshis > 0n) return `Over by ${formatted} sats`;
  if (satoshis < 0n) return `Short by ${formatted} sats`;
  return 'Matches your requested amount';
}

let stopLockProgressTracking: (() => void) | undefined;

Vue.onMounted(async () => {
  await myVault.load();
  await bitcoinLocks.load();
  stopLockProgressTracking = bitcoinLockProgress.trackLock(personalLock.value);
  hasInitializedLockProgress.value = true;

  Vue.watch(
    currency.priceIndex,
    () => {
      void updateBitcoinUnlockPrices();
    },
    { deep: true },
  );

  Vue.watch(
    personalLock,
    () => {
      hasInitializedLockProgress.value = false;
      bitcoinLockProgress.updateLock(personalLock.value);
      hasInitializedLockProgress.value = true;
      void loadPersonalUtxo();
      void updateBitcoinUnlockPrices();
    },
    { deep: true },
  );

  await loadPersonalUtxo();
  await updateBitcoinUnlockPrices();
});

Vue.onUnmounted(() => {
  stopLockProgressTracking?.();
  stopLockProgressTracking = undefined;
});

defineExpose({
  unlockPrice,
});
</script>

<style scoped>
@reference "../../../main.css";

[box] {
  @apply rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[stat-box] {
  @apply text-argon-600 flex flex-col items-center justify-center;
  span {
    @apply text-3xl font-bold;
  }
  label {
    @apply group-hover:text-argon-600/60 mt-1 text-sm text-gray-500;
  }
}

.fade-in-out {
  animation: fadeInOut 1s ease-in-out infinite;
  &:hover {
    animation: none !important;
  }
}

@keyframes fadeInOut {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

.bitcoin-spin {
  animation: bitcoinSpin 5s ease-in-out infinite;
}

@keyframes bitcoinSpin {
  0% {
    transform: rotate(0deg);
  }
  30% {
    transform: rotate(360deg); /* 2 full rotations = 720 degrees */
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
