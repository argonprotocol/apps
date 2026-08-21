<!-- prettier-ignore -->
<template>
  <div data-testid="CrosschainTransfersDashboard" class="flex h-full min-h-0 grow flex-col gap-y-2 overflow-y-auto pr-2.5">
    <section class="flex h-[14%] min-h-24 shrink-0 flex-row gap-x-2">
      <Tooltip :asChild="true">
        <div box stat-box class="flex w-1/5 cursor-help flex-col">
          <span>{{ currency.symbol }}{{ formatValue(remainingMintingAuthority.valueMicrogons) }}</span>
          <label>Remaining Minting Authority</label>
        </div>
        <template #content>
          <div class="space-y-1">
            <div>{{ formatArgon(remainingMintingAuthority.microgons) }} ARGN remaining</div>
            <div>{{ formatArgonot(remainingMintingAuthority.micronots) }} ARGNOT remaining</div>
            <div class="text-xs text-slate-500">
              {{ formatArgon(mintingAuthorityValuationRate) }} ARGN per ARGNOT transfer-out quote
            </div>
          </div>
        </template>
      </Tooltip>
      <Tooltip
        :asChild="true"
        content="Deduplicated value of transfer requests you authorized in your selected currency, using the current transfer-out quote."
      >
        <div box stat-box class="flex w-1/5 cursor-help flex-col">
          <span>{{ currency.symbol }}{{ formatValue(sponsoredTransferValue) }}</span>
          <label>Transfer Value Sponsored</label>
        </div>
      </Tooltip>
      <Tooltip :asChild="true" content="Transfer authorizations and council approvals recovered for this wallet.">
        <div box stat-box class="flex w-1/5 cursor-help flex-col">
          <span>{{ totalSigned.toLocaleString() }}</span>
          <label>Total Signed</label>
        </div>
      </Tooltip>
      <Tooltip
        :asChild="true"
        content="Value of your transfer-tip share recovered from signing history in your selected currency, using each transfer's snapshotted quote."
      >
        <div box stat-box class="flex w-1/5 cursor-help flex-col">
          <span>{{ currency.symbol }}{{ formatValue(crosschainHistory.getTransferTips()) }}</span>
          <label>Transfer Tips</label>
        </div>
      </Tooltip>
      <Tooltip
        :asChild="true"
        content="Value of your minting authorities' available tip shares in your selected currency, using each transfer's snapshotted quote."
      >
        <div box stat-box class="flex w-1/5 cursor-help flex-col">
          <span>{{ currency.symbol }}{{ formatValue(availableTipValueMicrogons) }}</span>
          <label>Tips Available</label>
        </div>
      </Tooltip>
    </section>

    <section box class="flex shrink-0 flex-col px-2">
      <header class="flex items-center border-b border-slate-400/30 px-2 py-2">
        <div class="grow">
          <div class="text-xl font-bold text-slate-900/80">Crosschain Transfers</div>
        </div>

        <div class="flex items-center gap-x-3 text-base font-light text-slate-700">
          <button
            type="button"
            class="cursor-pointer hover:opacity-80"
            @click="basicEmitter.emit('openMintingAuthorityRequestOverlay')">
            Add Authority
          </button>
          <div class="h-5 w-px bg-slate-600/30" />
          <EthereumSyncPopover position="top">
            <span class="cursor-pointer hover:opacity-80">Sync Status</span>
          </EthereumSyncPopover>
        </div>
      </header>

      <div v-if="fundingError" class="border-argon-error/30 bg-argon-error/5 text-argon-error border-b px-4 py-2 text-sm">
        {{ fundingError }}
      </div>
      <div
        v-if="myVault.mintingAuthorities.data.backedTransfersError"
        class="border-argon-error/30 bg-argon-error/5 text-argon-error border-b px-4 py-2 text-sm">
        Current backed-transfer status could not be refreshed. Previously loaded rows may be out of date.
      </div>

      <div v-if="transferQueueRows.length">
        <section>
          <header class="flex items-center border-b border-slate-300/70 px-4 py-3">
            <div class="grow">
              <h2 class="font-semibold text-slate-800">Transfer Requests</h2>
              <p class="text-sm text-slate-500">Choose which requests to fund with your minting authority.</p>
            </div>
            <button
              v-if="fundableRows.length > 1"
              type="button"
              role="checkbox"
              :aria-checked="selectedTransferIds.length > 0 && !allFundableRowsSelected ? 'mixed' : allFundableRowsSelected"
              class="flex cursor-pointer items-center gap-x-2 text-sm text-slate-600 hover:text-slate-800"
              @click="toggleAllFundableRows">
              <Checkbox
                :isChecked="allFundableRowsSelected"
                :isPartiallyChecked="selectedTransferIds.length > 0 && !allFundableRowsSelected"
                :size="4"
              />
              Select all
            </button>
          </header>

          <details
            v-for="row in transferQueueRows"
            :key="row.key"
            class="group border-b border-slate-200 last:border-b-0">
            <summary class="flex cursor-pointer list-none items-center gap-x-4 px-4 py-3 hover:bg-slate-50">
              <button
                v-if="row.needsAction && row.transferId"
                type="button"
                role="checkbox"
                :aria-checked="selectedTransferIds.includes(row.transferId)"
                class="cursor-pointer"
                title="Select this transfer request to fund"
                @click.stop="toggleTransferSelection(row.transferId)">
                <Checkbox :isChecked="selectedTransferIds.includes(row.transferId)" :size="4" />
                <span class="sr-only">Select transfer {{ row.transferId }} to fund</span>
              </button>
              <div v-else class="flex w-4 shrink-0 justify-center" title="Your authorization is recorded">
                <CheckCircleIcon class="-m-0.5 h-5 w-5 text-slate-400" />
                <span class="sr-only">Your authorization is recorded</span>
              </div>
              <div class="min-w-0 grow">
                <div class="flex items-center gap-x-2">
                  <span class="font-semibold text-slate-800">{{ row.title }}</span>
                  <span
                    v-if="row.sourceIdentity"
                    class="max-w-48 truncate rounded bg-slate-200/70 px-2 py-0.5 text-xs font-medium text-slate-600">
                    {{ formatCrosschainSourceIdentity(row.sourceIdentity) }}
                  </span>
                </div>
                <div class="mt-0.5 flex min-w-0 items-center gap-x-2 text-sm">
                  <span class="text-slate-600">{{ row.status }}</span>
                  <span class="text-slate-400">·</span>
                  <span class="truncate text-slate-500">Waiting for {{ row.waitingFor }}</span>
                </div>
              </div>
              <div v-if="row.amount !== undefined" class="shrink-0 text-right">
                <div class="font-mono font-semibold text-slate-700">{{ formatTokenAmount(row.amount, row.moveToken) }}</div>
                <div class="mt-0.5 text-xs text-slate-500">
                  {{ formatTokenAmount(row.tip ?? 0n, row.moveToken) }} tip
                </div>
              </div>
              <div class="text-slate-400 transition-transform group-open:rotate-90">›</div>
            </summary>

            <div class="border-t border-dashed border-slate-200 bg-slate-50/70 px-10 py-4">
              <CrosschainTransferDetails
                v-if="row.transferDetails"
                :transfer="row.transferDetails"
                :sourceIdentity="row.sourceIdentity"
                :sourceTotals="getSourceTotals(row.sourceAccount)"
                :recipientSeen="getRecipientSeen(row)"
                :progress="getTransferProgress(row)"
                wide
              />
              <div v-else class="text-sm text-slate-600">Waiting for {{ row.waitingFor }}.</div>
            </div>
          </details>

          <div
            v-if="fundableRows.length || showFundingProgress"
            class="flex items-center gap-x-4 border-t border-slate-300/70 px-4 py-2">
            <template v-if="showFundingProgress">
              <div class="grow text-sm font-medium text-slate-700">
                Funding {{ fundingTransferCount }} selected transfer{{ fundingTransferCount === 1 ? '' : 's' }} on Argon...
              </div>
              <div
                role="status"
                aria-live="polite"
                class="w-72 shrink-0">
                <div :class="fundingError ? 'text-argon-error' : 'text-slate-500'" class="mb-1 truncate text-xs">
                  {{ fundingError || fundingProgressLabel || 'Preparing transaction...' }}
                </div>
                <ProgressBar :progress="fundingProgressPct" :showLabel="false" class="h-4" />
              </div>
            </template>
            <template v-else>
              <div class="grow text-sm text-slate-500">
                <template v-if="selectedAuthorizations.length">
                  {{ formatArgon(selectedMicrogonCollateral) }} ARGN +
                  {{ formatArgonot(selectedMicronotCollateral) }} ARGNOT collateral for
                  <template v-if="selectedTipMicrogons > 0n">{{ formatArgon(selectedTipMicrogons) }} ARGN</template>
                  <template v-if="selectedTipMicrogons > 0n && selectedTipMicronots > 0n"> + </template>
                  <template v-if="selectedTipMicronots > 0n">
                    {{ formatArgonot(selectedTipMicronots) }} ARGNOT
                  </template>
                  <template v-if="selectedTipMicrogons === 0n && selectedTipMicronots === 0n">0 ARGN</template>
                  tip
                </template>
                <template v-else>Select one or more transfer requests to fund.</template>
              </div>
              <button
                type="button"
                class="bg-argon-button enabled:hover:bg-argon-button-hover rounded px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-white enabled:cursor-pointer disabled:cursor-default disabled:opacity-40"
                :disabled="!selectedAuthorizations.length"
                @click="fundSelectedTransfers">
                Fund Selected ({{ selectedAuthorizations.length }})
              </button>
            </template>
          </div>
        </section>

      </div>

      <div
        v-else-if="!accessState.hasMintingAuthority"
        class="flex min-h-32 flex-col items-center justify-center px-8 text-center text-slate-500">
        <div class="text-lg font-semibold text-slate-600">No minting authority is registered</div>
        <p class="mt-1 max-w-2xl text-sm">
          A minting authority is required to fund transfer requests and earn authorization tips. Use Add Authority
          above to register one.
        </p>
      </div>

      <div v-else class="flex min-h-32 flex-col items-center justify-center px-8 text-center text-slate-500">
        <div class="text-lg font-semibold text-slate-600">No transfers are in progress</div>
        <p class="mt-1 max-w-lg text-sm">
          New transfer requests will appear here when they need funding or are still moving to Ethereum.
        </p>
      </div>
    </section>

    <section v-if="councilQueueRows.length" box class="shrink-0 px-2">
      <header class="flex items-center border-b border-slate-300/70 px-4 py-3">
        <div class="grow">
          <h2 class="font-semibold text-slate-800">Global Council Approval Queue</h2>
          <p class="text-sm text-slate-500">Gateway updates waiting for signatures, quorum, or Ethereum relay.</p>
        </div>
      </header>

      <details
        v-for="row in councilQueueRows"
        :key="row.key"
        class="group border-b border-slate-200 last:border-b-0">
        <summary class="flex cursor-pointer list-none items-center gap-x-4 px-4 py-3 hover:bg-slate-50">
          <div
            v-if="row.needsAction"
            role="checkbox"
            aria-checked="true"
            aria-disabled="true"
            class="cursor-default opacity-40"
            title="Included in this approval batch">
            <Checkbox :isChecked="true" :size="4" />
            <span class="sr-only">Included in this approval batch</span>
          </div>
          <div v-else class="flex w-4 shrink-0 justify-center" title="Your approval is recorded">
            <CheckCircleIcon class="-m-0.5 h-5 w-5 text-slate-400" />
            <span class="sr-only">Your approval is recorded</span>
          </div>
          <div class="min-w-0 grow">
            <div class="flex items-center gap-x-2">
              <span class="font-semibold text-slate-800">{{ row.title }}</span>
              <span
                v-if="row.authorityOwnerIdentity"
                class="max-w-48 truncate rounded bg-slate-200/70 px-2 py-0.5 text-xs font-medium text-slate-600">
                {{ formatCrosschainSourceIdentity(row.authorityOwnerIdentity) }}
              </span>
            </div>
            <div class="mt-0.5 flex min-w-0 items-center gap-x-2 text-sm">
              <span class="text-slate-600">{{ row.status }}</span>
              <span class="text-slate-400">·</span>
              <span class="truncate text-slate-500">Waiting for {{ row.waitingFor }}</span>
            </div>
          </div>
          <div class="text-slate-400 transition-transform group-open:rotate-90">›</div>
        </summary>

        <div class="border-t border-dashed border-slate-200 bg-slate-50/70 px-10 py-4">
          <CrosschainActivityDetails
            :queueNonce="row.queueNonce"
            :targetKind="row.targetKind"
            :targetValue="row.targetValue"
            :authorityOwnerAccount="row.authorityOwnerAccount"
            :authorityOwnerIdentity="row.authorityOwnerIdentity"
            :approvalProgress="row.approvalProgress"
            :councilChange="row.councilChange"
            :awaitingArgonConfirmation="isCouncilUpdateRelayed(row.queueNonce)"
            :ethereumBlocksUntilArgonConfirmation="getEthereumBlocksUntilArgonConfirmation(row.queueNonce)"
            wide
          />
        </div>
      </details>

      <div
        v-if="
          pendingCouncilApprovalCount ||
          relayableCouncilUpdateCount ||
          relayedCouncilUpdateCount ||
          showCouncilApprovalProgress
        "
        class="flex items-center gap-x-4 border-t border-slate-300/70 px-4 py-2">
        <template v-if="showCouncilApprovalProgress">
          <div class="grow text-sm text-slate-500">
            Approving {{ councilApprovalProgressItemCount }} gateway update{{ councilApprovalProgressItemCount === 1 ? '' : 's' }} on Argon.
          </div>
          <div
            role="status"
            aria-live="polite"
            class="w-72 shrink-0">
            <div
              :class="councilApprovalError ? 'text-argon-error' : 'text-slate-500'"
              class="mb-1 truncate text-xs">
              {{ councilApprovalError || councilApprovalProgressLabel || 'Preparing transaction...' }}
            </div>
            <ProgressBar :progress="councilApprovalProgressPct" :showLabel="false" class="h-4" />
          </div>
        </template>
        <template v-else>
          <div class="grow text-sm text-slate-500">
            <template v-if="pendingCouncilApprovalCount">
              {{ pendingCouncilApprovalCount }} gateway update{{ pendingCouncilApprovalCount === 1 ? '' : 's' }} waiting
              for your council signature.
            </template>
            <template v-else-if="relayableCouncilUpdateCount">
              {{ relayableCouncilUpdateCount }} gateway update{{ relayableCouncilUpdateCount === 1 ? '' : 's' }} ready
              for Ethereum relay.
            </template>
            <template v-else>
              {{ relayedCouncilUpdateCount }} gateway update{{ relayedCouncilUpdateCount === 1 ? '' : 's' }} applied
              on Ethereum and waiting for Argon confirmation.
            </template>
          </div>
          <button
            v-if="relayableCouncilUpdateCount"
            type="button"
            class="cursor-pointer rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-slate-600 hover:bg-slate-50"
            @click="basicEmitter.emit('openGatewayRelayOverlay')">
            Relay Gateway Updates ({{ relayableCouncilUpdateCount }})
          </button>
          <button
            v-if="pendingCouncilApprovalCount"
            type="button"
            class="bg-argon-button hover:bg-argon-button-hover cursor-pointer rounded px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-white"
            @click="basicEmitter.emit('openVaultCollect')">
            Approve Updates ({{ pendingCouncilApprovalCount }})
          </button>
        </template>
      </div>
    </section>

    <section box class="shrink-0 px-2">
      <header class="flex items-center border-b border-slate-300/70 px-4 py-3">
        <div class="grow">
          <div class="flex items-center gap-x-2">
            <h2 class="font-semibold text-slate-800">History</h2>
            <span
              v-if="crosschainHistory.data.isSyncing"
              class="border-argon-500 h-3.5 w-3.5 animate-spin rounded-full border-2 border-r-transparent"
              title="Downloading crosschain history"
            />
          </div>
          <p class="text-sm text-slate-500">Your transfer authorizations, council signatures, and authority changes.</p>
        </div>
        <button
          type="button"
          class="text-argon-600 hover:text-argon-800 cursor-pointer text-sm"
          @click="basicEmitter.emit('openCrosschainHistoryOverlay')">
          View all
        </button>
      </header>

      <CrosschainHistoryRows
        v-if="recentHistory.length"
        :records="recentHistory"
        :knownIdentities="knownSourceIdentities"
      />
      <div v-else-if="crosschainHistory.data.isSyncing" class="px-6 py-6 text-center text-sm text-slate-500">
        Downloading history. The live queue remains available.
      </div>
      <div v-else-if="crosschainHistory.data.error" class="px-6 py-6 text-center text-sm text-slate-500">
        {{ crosschainHistory.data.error }}. Cached history will appear here when available.
      </div>
      <div v-else class="px-6 py-6 text-center text-sm text-slate-500">
        No completed crosschain activity was found.
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, MoveToken } from '@argonprotocol/apps-core';
import { CheckCircleIcon } from '@heroicons/vue/24/outline';
import basicEmitter from '../../emitters/basicEmitter.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../../interfaces/ITransactionRecord.ts';
import {
  formatCouncilTarget,
  formatCrosschainSourceIdentity,
  getCrosschainAccessState,
  type ICrosschainSourceIdentity,
} from '../../lib/CrosschainTransferView.ts';
import type { IGlobalCouncilChange, IGlobalCouncilQueueItem } from '../../lib/GlobalCouncil.ts';
import type {
  ICrosschainSourceTransferTotals,
  IMintingAuthorityAuthorization,
  IMintingAuthorityAuthorizeMetadata,
  IMintingAuthorityBackedTransfer,
} from '../../lib/MintingAuthorities.ts';
import { getActiveMintingAuthorityRemaining } from '../../lib/MintingAuthorities.ts';
import type { TransactionInfo } from '../../lib/TransactionInfo.ts';
import { getActiveTransactionInfos, trackTransactionProgress } from '../../lib/TransactionProgress.ts';
import type { IVaultCollectMetadata } from '../../lib/VaultCollectBuilder.ts';
import type { ICrosschainOutboundTransferRecord } from '../../lib/db/CrosschainOutboundTransfersTable.ts';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import Checkbox from '../../components/Checkbox.vue';
import CrosschainActivityDetails from '../../components/CrosschainActivityDetails.vue';
import CrosschainHistoryRows from '../../components/CrosschainHistoryRows.vue';
import CrosschainTransferDetails from '../../components/CrosschainTransferDetails.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import Tooltip from '../../components/Tooltip.vue';
import EthereumSyncPopover from '../../overlays/EthereumSyncPopover.vue';
import { getBot } from '../../stores/bot.ts';
import { getConfig } from '../../stores/config.ts';
import { getCurrency } from '../../stores/currency.ts';
import { getEthereumOutboundTransferTracker } from '../../stores/moveToEthereum.ts';
import { getCrosschainHistory, getKnownCrosschainSourceIdentities, getMyVault } from '../../stores/vaults.ts';

