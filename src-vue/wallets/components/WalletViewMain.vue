<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Internal App Wallet"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @close="emit('close')"
    />

    <div class="mx-1 px-4 py-6 text-center">
      <div class="text-argon-700/70 flex flex-row justify-center text-6xl font-bold">
        <span>{{ currency.symbol }}</span>
        <FormattedMoney :isLoaded="walletValueIsLoaded" :value="walletTotalValue" />
      </div>
    </div>

    <div class="relative pt-1">
      <div class="mb-2 flex flex-row gap-x-2 px-4">
        <button class="border-argon-600 cursor-pointer border-b-3 font-bold">Tokens</button>
        <button class="text-argon-900/50 cursor-pointer">Transactions</button>
        <div class="grow" />
        <button
          data-testid="WalletViewMain.openSend()"
          @click="emit('goto', 'send')"
          class="text-md border-argon-600/50 text-argon-600/70 hover:bg-argon-100/20 cursor-pointer rounded-lg border px-2"
        >
          Send
        </button>
        <button
          @click="emit('goto', 'receive')"
          class="text-md border-argon-600/50 text-argon-600/70 hover:bg-argon-100/20 cursor-pointer rounded-lg border px-2"
        >
          Receive
        </button>
      </div>
      <div class="relative px-4">
        <ArgonTokens
          :microgonsToMint="financials.bitcoinLiquidPendingMintMicrogons"
          :microgons="defaultArgonWallet.availableMicrogons"
          :micronots="defaultArgonWallet.availableMicronots"
          :satoshis="financials.bitcoinWalletTotalSatoshis"
          :showBitcoin="true"
        >
          <template #bitcoinAction>
            <button
              v-if="walletBitcoinLockGroups.length"
              type="button"
              data-testid="WalletViewMain.toggleBitcoinDetails()"
              class="ml-1 flex cursor-pointer items-center text-slate-500 hover:text-slate-700"
              :aria-expanded="bitcoinDetailsAreExpanded"
              :aria-label="bitcoinDetailsAreExpanded ? 'Hide Bitcoin details' : 'Show Bitcoin details'"
              @click="bitcoinDetailsAreExpanded = !bitcoinDetailsAreExpanded"
            >
              (
              <MinusIcon v-if="bitcoinDetailsAreExpanded" class="size-3" />
              <PlusIcon v-else class="size-3" />
              )
            </button>
          </template>
          <template #bitcoinDetails>
            <li
              v-if="bitcoinDetailsAreExpanded"
              class="mb-2 ml-4 overflow-hidden rounded-bl-lg border-b border-l border-slate-300/70 pt-2 pr-2 pb-3 pl-3"
            >
              <section v-for="group in walletBitcoinLockGroups" :key="group.vaultId" class="py-1 first:pt-0 last:pb-0">
                <div class="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  <template v-if="group.isMyVault">In my Vault</template>
                  <template v-else>Cosigner: {{ group.cosigner }}</template>
                </div>
                <ConnectorChannel
                  v-for="entry in group.entries"
                  :key="entry.lock.uuid"
                  :open="openInsuranceChannelUuid === entry.lock.uuid"
                  :wallet="wallets.bitcoinWallet"
                  :channelUuid="entry.lock.uuid"
                  direction="right"
                  mode="insurance"
                  @update:open="openInsuranceChannelUuid = $event ? entry.lock.uuid : undefined"
                >
                  <button
                    type="button"
                    data-testid="WalletViewMain.bitcoinChannel"
                    :data-channel-uuid="entry.lock.uuid"
                    :aria-label="group.isMyVault ? 'Channel in my Vault' : `${group.cosigner} Channel`"
                    class="flex w-full cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-left text-sm text-slate-600"
                    :class="
                      openInsuranceChannelUuid === entry.lock.uuid
                        ? 'bg-argon-100/40 ring-argon-300/30 ring-1 ring-inset'
                        : 'hover:bg-argon-100/30'
                    "
                  >
                    <span class="font-mono text-slate-700">
                      {{ satToBtcNm(entry.unusedSatoshis).format('0,0.[00000000]') }} BTC
                    </span>
                    <span v-if="entry.address" class="font-mono text-xs text-slate-400">
                      {{ abbreviateAddress(entry.address, 6) }}
                    </span>
                    <span class="ml-auto text-xs text-slate-500">
                      {{ currency.symbol
                      }}{{ microgonToArgonNm(entry.lock.securitizationCoverageMicrogons ?? 0n).format('0,0.[00]') }}
                      insurance
                    </span>
                    <ChevronRightIcon class="size-3.5 shrink-0 text-slate-400" />
                  </button>
                </ConnectorChannel>
              </section>
            </li>
          </template>
        </ArgonTokens>
      </div>
    </div>

    <div class="flex grow flex-col px-4">
      <ArgonBottom
        mode="chooser"
        :showGuidance="props.showGuidance"
        :guidanceContext="props.guidanceContext"
        :walletType="WalletType.argon"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { bigIntMax } from '@argonprotocol/apps-core';
import { ChevronRightIcon, MinusIcon, PlusIcon } from '@heroicons/vue/20/solid';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import { WalletType } from '../../lib/Wallet.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import { getBitcoinLocks } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useFinancials } from '../../stores/financials.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import { useWallets } from '../../stores/wallets.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import ArgonBottom from './ArgonBottom.vue';
import ArgonTokens from './ArgonTokens.vue';
import ConnectorChannel from './ConnectorChannel.vue';
import WalletHeader from './WalletHeader.vue';
import type { IWalletView } from '../walletOverlayState.ts';

const props = defineProps<{
  isDragging: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'close'): void;
}>();

const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const config = getConfig();
const currency = getCurrency();
const myVault = getMyVault();
const vaults = getVaults();
const wallets = useWallets();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const bitcoinDetailsAreExpanded = ref(false);
const openInsuranceChannelUuid = ref<string>();
const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
const walletValueIsLoaded = computed(() => financials.savingsIsLoaded);
const walletTotalValue = computed(() => financials.savingsTotalValue);
const walletBitcoinLockGroups = computed(() => {
  const locksByVaultId = new Map<number, { lock: IBitcoinLockRecord; unusedSatoshis: bigint }[]>();

  for (const lock of bitcoinLocks.getAllLocks()) {
    if (!bitcoinLocks.isLockFunded(lock)) continue;

    const unusedSatoshis = bigIntMax(lock.fundedSatoshis - (lock.fissionedSatoshis ?? 0n), 0n);
    if (!unusedSatoshis) continue;

    const locks = locksByVaultId.get(lock.vaultId) ?? [];
    locks.push({ lock, unusedSatoshis });
    locksByVaultId.set(lock.vaultId, locks);
  }

  return [...locksByVaultId].map(([vaultId, locks]) => ({
    vaultId,
    isMyVault: vaultId === myVault.vaultId,
    cosigner:
      vaults.operatorNamesByVaultId[vaultId] ??
      (config.upstreamOperator?.vaultId === vaultId ? config.upstreamOperator.name : undefined) ??
      `Vault ${vaultId}`,
    entries: locks.map(entry => ({
      ...entry,
      address: locks.length > 1 ? wallets.bitcoinWallet.getChannelFundingAddress(entry.lock) : undefined,
    })),
  }));
});
</script>
