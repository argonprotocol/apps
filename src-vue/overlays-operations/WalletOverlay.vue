<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @esc="closeOverlay" class="w-9/12">
    <template #title>
      <div class="inline-block text-2xl font-bold relative">Add Funds to Your {{ walletName }} Wallet</div>
    </template>

    <div class="flex flex-row items-stretch w-full pt-3 pb-5 px-5 gap-x-5">
      <div class="flex flex-col grow pt-2 text-md">
        <div class="w-11/12">
          <p class="max-w-3xl font-light">
            You can use any polkadot/substrate compatible wallet to add funds to your account. Just scan the QR
            code shown on the right, or copy and paste the address that's printed below it.
          </p>

          <div class="flex flex-col my-4 border border-slate-400 border-dashed rounded px-2 py-2">
            <div v-if="showJurisdictionAlert">
              <AlertIcon class="w-5 h-5 inline-block mr-1.5 text-red-600" /> Uh oh... Instructions for acquiring
              tokens is only available to those outside the United States. It seems
              <span
                @click="openJurisdictionOverlay"
                class="text-argon-800/80 cursor-pointer hover:text-argon-600 hover:font-bold underline decoration-dashed">
                your chosen jurisdiction
              </span>
              is not yet supported.
            </div>
            <div
              v-else
              @click="openUniswapInstructions"
              class="flex flex-row gap-x-2 items-center cursor-pointer text-argon-800/60 hover:text-argon-600">
              <InstructionsIcon class="w-6 h-6 inline-block" />
              View Step-by-Step Instructions for Acquiring Argons and Argonots
            </div>
          </div>

          <table class="wallet-balance-table mt-6 w-full">
            <thead>
              <tr>
                <td>Token</td>
                <td class="text-right">Available</td>
                <td class="text-right">Locked</td>
                <td class="text-right">Total</td>
              </tr>
            </thead>
            <tbody class="selectable-text">
              <tr>
                <td>ARGN</td>
                <td
                  class="text-right"
                  :title="`${microgonToArgonNm(availableMicrogons).format('0,0.[00000000]')} ARGN`">
                  {{ microgonToArgonNm(availableMicrogons).format('0,0.00') }}
                </td>
                <td
                  class="text-right"
                  :title="`${microgonToArgonNm(lockedMicrogons).format('0,0.[00000000]')} ARGN`">
                  {{ microgonToArgonNm(lockedMicrogons).format('0,0.00') }}
                </td>
                <td
                  class="text-right"
                  :title="`${microgonToArgonNm(availableMicrogons + lockedMicrogons).format('0,0.[00000000]')} ARGN`">
                  {{ microgonToArgonNm(availableMicrogons + lockedMicrogons).format('0,0.00') }}
                </td>
              </tr>
              <tr>
                <td>ARGNOT</td>
                <td
                  class="text-right"
                  :title="`${micronotToArgonotNm(availableMicronots).format('0,0.[00000000]')} ARGNOT`">
                  {{ micronotToArgonotNm(availableMicronots).format('0,0.00') }}
                </td>
                <td
                  class="text-right"
                  :title="`${micronotToArgonotNm(lockedMicronots).format('0,0.[00000000]')} ARGNOT`">
                  {{ micronotToArgonotNm(lockedMicronots).format('0,0.00') }}
                </td>
                <td
                  class="text-right"
                  :title="`${micronotToArgonotNm(availableMicronots + lockedMicronots).format('0,0.[00000000]')} ARGNOT`">
                  {{ micronotToArgonotNm(availableMicronots + lockedMicronots).format('0,0.00') }}
                </td>
              </tr>
            </tbody>
          </table>

          <button
            @click="closeOverlay"
            class="w-full mt-6 inner-button-shadow px-4 py-2 rounded-lg focus:outline-none cursor-pointer bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 text-slate-900">
            Close Wallet
          </button>
        </div>
      </div>

      <div class="-mt-3 -mb-5 -mr-5 flex w-52 shrink-0 self-stretch border-l border-slate-200/70 bg-slate-50">
        <div class="w-full px-5 pt-6 pb-6 text-center">
          <img :src="qrCode" class="w-full" alt="QR Code for Vault Address" />

          <CopyToClipboard data-testid="walletAddress" :content="wallet.address" class="relative mt-4 cursor-pointer py-1">
            <div class="inline-flex max-w-full items-center gap-x-2 text-sm text-slate-700">
              <span class="truncate">
                {{ abbreviateAddress(wallet.address, 6) }}
              </span>
              <span class="inline-flex shrink-0 items-center text-argon-600">
                <CopyIcon class="h-4 w-4" />
              </span>
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
import basicEmitter from '../emitters/basicEmitter';
import { WalletType } from '../lib/Wallet.ts';
import InstructionsIcon from '../assets/instructions.svg?component';
import { open as tauriOpen } from '@tauri-apps/plugin-shell';
import { useBasics } from '../stores/basics.ts';