type ITransferQueueRow = {
  key: string;
  title: string;
  status: string;
  waitingFor: string;
  needsAction: boolean;
  transferId: string;
  moveToken?: MoveToken.ARGN | MoveToken.ARGNOT;
  amount?: bigint;
  tip?: bigint;
  sourceAccount?: string;
  sourceIdentity?: ICrosschainSourceIdentity;
  destinationAccount?: string;
  validUntilEthereumBlock?: bigint;
  microgonCollateral?: bigint;
  micronotCollateral?: bigint;
  argonBlockHeight?: number;
  ethereumBlockNumber?: number;
  transferDetails?: IMintingAuthorityAuthorization | IMintingAuthorityBackedTransfer;
};

type ICouncilQueueRow = {
  key: string;
  title: string;
  status: string;
  waitingFor: string;
  needsAction: boolean;
  queueNonce: bigint;
  targetKind: IGlobalCouncilQueueItem['targetKind'];
  targetValue: string;
  authorityOwnerAccount?: string;
  authorityOwnerIdentity?: ICrosschainSourceIdentity;
  approvalProgress: IGlobalCouncilQueueItem['approvalProgress'];
  councilChange?: IGlobalCouncilChange;
};

const myVault = getMyVault();
const crosschainHistory = getCrosschainHistory();
const bot = getBot();
const config = getConfig();
const currency = getCurrency();
const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const accessState = Vue.computed(() =>
  getCrosschainAccessState({
    hasActivatedCrosschain: config.hasActivatedCrosschain,
    authorityCount: myVault.mintingAuthorities.data.authorities.length,
    isActiveCouncilMember: myVault.globalCouncil.data.isActiveCouncilMember,
  }),
);

