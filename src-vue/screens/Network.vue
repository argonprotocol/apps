<!-- prettier-ignore -->
<template>
  <div class="flex h-full grow flex-col justify-stretch">
    <section box class="grow flex flex-col">
      <div class="network-map">
        <article class="network-card network-card--wide network-card--row-1 network-card--col-1" />
        <article class="network-card network-card--wide network-card--row-1 network-card--col-3" />

        <header class="network-heading opacity-50">
          <h1>Global Argon Network</h1>
          <p>
            Argon Has {{ networkStats.activeNodes.length }} Nodes
            with {{ networkStats.miningNodes.length }} Miners
            and {{ networkStats.vaultNodes.length }} Vault{{networkStats.vaultNodes.length===1 ? '' : 's'}}
          </p>
          <p>With an Economic Value of ${{ microgonToMoneyNm(networkStats.totalEconomicValue).format('0,0') }} and the Stablecoin @ Target</p>
        </header>

        <article class="network-card network-card--wide network-card--row-1 network-card--col-13" />
        <article class="network-card network-card--wide network-card--row-1 network-card--col-15" />

        <article class="network-card network-card--compact network-card--row-2 network-card--col-1" />
        <article class="network-card network-card--wide network-card--row-2 network-card--col-2" />
        <article class="network-card network-card--wide network-card--row-2 network-card--col-14" />
        <article class="network-card network-card--compact network-card--row-2 network-card--col-16" />

        <article class="network-card network-card--wide network-card--row-3 network-card--col-1" />
        <article class="network-card network-card--wide network-card--row-3 network-card--col-3" />
        <article class="network-card network-card--wide network-card--row-3 network-card--col-5" />
        <article class="network-card network-card--wide network-card--row-3 network-card--col-7" />
        <article class="network-card network-card--wide network-card--row-3 network-card--col-9" />
        <article class="network-card network-card--wide network-card--row-3 network-card--col-11" />
        <article class="network-card network-card--wide network-card--row-3 network-card--col-13" />
        <article class="network-card network-card--wide network-card--row-3 network-card--col-15" />
        <div class="network-connectors" aria-hidden="true">
          <div class="network-rail" />
          <div
            v-for="connector in 8"
            :key="connector"
            class="network-tap"
            :style="{ left: `${(connector - 0.5) * 12.5}%` }"
          />
          <div class="network-drop" />
        </div>
      </div>

      <div
        class="flex flex-col justify-start relative"
        :class="[config.hasExtensionOperations ? '' : 'grow']"
      >
        <div class="network-map network-map--upstream w-full">
          <header class="upstream-heading">
            <h2>Upstream Network</h2>
          </header>

          <article class="network-spacer-card upstream-left-spacer" />
          <article class="network-card network-card--wide upstream-card-1" />
          <article class="network-card network-card--wide upstream-card-2" />
          <article class="network-card network-card--wide upstream-card-3" />
          <article class="network-spacer-card upstream-right-spacer" />

          <div class="upstream-connectors" aria-hidden="true">
            <div class="upstream-rail" />
            <div class="upstream-tap upstream-tap--1" />
            <div class="upstream-tap upstream-tap--2" />
            <div class="upstream-tap upstream-tap--3" />
            <div class="upstream-drop" />
          </div>
        </div>
      </div>

      <template v-if="config.hasExtensionOperations">
        <div class="network-map network-map--operational">
          <div class="operational-account-card">
            <div class="operational-account-header">
              <div class="flex min-w-0 items-center gap-3">
                <h2>Your Operational Account</h2>
                <span
                  v-if="controller.operationalOverview.isOperationalActivationReady"
                  class="text-xs font-semibold text-argon-600"
                >
                  Ready to activate
                </span>
                <span
                  v-else-if="controller.operationalOverview.isFullyOperational"
                  class="text-xs font-semibold text-argon-600"
                >
                  Operational
                </span>
                <span v-else class="text-xs font-semibold text-slate-500">Finishing certification</span>
              </div>

              <button
                type="button"
                class="bg-argon-button hover:bg-argon-button-hover operational-account-action"
                @click="openOperationalAction"
              >
                <span v-if="controller.operationalOverview.isOperationalActivationReady">Activate &amp; Claim Reward</span>
                <span v-else-if="controller.operationalOverview.isFullyOperational && controller.operationalOverview.hasPendingRewards">Claim Rewards</span>
                <span v-else-if="controller.operationalOverview.isFullyOperational">View Rewards</span>
                <span v-else>Open Certification</span>
              </button>
            </div>

            <p v-if="controller.operationalOverview.isOperationalActivationReady">
              Certification is complete. Activate it to unlock your reward and begin growing your operator network.
            </p>
            <p v-else-if="controller.operationalOverview.isFullyOperational && controller.operationalOverview.hasPendingRewards">
              Claim available rewards and keep guiding treasury members through certification.
            </p>
            <p v-else-if="controller.operationalOverview.isFullyOperational">
              Manage active invites here. New rewards will appear as they become claimable.
            </p>
            <p v-else>
              Continue from Certification. Guided steps will point to Mining and Vaulting in the sidebar.
            </p>

            <div class="operational-account-stats">
              <div class="operational-account-stat">
                <strong>₳{{ microgonToArgonNm(controller.operationalOverview.pendingRewardsAmount).format('0,0.[00]') }}</strong>
                <span>Pending rewards</span>
              </div>

              <div class="operational-account-stat">
                <strong>{{ controller.operationalOverview.availableUpgradeCodeCount }}</strong>
                <span>Upgrade codes ready</span>
              </div>

              <div class="operational-account-stat">
                <strong>{{ controller.operationalOverview.activeInviteCount }}</strong>
                <span>Invites in progress</span>
              </div>
            </div>
          </div>
          <div class="operational-account-connector" aria-hidden="true" />
        </div>
        <div class="grow px-8 pb-5">
          <MemberInvites />
        </div>
      </template>

      <div v-else-if="config.hasExtensionTreasury" class="grow">
        <div class="text-argon-600/60 relative z-10 mt-0">
          <LockedIcon class="w-10 mx-auto" />
          <div class="mt-7 text-5xl text-center font-bold">LOCKED</div>
          <div class="text-center text-2xl leading-normal font-bold text-slate-800/80 border-y border-argon-600/10 w-fit mx-auto mt-6 py-6 px-3">
            You Must Complete Your Operator<br />
            Certification to Unlock Additional Features<br />

          </div>
          <div class="text-center mt-6">
            <a href="https://argon.network/docs/desktop-app/treasury">Learn more</a>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import LockedIcon from '../assets/locked.svg?component';
