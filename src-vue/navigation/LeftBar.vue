<template>
  <div class="Navigation LeftBar z-10 flex h-full max-w-76 min-w-76 flex-col gap-y-1.5 select-none">
    <section DashBox class="border-argon-600/50! w-full">
      <div class="flex flex-col justify-center px-1">
        <header class="flex w-full flex-row items-center border-b border-slate-500/20">
          <div class="grow">Your Argon Wallet</div>
          <button type="button" class="cursor-pointer" @click="openDefaultArgonWallet">
            <ExternalIcon class="w-4 opacity-80" />
          </button>
        </header>
        <div class="text-argon-600/50 mt-5 flex flex-row justify-center text-5xl font-bold">
          <FormattedMoney :value="0n" />
        </div>
        <div class="w-full text-center">Total Value</div>
        <div class="mt-4 text-left text-slate-900/60">
          <div class="flex flex-row border-t border-slate-500/20 px-3 py-2">
            <div class="grow">0 ARGN</div>
            <div class="opacity-60">$0.00</div>
          </div>
          <div class="flex flex-row border-t border-slate-500/20 px-3 py-2">
            <div class="grow">0 ARGNOT</div>
            <div class="opacity-60">$0.00</div>
          </div>
        </div>
        <WalletsMenu />
      </div>
    </section>

    <section DashBox class="w-full grow px-1 pb-3">
      <div>
        <!--        <header>Basics</header>-->
        <ul>
          <li
            @click="goto(TopTab.Dashboard)"
            class="border-t-0!"
            :class="{ Selected: controller.selectedTab === TopTab.Dashboard }"
          >
            <article TopLevel class="flex flex-row items-center">
              <div class="grow">Dashboard</div>
              <div><span class="rounded-full bg-slate-600/40 px-2 font-bold text-white">1</span></div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.Network)" :class="{ Selected: controller.selectedTab === TopTab.Network }">
            <article TopLevel class="flex flex-row items-center">
              <div class="grow">{{ config.hasExtensionTreasury ? 'Network' : 'Treasury Unlock' }}</div>
              <div class="opacity-30">$0.00</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#000000" :strokeWidth="1" />
              </div>
            </div>
          </li>
        </ul>
        <div
          v-if="config.isLoaded && !config.hasExtensionTreasury"
          class="pointer-events-none relative -top-2 z-20 text-center"
        >
          <div class="text-right">
            <div class="absolute top-[7px] right-[19px] z-10 h-px w-[21px] bg-[#FDF4FF]" />
            <img src="/arrow.png" class="relative z-20 mr-5 inline-block" />
          </div>
          <div class="font-bold">Upgrade Your App</div>
          <div class="mt-1 text-slate-700/60">
            Insert an access code to
            <br />
            unlock your network’s
            <br />
            yield generating assets.
          </div>
        </div>
      </div>

      <div class="mt-3" v-if="config.isLoaded && config.hasExtensionTreasury">
        <header>Treasury</header>
        <ul>
          <li @click="goto(TopTab.BitcoinLocks)" :class="{ Selected: controller.selectedTab === TopTab.BitcoinLocks }">
            <article class="flex flex-row items-center">
              <div class="grow">Bitcoin Locks</div>
              <div>
                <span class="rounded-full bg-slate-600/40 px-2 font-bold text-white">
                  {{ bitcoinLockCoupons.openCouponCount }}
                </span>
              </div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.BitcoinLoans)" :class="{ Selected: controller.selectedTab === TopTab.BitcoinLoans }">
            <article class="flex flex-row items-center">
              <div class="grow">Bitcoin Loans</div>
              <div class="opacity-30">$0.00</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.ArgonBonds)" :class="{ Selected: controller.selectedTab === TopTab.ArgonBonds }">
            <article class="flex flex-row items-center">
              <div class="grow">Argon Bonds</div>
              <div class="opacity-30">$0.00</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.ArgonotBonds)" :class="{ Selected: controller.selectedTab === TopTab.ArgonotBonds }">
            <article class="flex flex-row items-center">
              <div class="grow">Argonot Bonds</div>
              <div class="opacity-30">$0.00</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
          <li @click="goto(TopTab.StableSwaps)" :class="{ Selected: controller.selectedTab === TopTab.StableSwaps }">
            <article class="flex flex-row items-center">
              <div class="grow">Stable Swaps</div>
              <div class="opacity-30">$0.00</div>
            </article>
            <div Selector>
              <div ArrowSquare>
                <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
              </div>
            </div>
          </li>
        </ul>
      </div>

      <div class="mt-3" v-if="config.isLoaded && config.hasExtensionOperations">
        <header>Operations</header>
        <ul>
          <li
            data-testid="LeftBar.goto(TopTab.Mining)"
            @click="goto(TopTab.Mining)"
            :class="{ selected: controller.selectedTab === TopTab.Mining }"
          >
            Mining
          </li>
          <li
            data-testid="LeftBar.goto(TopTab.Vaulting)"
            @click="goto(TopTab.Vaulting)"
            :class="{ selected: controller.selectedTab === TopTab.Vaulting }"
          >
            Vaulting
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { MiningSetupStatus, TopTab, VaultingSetupStatus } from '../interfaces/IConfig.ts';
import { useCertificationController } from '../stores/certificationController.ts';
import { getConfig } from '../stores/config.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import { getBitcoinLockCoupons } from '../stores/bitcoin.ts';
import ExternalIcon from '../assets/external.svg?component';
import WalletsMenu from './WalletsMenu.vue';
import Arrow from '../components/Arrow.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletType } from '../lib/Wallet.ts';

