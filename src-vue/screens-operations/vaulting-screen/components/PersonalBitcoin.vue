<!-- prettier-ignore -->
<template>
  <section class="grow flex flex-col">
    <div v-if="!lockStatus" class="grow flex flex-row items-center justify-start px-[3%] py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-col items-start justify-center grow pr-16 text-argon-800/70">
        <div class="text-xl font-bold opacity-60">No Bitcoin Attached to this Vault</div>
        <div class="font-light">
          Vaults require bitcoin in order to function properly and generate revenue<br/>
          opportunities for their owners. Click the button to add one.
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
          <div class="opacity-60 w-fit pr-10">
            Your Liquid Locking Request Is Being Processed on Argon...
          </div>
          <div class="flex flex-row items-center justify-start w-full mt-2">
            <ProgressBar :progress="bitcoinLockProcessingPercent" :showLabel="false" class="h-4" />
          </div>
        </div>
        <div class="flex flex-row space-x-2 items-center justify-end grow">
          <button @click="showLockingOverlay" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">
            View Details
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="lockStatus === BitcoinLockStatus.LockReadyForBitcoin" class="grow flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 relative top-px fade-in-out" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-60 border-b border-argon-600/20 pb-1.5 mb-1.5">Your
          {{ numeral(currency.convertSatToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Is Ready to
          Finish Locking</div>
        <div class="relative text-argon-700/80 pt-0.5 font-bold text-md pointer-events-none fade-in-out">Actively Monitoring Network for Incoming Bitcoin</div>
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
    <div v-else-if="lockStatus === BitcoinLockStatus.LockIsProcessingOnBitcoin" @click="showLockingOverlay" class="grow cursor-pointer hover:bg-white/50 row flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 opacity-80 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow pr-5">
          <div class="text-xl font-bold opacity-60 pb-1.5">
            Your {{ numeral(currency.convertSatToBtc(personalLock?.lockDetails?.satoshis ?? personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} In BTC
            Is Being Processed by Bitcoin's Network
          </div>
          <ProgressBar :progress="bitcoinLockProcessingPercent" />
        </div>
      </div>
    </div>
    <div v-else-if="[BitcoinLockStatus.LockedAndIsMinting, BitcoinLockStatus.LockedAndMinted].includes(lockStatus!)" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5">
      <BitcoinIcon class="w-22 inline-block mr-5 -rotate-24 opacity-60" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-60">
          {{ numeral(currency.convertSatToBtc(personalLock?.lockedUtxoSatoshis ?? personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Locked
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
    <div v-else-if="lockStatus === BitcoinLockStatus.ReleaseIsProcessingOnArgon" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
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
        </div>
      </div>
    </div>
    <div v-else-if="lockStatus === BitcoinLockStatus.ReleaseIsWaitingForVault" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 opacity-60 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center mr-5">
          <div class="opacity-60 w-fit pr-20">
            Your Unlocking Request Is Being Processed on Argon...
          </div>
          <div class="flex flex-row items-center justify-start w-full mt-2">
            <ProgressBar :progress="requestBitcoinReleaseByVaultProgress" :showLabel="false" class="h-4" />
          </div>
        </div>
        <div class="flex flex-row space-x-2 items-center justify-end grow">
          <button @click="showLockingOverlay" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">
            View Details
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="lockStatus === BitcoinLockStatus.ReleaseSigned" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full fade-in-out" v-if="!personalLock?.releaseError">
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
        <div  class="flex flex-col items-start justify-center grow  opacity-80 font-bold " v-if="personalLock?.releaseError">
          <div class="text-xl">Releasing has Failed.</div>
          <div class="text-md font-normal mt-2 text-red-700">
            Technical details: {{ personalLock.releaseError }}
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="lockStatus === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin" @click="showReleaseOverlay" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/70 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.convertSatToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]')
            }} BTC <span class="font-light opacity-60">(Step 4 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-center w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-60">Finalizing On Bitcoin</div>
            <ProgressBar :progress="releasingBitcoinDetails.progressPct" class="!h-6 mt-0.5" />
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Overlays -->

  <BitcoinLockingOverlay
    v-if="doShowLockingOverlay"
    :personalLock="personalLock"
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

const bitcoinLockProcessingPercent = Vue.ref(0);
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
import BitcoinLockingOverlay from '../../../overlays/BitcoinLockingOverlay.vue';
import BitcoinUnlockingOverlay from '../../../overlays/BitcoinUnlockingOverlay.vue';
import BitcoinIcon from '../../../assets/wallets/bitcoin-thin.svg?component';
import { BitcoinLockStatus } from '../../../lib/db/BitcoinLocksTable.ts';
import ProgressBar from '../../../components/ProgressBar.vue';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { getMiningFrames } from '../../../stores/mainchain.ts';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const myVault = getMyVault();
const miningFrames = getMiningFrames();
const vaults = getVaults();
const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();

function showLockingOverlay() {
  doShowReleaseOverlay.value = false;
  doShowLockingOverlay.value = true;
}
function showReleaseOverlay() {
  doShowLockingOverlay.value = false;
  doShowReleaseOverlay.value = true;
}

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const personalLock = Vue.computed(() => {
  if (bitcoinLocks.data.pendingLock) {
    return bitcoinLocks.data.pendingLock;
  }

  const locks = bitcoinLocks.data.locksByUtxoId;
  for (const lock of Object.values(locks)) {
    if (
      lock.vaultId === myVault.vaultId &&
      ![BitcoinLockStatus.LockFailedToHappen, BitcoinLockStatus.ReleaseComplete].includes(lock.status)
    ) {
      return lock;
    }
  }
});

const lockExpirationTime = Vue.ref(dayjs.utc());
const lockInitializeExpirationTime = Vue.ref(dayjs.utc().add(1, 'day'));

function updateBitcoinLockProcessingPercent() {
  if (!personalLock.value) return 0;
  const details = bitcoinLocks.getLockProcessingDetails(personalLock.value);
  bitcoinLockProcessingPercent.value = details.progressPct;
  // blockConfirmations.value = details.blockConfirmations;
}

const lockStatus = Vue.computed(() => {
  if (
    !personalLock.value ||
    [BitcoinLockStatus.LockFailedToHappen, BitcoinLockStatus.ReleaseComplete].includes(personalLock.value.status)
  ) {
    return null;
  }
  return personalLock.value.status;
});

const releasingBitcoinDetails = Vue.computed<{ progressPct: number; confirmations: number }>(() => {
  const lock = personalLock.value;
  if (!lock) return { progressPct: 0, confirmations: 0 };
  return bitcoinLocks.getReleaseProcessingDetails(lock);
});

const requestBitcoinReleaseByVaultProgress = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return 0;
  return bitcoinLocks.getRequestReleaseByVaultProgress(lock, miningFrames);
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
    const expirationMillis = bitcoinLocks.approximateExpirationTime(lock);
    lockExpirationTime.value = dayjs.utc(expirationMillis);
  }
}

async function updateBitcoinUnlockPrices() {
  const lock = personalLock.value;
  if (!lock) return;

  btcMarketRate.value = await vaults.getMarketRateInMicrogons(lock.lockedUtxoSatoshis ?? lock.satoshis).catch(() => 0n);

  if (lock.status !== BitcoinLockStatus.LockedAndIsMinting && lock.status !== BitcoinLockStatus.LockedAndMinted) {
    unlockPrice.value = 0n;
    return;
  }
  const vaultingAddress = getWalletKeys().vaultingAddress;
  const unlockFee = await bitcoinLocks.estimatedReleaseArgonTxFee({ lock: lock, vaultingAddress }).catch(() => 0n);
  unlockPrice.value = (await vaults.getRedemptionRate(lock).catch(() => 0n)) + unlockFee;
}

function closeLockingOverlay() {
  doShowLockingOverlay.value = false;
}

function closeReleaseOverlay() {
  doShowReleaseOverlay.value = false;
}

let updateBitcoinLockProcessingInterval: ReturnType<typeof setInterval> | undefined;

Vue.onMounted(async () => {
  await myVault.load();
  await myVault.subscribe();
  await bitcoinLocks.load();

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
      void loadPersonalUtxo();
      void updateBitcoinUnlockPrices();
    },
    { deep: true },
  );

  await loadPersonalUtxo();
  await updateBitcoinUnlockPrices();

  updateBitcoinLockProcessingInterval = setInterval(updateBitcoinLockProcessingPercent, 1e3);
  updateBitcoinLockProcessingPercent();
});

Vue.onUnmounted(() => {
  myVault.unsubscribe();
  bitcoinLocks.unsubscribeFromArgonBlocks();
  if (updateBitcoinLockProcessingInterval) {
    clearInterval(updateBitcoinLockProcessingInterval);
  }
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