import basicEmitter from '../emitters/basicEmitter.ts';
import { useNetworkStats } from '../stores/networkStats.ts';
import { getCurrency } from '../stores/currency.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import MemberInvites from './network-screen/MemberInvites.vue';
import { getConfig } from '../stores/config.ts';
import { useCertificationController } from '../stores/certificationController.ts';

const config = getConfig();
const networkStats = useNetworkStats();
const currency = getCurrency();
const controller = useCertificationController();

const { microgonToArgonNm, microgonToMoneyNm } = createNumeralHelpers(currency);

function openOperationalAction() {
  if (controller.operationalOverview.isOperationalActivationReady) {
    basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'activate' });
    return;
  }

  if (controller.operationalOverview.isFullyOperational) {
    basicEmitter.emit('openOperationalRewardsOverlay', { screen: 'claim' });
    return;
  }

  basicEmitter.emit('openCertificationMenu');
}
</script>

<style scoped>
@reference "../main.css";

[box] {
  @apply h-full rounded border-[1px] border-slate-400/30 bg-white shadow;
}

.network-map {
  --network-card-bg: theme(colors.fuchsia.50 / 68%);
  --network-card-border: theme(colors.fuchsia.200 / 72%);
  --network-connector: #ebeff4;
  --network-grid-gap: theme(spacing.3);

  @apply relative grid grid-cols-[repeat(16,minmax(0,1fr))] grid-rows-[repeat(3,56px)_64px] gap-x-3 gap-y-3 overflow-hidden px-3 py-3;
}

.network-map--upstream {
  @apply grid-rows-[42px_56px_64px] pt-0;
}

.network-map--operational {
  @apply grid-rows-[112px_30px] overflow-visible pt-0;
}

.network-heading {
  @apply col-start-5 col-end-13 row-start-1 row-end-3 flex flex-col items-center justify-center text-center text-slate-700;

  h1 {
    @apply mb-2 text-xl leading-none font-bold text-slate-800;
  }

  p {
    @apply text-[17px] leading-7 font-light;
  }
}

.network-card {
  @apply relative z-10 min-w-0 rounded border;
  border-color: var(--network-card-border);
  box-shadow:
    inset 1px 1px 0 rgb(255, 255, 255),
    1px 1px 1px rgba(0, 0, 0, 0.05);
}

.network-spacer-card {
  @apply relative z-10 min-w-0 rounded border border-fuchsia-200/60 bg-white;
  box-shadow:
    inset 1px 1px 0 rgb(255, 255, 255),
    1px 1px 1px rgba(0, 0, 0, 0.05);
}

.network-connectors {
  @apply relative row-start-4;
  grid-column: 1 / -1;
}