const controller = useCertificationController();
const bitcoinLockCoupons = getBitcoinLockCoupons();
const config = getConfig();

function openDefaultArgonWallet() {
  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

function goto(tab: TopTab) {
  if (controller.backButtonTriggersHome) {
    controller.backButtonTriggersHome = false;
    if (tab === TopTab.Mining) {
      config.miningSetupStatus = MiningSetupStatus.None;
    } else if (tab === TopTab.Vaulting) {
      config.vaultingSetupStatus = VaultingSetupStatus.None;
    }
  }
  controller.setTab(tab);
}
</script>

<style scoped>
@reference "../main.css";

header {
  @apply px-3 py-3 font-bold text-slate-700/40 uppercase;
}

ul {
  @apply border-b border-slate-500/20;
}

ul li {
  @apply relative cursor-pointer border-t border-slate-500/20 py-1;
  &.Selected {
    [Selector] {
      @apply block;
    }
    article {
      @apply text-slate-900;
    }
    article[TopLevel] {
      @apply text-argon-700/70;
    }
  }
  &:hover:not(.Selected) {
    article {
      @apply bg-argon-100/20 text-slate-900;
    }
    article[TopLevel] {
      @apply text-argon-700/50;
    }
  }
  article {
    @apply relative z-10 px-2 py-2 text-slate-900/60;
  }
  article[TopLevel] {
    @apply font-bold text-slate-700/40 uppercase;
  }
  [Selector] {
    @apply border-argon-600 absolute -top-px left-[-5px] hidden h-[calc(100%+2px)] w-[calc(100%+10px)] rounded-l border border-r-0 shadow-lg;
    background: #fdf4ff;
  }
}

[ArrowSquare] {
  @apply absolute left-[calc(100%+0px)] z-10 block h-full w-4 overflow-visible;
  &::before {
    content: '';
    @apply absolute inset-y-0 left-0 w-full bg-black drop-shadow-[1px_1px_1px_rgb(0_0_0/0.16)];
    clip-path: polygon(0 0, 100% 50%, 0 100%);
  }
  &::after {
    content: '';
    @apply absolute top-px right-[1px] bottom-px left-0;
    background: #fdf4ff;
    clip-path: polygon(0 0, 100% 50%, 0 100%);
  }
  svg[InactiveArrow] {
    @apply hidden;
  }
  svg[ActiveArrow] {
    @apply absolute top-[2px] left-[calc(25%-9px)] hidden h-5.5 w-[calc(100%-10px)] origin-left -translate-y-1/2 rotate-90 drop-shadow-[2px_2px_2px_rgb(0_0_0/0.3)];
    path {
      fill: #fdf4ff !important;
    }
  }
}
</style>
