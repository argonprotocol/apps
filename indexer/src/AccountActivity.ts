import { Option, type GenericEvent } from '@argonprotocol/mainchain';
import {
  AccountActivityKind,
  groupEventsByExtrinsic,
  isUserTransferEventSet,
  readEventField,
} from '@argonprotocol/apps-core';
import { AccountActivityCoverageError, hasNamedEventData, type HistoricalEvent } from './HistoricalEventSpecs.js';

export { AccountActivityKind };

export const accountActivityKindNames = new Map<AccountActivityKind, string>([
  [AccountActivityKind.Transfer, 'transfer'],
  [AccountActivityKind.MiningBid, 'mining_bid'],
  [AccountActivityKind.MiningSeat, 'mining_seat'],
  [AccountActivityKind.VaultPosition, 'vault_position'],
  [AccountActivityKind.VaultRevenue, 'vault_revenue'],
  [AccountActivityKind.BondPosition, 'bond_position'],
  [AccountActivityKind.BitcoinLock, 'bitcoin_lock'],
  [AccountActivityKind.BitcoinMint, 'bitcoin_mint'],
  [AccountActivityKind.Crosschain, 'crosschain'],
  [AccountActivityKind.OperationalReward, 'operational_reward'],
  [AccountActivityKind.Fee, 'fee'],
  [AccountActivityKind.AccountBalance, 'account_balance'],
]);

type IDecodedAccountActivityEvent = {
  mask: number;
  accounts: string[];
  vaultIds: number[];
  bitcoinLockIds: number[];
};
type IAccountActivityEvent = Pick<GenericEvent, 'data' | 'method' | 'section'>;
type IAccountActivityEventGroup = Omit<ReturnType<typeof groupEventsByExtrinsic>[number], 'extrinsicEvents'> & {
  extrinsicEvents: readonly IAccountActivityEvent[];
};

type IAccountActivityResult = {
  accounts: { address: string; mask: number }[];
  vaults: { vaultId: number; mask: number }[];
  vaultOwners: { vaultId: number; address: string }[];
  bitcoinLocks: { utxoId: number; mask: number }[];
  bitcoinLockOwners: { utxoId: number; address: string }[];
};

export class AccountActivityDecoder {
  public decode(args: {
    eventGroups: readonly IAccountActivityEventGroup[];
    specVersion: number;
  }): IAccountActivityResult {
    const accountMasks = new Map<string, number>();
    const vaultMasks = new Map<number, number>();
    const vaultOwners: { vaultId: number; address: string }[] = [];
    const bitcoinLockMasks = new Map<number, number>();
    const bitcoinLockOwners: { utxoId: number; address: string }[] = [];

    for (const { extrinsicEvents, extrinsicIndex } of args.eventGroups) {
      for (let eventIndex = 0; eventIndex < extrinsicEvents.length; eventIndex += 1) {
        const event = extrinsicEvents[eventIndex];
        const isBalanceSet =
          (event.section === 'balances' || event.section === 'ownership') && event.method === 'BalanceSet';
        const isUserTransfer =
          (event.section === 'balances' || event.section === 'ownership') &&
          event.method === 'Transfer' &&
          isUserTransferEventSet(extrinsicEvents, eventIndex);
        const isCustodyTransfer = extrinsicIndex !== undefined && (isBalanceSet || isUserTransfer);
        const decoded = this.decodeEvent(event, args.specVersion, isCustodyTransfer);
        const { mask } = decoded;
        if (!mask) continue;

        const eventAccounts = decoded.accounts;
        for (const address of eventAccounts) {
          accountMasks.set(address, (accountMasks.get(address) ?? 0) | mask);
        }

        const { vaultIds } = decoded;
        for (const vaultId of vaultIds) {
          vaultMasks.set(vaultId, (vaultMasks.get(vaultId) ?? 0) | mask);
        }

        for (const utxoId of decoded.bitcoinLockIds) {
          bitcoinLockMasks.set(utxoId, (bitcoinLockMasks.get(utxoId) ?? 0) | mask);
        }

        if (event.section === 'vaults' && event.method === 'VaultCreated') {
          const address = eventAccounts[0];
          const vaultId = vaultIds[0];
          if (address && vaultId !== undefined) vaultOwners.push({ vaultId, address });
        }
        // Creation and ratchet events can re-establish ownership even when an
        // earlier local seed is unavailable. The old Bonds pallet also attached
        // an optional Bitcoin UTXO to BondCreated.
        if (
          (event.section === 'bitcoinLocks' || (event.section === 'bonds' && event.method === 'BondCreated')) &&
          eventAccounts.length === 1
        ) {
          const address = eventAccounts[0];
          const utxoId = decoded.bitcoinLockIds[0];
          if (address && utxoId !== undefined) bitcoinLockOwners.push({ utxoId, address });
        }
      }
    }

    return {
      accounts: [...accountMasks].map(([address, mask]) => ({ address, mask })),
      vaults: [...vaultMasks].map(([vaultId, mask]) => ({ vaultId, mask })),
      vaultOwners,
      bitcoinLocks: [...bitcoinLockMasks].map(([utxoId, mask]) => ({ utxoId, mask })),
      bitcoinLockOwners,
    };
  }

