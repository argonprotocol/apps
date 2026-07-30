<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" :hasHeaderBorder="false" class="w-7/12">
    <template #title>
      <div class="border-b-none relative top-2 ml-6 grow text-2xl font-bold">Put Your Assets to Work</div>
    </template>

    <div class="mt-2 px-10 pb-8">
      <div class="mb-5 space-y-3 text-[17px]/7 leading-normal font-light">
        <p>
          Treasury is the next level of Argon Desktop. It’s where the network's yield-generating instruments live, where
          your assets help grow and stabilize the currency. Here’s a snapshot into the network’s current APYs:
        </p>

        <ul class="mt-6 grid grid-cols-2 gap-3">
          <li class="border-argon-300/20 bg-argon-100/20 flex items-center justify-between rounded border px-3 py-2">
            <div class="leading-tight">
              <header class="font-bold">Argon Bonds</header>
              <span class="text-base opacity-80">Secure the Vaults</span>
            </div>
            <div class="bg-argon-100/50 rounded px-3 py-2 text-2xl leading-none font-bold">
              {{ numeral(vaultingStats.argonBondsAPR).formatIfElseCapped('< 100', '0.0', '0', 999) }}%
            </div>
          </li>
          <li class="border-argon-300/20 bg-argon-100/20 flex items-center justify-between rounded border px-3 py-2">
            <div class="leading-tight">
              <header class="font-bold">Argonot Staking</header>
              <span class="text-base opacity-80">Secure the Mining</span>
            </div>
            <div class="bg-argon-100/50 rounded px-3 py-2 text-2xl leading-none font-bold">
              <template v-if="isArgonotStakingAprReady">
                {{ numeral(vaultingStats.argonotStakingAPR).formatIfElseCapped('< 100', '0.0', '0', 999) }}%
              </template>
              <template v-else>---%</template>
            </div>
          </li>
          <li class="flex items-center justify-between rounded border border-orange-300/40 bg-orange-100/40 px-3 py-2">
            <div class="leading-tight">
              <header class="font-bold">Bitcoin Locks</header>
              <span class="text-base opacity-80">Stabilize the Currency</span>
            </div>
            <div class="rounded bg-orange-100/90 px-3 py-2 text-2xl leading-none font-bold">
              {{ numeral(vaultingStats.bitcoinAPR).formatIfElseCapped('< 100', '0.0', '0', 999) }}%
            </div>
          </li>
          <li class="flex items-center justify-between rounded border border-blue-300/30 bg-blue-100/30 px-3 py-2">
            <div class="leading-tight">
              <header class="font-bold">Stable Swaps</header>
              <span class="text-base opacity-80">Arbitrage the Swings</span>
            </div>
            <div class="rounded bg-blue-100/80 px-3 py-2 text-2xl leading-none font-bold">13.9%</div>
          </li>
        </ul>

        <div
          class="mt-4 rounded-md border border-slate-600/20 px-1 py-2"
          :class="showingExtraDetails ? '' : 'hover:bg-argon-100/10'"
        >
          <button
            @click="showingExtraDetails = !showingExtraDetails"
            class="flex w-full cursor-pointer flex-row items-center gap-x-1.5 px-3"
          >
            <InfoIcon class="text-argon-600 relative -top-px w-4" />
            <div class="text-argon-600 grow text-left">How are these rates possible?</div>
            <MinusIcon v-if="showingExtraDetails" class="w-4 cursor-pointer text-slate-900/60" />
            <PlusIcon v-else class="w-4 text-slate-900/60" />
          </button>
          <div
            v-if="showingExtraDetails"
            class="text-md mt-2 flex flex-col gap-y-2 border-t border-slate-600/20 px-3 pt-3 pb-1"
          >
            <p>
              First off, these rates float. The numbers shown above are simply what the network is paying right now. The
              strong returns are a combination of Argon's economic design paired with the fact that the network is in
              its very early growth stage -- these rates are guaranteed to drop down substantially over time. For now,
              they reflect the value these assets are adding to the network.
            </p>

            <p>
              <strong class="font-bold">Argon Bonds</strong>
              support the network's stabilization vaults. As demand for Argon grows, the new stablecoins must be
              stabilized.
            </p>

            <p>
              <strong class="font-bold">Argonot Staking</strong>
              support the network's mining efforts. The network needs continual mining and processing, which are secured
              by argonots.
            </p>

            <p>
              <strong class="font-bold">Bitcoin Locks</strong>
              earn fees for providing the collateral backing the massive shorts applied against Argon's peg.
            </p>
            <p>
              <strong class="font-bold">Stable Swaps</strong>
              provide short-term liquidity for whenever Argon deviates from its peg.
            </p>
          </div>
        </div>
      </div>

      <div class="mb-2 font-bold">Have An Access Code?</div>
      <div class="flex flex-row gap-x-3">
        <input
          v-model="inviteCode"
          type="text"
          placeholder="Paste access code"
          class="text-md focus:border-argon-500 focus:ring-argon-500/15 grow rounded-lg border border-slate-400/70 bg-white px-2.5 py-2.5 text-lg font-normal text-slate-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] transition outline-none focus:ring-2"
        />

        <button
          @click="connectToNetwork"
          class="bg-argon-button border-argon-button-hover hover:bg-argon-button-hover inner-button-shadow flex cursor-pointer flex-row items-center justify-center space-x-2 rounded-md border px-12 py-3 font-bold whitespace-nowrap text-white focus:outline-none"
          tabindex="0"
        >
          Activate Upgrade
        </button>
      </div>
      <div
        v-if="formError"
        class="mt-2 flex flex-row items-center gap-x-2 rounded-lg border border-red-400/50 bg-red-100 px-3 py-1.5 text-red-600"
      >
        <AlertIcon class="h-4 w-4 shrink-0" />
        <span>{{ formError }}</span>
      </div>
      <div class="text-md mt-2 italic opacity-60">
        Upgrades to Treasury are invite-only, distributed by network operators.
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { getConfig } from '../stores/config.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getUpstreamOperatorAuthClient } from '../stores/server.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import AlertIcon from '../assets/alert.svg?component';
import { BootstrapType, TopTab } from '../interfaces/IConfig.ts';
import { InviteEnvelope } from '../lib/InviteEnvelope.ts';
import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import numeral from '../lib/numeral.ts';
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { useVaultingStats } from '../stores/vaultingStats.ts';
import { getVaults } from '../stores/vaults.ts';
import InfoIcon from '../assets/info-outline.svg';
import { PlusIcon, MinusIcon } from '@heroicons/vue/20/solid';