let outboundTracker: ReturnType<typeof getEthereumOutboundTransferTracker> | undefined;
try {
  outboundTracker = getEthereumOutboundTransferTracker();
} catch {
  // Transfer rows remain authoritative without optional local Ethereum provenance.
}

const remainingMintingAuthority = Vue.computed(() => {
  return getActiveMintingAuthorityRemaining(
    myVault.mintingAuthorities.data.authorities,
    mintingAuthorityValuationRate.value,
  );
});
const mintingAuthorityValuationRate = Vue.computed(() => {
  return (
    myVault.globalCouncil.data.transferOutMicrogonsPerArgonot ??
    myVault.globalCouncil.data.activeEpochMicrogonsPerArgonot ??
    currency.microgonsPer.ARGNOT ??
    0n
  );
});
const crosschainQueueTxInfos = Vue.computed(() => myVault.getCrosschainQueueTxInfos());
const selectedTransferIds = Vue.ref<string[]>([]);
const isFundingSelected = Vue.ref(false);
const fundingProgressPct = Vue.ref(0);
const fundingProgressLabel = Vue.ref('');
const fundingError = Vue.ref('');

const isSubmittingCouncilApproval = Vue.ref(false);
const councilApprovalProgressPct = Vue.ref(0);
const councilApprovalProgressLabel = Vue.ref('');
const activeCouncilApprovalTransactionCount = Vue.ref(0);
const councilApprovalError = Vue.ref('');

