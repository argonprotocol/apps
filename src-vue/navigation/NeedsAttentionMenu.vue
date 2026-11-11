<template>
  <NavigationMenuItem v-if="attention.count" value="attention">
    <NavigationMenuTrigger
      :aria-label="`Needs attention (${attention.count})`"
      class="text-argon-600/70 flex h-[30px] cursor-pointer items-center gap-2 rounded-md border border-slate-400/50 px-2.5 text-base font-semibold hover:bg-slate-400/10"
    >
      <BellAlertIcon
        class="attention-bell size-5"
        :class="{ 'attention-bell-ringing': attention.hasUnseenActions }"
        :style="{ animationPlayState: isWindowFocused && visibility === 'visible' ? 'running' : 'paused' }"
      />
      <span>{{ attention.count }}</span>
    </NavigationMenuTrigger>
    <NavigationMenuContent class="w-160">
      <h2 class="border-argon-300/30 bg-argon-600/5 text-argon-600 border-b px-5 py-2 text-base font-bold">
        Notifications
      </h2>
      <div class="max-h-128 divide-y divide-slate-300/60 overflow-y-auto bg-white/80 px-5">
        <div v-if="attention.vaultAlert" class="py-4">
          <VaultAlert :notice="attention.vaultAlert" :isLast="true" @open="openVault" />
        </div>

        <div v-for="group in attention.bitcoinAlertGroups" :key="group.notices[0].kind" class="py-4">
          <BitcoinAlert
            v-if="group.notices.length === 1"
            :notice="group.notices[0]"
            :isLast="true"
            @open-lock="openBitcoin"
            @open-unlock="openBitcoin"
          />
          <AlertDetailRow
            v-else
            title="Bitcoin Locks Need Attention"
            buttonLabel="Review Locks"
            :isLast="true"
            @open="openBitcoinLocks"
          >
            <template #icon><BitcoinIcon class="text-argon-700/70 h-8 w-8" /></template>
            <template #subline>
              <div>
                <template v-if="group.notices[0].kind === 'unlockNeedsAttention'">
                  {{ group.notices.length }} Bitcoin unlocks need attention.
                </template>
                <template v-else-if="group.notices[0].kind === 'unlockExpiring'">
                  {{ group.notices.length }} Bitcoin locks are nearing expiry.
                </template>
                <template v-else>{{ group.notices.length }} cosigner guarantees are expiring.</template>
              </div>
              <div class="mt-1">
                ₳{{ microgonToArgonNm(group.amountMicrogons).format('0,0.00') }} in reserved collateral.
              </div>
            </template>
          </AlertDetailRow>
        </div>

        <div v-if="attention.pendingOperationsUpgradeRequests.length" class="py-4">
          <AlertDetailRow
            title="Operations Upgrade Requests"
            buttonLabel="Review Requests"
            :isLast="true"
            @open="openUpgrades"
          >
            <template #icon><AlertIcon class="text-argon-700/70 h-8 w-8" /></template>
            <template #subline>
              {{ attention.pendingOperationsUpgradeRequests.length }}
              <template v-if="attention.pendingOperationsUpgradeRequests.length === 1">member is</template>
              <template v-else>members are</template>
              waiting for your approval.
            </template>
          </AlertDetailRow>
        </div>

        <div v-if="attention.stabilizerBuyOpportunity" class="py-4">
          <AlertDetailRow
            title="Stabilizer Buy Opportunity"
            buttonLabel="Buy ARGN"
            :isLast="true"
            @open="openNotice(attention.stabilizerBuyOpportunity)"
          >
            <template #icon><EthereumIcon class="text-argon-700/70 h-9 w-9" /></template>
            <template #subline>
              <div class="text-argon-600 font-semibold">
                <Returns
                  :returns="{ apy: attention.stabilizerBuyOpportunity.apy }"
                  metric="APY"
                  :showLabel="false"
                  :hideDecimalsAt="10"
                />
                estimated APY ·
                {{
                  numeral(attention.stabilizerBuyOpportunity.discountPercent).formatIfElse(
                    Math.abs(attention.stabilizerBuyOpportunity.discountPercent) < 10,
                    '0,0.[0]',
                    '0,0',
                  )
                }}% below target
              </div>
              <div class="mt-1">
                Your current quote buys
                {{ microgonToArgonNm(attention.stabilizerBuyOpportunity.quote.quotedMicrogonsOut).format('0,0.[00]') }}
                ARGN.
              </div>
            </template>
          </AlertDetailRow>
        </div>

        <div v-if="attention.stabilizerBid" class="py-4">
          <AlertDetailRow
            :title="attention.stabilizerBid.bid ? 'Stabilizer Buy Bonus at Risk' : 'Stabilizer Buy Bidding Is Open'"
            :buttonLabel="attention.stabilizerBid.bid ? 'Adjust Bid' : 'Submit Bid'"
            :isLast="true"
            @open="openNotice(attention.stabilizerBid)"
          >
            <template #icon><AlertIcon class="text-argon-700/70 h-8 w-8" /></template>
            <template #subline>
              <template v-if="attention.stabilizerBid.bid">
                <div>
                  Your {{ attention.stabilizerBid.bid.latestBid }}% bid currently qualifies for an estimated
                  <strong>
                    ₳{{ microgonToArgonNm(attention.stabilizerBid.bid.fundingEstimate).format('0,0.00') }}
                  </strong>
                  of ₳{{ microgonToArgonNm(attention.stabilizerBid.bid.requestedReward).format('0,0.00') }} in bonuses.
                </div>
                <div class="mt-1">A smaller percentage can move your bid ahead.</div>
              </template>
              <template v-else>
                You have ₳{{ microgonToArgonNm(attention.stabilizerBid.position.purchase.principal).format('0,0.00') }}
                in held buys. Submit your first bid to qualify for a bonus.
              </template>
            </template>
          </AlertDetailRow>
        </div>
      </div>
    </NavigationMenuContent>
  </NavigationMenuItem>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useDocumentVisibility, useWindowFocus } from '@vueuse/core';
