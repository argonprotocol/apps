<template>
  <div class="flex h-full flex-col p-9">
    <table>
      <thead>
        <tr>
          <th class="text-left" colspan="2">Unused Mining Assets</th>
          <th class="text-right">Monetary Value</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{{ microgonToArgonNm(miningAssets.sidelinedMicrogons).format('0,0.[00]') }} ARGN</td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.sidelinedMicrogons).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ micronotToArgonotNm(miningAssets.sidelinedMicronots).format('0,0.[00]') }} ARGNOT</td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(miningAssets.sidelinedMicronots).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGNOT"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td colspan="4">&nbsp;</td>
        </tr>
      </tbody>

      <thead>
        <tr class="mt-5">
          <th class="text-left" colspan="2">Unused Vaulting Assets</th>
          <th class="text-right">Monetary Value</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{{ microgonToArgonNm(vaultingAssets.sidelinedMicrogons).format('0,0.[00]') }} ARGN</td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingAssets.sidelinedMicrogons).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.VaultingHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ micronotToArgonotNm(vaultingAssets.sidelinedMicronots).format('0,0.[00]') }} ARGNOT</td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(vaultingAssets.sidelinedMicronots).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.VaultingHold"
              :moveToken="MoveToken.ARGNOT"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td colspan="4">&nbsp;</td>
        </tr>
      </tbody>

      <thead>
        <tr class="mt-5">
          <th class="text-left" colspan="2">Mining Bid Capital</th>
          <th class="text-right">Monetary Value</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{{ microgonToArgonNm(miningAssets.auctionMicrogonsUnused).format('0,0.[00]') }} ARGN Waiting for Use</td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.auctionMicrogonsUnused).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningBot"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>
            {{ micronotToArgonotNm(miningAssets.auctionMicronotsUnused).format('0,0.[00]') }} ARGNOT Waiting for Use
          </td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(miningAssets.auctionMicronotsUnused).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningBot"
              :moveToken="MoveToken.ARGNOT"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ microgonToArgonNm(miningAssets.auctionMicrogonsActivated).format('0,0.[00]') }} ARGN Locked</td>
          <td>Locked for at least 24 hours</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.auctionMicrogonsActivated).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ micronotToArgonotNm(miningAssets.auctionMicronotsActivated).format('0,0.[00]') }} ARGNOT Locked</td>
          <td>Locked for at least 24 hours</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(miningAssets.auctionMicronotsActivated).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td colspan="4">&nbsp;</td>
        </tr>
      </tbody>

      <thead>
        <tr class="mt-5">
          <th class="text-left" colspan="2">Active Mining Seats</th>
          <th class="text-right">Monetary Value</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{{ microgonToArgonNm(miningAssets.expectedSeatMicrogons).format('0,0.[00]') }} ARGN to Mine</td>
          <td>Locked for up to 10 days</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(miningAssets.expectedSeatMicrogons).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ micronotToArgonotNm(miningAssets.expectedSeatMicronots).format('0,0.[00]') }} ARGNOT to Mine</td>
          <td>Locked for up to 10 days</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(miningAssets.expectedSeatMicronots).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ micronotToArgonotNm(miningAssets.stakedSeatMicronots).format('0,0.[00]') }} ARGNOT Staked</td>
          <td>Locked for up to 10 days</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(miningAssets.stakedSeatMicronots).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td colspan="4">&nbsp;</td>
        </tr>
      </tbody>

      <thead>
        <tr class="mt-5">
          <th class="text-left" colspan="2">Bitcoin Security for Vaulting</th>
          <th class="text-right">Monetary Value</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            {{ microgonToArgonNm(vaultingAssets.securityMicrogonsUnused).format('0,0.[00]') }} ARGN Waiting for Use
          </td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingAssets.securityMicrogonsUnused).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.VaultingSecurity"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>
            {{ micronotToArgonotNm(vaultingAssets.securityMicronotsUnused).format('0,0.[00]') }} ARGNOT Waiting for Use
          </td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(vaultingAssets.securityMicronotsUnused).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.VaultingSecurity"
              :moveToken="MoveToken.ARGNOT"
              class="pointer-events-auto"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ microgonToArgonNm(vaultingAssets.securityMicrogonsPending).format('0,0.[00]') }} ARGN Pending Lock</td>
          <td>Locked for at least 24 hours</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingAssets.securityMicrogonsPending).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>
            {{ micronotToArgonotNm(vaultingAssets.securityMicronotsPending).format('0,0.[00]') }} ARGNOT Pending Lock
          </td>
          <td>Locked for at least 24 hours</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(vaultingAssets.securityMicronotsPending).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ microgonToArgonNm(vaultingAssets.securityMicrogonsActivated).format('0,0.[00]') }} ARGN Locked</td>
          <td>Locked for up to one year</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingAssets.securityMicrogonsActivated).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td>{{ micronotToArgonotNm(vaultingAssets.securityMicronotsActivated).format('0,0.[00]') }} ARGNOT Locked</td>
          <td>Locked for up to one year</td>
          <td class="text-right">
            {{ currency.symbol }}{{ micronotToMoneyNm(vaultingAssets.securityMicronotsActivated).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td colspan="4">&nbsp;</td>
        </tr>
      </tbody>

      <thead>
        <tr class="mt-5">
          <th class="text-left" colspan="2">Treasury Bonds for Vaulting</th>
          <th class="text-right">Monetary Value</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            {{ microgonToArgonNm(vaultingAssets.treasuryMicrogonsUnused).format('0,0.[00') }} ARGN Waiting for Use
          </td>
          <td>Can move instantaneously</td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(vaultingAssets.treasuryMicrogonsUnused).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr v-for="treasuryBalance in treasuryBalances" :key="treasuryBalance.frameId">
          <td>
            {{ microgonToArgonNm(treasuryBalance.balance).format('0,0.[00]') }} ARGN Locked In Frame
            {{ treasuryBalance.frameId }}
          </td>
          <td>
            Locked for {{ 10 - (currentFrameId - treasuryBalance.frameId) }} day{{
              10 - (currentFrameId - treasuryBalance.frameId) === 1 ? '' : 's'
            }}
          </td>
          <td class="text-right">
            {{ currency.symbol }}{{ microgonToMoneyNm(treasuryBalance.balance).format('0,0.00') }}
          </td>
          <td class="text-right">
            <MoveCapitalButton
              :moveFrom="MoveFrom.MiningHold"
              :moveToken="MoveToken.ARGN"
              class="pointer-events-none opacity-30"
              side="left" />
          </td>
        </tr>
        <tr>
          <td colspan="4">&nbsp;</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import MoveCapitalButton from '../../overlays/MoveCapitalButton.vue';
import { MoveFrom, MoveToken } from '@argonprotocol/apps-core';
import { useVaultingAssetBreakdown } from '../../stores/vaultingAssetBreakdown.ts';
import { useMiningAssetBreakdown } from '../../stores/miningAssetBreakdown.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getVaults } from '../../stores/vaults.ts';
import { useWallets } from '../../stores/wallets.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';

const miningAssets = useMiningAssetBreakdown();
const vaultingAssets = useVaultingAssetBreakdown();
const currency = getCurrency();
const wallets = useWallets();
const vaults = getVaults();
const miningFrames = getMiningFrames();

const { microgonToArgonNm, micronotToArgonotNm, microgonToMoneyNm, micronotToMoneyNm } = createNumeralHelpers(currency);

const treasuryBalances = Vue.ref<{ frameId: number; balance: bigint }[]>();
const currentFrameId = Vue.ref(0);

Vue.onMounted(async () => {
  await miningFrames.load();
  const accountId = wallets.vaultingWallet.address;
  const balanceByFrameId = await vaults.getVaultPoolsByFrameForAccountId(accountId);

  currentFrameId.value = miningFrames.currentFrameId;
  treasuryBalances.value = Object.entries(balanceByFrameId)
    .map((x: [id: string, balance: bigint]) => {
      const frameId = Number(x[0]);
      const balance = x[1];
      return { frameId, balance };
    })
    .filter(x => x.frameId > currentFrameId.value - 10)
    .sort((a, b) => a.frameId - b.frameId);
});
</script>

<style scoped>
@reference "../../main.css";

table {
  th {
    @apply pb-2;
  }
  td {
    @apply border-t border-slate-300/50 py-2;
  }
}
</style>
