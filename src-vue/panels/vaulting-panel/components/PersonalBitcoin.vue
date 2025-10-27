<!-- prettier-ignore -->
<template>
  <section class="flex flex-col">
    <div v-if="personalLock?.status === BitcoinLockStatus.LockInitialized" class="grow flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 relative top-px fade-in-out" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-60 border-b border-argon-600/20 pb-1.5 mb-1.5">You're Locking {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} In BTC</div>
        <div class="relative text-argon-700/80 pt-0.5 font-bold text-md pointer-events-none fade-in-out">Actively Monitoring Network for Incoming Bitcoin</div>
      </div>
      <div class="flex flex-col items-center justify-center">
        <button @click="showFinishLockingOverlay = true" class="whitespace-nowrap bg-argon-600 text-white text-lg font-bold px-5 lg:px-10 py-2 rounded-md cursor-pointer relative top-1">
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
    <div v-else-if="!personalLock || [BitcoinLockStatus.LockVerificationExpired, BitcoinLockStatus.ReleaseComplete].includes(personalLock.status)" class="grow flex flex-row items-center justify-start px-[3%] py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-col items-start justify-center grow pr-16 text-argon-800/70">
        <div class="text-xl font-bold opacity-60">No Bitcoin Is Attached to this Vault</div>
        <div class="font-light">
          Vaults require bitcoin in order to function properly and generate revenue<br/>
          opportunities for their owners. Click the button to add.
        </div>
      </div>
      <div class="flex flex-col items-center justify-center">
        <button @click="showAddOverlay = true" class="bg-argon-600 text-white whitespace-nowrap text-lg font-bold px-12 py-2 rounded-md cursor-pointer">Add a Bitcoin</button>
      </div>
    </div>
    <div v-else-if="personalLock?.status === BitcoinLockStatus.LockProcessingOnBitcoin" @click="showFinishLockingOverlay = true" class="cursor-pointer hover:bg-white/50 row flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 opacity-80 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow pr-5">
          <div class="text-xl font-bold opacity-60 pb-1.5">
            Your {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} In BTC Is Being Processed by Bitcoin's Network
          </div>
          <ProgressBar :progress="bitcoinLockProcessingPercent" />
        </div>
      </div>
    </div>
    <div v-else-if="personalLock?.status === BitcoinLockStatus.LockReceivedWrongAmount" @click="showFinishLockingOverlay = true" class="grow text-red-700 flex flex-row items-center justify-start pl-[3%] pr-[3%] !py-5 border-[1.5px] border-dashed border-slate-900/30 m-0.5 cursor-pointer hover:bg-white/50">
      <BitcoinIcon class="w-22 inline-block mr-7 -rotate-24 opacity-80 relative top-px" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-80 border-b border-argon-600/20 pb-1.5 mb-1.5">
          Your {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Locking Failed
        </div>
        <div class="opacity-60">
          The amount of bitcoin you sent was incorrect. It could not be accepted by Argon.
        </div>
      </div>
    </div>
    <div v-else-if="[BitcoinLockStatus.LockedAndMinting, BitcoinLockStatus.LockedAndMinted].includes(personalLock?.status!)" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5">
      <BitcoinIcon class="w-22 inline-block mr-5 -rotate-24 opacity-60" />
      <div class="flex flex-col items-start justify-center grow">
        <div class="text-xl font-bold opacity-60">
          {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC Locked (Value = {{ currency.symbol }}{{ microgonToMoneyNm(btcMarketRate).format('0,0.[00]') }})
        </div>
        <div class="opacity-40">
          {{ currency.symbol}}{{ microgonToMoneyNm(personalLock?.liquidityPromised ?? 0n).format('0,0.[00]') }} Liquidity {{ personalLock?.status === BitcoinLockStatus.LockedAndMinting ? 'Promised' : 'Received'}}
          /
          {{ currency.symbol }}{{ microgonToMoneyNm(unlockPrice).format('0,0.[00]') }} to Unlock
        </div>
      </div>
      <div class="flex flex-col gap-x-3 xl:flex-row-reverse items-center justify-center whitespace-nowrap">
        <div class="flex flex-row space-x-2 items-center justify-center">
          <button @click="showReleaseOverlay=true" class="bg-argon-600 hover:bg-argon-700 text-white text-lg font-bold px-4 py-2 rounded-md cursor-pointer">Unlock Bitcoin</button>
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
    <div v-else-if="personalLock?.status === BitcoinLockStatus.ReleaseSubmittingToArgon" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full fade-in-out">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 1 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-start w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-80 font-bold text-argon-600">Requesting Release from Argon Network</div>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="personalLock?.status === BitcoinLockStatus.ReleaseWaitingForVault" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 opacity-80 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 2 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-center w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-60">Waiting for Vault</div>
            <ProgressBar :progress="requestBitcoinReleaseByVaultProgress" class="!h-6 mt-0.5" />
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="personalLock?.status === BitcoinLockStatus.ReleasedByVault" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/100 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full fade-in-out">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 3 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-start w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-80 font-bold text-argon-600">Submitting Transfer to Bitcoin Network</div>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="personalLock?.status === BitcoinLockStatus.ReleaseProcessingOnBitcoin" @click="showReleaseOverlay=true" box class="grow flex flex-row items-center justify-start pl-[5%] pr-[3%] !py-5 opacity-80 hover:opacity-100 !bg-white/50 hover:!bg-white/70 cursor-pointer">
      <div class="flex flex-row items-center justify-center w-full">
        <BitcoinIcon class="w-24 inline-block mr-7 -rotate-24 relative top-px bitcoin-spin" />
        <div class="flex flex-col items-start justify-center grow">
          <div class="text-xl font-bold opacity-60">
            Unlocking Your {{ numeral(currency.satsToBtc(personalLock?.satoshis ?? 0n)).format('0,0.[00000000]') }} BTC <span class="font-light opacity-60">(Step 4 of 4)</span>
          </div>
          <div class="flex flex-row items-center justify-center w-full pr-5 mt-1 space-x-3">
            <div class="whitespace-nowrap uppercase opacity-60">Finalizing On Bitcoin</div>
            <ProgressBar :progress="releasingBitcoinProgress" class="!h-6 mt-0.5" />
          </div>
        </div>
      </div>
    </div>
  </section>
  
  <!-- Overlays -->

  <BitcoinAddOverlay
    v-if="showAddOverlay"
    @close="closeAddOverlay"
  />

  <BitcoinFinishLockingOverlay
    v-if="showFinishLockingOverlay && personalLock"
    :lock="personalLock"
    @close="showFinishLockingOverlay = false"
  />

  <BitcoinReleaseOverlay
    v-if="showReleaseOverlay && personalLock"
    :lock="personalLock"
    @close="showReleaseOverlay = false"
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
import { useCurrency } from '../../../stores/currency';
import numeral, { createNumeralHelpers } from '../../../lib/numeral';
import { useMyVault, useVaults } from '../../../stores/vaults.ts';
import { useConfig } from '../../../stores/config.ts';
import CountdownClock from '../../../components/CountdownClock.vue';
import { useBitcoinLocks } from '../../../stores/bitcoin.ts';
import BitcoinFinishLockingOverlay from '../../../overlays/BitcoinFinishLockingOverlay.vue';
import BitcoinReleaseOverlay from '../../../overlays/BitcoinReleaseOverlay.vue';
import BitcoinAddOverlay from '../../../overlays/BitcoinAddOverlay.vue';
import BitcoinIcon from '../../../assets/wallets/bitcoin-thin.svg?component';
import { BitcoinLockStatus } from '../../../lib/db/BitcoinLocksTable.ts';
import ProgressBar from '../../../components/ProgressBar.vue';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const vault = useMyVault();
const vaults = useVaults();
const bitcoinLocks = useBitcoinLocks();
const config = useConfig();
const currency = useCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);

const personalLock = Vue.computed(() => {
  const utxoId = vault.metadata?.personalUtxoId;
  return utxoId ? bitcoinLocks.data.locksById[utxoId] : null;
});

const lockExpirationTime = Vue.ref(dayjs.utc());
const lockInitializeExpirationTime = Vue.ref(dayjs.utc().add(1, 'day'));

function updateBitcoinLockProcessingPercent() {
  if (!personalLock.value) return 0;
  bitcoinLockProcessingPercent.value = bitcoinLocks.getLockProcessingPercent(personalLock.value);
}

const releasingBitcoinProgress = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return 0;
  return bitcoinLocks.getReleaseProcessingPercent(lock);
});

