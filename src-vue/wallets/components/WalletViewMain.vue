<template>
  <div class="flex h-full grow flex-col text-black/90">
    <WalletHeader
      name="Internal App Wallet"
      :isDragging="props.isDragging"
      @dragStart="emit('dragStart', $event)"
      @close="emit('close')"
    >
      <template #name>
        <span class="flex items-center">
          Internal App Wallet
          <Tooltip v-if="bitcoinDepositAttention" :content="bitcoinDepositAttention" side="top" :asChild="true">
            <button
              type="button"
              aria-label="Review unattached Bitcoin deposits"
              class="ml-1.5 inline-flex cursor-pointer"
              @mousedown.stop
              @click.stop="reviewBitcoinDeposit"
            >
              <AlertIcon class="size-5" />
            </button>
          </Tooltip>
        </span>
      </template>
    </WalletHeader>

    <div class="mx-1 px-4 py-6 text-center">
      <div class="text-argon-700/70 flex flex-row justify-center text-6xl font-bold">
        <span>{{ currency.symbol }}</span>
        <FormattedMoney :isLoaded="walletValueIsLoaded" :value="walletTotalValue" />
      </div>
    </div>

    <div class="relative pt-1">
      <div class="mb-2 flex flex-row gap-x-2 px-4">
        <button class="border-argon-600 cursor-pointer border-b-3 font-bold">Tokens</button>
        <!--        <button class="text-argon-900/50 cursor-pointer">Transactions</button>-->
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
            <span v-if="pendingOutboundSatoshis" class="ml-1 text-slate-400">
              -{{ satToBtcNm(pendingOutboundSatoshis).format('0,0.[00000000]') }} BTC
            </span>
            <button
              v-if="walletBitcoinSections.length"
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
              v-if="bitcoinDetailsAreExpanded && walletBitcoinSections.length"
              class="mb-2 ml-4 overflow-hidden rounded-bl-lg border-b border-l border-slate-300/70 pt-2 pr-2 pb-3 pl-3"
            >
              <section v-for="group in walletBitcoinSections" :key="group.key" class="py-1 first:pt-0 last:pb-0">
                <div class="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                  {{ group.label }}
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
                    :aria-label="`${group.label} Channel`"
                    class="flex w-full cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-left text-sm text-slate-600"
                    :class="
                      openInsuranceChannelUuid === entry.lock.uuid
                        ? 'bg-argon-100/40 ring-argon-300/30 ring-1 ring-inset'
                        : 'hover:bg-argon-100/30'
                    "
                  >
                    <span class="font-mono text-slate-700">
                      {{ satToBtcNm(entry.satoshis).format('0,0.[00000000]') }} BTC
                    </span>
                    <span v-if="entry.address" class="font-mono text-xs text-slate-400">
                      {{ abbreviateAddress(entry.address, 6) }}
                    </span>
                    <span v-if="entry.releaseProgressPct !== undefined" class="ml-auto text-xs text-slate-500">
                      {{ numeral(entry.releaseProgressPct).format('0.0') }}%
                    </span>
                    <span v-else class="ml-auto text-xs text-slate-500">
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
  <BitcoinOrphanRecoveryOverlay
    v-if="selectedOrphan && selectedOrphanLock"
    :record="selectedOrphan"
    :lock="selectedOrphanLock"
    @close="selectedOrphan = undefined"
    @back="selectedOrphan = undefined"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { bigIntMax } from '@argonprotocol/apps-core';
import { ChevronRightIcon, MinusIcon, PlusIcon } from '@heroicons/vue/20/solid';
import AlertIcon from '../../assets/alert.svg?component';
import type { IWalletGuidanceContext } from '../../emitters/basicEmitter.ts';
import { BitcoinReleaseStatus } from '../../interfaces/IBitcoinReleaseRecord.ts';
import { WalletType } from '../../lib/Wallet.ts';
import numeral, { createNumeralHelpers } from '../../lib/numeral.ts';
import { abbreviateAddress } from '../../lib/Utils.ts';
import type { IBitcoinLockRecord } from '../../interfaces/IBitcoinLockRecord.ts';
import type { IBitcoinUtxoRecord } from '../../lib/db/BitcoinUtxosTable.ts';
import { getBitcoinLocks, getBitcoinTransactionOperations } from '../../stores/bitcoin.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { useFinancials } from '../../stores/financials.ts';
import { getMiningFrames } from '../../stores/mainchain.ts';
import { getMyVault, getVaults } from '../../stores/vaults.ts';
import { useWallets } from '../../stores/wallets.ts';
import FormattedMoney from '../../components/FormattedMoney.vue';
import Tooltip from '../../components/Tooltip.vue';
import BitcoinOrphanRecoveryOverlay from '../../overlays/BitcoinOrphanRecoveryOverlay.vue';
import ArgonBottom from './ArgonBottom.vue';
import ArgonTokens from './ArgonTokens.vue';
import ConnectorChannel from './ConnectorChannel.vue';
import WalletHeader from './WalletHeader.vue';
import { getBitcoinDepositAttention, type IWalletView } from '../walletOverlayState.ts';

interface IWalletBitcoinEntry {
  lock: IBitcoinLockRecord;
  satoshis: bigint;
  releaseProgressPct?: number;
}

const props = defineProps<{
  isDragging: boolean;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
}>();

const emit = defineEmits<{
  (event: 'dragStart', mouseEvent: MouseEvent): void;
  (event: 'goto', view: IWalletView): void;
  (event: 'openBitcoinConnector'): void;
  (event: 'close'): void;
}>();

