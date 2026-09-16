<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Internal App Wallet"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @close="emit('close')"
    />

    <div class="mx-1 px-4 py-6 text-center">
      <div class="text-argon-700/70 flex flex-row justify-center text-6xl font-bold">
        <span>{{ currency.symbol }}</span>
        <FormattedMoney :isLoaded="walletValueIsLoaded" :value="walletTotalValue" />
      </div>
    </div>

    <div class="relative pt-1">
      <div class="mb-2 flex flex-row gap-x-2 px-4">
        <button class="border-argon-600 cursor-pointer border-b-3 font-bold">Tokens</button>
        <!--        <button class="text-argon-900/50 cursor-pointer">Transactions</button>-->
        <div class="grow" />
        <button
          data-testid="WalletViewMain.openSend()"
          @click="emit('goto', 'send')"
          class="text-md border-argon-600/50 text-argon-600/70 hover:bg-argon-100/20 cursor-pointer rounded-lg border px-2"
        >
          Send
        </button>
        <button
          @click="emit('goto', 'receive')"
          class="text-md border-argon-600/50 text-argon-600/70 hover:bg-argon-100/20 cursor-pointer rounded-lg border px-2"
        >
          Receive
        </button>
      </div>
      <div class="relative px-4">
        <ArgonTokens
          :microgonsToMint="financials.bitcoinLiquidPendingMintMicrogons"
          :microgons="defaultArgonWallet.availableMicrogons"
          :micronots="defaultArgonWallet.availableMicronots"
          :satoshis="financials.bitcoinWalletTotalSatoshis"
          :showBitcoin="true"
        >
          <template #bitcoinAction>
            <span v-if="pendingOutboundSatoshis" class="ml-1 text-slate-400">
              -{{ satToBtcNm(pendingOutboundSatoshis).format('0,0.[00000000]') }} BTC
            </span>
            <button
              v-if="pendingBitcoinSends.length || walletBitcoinSections.length"
              type="button"
              data-testid="WalletViewMain.toggleBitcoinDetails()"
              class="ml-1 flex cursor-pointer items-center text-slate-500 hover:text-slate-700"
              :aria-expanded="bitcoinDetailsAreExpanded"
              :aria-label="bitcoinDetailsAreExpanded ? 'Hide Bitcoin details' : 'Show Bitcoin details'"
              @click="bitcoinDetailsAreExpanded = !bitcoinDetailsAreExpanded"
            >
              (
              <MinusIcon v-if="bitcoinDetailsAreExpanded" class="size-3" />
              <PlusIcon v-else class="size-3" />
              )
            </button>
          </template>
          <template #bitcoinDetails>
            <li
              v-if="bitcoinDetailsAreExpanded && (pendingBitcoinSends.length || walletBitcoinSections.length)"
              class="mb-2 ml-4 overflow-hidden rounded-bl-lg border-b border-l border-slate-300/70 pt-2 pr-2 pb-3 pl-3"
            >
              <section v-if="pendingBitcoinSends.length" class="pb-1">
                <div class="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Outbound transfers</div>
                <PopoverRoot v-for="send in pendingBitcoinSends" :key="send.sendId">
                  <PopoverTrigger as-child>
                    <button
                      data-testid="WalletViewMain.bitcoinSend"
                      :data-send-id="send.sendId"
                      type="button"
                      class="hover:bg-argon-100/30 w-full cursor-pointer rounded px-2 py-1.5 text-left text-sm text-slate-600"
                    >
                      <div class="flex items-center gap-3">
                        <span class="font-mono text-slate-700">
                          {{ satToBtcNm(send.satoshis).format('0,0.[00000000]') }} BTC
                        </span>
                        <span class="ml-auto text-xs" :class="send.hasError ? 'text-red-600' : 'text-slate-500'">
                          {{ send.hasError ? 'Needs attention' : `${send.entries.length} transactions` }}
                        </span>
                        <ChevronRightIcon class="size-3.5 shrink-0 text-slate-400" />
                      </div>
                      <ProgressBar
                        :progress="send.progressPct"
                        :hasError="send.hasError"
                        :showLabel="false"
                        class="mt-1.5 h-1.5"
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverPortal>
                    <PopoverContent
                      side="bottom"
                      align="center"
                      :sideOffset="8"
                      :collisionPadding="24"
                      :style="floatingZIndex"
                      class="w-96 rounded-lg border border-slate-300 bg-white px-5 py-4 text-sm text-slate-600 shadow-2xl"
                    >
                      <div class="flex flex-col space-y-5 pt-2 pb-4">
                        <p v-if="send.hasActiveRelease">
                          Argon is processing your request to send
                          {{ satToBtcNm(send.satoshis).format('0,0.[00000000]') }} BTC. This process requires several
                          steps and can take between 10 and 20 minutes.
                        </p>
                        <p v-else>This Bitcoin send could not be submitted. Review the failed transaction below.</p>
                        <div>
                          <div
                            v-for="entry in send.entries"
                            :key="entry.release.id"
                            class="border-t border-slate-200 py-3 first:border-t-0 first:pt-0 last:pb-0"
                          >
                            <div class="flex items-center gap-3">
                              <span class="font-semibold text-slate-700">
                                Cosigner: {{ getCosignerName(entry.lock.vaultId) }}
                              </span>
                              <span class="ml-auto font-mono text-slate-700">
                                {{ satToBtcNm(entry.satoshis).format('0,0.[00000000]') }} BTC
                              </span>
                            </div>
                            <ProgressBar
                              :progress="entry.releaseProgress.progressPct"
                              :hasError="!!entry.release.statusError"
                              :showLabel="false"
                              class="mt-1.5 h-1.5"
                            />
                            <div class="mt-1.5 flex items-center gap-3 text-xs text-slate-500">
                              <span class="inline-flex flex-wrap items-baseline gap-x-1">
                                <span>{{ entry.releaseProgress.detail }}</span>
                                <CountdownClock
                                  v-if="entry.cosignDueDate"
                                  :time="dayjs(entry.cosignDueDate)"
                                  v-slot="{ days, hours, minutes, isFinished }"
                                >
                                  <span>({{ formatReleaseDueTime(days, hours, minutes, isFinished) }})</span>
                                </CountdownClock>
                              </span>
                              <span class="ml-auto">
                                {{ numeral(entry.releaseProgress.progressPct).format('0.0') }}%
                              </span>
                            </div>
                            <div v-if="entry.release.statusError" class="mt-1 text-xs text-red-600">
                              {{ entry.release.statusError }}
                            </div>
                          </div>
                        </div>
                        <button
                          v-if="send.hasUnacknowledgedFailure"
                          data-testid="WalletViewMain.acknowledgeFailedBitcoinSend"
                          type="button"
                          class="text-argon-600 hover:text-argon-700 cursor-pointer self-end text-sm font-semibold"
                          @click="acknowledgeFailedSend(send.sendId)"
                        >
                          Acknowledge
                        </button>
                      </div>
                      <PopoverArrow
                        :width="24"
                        :height="12"
                        class="-mt-px fill-white stroke-slate-300 stroke-[0.5px]"
                      />
                    </PopoverContent>
                  </PopoverPortal>
                </PopoverRoot>
              </section>
              <section v-for="group in walletBitcoinSections" :key="group.key" class="py-1 first:pt-0 last:pb-0">
                <div class="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  {{ group.label }}
                </div>
                <ConnectorChannel
                  v-for="entry in group.entries"
                  :key="entry.lock.uuid"
                  :open="openInsuranceChannelUuid === entry.lock.uuid"
                  :wallet="wallets.bitcoinWallet"
                  :channelUuid="entry.lock.uuid"
                  direction="right"
                  mode="insurance"
                  @update:open="openInsuranceChannelUuid = $event ? entry.lock.uuid : undefined"
                >
                  <button
                    type="button"
                    data-testid="WalletViewMain.bitcoinChannel"
                    :data-channel-uuid="entry.lock.uuid"
                    :aria-label="`${group.label} Channel`"
                    class="flex w-full cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-left text-sm text-slate-600"
                    :class="
                      openInsuranceChannelUuid === entry.lock.uuid
                        ? 'bg-argon-100/40 ring-argon-300/30 ring-1 ring-inset'
                        : 'hover:bg-argon-100/30'
                    "
                  >
                    <span class="font-mono text-slate-700">
                      {{ satToBtcNm(entry.satoshis).format('0,0.[00000000]') }} BTC
                    </span>
                    <span v-if="entry.address" class="font-mono text-xs text-slate-400">
                      {{ abbreviateAddress(entry.address, 6) }}
                    </span>
                    <span class="ml-auto text-xs text-slate-500">
                      {{ currency.symbol
                      }}{{ microgonToArgonNm(entry.lock.securitizationCoverageMicrogons ?? 0n).format('0,0.[00]') }}
                      insurance
                    </span>
                    <ChevronRightIcon class="size-3.5 shrink-0 text-slate-400" />
                  </button>
                </ConnectorChannel>
              </section>
            </li>
          </template>
        </ArgonTokens>
      </div>
    </div>

    <div class="flex grow flex-col px-4">
      <ArgonBottom
        mode="chooser"
        :showGuidance="props.showGuidance"
        :guidanceContext="props.guidanceContext"
        :walletType="WalletType.argon"
      />
      <button
        v-if="unattachedBitcoinDeposits.length"
        data-testid="WalletViewMain.unattachedBitcoinDeposit"
        type="button"
        class="mb-3 flex w-full cursor-pointer items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-left text-sm text-amber-800 hover:bg-amber-100/70"
        @click="emit('goto', { type: 'unattachedBitcoin', recordId: unattachedBitcoinDeposits[0]!.id })"
      >
        <AlertIcon class="size-5 shrink-0" />
        <span class="min-w-0 grow">
          <strong class="block">
            {{ unattachedBitcoinDeposits.length }} unattached Bitcoin deposit{{
              unattachedBitcoinDeposits.length === 1 ? '' : 's'
            }}
          </strong>
          <span class="mt-0.5 block text-xs">Return the Bitcoin to an address you control.</span>
        </span>
        <ChevronRightIcon class="size-4 shrink-0" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { bigIntMax } from '@argonprotocol/apps-core';
