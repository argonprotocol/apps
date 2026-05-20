<!-- prettier-ignore -->
<template>
  <div class="Navigation LeftBar h-full min-w-80 max-w-80 flex flex-col gap-y-1.5 select-none z-10">
    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.MainchainSavings)"
      :Selected="controller.selectedTab === TreasuryTab.MainchainSavings || undefined"
    >
      <div Text>Inflation-Free Savings</div>
      <div Text>
        {{ currency.symbol }}{{ microgonToMoneyNm(financials.savingsTotalValue).format('0,0.00') }}
      </div>
      <div ArrowWrapper>
        <ArrowRightBg ArrowRightBg class="h-6/12 absolute left-[10px] top-1/2 -translate-y-1/2" />
        <Arrow InactiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
        <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
      </div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.MainchainDebts)"
      :Selected="controller.selectedTab === TreasuryTab.MainchainDebts || undefined"
    >
      <div Text>Interest-Free Liabilities</div>
      <div Text>
        <Spinner SpinnerIcon v-if="financials.liquidPrelockedRecords.length && !financials.liquidProblemRecords.length" />
        <template v-else>
          {{ financials.liquidCurrentBitcoinDebt ? '-' : '' }}{{
            currency.symbol }}{{ microgonToMoneyNm(financials.liquidCurrentBitcoinDebt).format('0,0.00')
          }}
        </template>
      </div>
      <div ArrowWrapper>
        <ArrowRightBg ArrowRightBg class="h-6/12 absolute left-[10px] top-1/2 -translate-y-1/2" />
        <Arrow InactiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
        <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
      </div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.BitcoinLocks)"
      :Selected="controller.selectedTab === TreasuryTab.BitcoinLocks || undefined"
    >
      <div Text>Bitcoin Locks</div>
      <div Text>
        <AlertIcon AlertIcon v-if="financials.liquidProblemRecords.length" class="h-6 w-6 text-argon-600" />
        <Spinner SpinnerIcon v-else-if="financials.liquidPrelockedRecords.length" />
        <template v-else>
          {{ currency.symbol }}{{ satToMoneyNm(financials.liquidTotalSatoshis).format('0,0.00') }}
        </template>
      </div>
      <div ArrowWrapper>
        <ArrowRightBg ArrowRightBg class="h-6/12 absolute left-[10px] top-1/2 -translate-y-1/2" />
        <Arrow InactiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
        <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
      </div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.ArgonBonds)"
      :Selected="controller.selectedTab === TreasuryTab.ArgonBonds || undefined"
    >
      <div Text>Argon Bonds</div>
      <div Text>{{ currency.symbol }}{{ microgonToMoneyNm(financials.bondsTotalValue).format('0,0.00') }}</div>
      <div ArrowWrapper>
        <ArrowRightBg ArrowRightBg class="h-6/12 absolute left-[10px] top-1/2 -translate-y-1/2" />
        <Arrow InactiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
        <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
      </div>
    </section>

    <section
      DashBox Item
      @click="controller.setScreenKey(TreasuryTab.EthereumSwaps)"
      :Selected="controller.selectedTab === TreasuryTab.EthereumSwaps || undefined"
    >
      <div Text>Stable Swaps</div>
      <div Text>{{ currency.symbol }}{{ microgonToMoneyNm(financials.swapsTotalValue).format('0,0.00') }}</div>
      <div ArrowWrapper>
        <ArrowRightBg ArrowRightBg class="h-6/12 absolute left-[10px] top-1/2 -translate-y-1/2" />
        <Arrow InactiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
        <Arrow ActiveArrow fill="white" stroke="#D3D9E3" :strokeWidth="1" />
      </div>
    </section>

    <section DashBox class="grow flex flex-col">
      <div class="grow pl-8 pr-10 pb-[40%] flex flex-col justify-center text-justify text-slate-800/60">
        <header class="font-bold">Did You Know?</header>
        <p class="break-words leading-7">
          This Argon Treasury app is fully decentralized and open-source. In fact, there is no company behind it. All the code runs on your
          computer, and all the data stays with you.
        </p>
      </div>
      <ul class="flex flex-row w-full items-end px-3 pb-3 gap-x-3 text-center">
        <li class="w-1/2 border-t border-slate-400/40 pt-4">
          <div @click="() => void openLink('https://argon.network/docs')" class="cursor-pointer flex flex-col items-center gap-y-1 text-center text-argon-600 hover:text-argon-600/70">
            <InstructionsIcon class="h-6 w-6" />
            <div>Docs</div>
          </div>
        </li>
        <li class="w-1/2 border-t border-slate-400/40 pt-4">
          <div @click="() => void openLink('https://discord.gg/xDwwDgCYr9')" class="cursor-pointer flex flex-col items-center gap-y-1 text-center text-argon-600 hover:text-argon-600/70">
            <DiscordIcon class="h-7 w-7 -mb-1" />
            <div>Community</div>
          </div>
        </li>
      </ul>

    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import Arrow from '../../components/Arrow.vue';