  private decodeEvent(
    event: IAccountActivityEvent,
    specVersion: number,
    isCustodyTransfer: boolean,
  ): IDecodedAccountActivityEvent {
    const mask = classifyEvent(event, { isCustodyTransfer });
    if (!mask) {
      return { mask, accounts: [], vaultIds: [], bitcoinLockIds: [] };
    }
    if (!hasNamedEventData(event)) {
      throw new AccountActivityCoverageError(
        `${event.section}.${event.method} at runtime spec ${specVersion} does not expose complete named metadata`,
      );
    }

    return {
      mask,
      accounts: collectEventAccounts(event),
      vaultIds: collectEventVaultIds(event),
      bitcoinLockIds: collectEventBitcoinLockIds(event),
    };
  }
}

export function classifyEvent(
  event: Pick<GenericEvent, 'data' | 'method' | 'section'>,
  options: { isCustodyTransfer?: boolean } = {},
): number {
  const { section, method } = event;
  const { isCustodyTransfer = false } = options;

  // Fee is separate from the operation category because proxy execution can make
  // the effective account and the fee-paying account different.
  if (section === 'transactionPayment' && method === 'TransactionFeePaid') return AccountActivityKind.Fee;

  if (section === 'bitcoinLocks') return AccountActivityKind.BitcoinLock;

  // BitcoinUtxos observes every watched candidate on the network. Those events
  // do not identify an account and are not needed to reconstruct a user's lock;
  // account-owned lifecycle events are emitted by BitcoinLocks instead.
  if (section === 'bitcoinUtxos') return 0;
  if (section === 'bonds') {
    if (legacyBitcoinBondEvents.has(method)) return AccountActivityKind.BitcoinLock;
    if (method !== 'BondCreated') return 0;

    const utxoId = readEventField(event, 'utxoId');
    return utxoId?.toHuman() === null ? 0 : AccountActivityKind.BitcoinLock;
  }

  // ChainTransfer was renamed LocalchainTransfer. TokenGateway is the older
  // external-chain pallet; CrosschainTransfer is its current replacement.
  if (section === 'chainTransfer' || section === 'localchainTransfer') {
    return localchainAccountEvents.has(method) ? AccountActivityKind.Crosschain : 0;
  }
  if (section === 'tokenGateway') {
    return tokenGatewayAccountEvents.has(method) ? AccountActivityKind.Crosschain : 0;
  }
  if (section === 'crosschainTransfer') {
    return crosschainAccountEvents.has(method) ? AccountActivityKind.Crosschain : 0;
  }

  if (section === 'balances' || section === 'ownership') {
    if (!accountBalanceEvents.has(method)) return 0;
    return isCustodyTransfer ? AccountActivityKind.Transfer : AccountActivityKind.AccountBalance;
  }

  if (section === 'miningSlot') {
    // Bid capital and awarded-seat economics are deliberately separate so recovery
    // can distinguish an auction change from revenue produced during a seat term.
    if (miningBidEvents.has(method)) return AccountActivityKind.MiningBid;
    if (miningSeatEvents.has(method)) return AccountActivityKind.MiningSeat;
    return 0;
  }
  if (section === 'blockRewards') return AccountActivityKind.MiningSeat;

  if (section === 'mint') {
    // ArgonsMinted carried both sources before the runtime split the event.
    if (method === 'ArgonsMinted') {
      if (!hasNamedEventData(event, { section: 'mint', method: 'ArgonsMinted' })) {
        return AccountActivityKind.AccountBalance;
      }

      const mintType = event.data.mintType.toString().toLowerCase();
      if (mintType?.includes('bitcoin')) return AccountActivityKind.BitcoinMint;
      if (mintType?.includes('mining')) return AccountActivityKind.MiningSeat;
      return AccountActivityKind.AccountBalance;
    }

    // MiningMint is a global floor adjustment correlated to active seat ranges.
    // BitcoinMint names its recipient directly and remains a distinct cash-flow type.
    if (method === 'BitcoinMint') return AccountActivityKind.BitcoinMint;
    if (method === 'MiningMint') return AccountActivityKind.MiningSeat;
    return AccountActivityKind.AccountBalance;
  }

  if (section === 'vaults') {
    // FundsLocked changes the vault's committed capital and creates/ratchets a
    // customer's Bitcoin position, so one block can legitimately carry both bits.
    if (method === 'FundsLocked' || vaultBitcoinLockEvents.has(method)) {
      return AccountActivityKind.VaultPosition | AccountActivityKind.BitcoinLock;
    }
    if (vaultRevenueEvents.has(method)) return AccountActivityKind.VaultRevenue;
    if (vaultPositionEvents.has(method)) return AccountActivityKind.VaultPosition;
    return 0;
  }

  if (section === 'treasury') {
    // Treasury replaced the vault-owned bid pool before it introduced bond lots.
    // Keep those vault capital/revenue eras separate from the later bond lifecycle.
    if (treasuryBondPositionEvents.has(method)) return AccountActivityKind.BondPosition;
    if (treasuryVaultPositionEvents.has(method)) return AccountActivityKind.VaultPosition;
    if (treasuryVaultRevenueEvents.has(method)) return AccountActivityKind.VaultRevenue;
    return 0;
  }

  if (section === 'operationalAccounts' || section === 'providers') {
    return method.includes('Reward') ? AccountActivityKind.OperationalReward : 0;
  }

  return 0;
}