const requestBitcoinReleaseByVaultProgress = Vue.computed(() => {
  const lock = personalLock.value;
  if (!lock) return 0;
  return bitcoinLocks.getRequestReleaseByVaultPercent(lock);
});

const btcMarketRate = Vue.ref(0n);
const unlockPrice = Vue.ref(0n);

const showFinishLockingOverlay = Vue.ref(false);
const showReleaseOverlay = Vue.ref(false);
const showAddOverlay = Vue.ref(false);

let loadedUtxoId = 0;
async function loadPersonalUtxo() {
  const lock = personalLock.value;
  if (!lock) return;

  if (loadedUtxoId !== lock.utxoId) {
    loadedUtxoId = lock.utxoId;
    bitcoinLocks.confirmAddress(lock);
    lockInitializeExpirationTime.value = dayjs.utc(bitcoinLocks.verifyExpirationTime(lock!));
    const expirationMillis = bitcoinLocks.approximateExpirationTime(lock);
    lockExpirationTime.value = dayjs.utc(expirationMillis);
    if (lock.status === BitcoinLockStatus.ReleasedByVault) {
      void vault.finalizeMyBitcoinUnlock({
        argonKeyring: config.vaultingAccount,
        lock: lock,
        bitcoinXprivSeed: config.bitcoinXprivSeed,
        bitcoinLocks,
      });
    }
  }
}