const activeFundingTxInfos = Vue.computed(() => {
  return getActiveTransactionInfos([
    ...myVault.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.values(),
  ]) as TransactionInfo<IMintingAuthorityAuthorizeMetadata>[];
});
const showFundingProgress = Vue.computed(() => {
  return isFundingSelected.value || activeFundingTxInfos.value.length > 0;
});

const activeCouncilApprovalTxInfos = Vue.computed(() => {
  return getActiveTransactionInfos(
    crosschainQueueTxInfos.value.filter(({ tx }) => {
      if (tx.extrinsicType === ExtrinsicType.CrosschainTransferApproveCouncil) return true;

      const metadata = tx.metadataJson as Partial<IVaultCollectMetadata>;
      return (
        tx.extrinsicType === ExtrinsicType.VaultCollect &&
        (metadata.actionType === 'approveCouncil' || (metadata.councilApprovalCount ?? 0) > 0)
      );
    }),
  ) as TransactionInfo<IVaultCollectMetadata>[];
});
const showCouncilApprovalProgress = Vue.computed(() => {
  return isSubmittingCouncilApproval.value || activeCouncilApprovalTxInfos.value.length > 0;
});
const councilApprovalProgressItemCount = Vue.computed(() => {
  const updateCount = activeCouncilApprovalTxInfos.value.reduce(
    (total, { tx }) => total + (tx.metadataJson.councilApprovalCount ?? 0),
    0,
  );
  return updateCount || activeCouncilApprovalTransactionCount.value;
});