.network-rail {
  @apply absolute top-[20px] h-2;
  right: calc(6.25% - 4px);
  left: calc(6.25% - 4px);
  background: var(--network-connector);
}

.network-tap {
  @apply absolute top-[-8px] h-8 w-2 -translate-x-1/2;
  background: var(--network-connector);
}

.network-drop {
  @apply absolute top-2 left-1/2 h-16 w-2 -translate-x-1/2;
  background: var(--network-connector);
}

.upstream-heading {
  @apply row-start-1 flex items-center justify-center text-center text-slate-800;
  grid-column: 1 / -1;

  h2 {
    @apply text-xl leading-none font-bold;
  }
}

.upstream-left-spacer {
  @apply col-span-5 col-start-1 row-start-2;
  margin-left: calc((100% - (4 * var(--network-grid-gap))) / 10 + (var(--network-grid-gap) / 4));
}

.upstream-card-1 {
  @apply col-start-6 row-start-2;
}

.upstream-card-2 {
  @apply col-start-8 row-start-2;
}

.upstream-card-3 {
  @apply col-start-10 row-start-2;
}

.upstream-right-spacer {
  @apply col-span-5 col-start-12 row-start-2;
  margin-right: calc((100% - (4 * var(--network-grid-gap))) / 10 + (var(--network-grid-gap) / 4));
}

.upstream-connectors {
  @apply relative row-start-3;
  grid-column: 6 / 12;
}

.upstream-rail {
  @apply absolute top-[10px] right-[16.6667%] left-[16.6667%] h-2;
  background: var(--network-connector);
}

.upstream-tap {
  @apply absolute -top-3 h-5 w-2 -translate-x-1/2;
  background: var(--network-connector);
}

.upstream-tap--1 {
  @apply left-[16.6667%];
}

.upstream-tap--2 {
  @apply left-1/2;
}

.upstream-tap--3 {
  @apply left-[83.3333%];
}

.upstream-drop {
  @apply absolute top-2 left-1/2 h-16 w-2 -translate-x-1/2;
  background: var(--network-connector);
}

.operational-account-card {
  @apply relative z-10 row-start-1 flex min-w-0 flex-col justify-center rounded border border-fuchsia-200/60 bg-white px-5 py-3 text-left;
  grid-column: 1 / -1;
  margin-inline: calc((100% - (15 * var(--network-grid-gap))) / 32 + (var(--network-grid-gap) / 4));
  box-shadow:
    inset 1px 1px 0 rgb(255, 255, 255),
    1px 1px 1px rgba(0, 0, 0, 0.05);

  h2 {
    @apply text-lg leading-none font-bold text-slate-800;
  }

  p {
    @apply mt-1 max-w-4xl text-sm leading-5 text-slate-600;
  }
}

.operational-account-header {
  @apply flex items-center justify-between gap-5;
}

.operational-account-stats {
  @apply mt-2 flex items-center gap-x-8;
}

.operational-account-stat {
  @apply flex min-w-0 items-baseline gap-2;

  strong {
    @apply text-argon-600 text-lg leading-none font-bold;
  }

  span {
    @apply text-xs font-medium text-slate-500;
  }
}

.operational-account-action {
  @apply shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-white;
}

.operational-account-connector {
  @apply relative row-start-1 row-end-3;
  grid-column: 1 / -1;
}

.operational-account-connector::before,
.operational-account-connector::after {
  @apply absolute left-1/2 w-2 -translate-x-1/2 content-[''];
  background: var(--network-connector);
}

.operational-account-connector::before {
  @apply top-[-32px] h-8;
}

.operational-account-connector::after {
  @apply top-[112px] h-8;
}

.network-card--wide {
  @apply col-span-2;
}

.network-card--compact {
  @apply col-span-1;
}

.network-card--row-1 {
  @apply row-start-1;
}

.network-card--row-2 {
  @apply row-start-2;
}

.network-card--row-3 {
  @apply row-start-3;
}

.network-card--col-1 {
  @apply col-start-1;
}

.network-card--col-2 {
  @apply col-start-2;
}

.network-card--col-3 {
  @apply col-start-3;
}

.network-card--col-5 {
  @apply col-start-5;
}

.network-card--col-7 {
  @apply col-start-7;
}

.network-card--col-9 {
  @apply col-start-9;
}

.network-card--col-11 {
  @apply col-start-11;
}

.network-card--col-13 {
  @apply col-start-13;
}

.network-card--col-14 {
  @apply col-start-14;
}

.network-card--col-15 {
  @apply col-start-15;
}

.network-card--col-16 {
  @apply col-start-16;
}
</style>