async function updateBitcoinUnlockPrices() {
  const lock = personalLock.value;
  if (!lock) return;

  btcMarketRate.value = await vaults.getMarketRate(lock.satoshis).catch(() => 0n);

  if (lock.status !== BitcoinLockStatus.LockedAndMinting && lock.status !== BitcoinLockStatus.LockedAndMinted) {
    unlockPrice.value = 0n;
    return;
  }
  const unlockFee = await bitcoinLocks
    .estimatedReleaseArgonTxFee({ lock: lock, argonKeyring: config.vaultingAccount })
    .catch(() => 0n);
  unlockPrice.value = (await vaults.getRedemptionRate(lock).catch(() => 0n)) + unlockFee;
}

function closeAddOverlay(shouldFinishLocking: boolean) {
  showAddOverlay.value = false;
  if (shouldFinishLocking) {
    showFinishLockingOverlay.value = true;
  }
}

Vue.onMounted(async () => {
  await vault.load();
  await vault.subscribe();
  await bitcoinLocks.load();
  await bitcoinLocks.subscribeToArgonBlocks();

  Vue.watch(currency.priceIndex.current, () => {
    void updateBitcoinUnlockPrices();
  });

  Vue.watch(personalLock, () => {
    void loadPersonalUtxo();
    void updateBitcoinUnlockPrices();
  });

  await loadPersonalUtxo();
  await updateBitcoinUnlockPrices();

  const updateBitcoinLockProcessingInterval = setInterval(updateBitcoinLockProcessingPercent, 1e3);
  Vue.onUnmounted(() => clearInterval(updateBitcoinLockProcessingInterval));
});

Vue.onUnmounted(() => {
  vault.unsubscribe();
  bitcoinLocks.unsubscribeFromArgonBlocks();
});

defineExpose({
  personalUtxo: personalLock,
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