const localAuthorizationTxByTransferId = Vue.computed(() => {
  const txByTransferId = new Map<string, ITransactionRecord>();
  for (const txInfo of crosschainQueueTxInfos.value) {
    if (txInfo.tx.extrinsicType !== ExtrinsicType.CrosschainTransferAuthorize) continue;

    const metadata = txInfo.tx.metadataJson as Partial<IMintingAuthorityAuthorizeMetadata>;
    for (const authorization of metadata.authorizations ?? []) {
      txByTransferId.set(authorization.transferId.toLowerCase(), txInfo.tx);
    }
  }
  return txByTransferId;
});

const localOutboundByTransferId = Vue.computed(() => {
  const transfersById = new Map<string, ICrosschainOutboundTransferRecord>();
  for (const transfer of Object.values(outboundTracker?.data.transfersById ?? {})) {
    const record = transfer.persistedRecord;
    if (record?.transferId) {
      transfersById.set(record.transferId.toLowerCase(), record);
    }
  }
  return transfersById;
});

const knownSourceIdentities = Vue.computed(() => {
  return getKnownCrosschainSourceIdentities();
});

const transferQueueRows = Vue.computed<ITransferQueueRow[]>(() => {
  const finalizedTransferIds = new Set(
    myVault.mintingAuthorities.data.backedTransfers.map(transfer => transfer.transferId.toLowerCase()),
  );
  const pendingSubmissionIds = new Set(
    [...myVault.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.keys()].map(transferId =>
      transferId.toLowerCase(),
    ),
  );
  const actionableAuthorizations = myVault.mintingAuthorities.data.pendingMintingAuthorizations.filter(
    authorization => !pendingSubmissionIds.has(authorization.transferId.toLowerCase()),
  );
  const actionableTransferIds = new Set(actionableAuthorizations.map(transfer => transfer.transferId.toLowerCase()));
  const rows = [
    ...actionableAuthorizations.map(toPendingAuthorizationRow),
    ...[...myVault.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.entries()]
      .filter(([transferId]) => {
        const normalizedTransferId = transferId.toLowerCase();
        return !finalizedTransferIds.has(normalizedTransferId) && !actionableTransferIds.has(normalizedTransferId);
      })
      .map(toPendingSubmissionRow),
    ...myVault.mintingAuthorities.data.backedTransfers.map(toBackedTransferRow),
  ];

  return rows.sort((left, right) => Number(right.needsAction) - Number(left.needsAction));
});

