<!-- prettier-ignore -->
<template>
  <Overlay :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-9/12">
    <template #title>
      <div class="text-2xl font-bold grow">Add Funds to Your {{ walletName }} Wallet</div>
    </template>

    <div v-if="requiresRulesToBeSet && walletId === 'mining'" class="flex flex-row items-center justify-center w-full pt-3 pb-5 px-5 gap-x-5 min-h-60">
      <div>You haven't set any bidding rules. Please do so before adding funds.</div>
    </div>
    <div v-else-if="requiresRulesToBeSet && walletId === 'vaulting'" class="flex flex-row items-start w-full pt-3 pb-5 px-5 gap-x-5 min-h-60">
      You haven't set any vaulting rules. Please do so before adding funds.
    </div>
    <div v-else class="flex flex-row items-start w-full pt-3 pb-5 px-5 gap-x-5">
      <div class="flex flex-col grow pt-2 text-md">
        <div class="w-11/12">
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

          <p v-if="walletId === 'mining'" class="mt-2 font-light">
            Based on the rules you set, your Mining Bot needs the following tokens in order to operate.
          </p>
          <p v-else class="mt-2 font-light">
            Based on the rules you set, your Vault needs the following tokens in order to operate.
          </p>

          <table class="w-full">
            <thead>
              <tr>
                <td>Required</td>
                <td>Wallet Balance</td>
                <td>Locked Value</td>
                <td>You Need</td>
                <td class="text-right">Status</td>
              </tr>
            </thead>
            <tbody class="selectable-text">
              <tr>
                <td data-testid="WalletOverlay.microgonsNeeded" :data-value="minimumMicrogonsNeeded">{{ microgonToArgonNm(minimumMicrogonsNeeded).format('0,0.[00000000]')
                  }} ARGN</td>
                <td>{{ microgonToArgonNm(wallet.availableMicrogons).format('0,0.[00000000]') }}</td>
                <td>{{ microgonToArgonNm(lockedMicrogons).format('0,0.[00000000]') }}</td>
                <td>{{ microgonToArgonNm(bigIntMax(0n, minimumMicrogonsNeeded - walletAllocatedMicrogons)).format('0,0.[00000000]')
                  }}</td>
                <td v-if="!minimumMicrogonsNeeded" class="text-right">--</td>
                <td v-else-if="walletAllocatedMicrogons >= minimumMicrogonsNeeded" class="text-right text-green-700 font-bold" data-testid="Received.argons">success</td>
                <td v-else class="fade-in-out text-right text-red-700 font-bold">
                  <template v-if="wallet.availableMicrogons > 0n">partially funded</template>
                  <template v-else>waiting</template>
                </td>
              </tr>
              <tr>
                <td data-testid="WalletOverlay.micronotsNeeded" :data-value="minimumMicronotsNeeded">{{ micronotToArgonotNm(minimumMicronotsNeeded).format('0,0.[00000000]')
                  }} ARGNOT</td>
                <td>{{ micronotToArgonotNm(wallet.availableMicronots).format('0,0.[00000000]') }}</td>
                <td>{{ micronotToArgonotNm(lockedMicronots).format('0,0.[00000000]') }}</td>
                <td>{{ micronotToArgonotNm(bigIntMax(0n, minimumMicronotsNeeded - walletAllocatedMicronots)).format('0,0.[00000000]')
                  }}</td>
                <td v-if="!minimumMicronotsNeeded" class="text-right">--</td>
                <td v-else-if="walletAllocatedMicronots >= minimumMicronotsNeeded" class="text-right text-green-700 font-bold" data-testid="Received.argonots">success</td>
                <td v-else class="fade-in-out text-right text-red-700 font-bold">
                  <template v-if="wallet.availableMicronots > 0n">partially funded</template>
                  <template v-else>waiting</template>
                </td>
              </tr>
            </tbody>
          </table>

          <button
            @click="closeOverlay"
            :class="walletIsFullyFunded ? 'bg-argon-600 hover:bg-argon-700 border-argon-700 text-white' : 'bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 text-slate-900'"
            class="w-full mt-8 inner-button-shadow px-4 py-2 rounded-lg focus:outline-none cursor-pointer"
          >
            Close Wallet
          </button>

        </div>
      </div>

      <div class="flex flex-col w-full max-w-44 items-end justify-end">
        <img :src="qrCode" width="100%" />
        <CopyToClipboard :content="wallet.address" class="relative mb-3 mr-5 cursor-pointer">
          <span class="opacity-80">
            {{ abbreviateAddress(wallet.address) }}
            <CopyIcon class="w-4 h-4 ml-1 inline-block" />
          </span>
          <div class="text-center text-argon-600 text-sm mt-1">COPY</div>
          <template #copied>
            <div class="absolute top-0 left-0 w-full h-full pointer-events-none">
              {{ abbreviateAddress(wallet.address) }}
              <CopyIcon class="w-4 h-4 ml-1 inline-block" />
              <div class="text-center text-argon-600 text-sm mt-1">COPY</div>
            </div>
          </template>
        </CopyToClipboard>
      </div>
    </div>
  </Overlay>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import QRCode from 'qrcode';
import { getConfig } from '../stores/config';
import { useWallets } from '../stores/wallets';
import { getCurrency } from '../stores/currency';
import { abbreviateAddress } from '../lib/Utils';
import Overlay from './Overlay.vue';
import CopyIcon from '../assets/copy.svg?component';
import CopyToClipboard from '../components/CopyToClipboard.vue';
import AlertIcon from '../assets/alert.svg?component';
import { createNumeralHelpers } from '../lib/numeral';
import { bigIntMax } from '@argonprotocol/apps-core/src/utils';
import { getBiddingCalculator } from '../stores/mainchain.ts';
import basicEmitter from '../emitters/basicEmitter';
import { useController } from '../stores/controller';
import { IWalletType } from '../lib/Wallet.ts';
import InstructionsIcon from '../assets/instructions.svg?component';
import { open as tauriOpen } from '@tauri-apps/plugin-shell';