import { ChevronRightIcon, MinusIcon, PlusIcon } from '@heroicons/vue/20/solid';
import dayjs from 'dayjs';
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import AlertIcon from '../../assets/alert.svg?component';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import {
  BitcoinReleaseKind,
  BitcoinReleaseStatus,
  type IBitcoinReleaseRecord,
} from '../../interfaces/IBitcoinReleaseRecord.ts';
import { WalletType } from '../../lib/Wallet.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useFinancials } from '../../stores/financials.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getBitcoinReleaseProgress } from '../../stores/bitcoinLockProgress.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import CountdownClock from '../../components/CountdownClock.vue';
import ArgonBottom from './ArgonBottom.vue';
import ArgonTokens from './ArgonTokens.vue';
import ConnectorChannel from './ConnectorChannel.vue';
import WalletHeader from './WalletHeader.vue';
import type { IWalletView } from '../walletOverlayState.ts';

interface IWalletBitcoinEntry {
  lock: IBitcoinLockRecord;
  satoshis: bigint;
}

interface IWalletBitcoinReleaseEntry extends IWalletBitcoinEntry {
  release: IBitcoinReleaseRecord;
  releaseProgress: ReturnType<typeof getBitcoinReleaseProgress>;
  cosignDueDate?: Date;
}

interface IWalletBitcoinSend {
  sendId: string;
  entries: IWalletBitcoinReleaseEntry[];
  satoshis: bigint;
  pendingSatoshis: bigint;
  progressPct: number;
  hasError: boolean;
  hasActiveRelease: boolean;
  hasUnacknowledgedFailure: boolean;
}

