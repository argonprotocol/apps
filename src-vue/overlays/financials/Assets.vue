<template>
  <div class="Assets Panel flex h-full flex-col space-y-5 px-3 pt-1 pb-6">
    <p class="relative z-20 w-11/12 font-light text-slate-800/90">
      This page presents a breakdown of all your Argon assets, including your mining, vaulting, and the holding
      accounts. Move your mouse over the various items to learn more or click the Move buttons to transfer.
    </p>

    <div class="flex grow flex-col">
      <div class="relative flex flex-row">
        <div class="relative flex h-full w-[30%] flex-col justify-end">
          <div class="relative mt-10 grow">
            <div class="absolute top-0 left-3 flex h-3 w-[140%] flex-row items-center justify-center">
              <div class="ml-3 h-3 grow bg-slate-600/13" />
              <div class="relative z-10 bg-white px-2">
                <button class="border-argon-600/50 text-argon-600/80 rounded border px-3 font-bold">Move</button>
              </div>
              <div class="mr-1 h-3 w-32 bg-gradient-to-r from-slate-600/13 to-slate-600/0" />
            </div>
            <div class="absolute top-0 bottom-3 left-3 w-3 bg-slate-600/13">
              <Arrow class="absolute top-full left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-90" />
            </div>
          </div>
          <header class="text-lg font-bold">Mining Assets</header>
          <div class="hover:text-argon-600/90 mb-3 cursor-pointer text-left">
            {{ abbreviateAddress(wallets.miningWallet.address, 10) }}
            <CopyIcon class="ml-1 inline-block h-5 w-5 text-slate-600/80" />
          </div>
        </div>
        <div class="relative h-full w-[40%]">
          <div
            class="absolute top-[65%] left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center">
            <CopyIcon class="h-5 w-5 cursor-pointer text-slate-600/80 hover:text-slate-600/90" />
            <header class="mt-2 text-center text-lg font-bold">Holding Account</header>
            <div class="mb-5 text-center">{{ abbreviateAddress(wallets.holdingWallet.address, 10) }}</div>
          </div>
          <BanklessTop1 class="w-full" />
        </div>
        <div class="relative flex h-full w-[30%] flex-col justify-end">
          <div class="relative mt-10 grow">
            <div class="absolute top-0 right-3 flex h-3 w-[140%] flex-row items-center justify-center">
              <div class="mr-1 h-3 w-32 bg-gradient-to-r from-slate-600/0 to-slate-600/13" />
              <div class="relative z-10 bg-white px-2">
                <button class="border-argon-600/50 text-argon-600/80 rounded border px-3 font-bold">Move</button>
              </div>
              <div class="mr-3 h-3 grow bg-slate-600/13" />
            </div>
            <div class="absolute top-0 right-3 bottom-3 w-3 bg-slate-600/13">
              <Arrow class="absolute top-full left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-90" />
            </div>
          </div>
          <header class="text-right text-lg font-bold">Vaulting Assets</header>
          <div class="hover:text-argon-600/90 mb-3 cursor-pointer text-right">
            <CopyIcon class="mr-1 inline-block h-5 w-5 text-slate-600/80" />
            {{ abbreviateAddress(wallets.vaultingWallet.address, 10) }}
          </div>
        </div>
      </div>

      <div class="flex grow flex-row">
        <div class="flex h-full w-[30%] flex-row">
          <MiningAssetBreakdown
            class="h-full grow border-t border-slate-600/30"
            show="AllExceptTotal"
            :showArrows="true" />
          <div class="flex min-w-20 flex-col">
            <div class="h-[9.091%]"></div>
            <div class="relative z-10 flex h-[9.091%] w-full flex-row items-center">
              <div class="relative -left-5 z-10 bg-white px-2">
                <button class="border-argon-600/50 text-argon-600/80 rounded border px-3 font-bold">Move</button>
              </div>
              <div class="absolute top-1/2 -right-14 h-3 w-full -translate-y-1/2 bg-slate-600/13" />
              <Arrow class="absolute top-1/2 -right-13 translate-x-full -translate-y-1/2" />
            </div>
            <div class="relative z-10 flex h-[9.091%] w-full flex-row items-center">
              <div class="relative -left-5 z-10 bg-white px-2">
                <button class="border-argon-600/50 text-argon-600/80 rounded border px-3 font-bold">Move</button>
              </div>
              <div class="absolute top-1/2 -right-14 h-3 w-full -translate-y-1/2 bg-slate-600/13" />
              <Arrow class="absolute top-1/2 -right-13 translate-x-full -translate-y-1/2" />
            </div>
          </div>
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
        <div class="flex h-full w-[30%] flex-row">
          <div class="min-w-20">
            <div class="h-[9.091%]"></div>
            <div class="h-[9.091%]"></div>
            <div class="relative z-10 flex h-[9.091%] w-full flex-row items-center">
              <div class="relative -right-5 z-10 bg-white px-2">
                <button class="border-argon-600/50 text-argon-600/80 rounded border px-3 font-bold">Move</button>
              </div>
              <div class="absolute top-1/2 -left-14 h-3 w-full -translate-y-1/2 bg-slate-600/13" />
              <Arrow class="absolute top-1/2 -left-13 -translate-x-full -translate-y-1/2 rotate-180" />
            </div>
            <div class="h-[9.091%]"></div>
            <div class="relative z-10 flex h-[9.091%] w-full flex-row items-center">
              <div class="relative -right-5 z-10 bg-white px-2">
                <button class="border-argon-600/50 text-argon-600/80 rounded border px-3 font-bold">Move</button>
              </div>
              <div class="absolute top-1/2 -left-14 h-3 w-full -translate-y-1/2 bg-slate-600/13" />
              <Arrow class="absolute top-1/2 -left-13 -translate-x-full -translate-y-1/2 rotate-180" />
            </div>
            <div class="h-[9.091%]"></div>
            <div class="h-[9.091%]"></div>
            <div class="h-[9.091%]"></div>
            <div class="relative z-10 flex h-[9.091%] w-full flex-row items-center">
              <div class="relative -right-5 z-10 bg-white px-2">
                <button class="border-argon-600/50 text-argon-600/80 rounded border px-3 font-bold">Move</button>
              </div>
              <div class="absolute top-1/2 -left-14 h-3 w-full -translate-y-1/2 bg-slate-600/13" />
              <Arrow class="absolute top-1/2 -left-13 -translate-x-full -translate-y-1/2 rotate-180" />
            </div>
          </div>
          <VaultingAssetBreakdown
            align="right"
            class="h-full border-t border-slate-600/30"
            show="AllExceptTotal"
            :showArrows="true" />
        </div>
      </div>

      <div class="flex flex-row">
        <div class="text-md h-full w-[30%] pr-20">
          <MiningAssetBreakdown class="h-full" show="OnlyTotal" />
        </div>
        <div class="h-full w-[40%]">
          <BanklessBottom2 class="w-full" />
        </div>
        <div class="h-full w-[30%] pl-20">
          <VaultingAssetBreakdown align="right" class="h-full" show="OnlyTotal" />
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
import Arrow from './components/Arrow.vue';

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