const financials = useFinancials();
const bitcoinLocks = getBitcoinLocks();
const { bitcoinLockRelease } = getBitcoinTransactionOperations();
const config = getConfig();
const currency = getCurrency();
const miningFrames = getMiningFrames();
const myVault = getMyVault();
const vaults = getVaults();
const wallets = useWallets();
const { microgonToArgonNm, satToBtcNm } = createNumeralHelpers(currency);
const bitcoinDetailsAreExpanded = ref(false);
const openInsuranceChannelUuid = ref<string>();
const selectedOrphan = ref<IBitcoinUtxoRecord>();
const progressNow = ref(Date.now());
let progressRefreshInterval: ReturnType<typeof setInterval> | undefined;
const defaultArgonWallet = computed(() => wallets.defaultArgonWallet);
const walletValueIsLoaded = computed(() => financials.savingsIsLoaded);
const walletTotalValue = computed(() => financials.savingsTotalValue);
const bitcoinDepositAttention = computed(() => {
  return getBitcoinDepositAttention(wallets.bitcoinWallet);
});
const selectedOrphanLock = computed(() => {
  const utxoId = selectedOrphan.value?.lockId;
  return utxoId == null ? undefined : bitcoinLocks.getLockById(utxoId);
});
const pendingBitcoinSends = computed<IWalletBitcoinEntry[]>(() => {
  void progressNow.value;
  return bitcoinLocks.getAllLocks().flatMap(lock => {
    const release = bitcoinLocks.releases.getActiveForLock(lock);
    if (!release) return [];

    let releaseProgressPct = 0;
    if (release.status === BitcoinReleaseStatus.SubmittingRequestOnArgon) {
      const argonProgress = bitcoinLockRelease.getPendingReleaseTxInfo(lock.lockId!)?.getStatus();
      releaseProgressPct = (argonProgress?.progressPct ?? 0) * 0.33;
      if ((argonProgress?.confirmations ?? -1) >= 0 && (argonProgress?.expectedConfirmations ?? 0) > 0) {
        releaseProgressPct = Math.max(1, releaseProgressPct);
      }
    } else if (release.status === BitcoinReleaseStatus.WaitingForVaultCosign) {
      releaseProgressPct = 33 + bitcoinLocks.getRequestReleaseByVaultProgress(lock, miningFrames) * 0.33;
    } else if (release.status === BitcoinReleaseStatus.ReadyForBitcoinBroadcast) releaseProgressPct = 66;
    else if (release.status === BitcoinReleaseStatus.ConfirmingOnBitcoin) {
      releaseProgressPct = Math.round(66 + bitcoinLocks.getReleaseProcessingDetails(release).progressPct * 0.34);
    } else if (
      release.status === BitcoinReleaseStatus.WaitingForArgonRecognition ||
      release.status === BitcoinReleaseStatus.Complete
    ) {
      releaseProgressPct = 100;
    }

    return [
      {
        lock,
        satoshis: bitcoinLocks.releases.getInputUtxos(release).reduce((total, utxo) => total + utxo.satoshis, 0n),
        releaseProgressPct,
      },
    ];
  });
});
const pendingOutboundSatoshis = computed(() => {
  return pendingBitcoinSends.value.reduce((total, entry) => total + entry.satoshis, 0n);
});
const walletBitcoinSections = computed(() => {
  const locksByVaultId = new Map<number, IWalletBitcoinEntry[]>();

  for (const lock of bitcoinLocks.getAllLocks()) {
    if (!bitcoinLocks.isLockFunded(lock)) continue;

    const satoshis = bigIntMax(lock.fundedSatoshis - (lock.fissionedSatoshis ?? 0n), 0n);
    if (!satoshis) continue;

    const locks = locksByVaultId.get(lock.vaultId) ?? [];
    locks.push({ lock, satoshis });
    locksByVaultId.set(lock.vaultId, locks);
  }

  return [
    ...(pendingBitcoinSends.value.length
      ? [
          {
            key: 'sending',
            label: 'Outbound transfers in progress',
            entries: pendingBitcoinSends.value.map(entry => ({
              ...entry,
              address: wallets.bitcoinWallet.getChannelFundingAddress(entry.lock),
            })),
          },
        ]
      : []),
    ...[...locksByVaultId].map(([vaultId, locks]) => ({
      key: `vault-${vaultId}`,
      label: `Cosigner: ${
        vaultId === (myVault.createdVault?.vaultId ?? myVault.vaultId)
          ? 'My Vault'
          : (vaults.operatorNamesByVaultId[vaultId] ??
            (config.upstreamOperator?.vaultId === vaultId ? config.upstreamOperator.name : undefined) ??
            `Vault ${vaultId}`)
      }`,
      entries: locks.map(entry => ({
        ...entry,
        address: locks.length > 1 ? wallets.bitcoinWallet.getChannelFundingAddress(entry.lock) : undefined,
      })),
    })),
  ];
});

function reviewBitcoinDeposit(): void {
  const orphan = wallets.bitcoinWallet.getUnresolvedOrphanDeposits()[0];
  const lock = orphan ? bitcoinLocks.getLockById(orphan.lockId) : undefined;
  if (!orphan || !lock) {
    emit('openBitcoinConnector');
    return;
  }

  selectedOrphan.value = orphan;
}

onMounted(() => {
  progressRefreshInterval = setInterval(() => (progressNow.value = Date.now()), 1_000);
});

onUnmounted(() => {
  if (progressRefreshInterval) clearInterval(progressRefreshInterval);
});
</script>