const props = defineProps<{
  isDragging: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'close'): void;
}>();

const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const { bitcoinLockRelease } = getBitcoinTransactionOperations();
const config = getConfig();
const currency = getCurrency();
const miningFrames = getMiningFrames();
const myVault = getMyVault();
const vaults = getVaults();
const wallets = useWallets();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const bitcoinDetailsAreExpanded = ref(false);
const openInsuranceChannelUuid = ref<string>();
const floatingZIndex = useFloatingZIndex(2);
const progressNow = ref(Date.now());
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;
const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
const walletValueIsLoaded = computed(() => financials.savingsIsLoaded);
const walletTotalValue = computed(() => financials.savingsTotalValue);
const unattachedBitcoinDeposits = computed(() => wallets.bitcoinWallet.getUnresolvedOrphanDeposits());
const bitcoinReleasesBySendId = computed(() => {
  const releasesBySendId = new Map<string, IBitcoinReleaseRecord[]>();
  for (const release of Object.values(bitcoinLocks.releases.data.releasesById)) {
    if (release.kind !== BitcoinReleaseKind.Lock) continue;
    const releases = releasesBySendId.get(release.sendId) ?? [];
    releases.push(release);
    releasesBySendId.set(release.sendId, releases);
  }
  return releasesBySendId;
});
const visibleBitcoinSendIds = computed(() => {
  const sendIds = new Set<string>();
  for (const lock of bitcoinLocks.getAllLocks()) {
    const activeRelease = bitcoinLocks.releases.getActiveForLock(lock);
    if (activeRelease?.kind === BitcoinReleaseKind.Lock) sendIds.add(activeRelease.sendId);
  }
  for (const release of bitcoinLocks.releases.getUnacknowledgedFailedLockReleases()) sendIds.add(release.sendId);
  return sendIds;
});
const pendingBitcoinSends = computed<IWalletBitcoinSend[]>(() => {
  void progressNow.value;

  const sends: IWalletBitcoinSend[] = [];
  for (const sendId of visibleBitcoinSendIds.value) {
    const entries = (bitcoinReleasesBySendId.value.get(sendId) ?? []).flatMap(release => {
      if (release.status === BitcoinReleaseStatus.FailedAcknowledged) return [];
      const lock = bitcoinLocks.getLockById(release.lockId);
      if (!lock) return [];
      return [
        {
          lock,
          release,
          satoshis: release.destinationSatoshis + release.bitcoinNetworkFee,
          releaseProgress: getReleaseProgress(lock, release),
          cosignDueDate:
            release.status === BitcoinReleaseStatus.WaitingForVaultCosign && release.cosignDueFrame
              ? miningFrames.getFrameDate(release.cosignDueFrame)
              : undefined,
        },
      ];
    });
    if (!entries.length) continue;

    const satoshis = entries.reduce((total, entry) => total + entry.satoshis, 0n);
    const weightedProgress = entries.reduce(
      (total, entry) => total + entry.releaseProgress.progressPct * Number(entry.satoshis),
      0,
    );
    sends.push({
      sendId,
      entries: entries.sort((left, right) => left.release.createdAt.getTime() - right.release.createdAt.getTime()),
      satoshis,
      pendingSatoshis: entries.reduce(
        (total, entry) => total + (entry.lock.activeReleaseId === entry.release.id ? entry.satoshis : 0n),
        0n,
      ),
      progressPct: satoshis > 0n ? weightedProgress / Number(satoshis) : 0,
      hasError: entries.some(entry => !!entry.release.statusError),
      hasActiveRelease: entries.some(entry => entry.lock.activeReleaseId === entry.release.id),
      hasUnacknowledgedFailure: entries.some(entry => entry.release.status === BitcoinReleaseStatus.Failed),
    });
  }
  return sends.sort(
    (left, right) => right.entries[0]!.release.createdAt.getTime() - left.entries[0]!.release.createdAt.getTime(),
  );
});
const pendingOutboundSatoshis = computed(() => {
  return pendingBitcoinSends.value.reduce((total, send) => total + send.pendingSatoshis, 0n);
});
const walletBitcoinSections = computed(() => {
  const locksByVaultId = new Map<number, IWalletBitcoinEntry[]>();

  for (const lock of bitcoinLocks.getAllLocks()) {
    if (!bitcoinLocks.isLockFunded(lock)) continue;

    const satoshis = bigIntMax(lock.fundedSatoshis - (lock.fissionedSatoshis ?? 0n), 0n);
    if (!satoshis) continue;

    const locks = locksByVaultId.get(lock.vaultId) ?? [];
    locks.push({ lock, satoshis });
    locksByVaultId.set(lock.vaultId, locks);
  }

  return [
    ...[...locksByVaultId].map(([vaultId, locks]) => ({
      key: `vault-${vaultId}`,
      label: `Cosigner: ${getCosignerName(vaultId)}`,
      entries: locks.map(entry => ({
        ...entry,
        address: locks.length > 1 ? wallets.bitcoinWallet.getChannelFundingAddress(entry.lock) : undefined,
      })),
    })),
  ];
});

