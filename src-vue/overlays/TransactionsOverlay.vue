<!-- prettier-ignore -->
<template>
  <OverlayBase :isOpen="isOpen" @close="closeOverlay" @pressEsc="closeOverlay" class="w-8/12" overflowScroll>
    <template #title>
      <div class="grow text-2xl font-bold">Transactions</div>
    </template>

    <div class="flex min-h-0 flex-col px-5 pb-5">
      <div v-if="isLoading" class="flex min-h-56 items-center justify-center text-sm font-semibold text-slate-500">
        Loading transactions...
      </div>

      <div v-else-if="!activities.length" class="flex min-h-56 items-center justify-center text-sm text-slate-500">
        Your wallet has no activity yet.
      </div>

      <div v-else class="min-h-0 max-h-[calc(100vh-10rem)] overflow-y-auto">
        <table class="mt-2 w-full table-auto">
          <thead class="sticky top-0 z-10 border-b border-slate-200 bg-white font-bold tracking-wide text-argon-600 uppercase">
            <tr>
              <th class="p-2 text-left">Date</th>
              <th class="p-2 text-left">Activity</th>
              <th class="p-2 text-left">Amount</th>
              <th class="p-2 text-left">Block #</th>
              <th class="p-2 text-right">Details</th>
            </tr>
          </thead>
          <tbody class="font-mono">
            <tr
              v-for="(activity, index) in activities"
              :key="activity.id"
              :class="index % 2 === 0 ? 'bg-argon-100/20' : ''"
            >
              <td class="p-2 text-left text-slate-500">{{ dateLabel(activity) }}</td>
              <td class="p-2 text-left">{{ activityLabel(activity) }}</td>
              <td class="p-2 text-left">{{ amountLabel(activity) }}</td>
              <td class="p-2 text-left">{{ blockLabel(activity) }}</td>
              <td class="relative p-2 text-right">
                <a
                  v-if="canTrack(activity)"
                  class="cursor-pointer !text-argon-600 hover:text-argon-800"
                  @click="openActivity(activity)"
                >
                  track
                </a>
                <span v-else class="text-slate-500">{{ statusLabel(activity) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import { bigIntAbs, MoveToken } from '@argonprotocol/apps-core';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import OverlayBase from './OverlayBase.vue';
import { getCurrency } from '../stores/currency.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';
import { useBasics } from '../stores/basics.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { buildWalletActivity, type IWalletActivityRecord } from '../lib/WalletActivity.ts';
import type { IBitcoinOrphanedUtxoFundingMetadata, IBitcoinRequestLockMetadata } from '../lib/BitcoinLocks.ts';
import type { IBuyArgonotBondMetadata, IBuyVaultBondMetadata } from '../lib/ArgonBonds.ts';
import type { ICrosschainTransferOutMetadata } from '../lib/EthereumOutboundTransferTracker.ts';
import type { ITransactionMoveMetadata } from '../lib/MoveCapital.ts';
import type {
  IVaultCommittedArgonotsMetadata,
  IVaultIncreaseAllocationMetadata,
  IVaultInitialAllocateMetadata,
} from '../lib/MyVault.ts';
import type { IVaultCollectMetadata } from '../lib/VaultCollectBuilder.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../interfaces/ITransactionRecord.ts';
import basicEmitter from '../emitters/basicEmitter.ts';

dayjs.extend(utc);
dayjs.extend(relativeTime);

const currency = getCurrency();
const walletKeys = getWalletKeys();
const wallets = useWallets();
const basics = useBasics();
const { microgonToArgonNm, micronotToArgonotNm, satToBtcNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(true);
const activities = Vue.ref<IWalletActivityRecord[]>([]);
let unsubscribe: (() => void) | undefined;

async function loadActivity(): Promise<void> {
  isLoading.value = true;
  const db = await getDbPromise();
  const [transfers, transactions] = await Promise.all([
    db.walletTransfersTable.fetchAll(),
    db.transactionsTable.fetchAll(),
  ]);
  activities.value = buildWalletActivity({ transfers, transactions });
  isLoading.value = false;
}

function closeOverlay(): void {
  isOpen.value = false;
  basics.overlayIsOpen = false;
}

async function openOverlay(): Promise<void> {
  isOpen.value = true;
  basics.overlayIsOpen = true;
  await loadActivity();
}

function activityLabel(activity: IWalletActivityRecord): string {
  if (activity.transaction && activity.transaction.extrinsicType !== ExtrinsicType.Transfer) {
    return transactionLabel(activity.transaction);
  }

  switch (activity.activityType) {
    case 'transfer':
      return transferLabel(activity, 'Transfer');
    case 'tokenGateway':
      return transferLabel(activity, 'Ethereum');
    case 'ethereum':
      return transferLabel(activity, 'Ethereum');
    case 'faucet':
      return transferLabel(activity, 'Testnet Faucet');
    default:
      return 'Wallet Activity';
  }
}

function transferLabel(activity: IWalletActivityRecord, fallback: string): string {
  const wallet = activity.walletName ? Vue.capitalize(activity.walletName) : 'Argon Wallet';
  const otherParty = activity.otherParty ? formatAddress(activity.otherParty) : fallback;
  return activity.amount !== undefined && activity.amount < 0n
    ? `${wallet} -> ${otherParty}`
    : `${otherParty} -> ${wallet}`;
}

function transactionLabel(transaction: ITransactionRecord): string {
  switch (transaction.extrinsicType) {
    case ExtrinsicType.VaultCreate:
      return 'Created Vault';
    case ExtrinsicType.VaultModifySettings:
      return 'Updated Vault Settings';
    case ExtrinsicType.VaultInitialAllocate:
      return 'Funded Vault';
    case ExtrinsicType.VaultIncreaseAllocation:
      return 'Added Vault Capital';
    case ExtrinsicType.VaultCollect: {
      const metadata = transaction.metadataJson as IVaultCollectMetadata;
      if (metadata.actionType === 'collectRevenue') return 'Collected Vault Revenue';
      if (metadata.actionType === 'cosignBitcoin') return 'Cosigned Bitcoin Locks';
      return 'Processed Vault Actions';
    }
    case ExtrinsicType.VaultSetCommittedArgonots:
      return 'Updated Vault ARGNOT Commitment';
    case ExtrinsicType.VaultSetBitcoinLockDelegate:
      return 'Set Bitcoin Lock Delegate';
    case ExtrinsicType.VaultTopUpBitcoinLockDelegate:
      return 'Funded Bitcoin Lock Delegate';
    case ExtrinsicType.MiningBidProxySetup:
      return 'Set Up Mining Bid Proxy';
    case ExtrinsicType.OperationalRegister:
      return 'Registered Operational Account';
    case ExtrinsicType.OperationalActivateAndClaim:
      return 'Activated Operational Account';
    case ExtrinsicType.OperationalClaimRewards:
      return 'Claimed Operational Rewards';
    case ExtrinsicType.BitcoinRequestLock:
      return 'Created Bitcoin Lock';
    case ExtrinsicType.BitcoinRequestRelease:
      return 'Requested Bitcoin Release';
    case ExtrinsicType.VaultCosignBitcoinRelease:
      return 'Cosigned Bitcoin Release';
    case ExtrinsicType.VaultCosignOrphanedUtxoRelease:
      return 'Cosigned Orphaned Bitcoin Release';
    case ExtrinsicType.BitcoinOrphanedUtxoUseAsFunding:
      return 'Used Orphaned Bitcoin as Funding';
    case ExtrinsicType.BitcoinOrphanedUtxoRelease:
      return 'Requested Orphaned Bitcoin Release';
    case ExtrinsicType.Transfer:
      return 'Moved Funds';
    case ExtrinsicType.CrosschainTransferProve:
      return 'Received from Ethereum';
    case ExtrinsicType.CrosschainTransferTransferOut:
      return 'Sent to Ethereum';
    case ExtrinsicType.CrosschainTransferApproveCouncil:
      return 'Approved Ethereum Transfer';
    case ExtrinsicType.CrosschainTransferAuthorize:
      return 'Authorized Ethereum Transfer';
    case ExtrinsicType.CrosschainTransferRegisterMintingAuthority:
      return 'Registered Minting Authority';
    case ExtrinsicType.TreasuryBuyBonds:
      return 'Purchased ARGN Bonds';
    case ExtrinsicType.TreasuryBuyArgonotBonds:
      return 'Purchased ARGNOT Bonds';
    case ExtrinsicType.TreasuryReleaseBondLot:
      return 'Scheduled Bond Release';
  }

  return 'Transaction';
}

function formatAddress(address: string): string {
  if (address === walletKeys.legacyMiningHoldAddress) return 'MiningHold';
  if (address === walletKeys.miningBotAddress) return 'MiningBot';
  if (address === walletKeys.vaultingAddress) return 'Vaulting';

  if (address.startsWith('0x')) {
    const value = address.slice(2).replace(/^0+/, '');
    return `0x${value.slice(0, 4)}...${value.slice(-4)}`;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function amountLabel(activity: IWalletActivityRecord): string {
  if (
    activity.amount !== undefined &&
    activity.currency &&
    (!activity.transaction ||
      activity.transaction.extrinsicType === ExtrinsicType.Transfer ||
      activity.transaction.extrinsicType === ExtrinsicType.CrosschainTransferProve)
  ) {
    return formatTokenAmount(activity.amount, activity.currency);
  }

  const transaction = activity.transaction;
  if (!transaction) return '--';

  switch (transaction.extrinsicType) {
    case ExtrinsicType.BitcoinRequestLock: {
      const metadata = transaction.metadataJson as IBitcoinRequestLockMetadata;
      return formatBitcoinAmount(metadata.bitcoin.satoshis);
    }
    case ExtrinsicType.BitcoinOrphanedUtxoUseAsFunding: {
      const metadata = transaction.metadataJson as IBitcoinOrphanedUtxoFundingMetadata;
      return formatBitcoinAmount(metadata.receivedSatoshis);
    }
    case ExtrinsicType.TreasuryBuyBonds: {
      const metadata = transaction.metadataJson as IBuyVaultBondMetadata;
      if (metadata.bondPurchaseMicrogons === undefined) return '--';
      return formatTokenAmount(metadata.bondPurchaseMicrogons, 'argon');
    }
    case ExtrinsicType.TreasuryBuyArgonotBonds: {
      const metadata = transaction.metadataJson as IBuyArgonotBondMetadata;
      if (metadata.bondPurchaseMicronots === undefined) return '--';
      return formatTokenAmount(metadata.bondPurchaseMicronots, 'argonot');
    }
    case ExtrinsicType.VaultInitialAllocate: {
      const metadata = transaction.metadataJson as IVaultInitialAllocateMetadata;
      return formatTokenAmount(metadata.microgonsForSecuritization, 'argon');
    }
    case ExtrinsicType.VaultIncreaseAllocation: {
      const metadata = transaction.metadataJson as IVaultIncreaseAllocationMetadata;
      return formatTokenAmount(metadata.addedSecuritizationMicrogons, 'argon');
    }
    case ExtrinsicType.VaultSetCommittedArgonots: {
      const metadata = transaction.metadataJson as IVaultCommittedArgonotsMetadata;
      return formatTokenAmount(metadata.committedMicronots, 'argonot');
    }
    case ExtrinsicType.VaultCollect: {
      const metadata = transaction.metadataJson as IVaultCollectMetadata;
      if (metadata.expectedCollectRevenue > 0n) return formatTokenAmount(metadata.expectedCollectRevenue, 'argon');
      return '--';
    }
    case ExtrinsicType.Transfer: {
      const metadata = transaction.metadataJson as ITransactionMoveMetadata;
      return formatAssetAmounts(metadata.assetsToMove.ARGN, metadata.assetsToMove.ARGNOT);
    }
    case ExtrinsicType.CrosschainTransferTransferOut: {
      const metadata = transaction.metadataJson as ICrosschainTransferOutMetadata;
      const currency = metadata.moveToken === MoveToken.ARGN ? 'argon' : 'argonot';
      return formatTokenAmount(metadata.amount, currency);
    }
  }

  return '--';
}

function formatBitcoinAmount(satoshis: bigint): string {
  return `${satToBtcNm(satoshis).format('0,0.[00000000]')} BTC`;
}

function formatAssetAmounts(microgons?: bigint, micronots?: bigint): string {
  const amounts: string[] = [];
  if (microgons) amounts.push(formatTokenAmount(microgons, 'argon'));
  if (micronots) amounts.push(formatTokenAmount(micronots, 'argonot'));
  return amounts.join(' + ') || '--';
}

function formatTokenAmount(amount: bigint, token: 'argon' | 'argonot'): string {
  if (token === 'argon') {
    return `${microgonToArgonNm(bigIntAbs(amount)).format('0,0.[000000]')} ARGN`;
  }
  return `${micronotToArgonotNm(bigIntAbs(amount)).format('0,0.[000000]')} ARGNOT`;
}

function statusLabel(activity: IWalletActivityRecord): string {
  switch (activity.transaction?.status) {
    case TransactionStatus.Submitted:
      return 'Submitted';
    case TransactionStatus.InBlock:
      return 'In block';
    case TransactionStatus.Finalized:
      return 'Finalized';
    case TransactionStatus.Error:
      return 'Failed';
    case TransactionStatus.TimedOutWaitingForBlock:
      return 'Timed out';
  }

  return activity.isFinalized ? 'Finalized' : 'Pending';
}

function blockLabel(activity: IWalletActivityRecord): string {
  if (activity.blockNumber === undefined) {
    return 'Pending';
  }
  return activity.blockNumber.toLocaleString();
}

function dateLabel(activity: IWalletActivityRecord): string {
  const date = activity.occurredAt;
  if (!date) return '';
  return dayjs.utc(date).local().fromNow();
}

function canTrack(activity: IWalletActivityRecord): boolean {
  return Boolean(
    activity.transfer?.tokenGatewayCommitmentHash || (activity.blockNumber && activity.extrinsicIndex !== null),
  );
}

function openActivity(activity: IWalletActivityRecord): void {
  let url = `https://argon.statescan.io/#/extrinsics/${activity.blockNumber}-${activity.extrinsicIndex}`;
  if (activity.transfer?.tokenGatewayCommitmentHash) {
    url = `https://explorer.hyperbridge.network/messages/${activity.transfer.tokenGatewayCommitmentHash}`;
  }
  void openUrl(url);
}

Vue.onMounted(async () => {
  basicEmitter.on('openTransactionsOverlay', openOverlay);
  unsubscribe = wallets.on('balance-change', async () => {
    if (isOpen.value) await loadActivity();
  });
});

Vue.onBeforeUnmount(() => {
  basicEmitter.off('openTransactionsOverlay', openOverlay);
  unsubscribe?.();
});
</script>