const councilQueueRows = Vue.computed<ICouncilQueueRow[]>(() => {
  return myVault.globalCouncil.data.approvalQueue
    .map(toCouncilRow)
    .sort((left, right) => Number(right.needsAction) - Number(left.needsAction));
});
const pendingCouncilApprovalCount = Vue.computed(() => myVault.globalCouncil.data.pendingApprovals.length);
const relayableCouncilUpdateCount = Vue.computed(() => {
  return myVault.globalCouncil.data.approvalQueue.filter(
    ({ queueNonce, status }) => status === 'readyForRelay' && !isCouncilUpdateRelayed(queueNonce),
  ).length;
});
const relayedCouncilUpdateCount = Vue.computed(() => {
  return myVault.globalCouncil.data.approvalQueue.filter(
    ({ queueNonce, status }) => status === 'readyForRelay' && isCouncilUpdateRelayed(queueNonce),
  ).length;
});
const relayedCouncilQueueNonces = Vue.computed(() => {
  return myVault.globalCouncil.data.approvalQueue
    .filter(({ queueNonce, status }) => status === 'readyForRelay' && isCouncilUpdateRelayed(queueNonce))
    .map(({ queueNonce }) => queueNonce);
});
const latestExecutionAnchorBlockNumber = Vue.computed(() => {
  return bot.state?.ethereumSync?.latestExecutionAnchorBlockNumber;
});

Vue.watch(
  [relayedCouncilQueueNonces, latestExecutionAnchorBlockNumber],
  ([queueNonces, executionAnchorBlockNumber]) => {
    if (!queueNonces.length || executionAnchorBlockNumber === undefined) return;

    void myVault.globalCouncil
      .hydrateEthereumApprovalBlockNumbers(queueNonces, executionAnchorBlockNumber)
      .catch(error => console.error('[CrosschainTransfers] Unable to hydrate live Ethereum approval activity', error));
  },
  { immediate: true },
);

const fundableRows = Vue.computed(() => transferQueueRows.value.filter(row => row.needsAction));
const allFundableRowsSelected = Vue.computed(() => {
  return (
    fundableRows.value.length > 0 && fundableRows.value.every(row => selectedTransferIds.value.includes(row.transferId))
  );
});
const selectedAuthorizations = Vue.computed(() => {
  const selectedIds = new Set(selectedTransferIds.value.map(transferId => transferId.toLowerCase()));
  const fundableIds = new Set(fundableRows.value.map(row => row.transferId.toLowerCase()));
  return myVault.mintingAuthorities.data.pendingMintingAuthorizations.filter(authorization => {
    const transferId = authorization.transferId.toLowerCase();
    return selectedIds.has(transferId) && fundableIds.has(transferId);
  });
});
const selectedMicrogonCollateral = Vue.computed(() => {
  return selectedAuthorizations.value.reduce((total, authorization) => total + authorization.microgonCollateral, 0n);
});
const selectedMicronotCollateral = Vue.computed(() => {
  return selectedAuthorizations.value.reduce((total, authorization) => total + authorization.micronotCollateral, 0n);
});
const selectedTipMicrogons = Vue.computed(() => {
  return selectedAuthorizations.value.reduce((total, authorization) => {
    return authorization.moveToken === MoveToken.ARGN ? total + authorization.mintingAuthorityTipShare : total;
  }, 0n);
});
const selectedTipMicronots = Vue.computed(() => {
  return selectedAuthorizations.value.reduce((total, authorization) => {
    return authorization.moveToken === MoveToken.ARGNOT ? total + authorization.mintingAuthorityTipShare : total;
  }, 0n);
});
const fundingTransferCount = Vue.computed(() => {
  if (!activeFundingTxInfos.value.length) return selectedAuthorizations.value.length;

  return new Set(
    activeFundingTxInfos.value.flatMap(({ tx }) => tx.metadataJson.authorizations.map(({ transferId }) => transferId)),
  ).size;
});
const availableTipValueMicrogons = Vue.computed(() => {
  return myVault.mintingAuthorities.data.pendingMintingAuthorizations.reduce(
    (total, authorization) => total + authorization.mintingAuthorityTipValueMicrogons,
    0n,
  );
});
const totalSigned = Vue.computed(() => {
  return crosschainHistory.data.records.filter(record => record.details.kind !== 'authorityLifecycle').length;
});
const sponsoredTransferValue = Vue.computed(() => {
  return crosschainHistory.getSponsoredTransferValue(mintingAuthorityValuationRate.value);
});
const recentHistory = Vue.computed(() => crosschainHistory.data.records.slice(0, 3));

Vue.onMounted(async () => {
  void crosschainHistory.refresh();
});

Vue.watch(
  () => myVault.globalCouncil.data.gatewayActivityCount,
  (gatewayActivityCount, previousCount) => {
    if (previousCount === undefined || gatewayActivityCount === previousCount) return;
    void crosschainHistory.refresh();
  },
);

Vue.watch(
  activeFundingTxInfos,
  (txInfos, _, onCleanup) => {
    trackTransactionProgress({
      txInfos,
      isSubmitting: isFundingSelected,
      progressPct: fundingProgressPct,
      progressLabel: fundingProgressLabel,
      error: fundingError,
      onCleanup,
    });
  },
  { immediate: true },
);

Vue.watch(
  activeCouncilApprovalTxInfos,
  (txInfos, _, onCleanup) => {
    trackTransactionProgress({
      txInfos,
      isSubmitting: isSubmittingCouncilApproval,
      progressPct: councilApprovalProgressPct,
      progressLabel: councilApprovalProgressLabel,
      activeTransactionCount: activeCouncilApprovalTransactionCount,
      error: councilApprovalError,
      onCleanup,
    });
  },
  { immediate: true },
);

