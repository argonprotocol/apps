<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Unattached Bitcoin"
      :isDragging="props.isDragging"
      :showHome="true"
      @dragStart="emit('dragStart', $event)"
      @goto="emit('goto', $event)"
      @close="emit('close')"
    >
      <template #actions>
        <button
          type="button"
          NotDraggable
          title="Find missing deposits"
          aria-label="Find missing deposits"
          :disabled="isSearching"
          class="flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-slate-400/60 text-slate-500/60 hover:border-slate-500/60 hover:bg-[#f1f3f7] disabled:opacity-50"
          @mousedown.stop
          @click="findMissingDeposits"
        >
          <ArrowPathIcon class="size-4" :class="{ 'animate-spin': isSearching }" />
        </button>
      </template>
    </WalletHeader>

    <!-- prettier-ignore -->
    <div class="min-h-0 max-h-[55vh] grow overflow-y-auto px-5 py-4 text-sm text-slate-700">
      <p v-if="searchError" role="alert" class="border-argon-error/30 bg-argon-error/5 text-argon-error mb-4 rounded-md border px-4 py-3 text-sm">{{ searchError }}</p>
      <p v-if="isSearching" role="status" class="mb-4">Checking Bitcoin addresses for missing deposits...</p>
      <p v-else-if="!deposits.length && !searchError">There are no unattached deposits.</p>
      <template v-if="deposits.length">
        <p class="mb-4">Choose a deposit to view or request a return.</p>
        <div class="flex flex-col gap-3">
          <button
            v-for="{ deposit, release } in deposits"
            :key="deposit.id"
            type="button"
            :data-deposit-id="deposit.id"
            class="flex w-full cursor-pointer items-center gap-3 rounded-md border border-slate-200 px-3 py-3 text-left"
            :class="
              release?.status === BitcoinReleaseStatus.Complete
                ? 'bg-slate-50 opacity-60 hover:opacity-80'
                : 'hover:bg-slate-50'
            "
            @click="emit('goto', { type: 'unattachedBitcoin', recordId: deposit.id })"
          >
            <span class="min-w-0 grow">
              <span class="flex items-center justify-between gap-3">
                <strong class="shrink-0">{{ satToBtcNm(deposit.satoshis).format('0,0.[00000000]') }} BTC</strong>
                <span
                  v-if="release"
                  :title="release.statusError"
                  class="text-right text-xs font-semibold"
                  :class="release.statusError ? 'text-argon-error' : 'text-slate-600'"
                >
                  <template v-if="release.status === BitcoinReleaseStatus.SubmittingRequestOnArgon">
                    Requesting return
                  </template>
                  <template v-else-if="release.status === BitcoinReleaseStatus.WaitingForVaultCosign">
                    Awaiting vault signature
                  </template>
                  <template v-else-if="release.status === BitcoinReleaseStatus.ReadyForBitcoinBroadcast">
                    Preparing Bitcoin return
                  </template>
                  <template
                    v-else-if="
                      release.status === BitcoinReleaseStatus.ConfirmingOnBitcoin ||
                      release.status === BitcoinReleaseStatus.WaitingForArgonRecognition
                    "
                  >
                    Returning on Bitcoin
                  </template>
                  <template v-else-if="release.status === BitcoinReleaseStatus.Complete">Returned · Archived</template>
                  <template v-else-if="release.status === BitcoinReleaseStatus.Cancelled">Request cancelled</template>
                  <template v-else>Return failed</template>
                </span>
              </span>
              <span class="mt-1 flex items-center justify-between gap-3 text-xs text-slate-500">
                <span class="shrink-0">{{ dayjs(deposit.firstSeenAt).format('MMM D, YYYY [at] h:mm A') }}</span>
                <span class="truncate text-right font-mono">
                  {{ abbreviateAddress(deposit.txid, 8) }}:{{ deposit.vout }}
                </span>
              </span>
            </span>
            <ChevronRightIcon class="size-4 shrink-0 text-slate-400" />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ChevronRightIcon } from '@heroicons/vue/20/solid';
import { ArrowPathIcon } from '@heroicons/vue/24/outline';
import { BitcoinReleaseStatus } from '../../interfaces/IBitcoinReleaseRecord.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { useWallets } from '../../stores/wallets.ts';
import type { IWalletView } from '../walletOverlayState.ts';
import WalletHeader from './WalletHeader.vue';

const props = defineProps<{ isDragging: boolean }>();
const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'close'): void;
}>();

const wallets = useWallets();
const bitcoinLocks = getBitcoinLocks();
const { satToBtcNm } = createNumeralHelpers(getCurrency());
const isSearching = ref(false);
const searchError = ref('');
const deposits = computed(() => {
  const entries = wallets.bitcoinWallet.getUnattachedDeposits({ includeReturned: true }).map(deposit => ({
    deposit,
    release: bitcoinLocks.releases.getActiveForUtxo(deposit) ?? bitcoinLocks.releases.getLatestForUtxo(deposit),
  }));
  // Keep discovery order within each group while completed returns move to the archive.
  return [
    ...entries.filter(entry => entry.release?.status !== BitcoinReleaseStatus.Complete),
    ...entries.filter(entry => entry.release?.status === BitcoinReleaseStatus.Complete),
  ];
});

async function findMissingDeposits() {
  if (isSearching.value) return;
  isSearching.value = true;
  searchError.value = '';
  try {
    await bitcoinLocks.findMissingDeposits();
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    isSearching.value = false;
  }
}

onMounted(findMissingDeposits);
</script>
