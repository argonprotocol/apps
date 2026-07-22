<template>
  <div DashBox class="relative flex h-full grow flex-col items-center justify-center">
    <div class="relative w-full px-4 py-3">
      <div class="text-argon-600/60 relative z-20 flex flex-row">
        <div class="w-1/3 grow text-left">
          <template v-if="financials.savingsIsLoaded">
            +{{ numeral(financials.savingsAllTimeReturn).format('0,0.[00]') }}%
          </template>
          <template v-else>--</template>
          Buying Power vs
          {{ financials.savingsAllTimeFiatKey }}
        </div>
        <div class="w-1/3 grow text-center">
          <template
            v-if="
              currency.priceIndex.argonUsdPrice?.isZero() === false &&
              currency.priceIndex.argonUsdTargetPrice?.isZero() === false
            "
          >
            <template v-if="currency.targetOffset">
              Argon Is {{ targetCurrency.symbol
              }}{{ microgonToNm(targetDiff, UnitOfMeasurement.USD).format('0.00[0]') }}
              <template v-if="currency.targetOffset > 0">ABOVE</template>
              <template v-else>BELOW</template>
              {{ targetCurrency.symbol }}{{ microgonToNm(oneArgon, UnitOfMeasurement.USD).format('0.00') }} Target
            </template>
            <template v-else>
              Argon Is At Its {{ targetCurrency.symbol
              }}{{ microgonToNm(oneArgon, UnitOfMeasurement.USD).format('0.00') }} Target
            </template>
          </template>
          <template v-else-if="!currency.isLoaded">Loading Argon Price</template>
          <template v-else>Argon Price Unavailable</template>
        </div>
        <div class="w-1/3 grow text-right">
          <template v-if="financials.savingsIsLoaded">
            {{ numeral(financials.savingsRestabilizationPower).formatIfElse('< 10', '0,0.[0]', '0,0') }}:1
          </template>
          <template v-else>--</template>
          Restabilization Power
        </div>
      </div>
      <div
        class="via-argon-300/30 absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent to-transparent"
      />
    </div>

    <div
      :class="[wallets.walletRecords.length === 1 ? 'pb-10' : 'pb-0']"
      class="mx-auto flex max-w-200 grow flex-col justify-center px-[5%]"
    >
      <h1 class="text-argon-600/80 text-4xl font-bold">
        {{ config.postWelcomeLaunchCount > 0 ? 'Welcome Back to Argon Desktop!' : 'Welcome to Argon Desktop!' }}
      </h1>

      <section class="mx-auto max-w-220 py-3 text-base font-light whitespace-normal opacity-80">
        <p v-if="config.hasExtensionOperations">
          You've been upgraded to the top level of Argon's operational feature set. In addition to Argon's bridgeless
          cross-chain transfers yield-generating assets, you're now approved to help run its core mining and vaulting
          infrastructure. Use the navbar on the left to explore your options.
        </p>
        <p v-else-if="config.hasExtensionTreasury">
          You've been upgraded to Treasury, which is the second of three app levels. You still have access to the same
          wallet and cross-chain transfer capabilities as before, but now you can access the main yield-generating
          assets of Argon Network. Click a wallet below to open, or use the navbar on the left to explore your options.
          Once you're Treasury Certified, you'll be eligible to apply for the final level of Operator.
        </p>
        <p v-else>
          This app has three levels of features. You’re currently approved for level one. This means you have full
          access to Argon's cross-chain wallet functionality and bridgeless transfers. Click a wallet below to explore,
          or click Upgrade to Treasury to jump to level two.
        </p>
      </section>

      <section class="mt-10 grid grid-cols-2 gap-3 border-y border-slate-600/20 py-4">
        <article
          v-for="wallet of wallets.walletRecords"
          :key="wallet.id"
          class="group hover:bg-argon-300/5 cursor-pointer rounded-lg border border-slate-500/30 has-[.wallet-actions:hover]:bg-transparent"
          @click="openWallet(wallet)"
        >
          <div class="mx-2 flex flex-row items-center border-b border-slate-500/20 py-1 pr-1 pl-2">
            <div class="mr-1 w-4.5 border-r border-slate-500/30 pr-1 opacity-70">
              <ArgonNetworkLogo v-if="wallet.walletType === 'argon'" class="relative -top-px h-full" />
              <EthereumNetworkLogo v-else-if="wallet.walletType === 'ethereum'" class="h-full" />
            </div>
            <span class="grow font-bold opacity-40">{{ wallet.name }}</span>
            <WalletActions
              :selection="getWalletSelection(wallet)"
              :wallet="getWalletData(wallet)"
              :walletAddressTestId="`AccountOverview.${wallet.id}.address`"
              :canExportPrivateKey="wallet.role === 'defaultEthereum'"
              class="wallet-actions justify-end gap-x-0!"
              @click.stop
            />
          </div>
          <div class="flex cursor-pointer flex-col justify-center pt-5 pb-4">
            <div class="text-argon-600/70 group-hover:text-argon-600 flex flex-row justify-center text-4xl font-bold">
              <span>{{ currency.symbol }}</span>
              <FormattedMoney :isLoaded="walletBalanceIsLoaded(wallet)" :value="getWalletBalance(wallet)" />
            </div>
            <div
              v-if="walletBalanceIsLoaded(wallet) && wallet.walletType === 'argon'"
              class="mx-auto mt-2 w-fit border-t border-slate-500/30 pt-2 text-center opacity-50"
            >
              {{ currency.symbol
              }}{{ microgonToMoneyNm(getWalletBalance(wallet) - financials.savingsTotalPending).format('0,0.00') }}
              is immediately usable
            </div>
            <div
              v-else-if="walletBalanceIsLoaded(wallet) && wallet.walletType === 'ethereum'"
              class="mx-auto mt-2 flex w-fit gap-x-2 border-t border-slate-500/30 pt-2 text-center opacity-50"
            >
              {{ currency.symbol }}{{ microgonToMoneyNm(getOtherTokenValue(wallet)).format('0,0.00') }} is in eth or
              other tokens
            </div>
          </div>
        </article>
        <article
          @click="openAddEthereumWallet"
          :class="[wallets.walletRecords.length % 2 === 0 ? 'col-span-2 flex-row gap-x-1' : 'flex-col']"
          class="hover:text-argon-600 hover:bg-argon-300/5 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-slate-500/40 py-5 font-bold text-slate-800/40"
        >
          <span
            class="relative"
            :class="[wallets.walletRecords.length % 2 === 0 ? '-top-0.5 gap-x-1 text-2xl' : 'mt-3 mb-1 text-4xl']"
          >
            +
          </span>
          <span>{{ wallets.walletRecords.length <= 1 ? 'Connect' : 'Add Another' }}</span>
          <span>Ethereum Wallet</span>
        </article>
      </section>
      <div class="relative -top-2 flex flex-row items-start justify-end gap-x-3 pr-[24%]">
        <div class="relative top-[75%] text-slate-900/40">
          You must connect an Ethereum wallet
          <br />
          to use Argon’s bridgeless transfer.
        </div>
        <div class="relative">
          <div class="absolute top-[6px] right-[-3px] h-1 w-6 bg-white" />
          <img src="/arrow.png" class="relative z-10" />
        </div>
      </div>
    </div>
    <div class="relative px-0.5 pb-0.5">
      <img src="/treasury-footers/inflation-free-savings.png" class="w-full opacity-50" />
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { bigIntAbs, UnitOfMeasurement } from '@argonprotocol/apps-core';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { getCurrency } from '../stores/currency.ts';
import { getWalletTotalValue, WalletType, type IWallet } from '../lib/Wallet.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import type { IWalletSelection } from '../wallets/walletOverlayState.ts';
import { useFinancials } from '../stores/financials.ts';
import { getConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import ArgonNetworkLogo from '../assets/wallets/networks/argon.svg';
import EthereumNetworkLogo from '../assets/wallets/networks/ethereum.svg';
import WalletActions from '../wallets/components/WalletActions.vue';

const financials = useFinancials();
const currency = getCurrency();
const wallets = useWallets();
const config = getConfig();

const oneArgon = BigInt(MICROGONS_PER_ARGON);
const targetCurrency = currency.recordsByKey[UnitOfMeasurement.USD];
const { microgonToNm, microgonToMoneyNm } = createNumeralHelpers(currency);

const targetDiff = Vue.computed(() => {
  const adjusted = currency.adjustByTargetOffset(oneArgon);
  return bigIntAbs(adjusted - oneArgon);
});

function getWalletSelection(walletRecord: IWalletRecord): IWalletSelection {
  if (walletRecord.walletType === 'ethereum') {
    return { walletType: WalletType.ethereum, walletRecord };
  }

  return { walletType: WalletType.defaultArgon };
}

function getWalletData(walletRecord: IWalletRecord): IWallet {
  if (walletRecord.walletType === 'ethereum') {
    return wallets.getEthereumWalletRecord(walletRecord.id);
  }

  return wallets.defaultArgonWallet;
}

function walletBalanceIsLoaded(walletRecord: IWalletRecord): boolean {
  return walletRecord.walletType === 'argon' ? financials.savingsIsLoaded : wallets.isLoaded;
}

function getWalletBalance(walletRecord: IWalletRecord): bigint {
  if (!currency.isLoaded) return 0n;
  if (walletRecord.walletType === 'argon') return financials.savingsTotalValue;
  return getWalletTotalValue(getWalletData(walletRecord), currency);
}

function getOtherTokenValue(walletRecord: IWalletRecord): bigint {
  return getWalletData(walletRecord).otherTokens.reduce((total, token) => {
    return total + currency.convertOtherToMicrogon(token);
  }, 0n);
}

function openWallet(walletRecord: IWalletRecord) {
  if (walletRecord.walletType === 'ethereum') {
    basicEmitter.emit('openWalletOverlay', {
      walletType: WalletType.ethereum,
      ethereumWalletRecordId: walletRecord.id,
    });
    return;
  }

  basicEmitter.emit('openWalletOverlay', { walletType: WalletType.defaultArgon });
}

function openAddEthereumWallet() {
  basicEmitter.emit('openEthereumWalletImportOverlay', 'external');
}
</script>

<style scoped>
@reference "../main.css";
</style>