import ArrowRightBg from '../../assets/arrow-right-bg.svg';
import { getCurrency } from '../../stores/currency.ts';
import { TreasuryTab, useTreasuryController } from '../stores/controller.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import DiscordIcon from '../../assets/discord.svg';
import InstructionsIcon from '../../assets/instructions.svg';
import { open as tauriOpenUrl } from '@tauri-apps/plugin-shell';
import { useFinancials } from '../stores/financials.ts';
import Spinner from '../../components/Spinner.vue';
import AlertIcon from '../../assets/alert.svg';

const controller = useTreasuryController();
const financials = useFinancials();
const currency = getCurrency();

const { microgonToMoneyNm, satToMoneyNm } = createNumeralHelpers(currency);

const isLoaded = Vue.ref(false);

function openLink(url: string) {
  void tauriOpenUrl(url);
}

Vue.onMounted(async () => {
  await Promise.all([currency.fetchMainchainRates()]);
  isLoaded.value = true;
});
</script>

<style>
@reference "../../main.css";

.Navigation.LeftBar {
  section[Item] {
    @apply relative flex cursor-pointer flex-row items-center justify-between gap-x-2 px-4 py-4 whitespace-nowrap;
    [SpinnerIcon] {
      @apply absolute top-1/2 right-0 -translate-x-full -translate-y-1/2;
    }
    [AlertIcon] {
      @apply absolute top-1/2 right-0 -translate-y-1/2;
    }
    div[Text] {
      @apply relative opacity-50;
    }
    div:nth-child(1) {
      @apply text-argon-700;
    }
    div:nth-child(2) {
      @apply text-argon-800/70;
    }
    &:hover:not([Selected]) {
      @apply bg-[var(--color-argon-20)];
      div[Text] {
        @apply opacity-100;
      }
      [ArrowWrapper] {
        .Component.Arrow[InactiveArrow] path {
          fill: var(--color-argon-20) !important;
        }
      }
    }
    &[Selected] {
      @apply w-[calc(100%+10px)] cursor-default bg-[var(--color-argon-20)] pr-[calc(16px+10px)];
      text-shadow: 1px 1px 1px white;
      div[Text] {
        @apply opacity-100;
      }
      [ArrowWrapper] {
        @apply top-[-4px] left-[calc(100%-2px)] aspect-square h-[calc(100%+8px)] w-auto translate-y-0 pr-[6px] pb-[8px];
        &::before {
          @apply block;
        }
        .Component.Arrow[InactiveArrow] {
          @apply hidden;
        }
        .Component.Arrow[ActiveArrow] {
          @apply block;
        }
        [ArrowRightBg] {
          @apply hidden;
        }
      }
    }
  }

  [ArrowWrapper] {
    @apply absolute top-[-4px] left-[calc(100%-2px)] block aspect-square h-[calc(100%+8px)] overflow-hidden;
    &::before {
      content: '';
      @apply absolute top-[3px] left-0 hidden h-[calc(100%+2px)] w-1 bg-[var(--bg-color)];
    }
    svg[InactiveArrow] {
      @apply absolute top-[2px] left-[calc(25%-8px)] h-4.5 w-[calc(100%-4px)] origin-left -translate-y-1/2 rotate-90 drop-shadow-[1px_1px_1px_rgb(0_0_0/0.16)];
    }
    svg[ActiveArrow] {
      @apply absolute top-[2px] left-[calc(25%-9px)] hidden h-5.5 w-[calc(100%-10px)] origin-left -translate-y-1/2 rotate-90 drop-shadow-[2px_2px_2px_rgb(0_0_0/0.3)];
      path {
        fill: var(--color-argon-20) !important;
      }
    }
  }
}
</style>
