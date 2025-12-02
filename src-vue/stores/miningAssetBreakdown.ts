import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { useWallets } from './wallets.ts';
import { useCurrency } from './currency.ts';
import { useConfig } from './config.ts';
import { useStats } from './stats.ts';
import numeral, { createNumeralHelpers } from '../lib/numeral';

export const useMiningAssetBreakdown = defineStore('miningAssetBreakdown', () => {
  const config = useConfig();
  const wallets = useWallets();
  const currency = useCurrency();
  const stats = useStats();

  const { microgonToMoneyNm } = createNumeralHelpers(currency);

  const unusedMicronots = Vue.computed(() => {
    const unused = wallets.miningWallet.availableMicronots - config.biddingRules.sidelinedMicronots;
    return unused > 0n ? unused : 0n;
  });

  const unusedMicrogons = Vue.computed(() => {
    const unused = wallets.miningWallet.availableMicrogons - config.biddingRules.sidelinedMicrogons;
    return unused > 0n ? unused : 0n;
  });

  const biddingReserves = Vue.computed(() => {
    return unusedMicrogons.value + currency.micronotToMicrogon(unusedMicronots.value);
  });

  const bidTotalCount = Vue.computed(() => {
    return stats.myMiningBids.bidCount;
  });

  const bidTotalCost = Vue.computed(() => {
    return wallets.miningBidValue;
  });

  const bidMicrogons = Vue.computed(() => {
    return wallets.miningBidMicrogons;
  });

  const bidMicronots = Vue.computed(() => {
    return wallets.miningBidMicronots;
  });

  const seatActiveCount = Vue.computed(() => {
    return stats.myMiningSeats.seatCount;
  });

  const expectedSeatValue = Vue.computed(() => {
    return wallets.miningSeatValue;
  });

  const expectedSeatMicrogons = Vue.computed(() => {
    return wallets.miningSeatMicrogons;
  });

  const expectedSeatMicronots = Vue.computed(() => {
    return wallets.miningSeatMicronots;
  });

  const totalMiningResources = Vue.computed(() => {
    return wallets.totalMiningResources;
  });

  const transactionFeesTotal = Vue.computed(() => {
    return stats.global.transactionFeesTotal;
  });

  const help = {
    biddingReserves: `<p class="break-words whitespace-normal">These argons are currently sitting unused.</p>`,
    unusedMicrogons: `<p class="break-words whitespace-normal">
        These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
      </p>`,
    unusedMicronots: `<p class="break-words whitespace-normal">
        These argonots are available for mining, but your bot hasn't found a competitively priced bid.
      </p>`,
    bidTotal: `
      <p class="break-words whitespace-normal">
        You have a total of ${numeral(stats.myMiningBids.bidCount).format('0,0')} winning bids in today's mining
        auction. They include both argons and argonots at a total value of 
        ${currency.symbol}${microgonToMoneyNm(wallets.miningBidValue).format('0,0.00')}:
      </p>
      <table class="my-3 w-full text-slate-800/50">
        <thead>
          <tr>
            <th class="h-10 w-1/4">Token</th>
            <th class="w-1/4 text-right">Per Seat</th>
            <th class="w-1/4 text-right">Total</th>
            <th class="h-10 w-1/4 text-right">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="h-10 border-t border-gray-600/20 pr-5">Argons</td>
            <td class="border-t border-gray-600/20 text-right">
              ${microgonToMoneyNm(
                stats.myMiningBids.bidCount > 0 ? bidMicrogons.value / BigInt(stats.myMiningBids.bidCount) : 0n,
              ).format('0,0.00')}
            </td>
            <td class="border-t border-gray-600/20 text-right">
              ${microgonToMoneyNm(bidMicrogons.value).format('0,0.00')}
            </td>
            <td class="border-t border-gray-600/20 text-right">
              ${currency.symbol}${microgonToMoneyNm(bidMicrogons.value).format('0,0.00')}
            </td>
          </tr>
          <tr>
            <td class="h-10 border-y border-gray-600/20 pr-5">Argonots</td>
            <td class="border-y border-gray-600/20 text-right">
              ${microgonToMoneyNm(
                stats.myMiningBids.bidCount > 0 ? wallets.miningBidMicronots / BigInt(stats.myMiningBids.bidCount) : 0n,
              ).format('0,0.00')}
            </td>
            <td class="border-y border-gray-600/20 text-right">
              ${microgonToMoneyNm(wallets.miningBidMicronots).format('0,0.00')}
            </td>
            <td class="border-y border-gray-600/20 text-right">
              ${
                currency.symbol
              }${microgonToMoneyNm(currency.micronotToMicrogon(wallets.miningBidMicronots)).format('0,0.00')}
            </td>
          </tr>
        </tbody>
      </table>

      <p class="break-words whitespace-normal">
        If any bids lose, all associated tokens will automatically revert back to your mining wallet.
      </p>
    `,
    bidMicrogons: `
      <p class="break-words whitespace-normal">
        These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
      </p>
    `,
    totalMiningResources: `
      <p class="font-normal break-words whitespace-normal">The total value of your vault's assets.</p>
    `,
    transactionFeesTotal: `
      <p class="break-words whitespace-normal">
        The summation of all operational expenses that have been paid since you started mining.
      </p>
    `,
    miningLosses: `
      <p class="break-words whitespace-normal">
        These are your cumulated losses from mining seats where your revenue was less than your bid.
      </p>
    `,
    bidMicronots: `
      <p class="break-words whitespace-normal">
        These argonots are available for mining, but your bot hasn't found a competitively priced bid.
      </p>
    `,
    seatTotal: `
      <p class="break-words whitespace-normal">
        You have a total of ${numeral(stats.myMiningSeats.seatCount).format('0,0')} active mining seats. You won
        them using a combination of argons and argonots. They have an currently estimated value of
        ${currency.symbol}${microgonToMoneyNm(wallets.miningSeatValue).format('0,0.00')}.
      </p>
      <p class="mt-3 break-words whitespace-normal">
        These mining seats have
        ${microgonToMoneyNm(stats.myMiningSeats.micronotsStakedTotal).format('0,0.00')} argonots which will be
        released back into your wallet once the associated mining cycle completes.
      </p>
    `,
    expectedSeatMicrogons: `
      <p class="break-words whitespace-normal">
        These argons have been activated for mining, but your bot hasn't found a competitively priced bid.
      </p>
    `,
    expectedSeatMicronots: `
      <p class="break-words whitespace-normal">
        These argonots are available for mining, but your bot hasn't found a competitively priced bid.
      </p>
    `,
  };

  return {
    help,
    biddingReserves,
    unusedMicrogons,
    unusedMicronots,
    bidTotalCount,
    bidTotalCost,
    bidMicrogons,
    bidMicronots,
    seatActiveCount,
    expectedSeatValue,
    expectedSeatMicrogons,
    expectedSeatMicronots,
    transactionFeesTotal,
    totalMiningResources,
  };
});