Vue.watch(
  () => fundableRows.value.map(row => row.transferId),
  availableTransferIds => {
    const availableIds = new Set(availableTransferIds.map(transferId => transferId.toLowerCase()));
    const validSelectedTransferIds = selectedTransferIds.value.filter(transferId =>
      availableIds.has(transferId.toLowerCase()),
    );
    if (validSelectedTransferIds.length !== selectedTransferIds.value.length) {
      selectedTransferIds.value = validSelectedTransferIds;
    }
  },
  { immediate: true },
);

function toggleAllFundableRows() {
  selectedTransferIds.value = allFundableRowsSelected.value ? [] : fundableRows.value.map(row => row.transferId);
}

function toggleTransferSelection(transferId: string) {
  selectedTransferIds.value = selectedTransferIds.value.includes(transferId)
    ? selectedTransferIds.value.filter(selectedTransferId => selectedTransferId !== transferId)
    : [...selectedTransferIds.value, transferId];
}

async function fundSelectedTransfers() {
  if (!selectedAuthorizations.value.length || isFundingSelected.value) return;

  isFundingSelected.value = true;
  fundingError.value = '';
  fundingProgressPct.value = 0;
  fundingProgressLabel.value = 'Preparing transaction...';

  try {
    await myVault.mintingAuthorities.authorize(
      selectedAuthorizations.value.map(authorization => authorization.transferId),
    );
    selectedTransferIds.value = [];
  } catch (error) {
    fundingError.value = error instanceof Error ? error.message : `${error}`;
  } finally {
    if (!activeFundingTxInfos.value.length) isFundingSelected.value = false;
  }
}

function toPendingAuthorizationRow(authorization: IMintingAuthorityAuthorization): ITransferQueueRow {
  const transferId = authorization.transferId.toLowerCase();
  const localArgonTx = localAuthorizationTxByTransferId.value.get(transferId);
  const localOutbound = localOutboundByTransferId.value.get(transferId);

  return {
    key: `authorize-${authorization.transferId}`,
    title: `Transfer ${authorization.moveToken} to Ethereum`,
    status: 'Available to fund',
    waitingFor: 'minting-authority funding',
    needsAction: true,
    moveToken: authorization.moveToken,
    amount: authorization.finalizeRequest.amount,
    tip: authorization.mintingAuthorityTipShare,
    transferId: authorization.transferId,
    sourceAccount: authorization.sourceAccount,
    sourceIdentity: knownSourceIdentities.value.get(authorization.sourceAccount),
    destinationAccount: authorization.finalizeRequest.recipient,
    validUntilEthereumBlock: authorization.finalizeRequest.validUntilBlock,
    microgonCollateral: authorization.microgonCollateral,
    micronotCollateral: authorization.micronotCollateral,
    argonBlockHeight: localArgonTx?.blockHeight,
    ethereumBlockNumber: localOutbound?.targetBlockNumber,
    transferDetails: authorization,
  };
}

function toBackedTransferRow(transfer: IMintingAuthorityBackedTransfer): ITransferQueueRow {
  const transferId = transfer.transferId.toLowerCase();
  const localArgonTx = localAuthorizationTxByTransferId.value.get(transferId);
  const localOutbound = localOutboundByTransferId.value.get(transferId);
  const isReady = transfer.status === 'readyForEthereum';

  return {
    key: `backed-${transfer.transferId}`,
    title: `Transfer ${transfer.moveToken} to Ethereum`,
    status: isReady ? 'Ready on Argon' : 'Partially funded on Argon',
    waitingFor: isReady ? 'the sender to submit on Ethereum' : 'another minting authority',
    needsAction: false,
    moveToken: transfer.moveToken,
    amount: transfer.amount,
    tip: transfer.mintingAuthorityTipShare,
    transferId: transfer.transferId,
    sourceAccount: transfer.sourceAccount,
    sourceIdentity: knownSourceIdentities.value.get(transfer.sourceAccount),
    destinationAccount: transfer.destinationAccount,
    validUntilEthereumBlock: transfer.validUntilEthereumBlock,
    microgonCollateral: transfer.ownedMicrogonCollateral,
    micronotCollateral: transfer.ownedMicronotCollateral,
    argonBlockHeight: localArgonTx?.blockHeight,
    ethereumBlockNumber: localOutbound?.targetBlockNumber,
    transferDetails: transfer,
  };
}

function toPendingSubmissionRow(
  entry: [string, TransactionInfo<IMintingAuthorityAuthorizeMetadata>],
): ITransferQueueRow {
  const [transferId, txInfo] = entry;
  const metadata = txInfo.tx.metadataJson as IMintingAuthorityAuthorizeMetadata;
  const authorization = metadata.authorizations.find(
    item => item.transferId.toLowerCase() === transferId.toLowerCase(),
  );
  const isInBlock = txInfo.tx.status === TransactionStatus.InBlock;

  return {
    key: `submitted-${transferId}`,
    title: 'Transfer authorization to Ethereum',
    status: isInBlock ? 'Authorization included on Argon' : 'Authorization submitted',
    waitingFor: 'Argon finalization',
    needsAction: false,
    transferId,
    tip: authorization?.mintingAuthorityTipShare ?? authorization?.mintingAuthorityTip,
    microgonCollateral: authorization?.microgonCollateral,
    micronotCollateral: authorization?.micronotCollateral,
    argonBlockHeight: txInfo.tx.blockHeight,
  };
}