const emit = defineEmits<{
  (e: 'claimed'): void;
}>();

const config = getConfig();
const walletKeys = getWalletKeys();
const controller = useCertificationController();
const vaultingStats = useVaultingStats();
const vaults = getVaults();

const isOpen = Vue.ref(false);
const hasValidInviteCode = Vue.ref(false);
const inviteCode = Vue.ref<string>('');
const formError = Vue.ref('');
const showingExtraDetails = Vue.ref(false);
const isArgonotStakingAprReady = Vue.ref(false);

async function refreshArgonotStakingApr(): Promise<void> {
  isArgonotStakingAprReady.value = false;
  try {
    await vaults.updateRevenue();
    await vaultingStats.update();
    isArgonotStakingAprReady.value = Boolean(vaults.stats?.argonotStakingByFrame.length);
  } catch (error) {
    console.warn('[UpgradeToTreasuryOverlay] Unable to refresh Argonot staking APR', error);
  }
}

function extractInviteCodeFromUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const match = parsedUrl.pathname.match(/^\/invite\/([^/?#]+)/);
  if (!match?.[1]) return trimmed;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

if (typeof window !== 'undefined') {
  const inviteFromPageUrl = extractInviteCodeFromUrl(window.location.href);
  if (inviteFromPageUrl !== window.location.href.trim()) {
    inviteCode.value = inviteFromPageUrl;
  }
}

function closeOverlay() {
  isOpen.value = false;
  showingExtraDetails.value = false;
}

async function connectToNetwork() {
  formError.value = '';

  if (!hasValidInviteCode.value) {
    formError.value = 'You must provide a valid access code.';
    return;
  }

  const meta = InviteEnvelope.decode(inviteCode.value);
  if (meta.hasError || meta.isEmpty) {
    formError.value = 'The access code you provided is invalid.';
    return;
  }
  if (!meta.inviteCode || !meta.host || !meta.port) {
    formError.value = 'The access code you provided is invalid.';
    return;
  }

  const operatorAddress = [meta.host, meta.port].filter(Boolean).join(':');
  const operatorHost = UpstreamOperatorClient.getBootstrapHost({
    type: BootstrapType.Private,
    routerHost: operatorAddress,
  });
  if (!operatorHost) {
    formError.value = 'The access code you provided is invalid.';
    return;
  }

  try {
    const authKeypair = await walletKeys.getUpstreamOperatorAuthKeypair();
    const defaultAccountKeypair = await walletKeys.getLiquidLockingKeypair();
    const body = await UpstreamOperatorClient.claimInvite({
      operatorHost,
      inviteCode: meta.inviteCode,
      defaultAccountKeypair,
      authKeypair,
    });

    if (!body?.fromName || !body.invite?.vaultId || !body.invite.bitcoinLockCoupon) {
      throw new Error('Unable to connect with that access code. Please verify it and try again.');
    }

    config.upstreamOperator = {
      ...config.upstreamOperator,
      name: body.fromName,
      vaultId: body.invite.vaultId,
      accountId: body.operatorAccountId ?? body.referrer,
    };
    config.hasExtensionTreasury = true;
    config.showWelcomeOverlay = false;
    config.bootstrapDetails = {
      ...UpstreamOperatorClient.getBootstrapDetails(operatorHost, BootstrapType.Private),
    };
    closeOverlay();
    config.showWelcomeOverlay = true;
    emit('claimed');

    await config.save();
    try {
      await getUpstreamOperatorAuthClient().getMemberSessionId(operatorHost);
    } catch (error) {
      console.warn('Unable to enroll upstream recovery during invite claim', error);
    }
    controller.setTab(TopTab.BitcoinLocks);
  } catch (error) {
    formError.value =
      error instanceof Error && error.message
        ? error.message
        : 'An error occurred trying to connect with that access code. Please verify it and try again.';
    return;
  }
}

basicEmitter.on('openUpgradeToTreasuryOverlay', () => {
  isOpen.value = true;
  void refreshArgonotStakingApr();
});

Vue.watch(
  inviteCode,
  () => {
    const normalizedInviteCode = extractInviteCodeFromUrl(inviteCode.value);
    if (normalizedInviteCode !== inviteCode.value) {
      inviteCode.value = normalizedInviteCode;
      return;
    }

    const decoded = InviteEnvelope.decode(normalizedInviteCode);
    formError.value = '';
    hasValidInviteCode.value = true;
    if (decoded.hasError) {
      formError.value = 'The access code you provided is invalid.';
      hasValidInviteCode.value = false;
    }
  },
  { immediate: true },
);
</script>