const isOpen = Vue.ref(false);
const isLoaded = Vue.ref(false);

const walletId: Vue.Ref<IWalletType> = Vue.ref('mining');

const config = getConfig();
const wallets = useWallets();
const currency = getCurrency();
const controller = useController();
const calculator = getBiddingCalculator();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const qrCode = Vue.ref('');
const requiredMicrogonsForGoal = Vue.ref(0n);
const requiredMicronotsForGoal = Vue.ref(0n);
const showJurisdictionAlert = Vue.ref(false);

const minimumMicrogonsNeeded = Vue.computed(() => {
  if (walletId.value === 'mining') {
    const baseAmountNeeded = requiredMicrogonsForGoal.value;
    return baseAmountNeeded + (config.biddingRules?.sidelinedMicrogons ?? 0n);
  } else if (walletId.value === 'vaulting') {
    return config.vaultingRules?.baseMicrogonCommitment || 0n;
  }
  return 0n;
});

const minimumMicronotsNeeded = Vue.computed(() => {
  if (walletId.value === 'mining') {
    const baseAmountNeeded = requiredMicronotsForGoal.value;
    return baseAmountNeeded + (config.biddingRules?.sidelinedMicronots ?? 0n);
  } else if (walletId.value === 'vaulting') {
    return config.vaultingRules?.baseMicronotCommitment || 0n;
  }
  return 0n;
});

const lockedMicrogons = Vue.computed(() => {
  if (walletId.value === 'mining') {
    const sidelined = config.biddingRules?.sidelinedMicrogons ?? 0n;
    return wallets.miningBidMicrogons + wallets.miningSeatMicrogons + sidelined;
  } else {
    return wallets.vaultingWallet.reservedMicrogons || 0n;
  }
});

const lockedMicronots = Vue.computed(() => {
  if (walletId.value === 'mining') {
    const sidelined = config.biddingRules?.sidelinedMicronots ?? 0n;
    return wallets.miningBidMicronots + wallets.miningSeatMicronots + sidelined;
  } else {
    return wallets.vaultingWallet.reservedMicronots || 0n;
  }
});

const walletAllocatedMicrogons = Vue.computed(() => {
  if (walletId.value === 'mining') {
    return wallets.totalMiningMicrogons || 0n;
  } else if (walletId.value === 'vaulting') {
    return wallets.totalVaultingMicrogons || 0n;
  }
  return 0n;
});

const walletAllocatedMicronots = Vue.computed(() => {
  if (walletId.value === 'mining') {
    return wallets.totalMiningMicronots || 0n;
  } else if (walletId.value === 'vaulting') {
    return wallets.vaultingWallet.reservedMicronots || 0n;
  }
  return 0n;
});

const walletName = Vue.computed(() => {
  if (walletId.value === 'mining') {
    return 'Mining';
  } else if (walletId.value === 'vaulting') {
    return 'Vaulting';
  }
});

const wallet = Vue.computed(() => {
  if (walletId.value === 'mining') {
    return wallets.miningWallet;
  } else {
    return wallets.vaultingWallet;
  }
});

const walletIsFullyFunded = Vue.computed(() => {
  if (walletAllocatedMicronots.value < minimumMicronotsNeeded.value) return false;
  if (walletAllocatedMicrogons.value < minimumMicrogonsNeeded.value) return false;
  return true;
});

const requiresRulesToBeSet = Vue.computed(() => {
  if (walletId.value === 'mining' && !config.hasSavedBiddingRules) {
    return true;
  }
  if (walletId.value === 'vaulting' && !config.hasSavedVaultingRules) {
    return true;
  }
  return false;
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
  basicEmitter.emit('openComplianceOverlay');
}

let calculatorIsSubscribed = false;

async function load() {
  void loadQRCode();
  if (walletId.value === 'mining' && !calculatorIsSubscribed) {
    calculatorIsSubscribed = true;
    await config.isLoadedPromise;

    const loadSubscription = calculator.onLoad(() => {
      const projections = calculator.runProjections(config.biddingRules, 'maximum');
      requiredMicrogonsForGoal.value = projections.microgonRequirement;
      requiredMicronotsForGoal.value = projections.micronotRequirement;
    });
    Vue.onMounted(() => {
      loadSubscription.unsubscribe();
    });

    await calculator.load();
  }
}

async function loadQRCode() {
  let address = '';
  if (walletId.value === 'mining') {
    address = wallets.miningWallet.address;
  } else if (walletId.value === 'vaulting') {
    address = wallets.vaultingWallet.address;
  }
  qrCode.value = await QRCode.toDataURL(address);
}

function closeOverlay() {
  isOpen.value = false;
  controller.walletOverlayIsOpen = false;
}

basicEmitter.on('openWalletOverlay', async data => {
  walletId.value = data.walletType;
  await load();
  isOpen.value = true;
  isLoaded.value = true;
  showJurisdictionAlert.value = false;
  controller.walletOverlayIsOpen = true;
});
</script>

<style scoped>
@reference "../main.css";

table {
  @apply text-md mt-6 font-mono;
  thead {
    @apply font-bold uppercase;
  }
  td {
    @apply border-b border-slate-400/30 py-3;
  }
}

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