function toCouncilRow(approval: IGlobalCouncilQueueItem): ICouncilQueueRow {
  const needsAction = approval.status === 'needsSignature';
  const isRelayedToEthereum = isCouncilUpdateRelayed(approval.queueNonce);
  const authorityOwnerAccount =
    approval.targetKind === 'globalIssuanceCouncilRotation' ? undefined : approval.authorityOwnerAccount;
  const approvalWeightPercent = approval.approvalProgress.totalWeight
    ? Number((approval.approvalProgress.approvedWeight * 1_000n) / approval.approvalProgress.totalWeight) / 10
    : 0;
  const approvalProgressLabel = `${approval.approvalProgress.signatureCount} of ${approval.approvalProgress.memberCount} signers · ${approvalWeightPercent}% approval weight`;
  let status = isRelayedToEthereum ? 'Applied on Ethereum' : 'Council quorum reached';
  let waitingFor = isRelayedToEthereum ? 'Argon confirmation' : 'Ethereum relay';
  if (approval.status === 'needsSignature') {
    status = 'Your council approval is needed';
    waitingFor = `your council signature (${approvalProgressLabel})`;
  } else if (approval.status === 'awaitingCouncilQuorum') {
    status = 'Your signature is recorded';
    waitingFor = `council quorum (${approvalProgressLabel})`;
  }

  return {
    key: `council-${approval.queueNonce}`,
    title: formatCouncilTarget(approval.targetKind),
    status,
    waitingFor,
    needsAction,
    approvalProgress: approval.approvalProgress,
    queueNonce: approval.queueNonce,
    targetKind: approval.targetKind,
    targetValue:
      approval.targetKind === 'globalIssuanceCouncilRotation' ? approval.targetCouncilHash : approval.targetSigningKey,
    ...(authorityOwnerAccount
      ? {
          authorityOwnerAccount,
          authorityOwnerIdentity: knownSourceIdentities.value.get(authorityOwnerAccount),
        }
      : {}),
    ...(approval.targetKind === 'globalIssuanceCouncilRotation' && approval.councilChange
      ? { councilChange: approval.councilChange }
      : {}),
  };
}

function isCouncilUpdateRelayed(queueNonce: bigint): boolean {
  return queueNonce <= (myVault.globalCouncil.data.ethereumApprovalNonce ?? -1n);
}

function getEthereumBlocksUntilArgonConfirmation(queueNonce: bigint): bigint | undefined {
  const activityBlockNumber = myVault.globalCouncil.data.ethereumApprovalBlockNumbers.get(queueNonce);
  const executionAnchorBlockNumber = latestExecutionAnchorBlockNumber.value;
  if (activityBlockNumber === undefined || executionAnchorBlockNumber === undefined) return;

  return activityBlockNumber > executionAnchorBlockNumber ? activityBlockNumber - executionAnchorBlockNumber : 0n;
}

function getSourceTotals(sourceAccount?: string): ICrosschainSourceTransferTotals | undefined {
  return sourceAccount ? myVault.mintingAuthorities.data.sourceTotalsByAccount.get(sourceAccount) : undefined;
}

function getRecipientSeen(row: ITransferQueueRow): boolean | undefined {
  if (!row.destinationAccount) return;
  return crosschainHistory.hasSeenRecipient(row.destinationAccount, row.transferId);
}

function formatTokenAmount(amount: bigint, moveToken?: MoveToken.ARGN | MoveToken.ARGNOT) {
  return moveToken === MoveToken.ARGNOT ? `${formatArgonot(amount)} ARGNOT` : `${formatArgon(amount)} ARGN`;
}

function formatArgon(amount: bigint) {
  if (amount > 0n && amount < BigInt(MICROGONS_PER_ARGON) / 100n) return '<0.01';
  return microgonToArgonNm(amount).format('0,0.[00]');
}

function formatArgonot(amount: bigint) {
  if (amount > 0n && amount < BigInt(MICRONOTS_PER_ARGONOT) / 100n) return '<0.01';
  return micronotToArgonotNm(amount).format('0,0.[00]');
}

function formatValue(amount: bigint) {
  return microgonToMoneyNm(amount).format('0,0.00');
}

function getTransferProgress(row: ITransferQueueRow) {
  const blocks = [];
  if (row.argonBlockHeight) blocks.push(`Argon block ${row.argonBlockHeight}`);
  if (row.ethereumBlockNumber) blocks.push(`Ethereum block ${row.ethereumBlockNumber}`);
  if (blocks.length) return blocks.join(' · ');
  return `Waiting for ${row.waitingFor}`;
}
</script>

<style scoped>
@reference "../../main.css";

[box] {
  @apply min-h-20 rounded border-[1px] border-slate-400/30 bg-white py-2 shadow;
}

[stat-box] {
  @apply text-argon-600 flex flex-col items-center justify-center;

  span {
    @apply font-mono text-3xl font-bold;
  }

  label {
    @apply mt-1 text-sm text-gray-500;
  }
}

dt {
  @apply text-slate-500;
}

dd {
  @apply min-w-0 break-words text-slate-700;
}
</style>