import { updateAppBadge } from '../lib/SystemNotifications.ts';
import { NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent } from 'reka-ui';
import { BellAlertIcon } from '@heroicons/vue/24/outline';
import AlertDetailRow from '../alerts/AlertDetailRow.vue';
import BitcoinAlert from '../alerts/BitcoinAlert.vue';
import VaultAlert from '../alerts/VaultAlert.vue';
import AlertIcon from '../assets/alert.svg?component';
import BitcoinIcon from '../assets/wallets/bitcoin.svg?component';
import EthereumIcon from '../assets/wallets/networks/ethereum.svg?component';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import Returns from '../components/Returns.vue';
import { getCurrency } from '../stores/currency.ts';
import { useAttention, openStabilizerBuyNotice } from '../stores/attention.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { useWallets } from '../stores/wallets.ts';
import { TopTab } from '../interfaces/IConfig.ts';
import type { IBitcoinAlert } from '../lib/Alerts.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import type { IStabilizerBuyOpportunity } from '../interfaces/IStabilizerBuyPurchase.ts';

const attention = useAttention();
const controller = useCertificationController();
const wallets = useWallets();
const { microgonToArgonNm } = createNumeralHelpers(getCurrency());
const emit = defineEmits<{ close: [] }>();
const props = defineProps<{ isOpen: boolean }>();

const isWindowFocused = useWindowFocus();
const visibility = useDocumentVisibility();

watch(
  [() => props.isOpen, () => attention.actionKeys],
  () => {
    if (props.isOpen) attention.markViewed();
  },
  { immediate: true },
);

watch(
  () => attention.count,
  count => {
    void updateAppBadge(count).catch(error => console.warn('[Attention] Unable to update the app badge', error));
  },
  { immediate: true },
);

function openVault() {
  emit('close');
  basicEmitter.emit('closeAllOverlays');
  basicEmitter.emit('openVaultCollect');
}

function openBitcoin(alert: IBitcoinAlert) {
  emit('close');
  basicEmitter.emit('closeAllOverlays');
  if (alert.kind === 'securitizationHoldExpiring') {
    basicEmitter.emit('openWalletOverlay', { wallet: wallets.bitcoinWallet, bitcoinChannelUuid: alert.lock.uuid });
  } else basicEmitter.emit('openBitcoinUnlock', alert.lock);
}

function openUpgrades() {
  emit('close');
  basicEmitter.emit('closeAllOverlays');
  controller.setTab(TopTab.Onboarding);
}

function openBitcoinLocks() {
  emit('close');
  basicEmitter.emit('closeAllOverlays');
  controller.setTab(TopTab.BitcoinLocks);
}

function openNotice(notice: IStabilizerBuyOpportunity) {
  emit('close');
  openStabilizerBuyNotice(notice);
}
</script>

<style scoped>
.attention-bell {
  transform-origin: 50% 15%;
}

.attention-bell-ringing {
  animation: attention-bell-shiver 60s ease-in-out infinite;
}

@keyframes attention-bell-shiver {
  0%,
  1.2%,
  100% {
    transform: rotate(0deg);
  }
  0.2% {
    transform: rotate(-4deg);
  }
  0.4% {
    transform: rotate(4deg);
  }
  0.6% {
    transform: rotate(-3deg);
  }
  0.8% {
    transform: rotate(2deg);
  }
  1% {
    transform: rotate(-1deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .attention-bell-ringing {
    animation: none;
  }
}
</style>
