<!-- prettier-ignore -->
<template>
  <AlertBarRow
    DbMigrationError
    v-if="config.hasDbMigrationError"
    tone="error"
    showDefaultIcon>
    <div class="font-bold">DATABASE CORRUPTION. Your database has become corrupted, and requires a hard reset.</div>
    <template #action>
      <button
        @click="restartDatabase"
        :disabled="isRestarting">
        Hard Reset
      </button>
    </template>
  </AlertBarRow>

  <AlertBarRow
    BotBroken
    v-else-if="bot.isBroken"
    tone="error"
    showDefaultIcon>
    <div><span class="font-bold">Server Error</span> Your server has encountered an unknown error. Restarting might resolve it.</div>
    <template #action>
      <button
        @click="restartBot"
        :disabled="isRestarting">
        {{ isRestarting ? 'Restarting...' : 'Restart' }}
      </button>
    </template>
  </AlertBarRow>

  <AlertBarRow
    ServerDegraded
    v-if="isApiClientDegraded"
    tone="warn"
    showDefaultIcon>
    <div><span class="font-bold">Degraded Performance</span> The api for Argon is experiencing issues, which might impact some parts of this app (eg, your wallet balance).</div>
  </AlertBarRow>

  <PopoverRoot
    v-else
    data-testid="AlertsRoot"
    class="relative z-40 w-full"
    :open="isExpanded"
    @update:open="isExpanded = $event">
    <div v-if="noticeCount">
      <VaultAlert
        v-if="isSingleAlert && vaultAlert"
        :notice="vaultAlert"
        variant="bar"
        @open="openVaultCollect()" />

      <AlertBarRow
        v-else-if="isSingleAlert && singleBitcoinAlert"
        tone="warn">
        <template #icon>
          <BitcoinIcon class="h-5 w-5 text-white opacity-100" />
        </template>

        <div class="pr-3 text-white">
          {{ singleBitcoinBarText }}
        </div>
        <template #action>
          <button @click="openSingleBitcoinAlert()">
            {{ singleBitcoinBarButtonLabel }}
          </button>
        </template>
      </AlertBarRow>

      <template v-else>
        <PopoverAnchor as-child>
          <AlertBarRow tone="warn" showDefaultIcon>
            <div class="pr-3 text-white">
              {{ summaryText }}
            </div>
            <template #action>
              <PopoverTrigger as-child>
                <button>
                  {{ isExpanded ? 'Collapse' : 'Expand' }}
                </button>
              </PopoverTrigger>
            </template>
          </AlertBarRow>
        </PopoverAnchor>

        <PopoverContent
          data-testid="AlertsRoot.details"
          side="bottom"
          align="start"
          :sideOffset="0"
          :collisionPadding="0"
          :avoidCollisions="false"
          @open-auto-focus.prevent
          class="z-50 w-[var(--reka-popover-trigger-width)] max-w-none outline-none">
          <div class="alerts-popover-shell pointer-events-auto">
            <div class="alerts-popover-panel">
              <div class="alerts-popover-body max-h-[min(62vh,560px)] overflow-y-auto px-3 py-3">
                <div>
                  <VaultAlert
                    v-if="vaultAlert"
                    :notice="vaultAlert"
                    :isLast="displayBitcoinAlerts.length === 0"
                    @open="openVaultCollect()" />

                  <BitcoinAlert
                    v-for="entry in displayBitcoinAlerts"
                    :key="entry.key"
                    :notice="entry.alert"
                    :isPreview="entry.isPreview"
                    :isResumedFunding="isResumedFundingAlert(entry.alert)"
                    :isLast="entry.isLast"
                    @open-lock="openBitcoinLock({ lock: $event.lock })"
                    @open-unlock="openBitcoinUnlock($event.lock)" />
                </div>
              </div>
            </div>
          </div>
        </PopoverContent>
      </template>
    </div>

    <VaultCollectOverlay
      v-if="showVaultCollectOverlay"
      @close="showVaultCollectOverlay = false" />

    <BitcoinLockingOverlay
      v-if="showBitcoinLockingOverlay && myVault.createdVault"
      :personalLock="selectedBitcoinLock"
      :vault="myVault.createdVault"
      @close="closeBitcoinLockingOverlay" />

    <BitcoinUnlockingOverlay
      v-if="showBitcoinUnlockingOverlay && selectedUnlockLock"
      :personalLock="selectedUnlockLock"
      @close="closeBitcoinUnlockingOverlay" />
  </PopoverRoot>

  <!-- <div
    InsufficientFunds
    v-else-if="hasInsufficientFunds"
    @click="openFundMiningWalletOverlay"
    class="group flex flex-row items-center gap-x-3 cursor-pointer bg-argon-error hover:bg-argon-error-darker text-white px-3.5 py-2 border-b border-argon-error-darkest"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">BIDDING DISABLED. Your wallet no longer has enough funds to continue bidding.</div>
    <span
      class="cursor-pointer font-bold inline-block rounded-full bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest hover:bg-black/80 px-3"
    >
      Add Funds
    </span>
  </div>
  <div
    MaxBudgetTooLow
    v-else-if="maxBudgetIsTooLow"
    @click="openBotCreateOverlay"
    class="group flex flex-row items-center gap-x-3 cursor-pointer bg-argon-error hover:bg-argon-error-darker text-white px-3.5 py-2 border-b border-argon-error-darkest"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">
      BIDDING DISABLED. Your bot has stopped submitting bids because your budget has been reached.
    </div>
    <span
      class="cursor-pointer font-bold inline-block rounded-full bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest hover:bg-black/80 px-3"
    >
      Open Bidding Rules
    </span>
  </div>
  <div
    MaxBidTooLow
    v-else-if="maxBidIsTooLow"
    @click="openBotCreateOverlay"
    class="group flex flex-row items-center gap-x-3 cursor-pointer bg-argon-error hover:bg-argon-error-darker text-white px-3.5 py-2 border-b border-argon-error-darkest"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">BIDDING DISABLED. The auction's lowest price has climbed above your Maximum Price.</div>
    <span
      class="cursor-pointer font-bold inline-block rounded-full bg-argon-error-darkest/60 group-hover:bg-argon-error-darkest hover:bg-black/80 px-3"
    >
      Open Bidding Rules
    </span>
  </div>
  <div
    LowFunds
    v-else-if="hasLowFunds"
    @click="openFundMiningWalletOverlay"
    class="flex flex-row items-center gap-x-3 cursor-pointer bg-argon-500 hover:bg-argon-600 text-white px-3.5 py-2 border-b border-argon-700"
    style="box-shadow: inset 0 2px 2px rgba(0, 0, 0, 0.1)"
  >
    <AlertIcon class="w-4 h-4 text-white relative left-1 inline-block" />
    <div class="font-bold grow">WARNING. Your mining wallet is low on usable argons which may inhibit bidding.</div>
    <span class="cursor-pointer font-bold inline-block rounded-full bg-argon-700 hover:bg-black/90 px-3">
      Add Funds
    </span>
  </div> -->
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { PopoverAnchor, PopoverContent, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { getConfig } from '../../stores/config.ts';
import basicEmitter from '../../emitters/basicEmitter.ts';
import type { IBitcoinLockRecord } from '../../lib/db/BitcoinLocksTable.ts';
import { getBot } from '../../stores/bot.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import Restarter from '../../lib/Restarter.ts';
import { getDbPromise } from '../../stores/helpers/dbPromise.ts';
import { getInstaller } from '../../stores/installer.ts';
import { getMainchainClient, getMainchainClients } from '../../stores/mainchain.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getMyVault } from '../../stores/vaults.ts';
import { getBondMarket } from '../../stores/myBonds.ts';
import BitcoinIcon from '../../assets/wallets/bitcoin-alert.svg?component';
import VaultCollectOverlay from '../../app-operations/overlays/VaultCollectOverlay.vue';
import BitcoinLockingOverlay from '../../app-operations/overlays/BitcoinLockingOverlay.vue';
import BitcoinUnlockingOverlay from '../../app-operations/overlays/BitcoinUnlockingOverlay.vue';
import AlertBarRow from '../alerts/AlertBarRow.vue';
import BitcoinAlert from '../alerts/BitcoinAlert.vue';
import VaultAlert from '../alerts/VaultAlert.vue';
import {
  buildAlertSummary,
  getBitcoinAlertNotices,
  getVaultAlertNotice,
  sumAlertAmount,
  type IBitcoinAlert,
} from '../../lib/Alerts.ts';

const config = getConfig();
const bot = getBot();
const installer = getInstaller();
const dbPromise = getDbPromise();
const clients = getMainchainClients();
const myVault = getMyVault();
const bitcoinLocks = getBitcoinLocks();
const currency = getCurrency();
const bondMarket = getBondMarket();
const { microgonToMoneyNm } = createNumeralHelpers(currency);

const isRestarting = Vue.ref(false);
const isApiClientDegraded = Vue.ref(false);
const isExpanded = Vue.ref(false);
const showVaultCollectOverlay = Vue.ref(false);
const showBitcoinLockingOverlay = Vue.ref(false);
const showBitcoinUnlockingOverlay = Vue.ref(false);
const selectedBitcoinLock = Vue.ref<IBitcoinLockRecord | undefined>(undefined);
const selectedUnlockLock = Vue.ref<IBitcoinLockRecord | undefined>(undefined);
const resumedFundingByLockUtxoId = Vue.ref<{ [lockUtxoId: number]: true }>({});

let unsubscribeBondMarketVault: VoidFunction | undefined;

const vaultAlert = Vue.computed(() => getVaultAlertNotice(myVault, bitcoinLocks));
const bitcoinAlerts = Vue.computed(() => getBitcoinAlertNotices(bitcoinLocks));

const realAlertCount = Vue.computed(() => {
  return (vaultAlert.value ? 1 : 0) + bitcoinAlerts.value.length;
});

const displayBitcoinAlerts = Vue.computed(() => {
  const alerts = bitcoinAlerts.value.map((alert, index) => ({
    key: `${alert.kind}:${alert.lock.uuid}:${alert.lock.utxoId ?? 'pending'}:${index}`,
    alert,
    isPreview: false,
    isLast: false,
  }));

  alerts.forEach((entry, index) => {
    entry.isLast = index === alerts.length - 1;
  });

  return alerts;
});

const noticeCount = Vue.computed(() => {
  return realAlertCount.value;
});

const isSingleAlert = Vue.computed(() => {
  return noticeCount.value === 1;
});

const singleBitcoinAlert = Vue.computed(() => {
  if (vaultAlert.value || bitcoinAlerts.value.length !== 1) return null;
  return bitcoinAlerts.value[0];
});

const totalAmount = Vue.computed(() => {
  return sumAlertAmount(vaultAlert.value, bitcoinAlerts.value);
});

const summaryText = Vue.computed(() => {
  const formattedAmount =
    totalAmount.value > 0n
      ? `${currency.symbol}${microgonToMoneyNm(totalAmount.value).formatIfElse('< 1_000', '0,0.00', '0,0')}`
      : undefined;
  return buildAlertSummary({
    count: noticeCount.value,
    formattedAmount,
  });
});

const singleBitcoinBarText = Vue.computed(() => {
  if (!singleBitcoinAlert.value) return '';

  switch (singleBitcoinAlert.value.kind) {
    case 'mismatch': {
      const mismatchView = bitcoinLocks.getMismatchViewState(singleBitcoinAlert.value.lock);
      if (mismatchView.phase === 'returningOnArgon' || mismatchView.phase === 'returningOnBitcoin') {
        return 'Mismatched Bitcoin deposit return in progress.';
      }
      const mismatchCanAct =
        !!mismatchView.nextCandidate && (mismatchView.nextCandidate.canAccept || mismatchView.nextCandidate.canReturn);
      if (!mismatchView.error && !mismatchView.isFundingExpired && !mismatchCanAct) {
        return 'Mismatched Bitcoin deposit detected, awaiting finalization.';
      }
      return 'Mismatched Bitcoin deposit needs decision.';
    }
    case 'resumeFunding':
      return 'Mismatched Bitcoin deposit returned. Ready to resume funding.';
    case 'fundingExpiring':
      return isResumedFundingAlert(singleBitcoinAlert.value)
        ? 'Mismatched Bitcoin deposit returned. Time to complete funding running out.'
        : 'Time to fund Bitcoin lock running out.';
    case 'unlockNeedsAttention':
      return 'Bitcoin unlock needs attention.';
    case 'unlockExpiring':
      return 'Bitcoin lock nearing expiration - at risk of loss.';
  }
});

const singleBitcoinBarButtonLabel = Vue.computed(() => {
  if (!singleBitcoinAlert.value) return '';

  switch (singleBitcoinAlert.value.kind) {
    case 'resumeFunding':
      return isResumedFundingAlert(singleBitcoinAlert.value) ? 'Open Details' : 'Resume Funding';
    case 'fundingExpiring':
      return isResumedFundingAlert(singleBitcoinAlert.value) ? 'Open Details' : 'Open Details';
    case 'unlockExpiring':
      return 'Unlock Bitcoin';
    case 'unlockNeedsAttention':
    case 'mismatch':
      return 'Open Details';
  }
});

clients.events.on('working', () => {
  isApiClientDegraded.value = false;
});
clients.events.on('degraded', () => {
  isApiClientDegraded.value = true;
});

function markResumedFunding(lock: IBitcoinLockRecord) {
  if (!lock.utxoId) return;
  resumedFundingByLockUtxoId.value[lock.utxoId] = true;
}

function openBotCreateOverlay() {
  basicEmitter.emit('openBotEditOverlay');
}

async function restartDatabase() {
  await config.isLoadedPromise;
  const restarter = new Restarter(dbPromise, config as any);
  await restarter.migrateToFreshLocalDatabase(true);
}

async function restartBot() {
  isRestarting.value = true;
  await bot.restart();
  isRestarting.value = false;
}

function closeSharedOverlays() {
  showVaultCollectOverlay.value = false;
  showBitcoinLockingOverlay.value = false;
  showBitcoinUnlockingOverlay.value = false;
  selectedBitcoinLock.value = undefined;
  selectedUnlockLock.value = undefined;
}

function openVaultCollect() {
  isExpanded.value = false;
  closeSharedOverlays();
  showVaultCollectOverlay.value = true;
}

function openBitcoinLock(args?: { lock?: IBitcoinLockRecord }) {
  if (!myVault.createdVault) return;
  isExpanded.value = false;
  closeSharedOverlays();
  selectedUnlockLock.value = undefined;
  selectedBitcoinLock.value = args?.lock;
  showBitcoinLockingOverlay.value = true;
}

function openBitcoinUnlock(lock: IBitcoinLockRecord) {
  isExpanded.value = false;
  closeSharedOverlays();
  selectedBitcoinLock.value = undefined;
  selectedUnlockLock.value = lock;
  showBitcoinUnlockingOverlay.value = true;
}

function openSingleBitcoinAlert() {
  if (!singleBitcoinAlert.value) return;

  if (
    singleBitcoinAlert.value.kind === 'mismatch' ||
    singleBitcoinAlert.value.kind === 'resumeFunding' ||
    singleBitcoinAlert.value.kind === 'fundingExpiring'
  ) {
    openBitcoinLock({ lock: singleBitcoinAlert.value.lock });
    return;
  }

  openBitcoinUnlock(singleBitcoinAlert.value.lock);
}

function closeBitcoinLockingOverlay(shouldStartNewLocking: boolean) {
  showBitcoinLockingOverlay.value = false;
  selectedBitcoinLock.value = undefined;

  if (!shouldStartNewLocking || !myVault.createdVault) {
    return;
  }

  Vue.nextTick(() => {
    openBitcoinLock();
  });
}

function closeBitcoinUnlockingOverlay() {
  showBitcoinUnlockingOverlay.value = false;
  selectedUnlockLock.value = undefined;
}

function isResumedFundingAlert(alert: IBitcoinAlert | null | undefined): boolean {
  if (!alert?.lock.utxoId) return false;
  return alert.kind === 'fundingExpiring' && !!resumedFundingByLockUtxoId.value[alert.lock.utxoId];
}

async function loadAttentionData() {
  await bitcoinLocks.load().catch(() => undefined);
  await myVault.load().catch(() => undefined);
  if (myVault.createdVault) {
    await myVault.subscribe().catch(() => undefined);
  }
}

async function subscribeBondMarketVault() {
  const vault = myVault.createdVault;
  const vaultId = myVault.vaultId;
  if (!vault || vaultId == null) return;

  const client = await getMainchainClient(false);
  await bondMarket.subscribeGlobal(client);

  unsubscribeBondMarketVault?.();
  unsubscribeBondMarketVault = await bondMarket.subscribeVault(
    {
      vaultId,
      operatorAddress: vault.operatorAccountId,
      accountId: myVault.walletKeys.vaultingAddress,
    },
    client,
  );
}

Vue.watch(
  () => myVault.createdVault?.vaultId,
  vaultId => {
    if (!vaultId) return;
    void myVault.subscribe().catch(() => undefined);
    void subscribeBondMarketVault().catch(() => undefined);
  },
  { immediate: true },
);

Vue.watch(
  bitcoinAlerts,
  alerts => {
    const activeFundingExpiringUtxoIds = new Set(
      alerts
        .filter(alert => alert.kind === 'fundingExpiring')
        .map(alert => alert.lock.utxoId)
        .filter(Boolean) as number[],
    );

    for (const utxoId of Object.keys(resumedFundingByLockUtxoId.value)) {
      if (!activeFundingExpiringUtxoIds.has(Number(utxoId))) {
        delete resumedFundingByLockUtxoId.value[Number(utxoId)];
      }
    }
  },
  { immediate: true },
);

Vue.watch(noticeCount, count => {
  if (count === 0) {
    isExpanded.value = false;
  }
});

Vue.onMounted(() => {
  void loadAttentionData();

  basicEmitter.on('openVaultCollect', openVaultCollect);
  basicEmitter.on('openBitcoinLock', openBitcoinLock);
  basicEmitter.on('openBitcoinUnlock', openBitcoinUnlock);
  basicEmitter.on('closeAllOverlays', closeSharedOverlays);
  basicEmitter.on('resumeBitcoinFunding', markResumedFunding);
});

Vue.onUnmounted(() => {
  unsubscribeBondMarketVault?.();

  basicEmitter.off('openVaultCollect', openVaultCollect);
  basicEmitter.off('openBitcoinLock', openBitcoinLock);
  basicEmitter.off('openBitcoinUnlock', openBitcoinUnlock);
  basicEmitter.off('closeAllOverlays', closeSharedOverlays);
  basicEmitter.off('resumeBitcoinFunding', markResumedFunding);
});
</script>
<style scoped>
@reference "../../main.css";

.alerts-popover-shell {
  @apply rounded-b-lg;
  box-shadow:
    0 18px 36px rgba(15, 23, 42, 0.16),
    0 8px 18px rgba(15, 23, 42, 0.08);
}

.alerts-popover-panel {
  @apply rounded-b-lg border border-slate-300/35 bg-white/98 backdrop-blur-sm;
}
</style>