const miningBidEvents = new Set([
  'MiningBidsClosed',
  'ReleaseBidError',
  'SlotBidderAdded',
  'SlotBidderDropped',
  'SlotBidderOut',
  'SlotBidderReplaced',
]);
const legacyBitcoinBondEvents = new Set([
  'BitcoinBondBurned',
  'BitcoinCosignPastDue',
  'BitcoinUtxoCosignRequested',
  'BitcoinUtxoCosigned',
  'CosignOverdueError',
]);
const miningSeatEvents = new Set([
  'NewMiners',
  'ReleasedMinerSeat',
  'ReleaseMinerSeatError',
  'UnbondedMiner',
  'UnbondMinerError',
]);
const accountBalanceEvents = new Set([
  'BalanceSet',
  'Burned',
  'BurnedHeld',
  'Deposit',
  'DustLost',
  'Endowed',
  'Frozen',
  'Held',
  'Locked',
  'Minted',
  'Released',
  'ReserveRepatriated',
  'Reserved',
  'Restored',
  'Slashed',
  'Suspended',
  'Thawed',
  'Transfer',
  'TransferAndHold',
  'TransferOnHold',
  'Unlocked',
  'Unreserved',
  'Upgraded',
  'Withdraw',
]);
const localchainAccountEvents = new Set([
  'TransferFromLocalchain',
  'TransferFromLocalchainError',
  'TransferToLocalchain',
  'TransferToLocalchainExpired',
  'TransferToLocalchainRefundError',
]);
const tokenGatewayAccountEvents = new Set(['AssetReceived', 'AssetRefunded', 'AssetTeleported']);
const crosschainAccountEvents = new Set([
  'TransferCollateralInvalidated',
  'TransferCollateralized',
  'TransferOutCanceled',
  'TransferOutFinalized',
  'TransferOutReady',
  'TransferOutStarted',
  'TransferToArgonSettled',
]);
const vaultRevenueEvents = new Set([
  'BidPoolDistributed',
  'CouldNotAllocateNextBidPool',
  'CouldNotBurnBidPool',
  'CouldNotDistributeBidPool',
  'LiquidityPoolRecordingError',
  'NextBidPoolAllocated',
  'TreasuryRecordingError',
  'VaultCollected',
  'VaultRevenueUncollected',
]);
const vaultBitcoinLockEvents = new Set([
  // A canceled fund lock reverses the same vault-backed Bitcoin commitment
  // created by FundsLocked, so it belongs to that lifecycle rather than vault capital.
  'FundLockCanceled',
  'LostBitcoinCompensated',
  'ObligationBaseFeeMaturationError',
  'ObligationCanceled',
  'ObligationCompleted',
  'ObligationCompletionError',
  'ObligationCreated',
  'ObligationModified',
]);
// Creation, modification, and closure establish or change the operator's
// committed vault capital. Configuration-only changes such as xpub and terms
// updates are deliberately excluded.
const vaultPositionEvents = new Set([
  'VaultClosed',
  'VaultCreated',
  'VaultModified',

  // Specs 106-115 used mining-bond/bonded-ARGN events for scheduled and applied
  // capital changes before later runtimes folded them into VaultModified.
  'VaultBondedArgonsChangeScheduled',
  'VaultBondedArgonsIncreased',
  'VaultMiningBondsChangeScheduled',
  'VaultMiningBondsIncreased',

  // Specs 125+ split delayed securitization release into schedule and completion
  // events. Only successful lifecycle changes are indexed.
  'FundsReleased',
  'FundsScheduledForRelease',

  // Specs 151+ track ARGNOT committed as vault capital separately from ARGN.
  'CommittedArgonotsSet',
]);
// Treasury bond lots begin at spec 151. Spec 156 replaces the event's vaultId
// with programId so one lifecycle can cover vault-backed and ARGNOT-backed lots;
// the block's runtime metadata resolves that shape change before account collection.
const treasuryBondPositionEvents = new Set([
  'BondLotPurchased',
  'BondLotReleased',
  'BondLotReleaseScheduled',
  'CouldNotReleaseBondLot',
  'EncumberedBondMicrogonsBurned',
  'FrameVaultCapitalLocked',
]);
// Before bond lots, specs 131-150 use Treasury for the vault bid-pool capital
// lifecycle. Keep these as vault activity even though the later bond lifecycle
// lives in the same pallet.
const treasuryVaultPositionEvents = new Set([
  'ErrorRefundingTreasuryCapital',
  'NextBidPoolCapitalLocked',
  'RefundedTreasuryCapital',
  'VaultFunderAllocation',
  'VaultOperatorPrebond',
]);
const treasuryVaultRevenueEvents = new Set([
  'BidPoolDistributed',
  'CouldNotBurnBidPool',
  'CouldNotDistributeBidPool',
  'CouldNotFundTreasury',
]);
function collectEventAccounts(event: HistoricalEvent): string[] {
  return event.data.flatMap((value, index) => {
    return event.data.typeDef[index].type.includes('AccountId') ? [value.toString()] : [];
  });
}

function collectEventVaultIds(event: HistoricalEvent): number[] {
  const { data } = event;
  if ('vaultId' in data) return [data.vaultId.toNumber()];
  if ('programId' in data && data.programId.isVault) return [data.programId.asVault.vaultId.toNumber()];
  return [];
}

function collectEventBitcoinLockIds(event: HistoricalEvent): number[] {
  const { data } = event;
  if (!('utxoId' in data)) return [];

  const { utxoId } = data;
  if (utxoId instanceof Option) return utxoId.isSome ? [utxoId.unwrap().toNumber()] : [];
  return [utxoId.toNumber()];
}
