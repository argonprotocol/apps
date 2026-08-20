<template>
  <div DashBox class="relative flex grow flex-col items-center justify-start">
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
              Argon Is @ {{ targetCurrency.symbol
              }}{{ microgonToNm(oneArgon, UnitOfMeasurement.USD).format('0.00') }} Target
            </template>
          </template>
          <template v-else-if="!currency.isLoaded">Loading Argon Price</template>
          <template v-else>Argon Price Unavailable</template>
        </div>
        <div class="w-1/3 grow text-right">
          <template v-if="financials.savingsIsLoaded">
            {{ numeral(financials.savingsRestabilizationPower).formatIfElse('< 100', '0,0.[0]', '0,0') }}
            <span class="relative text-xs">TO</span>
            1
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
      class="mx-auto flex max-w-180 grow flex-col justify-start px-[5%] xl:max-w-220"
    >
      <h1 class="mt-10 text-4xl font-bold whitespace-nowrap opacity-80 xl:text-5xl">
        {{ config.postWelcomeLaunchCount > 0 ? 'Welcome Back to Argon Desktop!' : 'Your Gateway to Argon' }}
      </h1>

      <section class="mx-auto max-w-220 py-3 text-base font-light whitespace-normal opacity-80">
        <p v-if="config.hasExtensionOperations">
          You've been upgraded to the top level of Argon's operational feature set. In addition to Argon's bridgeless
          cross-chain transfers and yield-generating assets, you're now approved to help run its core mining and
          vaulting infrastructure. Use the navbar on the left to explore your options.
        </p>
        <p v-else-if="config.hasExtensionTreasury">
          You've been upgraded to Treasury, which is the second of three app levels! You can still use the same wallet
          and cross-chain transfer capabilities, but now you're also given access to the yield-generating assets of the
          network. The final step is becoming Treasury Certified, which makes you eligible for the final level of
          upgrading to a full-fledged network Operator.
        </p>
        <p v-else>
          This app has three levels of features. You’re currently approved for level one. This means you have full use
          of Argon's cross-chain wallet functionality and bridgeless transfers. Click the Upgrade to Treasury button
          above to access level two, or click a connector to open the transfer portal.
        </p>
      </section>

      <section class="mt-10 grid grid-cols-2 gap-x-6 text-center">
        <article class="border-t border-slate-500/30 py-2">
          <div @click="openWallet" class="hover:bg-argon-100/20 cursor-pointer rounded py-4">
            <div class="text-argon-600/70 flex flex-row justify-center text-3xl font-bold xl:text-4xl">
              <span>{{ currency.symbol }}</span>
              <FormattedMoney
                :isLoaded="walletBalanceIsLoaded(internalWallet)"
                :value="getWalletBalance(internalWallet)"
              />
            </div>
            <div class="mt-1 font-light opacity-70">Immediately Usable In Wallet</div>
          </div>
        </article>

        <article
          class="relative border-t border-slate-500/30 py-2 before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-px before:bg-slate-500/30"
        >
          <div @click="openWallet" class="hover:bg-argon-100/20 cursor-pointer rounded py-4">
            <div class="text-argon-600/70 flex flex-row justify-center text-3xl font-bold xl:text-4xl">
              <span>{{ currency.symbol }}</span>
              <FormattedMoney
                :isLoaded="walletBalanceIsLoaded(internalWallet)"
                :value="getOtherTokenValue(internalWallet)"
              />
            </div>
            <div class="mt-1 font-light opacity-70">Actively Minting In Wallet</div>
          </div>
        </article>
        <article class="border-t border-slate-500/30 py-2">
          <div class="hover:bg-argon-100/20 cursor-pointer rounded py-4">
            <div class="text-argon-600/70 flex items-baseline justify-center text-3xl font-bold xl:text-4xl">
              <span>₳0</span>
              <span class="text-argon-300">.00</span>
            </div>
            <div class="mt-1 font-light opacity-70">Invested In Treasury</div>
          </div>
        </article>
        <article
          class="relative border-t border-slate-500/30 py-2 before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-px before:bg-slate-500/30"
        >
          <div class="hover:bg-argon-100/20 cursor-pointer rounded py-4">
            <div class="text-argon-600/70 flex items-baseline justify-center text-3xl font-bold xl:text-4xl">
              <span>₳0</span>
              <span class="text-argon-300">.00</span>
            </div>
            <div class="mt-1 font-light opacity-70">Invested In Operations</div>
          </div>
        </article>
      </section>

      <section class="mt-1 border-y border-slate-600/20 pt-5 pb-12">
        <p class="font-light text-slate-900/70">You can connect up to 6 external transfer portals...</p>
        <div class="text-argon-600/70 mt-5 flex flex-row justify-between">
          <article
            @click="openBitcoinConnector()"
            class="hover:bg-argon-300/5 relative flex size-22 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-slate-500/30 text-center"
          >
            <BitcoinNetworkLogo class="size-10" />
            <p class="text-argon-600 absolute -bottom-8 mt-1 w-22 font-bold opacity-50">Bitcoin</p>
          </article>
          <article
            v-for="wallet of externalConnectors"
            :key="wallet.id"
            class="hover:bg-argon-300/5 relative flex size-22 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-slate-500/30 text-center"
            @click="openEthereumConnector(wallet)"
          >
            <EthereumNetworkLogo class="size-12" />
            <p class="text-argon-600 absolute -bottom-8 mt-1 w-22 max-w-full truncate font-bold opacity-50">
              {{ wallet.walletType === 'ethereum' ? getEthereumWalletDisplayName(wallet.name) : wallet.name }}
            </p>
          </article>
          <article
            v-for="slot in Math.max(0, 5 - externalConnectors.length)"
            :key="`add-external-connector-${slot}`"
            @click="openAddConnector"
            class="hover:text-argon-600 hover:bg-argon-300/5 flex size-22 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-slate-500/20 text-center"
          >
            <span class="relative -top-1 text-6xl font-light opacity-30">+</span>
          </article>
        </div>
      </section>

      <div
        v-if="!externalConnectors.length"
        class="relative -top-8 left-[21%] flex flex-row items-end justify-start gap-x-3"
      >
        <div class="relative">
          <div class="absolute top-[30px] left-[2px] h-1 w-6 bg-white" />
          <img src="/arrow.png" class="relative z-10 -scale-x-100" />
        </div>
        <div class="relative top-[75%] text-right text-slate-900/40">
          You must connect an Ethereum wallet
          <br />
          to use Argon’s bridgeless transfer.
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
import { getEthereumWalletDisplayName, getWalletTotalValue, WalletType, type IWallet } from '../lib/Wallet.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral.ts';
import basicEmitter from '../emitters/basicEmitter.ts';
import FormattedMoney from '../components/FormattedMoney.vue';
import type { IWalletSelection } from '../wallets/walletOverlayState.ts';
import { useFinancials } from '../stores/financials.ts';
import { getConfig } from '../stores/config.ts';
import { useWallets } from '../stores/wallets.ts';
import EthereumNetworkLogo from '../assets/wallets/networks/ethereum.svg';
import BitcoinNetworkLogo from '../assets/networks/bitcoin.svg';

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

const internalWallet = Vue.computed<IWalletRecord>(() => {
  return wallets.walletRecords.filter(x => x.walletType === 'argon')[0];
});

const externalConnectors = Vue.computed<IWalletRecord[]>(() => {
  return wallets.walletRecords.filter(x => x.walletType !== 'argon');
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

function openWallet() {
  basicEmitter.emit('openWalletOverlay', { connectorType: WalletType.defaultArgon });
}

function openEthereumConnector(walletRecord: IWalletRecord) {
  basicEmitter.emit('openWalletOverlay', {
    connectorType: WalletType.ethereum,
    ethereumWalletRecordId: walletRecord.id,
  });
}

function openBitcoinConnector() {
  basicEmitter.emit('openWalletOverlay', { connectorType: 'bitcoin' });
}

function openAddConnector() {
  basicEmitter.emit('openWalletOverlayAddConnector', 'external');
}
</script>

<style scoped>
@reference "../main.css";
</style>