function getCosignerName(vaultId: number): string {
  if (vaultId === (myVault.createdVault?.vaultId ?? myVault.vaultId)) return 'My Vault';
  return (
    vaults.operatorNamesByVaultId[vaultId] ??
    (config.upstreamOperator?.vaultId === vaultId ? config.upstreamOperator.name : undefined) ??
    `Vault ${vaultId}`
  );
}

function getReleaseProgress(lock: IBitcoinLockRecord, release: IBitcoinReleaseRecord) {
  return getBitcoinReleaseProgress({
    release,
    releaseState: bitcoinLocks.getLockUnlockReleaseState(lock),
    argonProgress: bitcoinLockRelease.getPendingReleaseTxInfo(lock.lockId!)?.getStatus(),
    vaultProgressPct: bitcoinLocks.getRequestReleaseByVaultProgress(lock, miningFrames),
    bitcoinProgress: bitcoinLocks.getReleaseProcessingDetails(release),
    cosignerLabel: getCosignerName(lock.vaultId),
  });
}

function formatReleaseDueTime(days: number, hours: number, minutes: number, isFinished: boolean): string {
  if (isFinished) return 'due now';
  if (days) return `due in ${days} day${days === 1 ? '' : 's'}`;

  const time = [
    hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '',
    minutes ? `${minutes} minute${minutes === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `due in ${time || 'less than a minute'}`;
}

async function acknowledgeFailedSend(sendId: string): Promise<void> {
  await bitcoinLocks.releases.acknowledgeFailedSend(sendId).catch(error => {
    console.error(`[WalletViewMain] Unable to acknowledge failed Bitcoin send ${sendId}`, error);
  });
}

onMounted(() => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
});

onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
