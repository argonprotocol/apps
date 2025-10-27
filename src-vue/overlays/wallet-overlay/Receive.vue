<!-- prettier-ignore -->
<template>
  <div>
    <div class="flex flex-row justify-between items-center w-full pt-2 pb-3 space-x-1 border-b border-black/20">
      <!-- <div class="flex flex-row items-center hover:bg-[#f1f3f7] rounded-md p-1 cursor-pointer ml-3">
        <ChevronLeftIcon @click="goBack" class="w-6 h-6 cursor-pointer relative -top-0.25" />
      </div> -->
      <div class="text-2xl font-bold grow pl-5">Add Funds to Your {{ walletName }} Wallet</div>
      <div
        @click="closeOverlay"
        class="mr-2 z-10 flex items-center justify-center text-sm/6 font-semibold cursor-pointer border rounded-md w-[30px] h-[30px] focus:outline-none border-slate-400/60 hover:border-slate-500/60 hover:bg-[#f1f3f7]"
      >
        <XMarkIcon class="w-5 h-5 text-[#B74CBA] stroke-4" />
      </div>
    </div>

    <div class="flex flex-row items-start w-full pt-3 pb-5 px-5 gap-x-5">
      <div class="flex flex-col grow pt-2 text-md">
        <div v-if="config.biddingRules" class="w-11/12">
          <p class="font-light">
            You can use any polkadot/substrate compatible wallet to add funds to your account. Just scan the
            QR code shown on the right, or copy and paste the address that's printed below it.
          </p>
          <p v-if="props.walletId === 'mining'" class="mt-2 font-light">
            Based on the rules configured, your Mining Bot needs the following tokens in order to operate.
          </p>
          <p v-else class="mt-2 font-light">
            Based on the rules configured in your account, your Vault needs the following tokens in order to operate.
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
                <td data-testid="Receive.microgonsNeeded" :data-value="baseMicrogonCommitment">{{ microgonToArgonNm(baseMicrogonCommitment).format('0,0.[00000000]') }} ARGN</td>
                <td>{{ microgonToArgonNm(wallet.availableMicrogons).format('0,0.[00000000]') }}</td>
                <td>{{ microgonToArgonNm(walletAllocatedMicrogons - wallet.availableMicrogons).format('0,0.[00000000]') }}</td>
                <td>{{ microgonToArgonNm(bigIntMax(0n, baseMicrogonCommitment - walletAllocatedMicrogons)).format('0,0.[00000000]') }}</td>
                <td v-if="!baseMicrogonCommitment" class="text-right">--</td>
                <td v-else-if="walletAllocatedMicrogons >= baseMicrogonCommitment" class="text-right text-green-700 font-bold" data-testid="Received.argons">success</td>
                <td v-else class="fade-in-out text-right text-red-700 font-bold">
                  <template v-if="wallet.availableMicrogons > 0n">partially funded</template>
                  <template v-else>waiting</template>
                </td>
              </tr>
              <tr>
                <td data-testid="Receive.micronotsNeeded" :data-value="baseMicronotCommitment">{{ micronotToArgonotNm(baseMicronotCommitment).format('0,0.[00000000]') }} ARGNOT</td>
                <td>{{ micronotToArgonotNm(wallet.availableMicronots).format('0,0.[00000000]') }}</td>
                <td>{{ micronotToArgonotNm(wallet.reservedMicronots).format('0,0.[00000000]') }}</td>
                <td>{{ micronotToArgonotNm(bigIntMax(0n, baseMicronotCommitment - wallet.availableMicronots)).format('0,0.[00000000]') }}</td>
                <td v-if="!baseMicronotCommitment" class="text-right">--</td>
                <td v-else-if="wallet.availableMicronots >= baseMicronotCommitment" class="text-right text-green-700 font-bold" data-testid="Received.argonots">success</td>
                <td v-else class="fade-in-out text-right text-red-700 font-bold">
                  <template v-if="wallet.availableMicronots > 0n">partially funded</template>
                  <template v-else>waiting</template>
                </td>
              </tr>
            </tbody>
          </table>

          <button @click="closeOverlay" class="w-full mt-8 bg-slate-600/20 hover:bg-slate-600/15 border border-slate-900/10 inner-button-shadow text-slate-900 px-4 py-2 rounded-lg focus:outline-none cursor-pointer">
            Close Wallet
          </button>

        </div>
        <div v-else>You haven't set any bidding rules. Please do so before adding funds.</div>
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
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import QRCode from 'qrcode';
import { useConfig } from '../../stores/config';
import { useWallets } from '../../stores/wallets';
import { useCurrency } from '../../stores/currency';
import { abbreviateAddress } from '../../lib/Utils';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import CopyIcon from '../../assets/copy.svg?component';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import { createNumeralHelpers } from '../../lib/numeral';
import { bigIntMax } from '@argonprotocol/apps-core/src/utils';

const props = defineProps({
  walletId: {
    type: String as Vue.PropType<'mining' | 'vaulting'>,
    required: true,
  },
});

const config = useConfig();
const wallets = useWallets();
const currency = useCurrency();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const emit = defineEmits(['navigate']);

function goBack() {
  emit('navigate', { screen: 'main' });
}

const qrCode = Vue.ref('');

function stillNeeded(amount: bigint, walletValue: bigint) {
  const stillNeeded = amount - walletValue === 0n ? 0n : amount - walletValue;
  return stillNeeded > 0n ? stillNeeded : 0n;
}

const baseMicrogonCommitment = Vue.computed(() => {
  if (props.walletId === 'mining') {
    return config.biddingRules?.baseMicrogonCommitment || 0n;
  } else if (props.walletId === 'vaulting') {
    return config.vaultingRules?.baseMicrogonCommitment || 0n;
  }
  return 0n;
});

const walletAllocatedMicrogons = Vue.computed(() => {
  if (props.walletId === 'mining') {
    return wallets.totalMiningMicrogons || 0n;
  } else if (props.walletId === 'vaulting') {
    return wallets.totalVaultingMicrogons || 0n;
  }
  return 0n;
});

const baseMicronotCommitment = Vue.computed(() => {
  if (props.walletId === 'mining') {
    return config.biddingRules?.baseMicronotCommitment || 0n;
  } else if (props.walletId === 'vaulting') {
    return config.vaultingRules?.baseMicronotCommitment || 0n;
  }
  return 0n;
});

const walletName = Vue.computed(() => {
  if (props.walletId === 'mining') {
    return 'Mining';
  } else if (props.walletId === 'vaulting') {
    return 'Vaulting';
  }
});

const wallet = Vue.computed(() => {
  if (props.walletId === 'mining') {
    return wallets.miningWallet;
  } else {
    return wallets.vaultingWallet;
  }
});

async function loadQRCode() {
  let address = '';
  if (props.walletId === 'mining') {
    address = wallets.miningWallet.address;
  } else if (props.walletId === 'vaulting') {
    address = wallets.vaultingWallet.address;
  }
  qrCode.value = await QRCode.toDataURL(address);
}

function closeOverlay() {
  emit('navigate', { close: true });
}

Vue.onMounted(() => {
  loadQRCode();
});
</script>

<style scoped>
@reference "../../main.css";

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
