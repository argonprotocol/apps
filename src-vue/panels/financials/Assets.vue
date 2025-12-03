<template>
  <div class="Assets Panel flex h-full flex-col space-y-5 px-3 pt-1 pb-6">
    <p class="relative z-20 w-11/12 font-light text-slate-800/90">
      This page presents a breakdown of all your Argon assets, including your mining, vaulting, and the holding
      accounts. Move your mouse over the various items to learn more or click the Move buttons to transfer.
    </p>

    <div class="flex grow flex-col">
      <div class="relative flex flex-row">
        <div class="relative z-10 flex h-full w-[30%] flex-col justify-end">
          <div class="group pointer-events-none relative mt-10 grow">
            <div class="absolute top-0 left-3 flex h-3 w-[140%] flex-row items-center justify-center">
              <div class="pointer-events-auto ml-3 h-3 grow bg-slate-600/13 group-hover:bg-slate-600/30" />
              <div class="bg-argon-menu-bg pointer-events-auto absolute top-1/2 right-32 z-10 -translate-y-1/2 px-2">
                <MoveCapitalButton
                  :moveFrom="MoveFrom.Holding"
                  :moveTo="MoveTo.Mining"
                  class="opacity-50 transition-opacity duration-100 hover:opacity-100" />
              </div>
              <div
                class="pointer-events-auto mr-1 h-3 w-32 bg-gradient-to-r from-slate-600/13 to-slate-600/0 group-hover:from-slate-600/30" />
            </div>
            <div
              class="pointer-events-auto absolute top-0 bottom-0.5 left-3 z-10 w-3 bg-slate-600/13 group-hover:bg-slate-600/30">
              <LineArrow
                class="absolute top-full left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13 group-hover:text-slate-600/30" />
            </div>
          </div>
          <header class="relative pt-3 text-lg font-bold">
            <div class="absolute top-0 left-0 h-px w-[110%] bg-gray-600/20" />
            Mining Assets
          </header>
          <div class="hover:text-argon-600/90 mb-3 w-fit cursor-pointer text-left text-slate-800/60">
            {{ abbreviateAddress(wallets.miningWallet.address, 10) }}
            <CopyIcon class="ml-1 inline-block h-4 w-4 text-slate-600/60" />
          </div>
        </div>
        <div class="relative h-full w-[40%]">
          <div
            class="absolute top-[65%] left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center">
            <CopyIcon class="h-4.5 w-4.5 cursor-pointer text-slate-600/60 hover:text-slate-600/90" />
            <header class="mt-2 text-center text-lg font-bold">Holding Account</header>
            <div class="hover:text-argon-600/90 mb-5 cursor-pointer text-center text-slate-800/60">
              {{ abbreviateAddress(wallets.holdingWallet.address, 10) }}
            </div>
          </div>
          <BanklessTop1 class="w-full" />
        </div>
        <div class="relative z-10 flex h-full w-[30%] flex-col justify-end">
          <div class="group pointer-events-none relative grow pt-10">
            <div class="absolute top-10 right-3 flex h-3 w-[140%] flex-row items-center justify-center">
              <div
                class="pointer-events-auto ml-1 h-3 w-32 bg-gradient-to-r from-slate-600/0 to-slate-600/13 group-hover:to-slate-600/30" />
              <div class="bg-argon-menu-bg pointer-events-auto absolute top-1/2 left-32 z-10 -translate-y-1/2 px-2">
                <MoveCapitalButton
                  :moveFrom="MoveFrom.Holding"
                  :moveTo="MoveTo.Vaulting"
                  class="opacity-50 transition-opacity duration-100 hover:opacity-100" />
              </div>
              <div class="pointer-events-auto mr-3 h-3 grow bg-slate-600/13 group-hover:bg-slate-600/30" />
            </div>
            <div
              class="pointer-events-auto absolute top-10 right-3 bottom-0.5 z-10 w-3 bg-slate-600/13 group-hover:bg-slate-600/30">
              <LineArrow
                class="absolute top-full left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-90 text-slate-600/13 group-hover:text-slate-600/30" />
            </div>
          </div>
          <header class="relative pt-3 text-right text-lg font-bold">
            <div class="absolute top-0 right-0 h-px w-[110%] bg-gray-600/20" />
            Vaulting Assets
          </header>
          <div class="hover:text-argon-600/90 mb-3 ml-auto w-fit cursor-pointer text-right text-slate-800/60">
            <CopyIcon class="mr-1 inline-block h-4 w-4 text-slate-600/60" />
            {{ abbreviateAddress(wallets.vaultingWallet.address, 10) }}
          </div>
        </div>
      </div>

      <div class="flex grow flex-row">
        <div class="relative z-30 mt-[-2px] flex h-full w-[30%] flex-row border-t border-gray-600/20">
          <MiningAssetBreakdown
            class="relative h-[calc(100%+4px)] min-w-[105%] grow"
            show="AllExceptTotal"
            spacerWidth="0"
            :showMoveButtons="true"
            tooltipSide="top" />
        </div>
        <div class="flex h-full w-[40%] flex-col">
          <BanklessTop2 class="w-full" />
          <div class="relative -my-px w-full grow">
            <BanklessMiddle class="-my-1 h-full w-full" />
            <div class="absolute top-0 left-0 flex h-full w-full flex-col justify-around text-slate-600/70">
              <div class="flex flex-col items-center justify-center pt-10 text-2xl font-bold">
                <div>{{ microgonToArgonNm(wallets.holdingWallet.availableMicrogons).format('0,0.[0000000]') }}</div>
                ARGN
                <div class="text-base font-light">
                  ( {{ currency.symbol
                  }}{{ microgonToMoneyNm(wallets.holdingWallet.availableMicrogons).format('0,0.00') }} )
                </div>
              </div>
              <div class="flex flex-col items-center justify-center pb-10 text-2xl font-bold">
                <div>{{ microgonToArgonNm(wallets.holdingWallet.availableMicronots).format('0,0.[0000000]') }}</div>
                ARGNOT
                <div class="text-base font-light">
                  ( {{ currency.symbol
                  }}{{ micronotToMoneyNm(wallets.holdingWallet.availableMicronots).format('0,0.00') }} )
                </div>
              </div>
            </div>
          </div>
          <BanklessBottom1 class="-mt-1.5 -mb-px w-full" />
        </div>
        <div class="relative mt-[-2px] flex h-full w-[30%] flex-row border-t border-gray-600/20">
          <VaultingAssetBreakdown
            align="right"
            class="right-[5%] h-[calc(100%+4px)] min-w-[105%] grow"
            tooltipSide="top"
            show="AllExceptTotal"
            :showMoveButtons="true" />
        </div>
      </div>

      <div class="flex flex-row">
        <div class="relative mt-px h-full w-[30%]">
          <MiningAssetBreakdown class="h-[calc(100%-3px)]" show="OnlyTotal" spacerWidth="20px" tooltipSide="top" />
          <div class="absolute right-[15px] bottom-[2px] left-0 h-px bg-gray-800/30" />
        </div>
        <div class="h-full w-[40%]">
          <BanklessBottom2 class="w-full" />
        </div>
        <div class="relative mt-px h-full w-[30%]">
          <VaultingAssetBreakdown
            align="right"
            class="h-[calc(100%-3px)]"
            show="OnlyTotal"
            spacerWidth="20px"
            tooltipSide="top" />
          <div class="absolute right-0 bottom-[2px] left-[15px] h-px bg-gray-800/30" />
        </div>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import * as Vue from 'vue';
import VaultingAssetBreakdown from '../../components/VaultingAssetBreakdown.vue';
import MiningAssetBreakdown from '../../components/MiningAssetBreakdown.vue';
import BanklessTop1 from '../../assets/bankless-top1.svg';
import BanklessTop2 from '../../assets/bankless-top2.svg';
import BanklessMiddle from '../../assets/bankless-middle.svg';
import BanklessBottom1 from '../../assets/bankless-bottom1.svg';
import BanklessBottom2 from '../../assets/bankless-bottom2.svg';
import { useWallets } from '../../stores/wallets.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import { useCurrency } from '../../stores/currency.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import CopyIcon from '../../assets/copy.svg';
import LineArrow from '../../components/asset-breakdown/LineArrow.vue';
import MoveCapitalButton, { MoveFrom, MoveTo } from '../../overlays/MoveCapitalButton.vue';

const wallets = useWallets();
const currency = useCurrency();

const { microgonToMoneyNm, microgonToArgonNm, micronotToMoneyNm } = createNumeralHelpers(currency);
</script>

<style>
@reference "../../main.css";

.Assets.Panel {
  .hasStroke {
    @apply stroke-slate-300 stroke-1;
  }
}
</style>