const isOpen = Vue.ref(false);
const walletId: Vue.Ref<WalletType.miningHold | WalletType.vaulting> = Vue.ref(WalletType.miningHold);
const qrCode = Vue.ref('');
const showJurisdictionAlert = Vue.ref(false);

const config = getConfig();
const basics = useBasics();
const wallets = useWallets();
const currency = getCurrency();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const walletName = Vue.computed(() => {
  if (walletId.value === WalletType.miningHold) {
    return 'Mining';
  }

  return 'Vaulting';
});

const wallet = Vue.computed(() => {
  if (walletId.value === WalletType.miningHold) {
    return wallets.miningHoldWallet;
  }

  return wallets.vaultingWallet;
});

const availableMicrogons = Vue.computed(() => {
  if (walletId.value === WalletType.miningHold) {
    return wallets.miningHoldSpendableMicrogons + wallets.miningBotWallet.availableMicrogons;
  }

  return wallets.vaultingWallet.availableMicrogons;
});

const availableMicronots = Vue.computed(() => {
  if (walletId.value === WalletType.miningHold) {
    return wallets.miningHoldWallet.availableMicronots + wallets.miningBotWallet.availableMicronots;
  }

  return wallets.vaultingWallet.availableMicronots;
});

const lockedMicrogons = Vue.computed(() => {
  if (walletId.value === WalletType.miningHold) {
    const sidelined = config.biddingRules?.sidelinedMicrogons ?? 0n;
    return wallets.miningBidMicrogons + wallets.miningSeatMicrogons + sidelined;
  }

  return wallets.vaultingWallet.reservedMicrogons || 0n;
});

const lockedMicronots = Vue.computed(() => {
  if (walletId.value === WalletType.miningHold) {
    const sidelined = config.biddingRules?.sidelinedMicronots ?? 0n;
    return wallets.miningBidMicronots + wallets.miningSeatMicronots + sidelined;
  }

  return wallets.vaultingWallet.reservedMicronots || 0n;
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

async function loadQRCode() {
  let address = '';
  if (walletId.value === WalletType.miningHold) {
    address = wallets.miningHoldWallet.address;
  } else if (walletId.value === WalletType.vaulting) {
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
  if (data.screen !== 'receive') return;

  walletId.value = data.walletType;
  await loadQRCode();
  isOpen.value = true;
  showJurisdictionAlert.value = false;
  basics.overlayIsOpen = true;
});
</script>

<style scoped>
@reference "../main.css";

.wallet-balance-table {
  @apply whitespace-nowrap;

  thead td {
    @apply pb-3 text-left text-sm font-semibold tracking-wide text-slate-500 uppercase;
  }

  thead td.text-right {
    @apply text-right;
  }

  tbody tr {
    @apply border-t border-slate-300/60;
  }

  tbody td {
    @apply py-3 font-mono text-sm text-slate-900;
  }
}
</style>
