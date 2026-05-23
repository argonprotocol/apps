import {
  type AccountId32,
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
  type u32,
} from '@argonprotocol/mainchain';
import type { ArgonQueryClient } from './MainchainClients.js';

export type IEventInfo = {
  pallet: string;
  method: string;
  data: any;
};

export type IBalanceTransfer = {
  to: string;
  from?: string;
  transferType: 'transfer' | 'faucet' | 'ethereum';
  currency: 'argon' | 'argonot';
  isInternal: boolean;
  isInbound: boolean;
  amount: bigint;
  extrinsicIndex: number;
};

export type IVaultRevenueEvent = {
  amount: bigint;
  source: 'vaultCollect' | 'vaultBurn';
};

export type IExtrinsicEvent = [extrinsicIndex: number | null, ...events: IEventInfo[]];
export class AccountEventsFilter {
  public eventsByExtrinsic: IExtrinsicEvent[] = [];
  public transfers: IBalanceTransfer[] = [];
  public vaultRevenueEvents: IVaultRevenueEvent[] = [];

  constructor(
    public readonly address: string,
    public type: 'miningHold' | 'miningBot' | 'vaulting' | 'operational' | 'investment',
    public myOtherAddresses: string[],
    public vaultId?: number,
  ) {}

  public process(client: ArgonClient, allEvents: FrameSystemEventRecord[]) {
    let iAmMiner = false;
    if (this.type === 'miningBot') {
      for (const { event, phase } of allEvents) {
        if (phase.isApplyExtrinsic) {
          continue;
        }
        if (client.events.blockRewards.RewardCreated.is(event)) {
          iAmMiner = event.data.rewards.some(x => this.isAccountIdMe(x.accountId));
          if (iAmMiner) {
            break;
          }
        }
      }
    }

    const groupedEvents = AccountEventsFilter.groupEventsByExtrinsic(allEvents);

    for (const { extrinsicEvents, extrinsicIndex } of groupedEvents) {
      let isMine = false;
      for (const event of extrinsicEvents) {
        // these cover transfers in, mint, mining, etc
        for (const key of ['who', 'accountId', 'from', 'to', 'operatorAccountId', 'beneficiary'] as const) {
          if (key in event.data) {
            const possibleAccount = (event.data as any)[key] as AccountId32;
            if (this.isAccountIdMe(possibleAccount)) {
              isMine = true;
              break;
            }
          }
        }

        const transfer = AccountEventsFilter.isTransfer({
          client,
          event,
          extrinsicIndex,
          accountFilter: x => this.isAccountIdMe(x),
          extrinsicEvents: extrinsicEvents,
          isFromInternal: from => this.myOtherAddresses.includes(from.toHuman()),
        });
        if (transfer) {
          this.transfers.push(transfer);
          isMine = true;
        }

        if (iAmMiner) {
          if (client.events.blockRewards.RewardCreated.is(event)) {
            isMine = true;
          }
          if (client.events.transactionPayment.TransactionFeePaid.is(event)) {
            isMine = true;
          }
        }

        if (this.type === 'vaulting' && this.vaultId !== undefined) {
          if (AccountEventsFilter.isTreasuryEarningsEvent(event)) {
            isMine = true;
          } else if (client.events.vaults.VaultCollected.is(event)) {
            const { revenue, vaultId } = event.data;
            if (vaultId.toNumber() === this.vaultId) {
              isMine = true;
              const amount = revenue.toBigInt();
              this.vaultRevenueEvents.push({
                amount,
                source: 'vaultCollect',
              });
            }
          } else if (client.events.bitcoinLocks.BitcoinLockBurned.is(event)) {
            const { vaultId } = event.data;
            if (vaultId.toNumber() === this.vaultId) {
              isMine = true;
              const burnAmount = extrinsicEvents
                .filter(x => client.events.balances.Burned.is(x))
                .reduce((acc, x) => {
                  if (x.data.who.toHuman() === this.address) {
                    const amt = x.data.amount?.toBigInt() ?? 0n;
                    return acc + amt;
                  }
                  return acc;
                }, 0n);
              this.vaultRevenueEvents.push({
                amount: -burnAmount,
                source: 'vaultBurn',
              });
            }
          } else if ('vaultId' in event.data) {
            const vaultId = event.data.vaultId as u32;
            if (vaultId.toNumber() === this.vaultId) {
              isMine = true;
            }
          }
        }
      }

      if (isMine) {
        const eventGroup: IExtrinsicEvent = [extrinsicIndex ?? null];
        for (const event of extrinsicEvents) {
          eventGroup.push(this.toEventInfo(event));
        }
        this.eventsByExtrinsic.push(eventGroup);
      }
    }
  }

  private toEventInfo(event: GenericEvent): IEventInfo {
    return {
      pallet: event.section,
      method: event.method,
      data: event.data.toHuman(),
    };
  }

  private static isTreasuryEarningsEvent(event: GenericEvent): boolean {
    return event.section === 'treasury' && ['FrameEarningsDistributed', 'BidPoolDistributed'].includes(event.method);
  }

  private isAccountIdMe(accountId: AccountId32): boolean {
    const address = accountId.toHuman();
    return address === this.address;
  }

  public static groupEventsByExtrinsic(events: FrameSystemEventRecord[]) {
    const groupedEvents: { extrinsicEvents: GenericEvent[]; extrinsicIndex?: number }[] = [];
    const categorizedEvents: Set<GenericEvent> = new Set();
    for (const event of events) {
      if (categorizedEvents.has(event.event)) {
        continue;
      }
      if (event.phase.isApplyExtrinsic) {
        const subEvents = events
          .filter(e2 => e2.phase.isApplyExtrinsic && e2.phase.asApplyExtrinsic.eq(event.phase.asApplyExtrinsic))
          .map(e3 => e3.event);
        groupedEvents.push({ extrinsicEvents: subEvents, extrinsicIndex: event.phase.asApplyExtrinsic.toNumber() });
        for (const subEvent of subEvents) {
          categorizedEvents.add(subEvent);
        }
      } else {
        groupedEvents.push({ extrinsicEvents: [event.event] });
        categorizedEvents.add(event.event);
      }
    }
    return groupedEvents;
  }

  public static hasArgonotTransfer(
    client: ArgonQueryClient,
    extrinsicEvents: GenericEvent[],
    toAccount: string,
    amount: bigint,
  ): boolean {
    for (const event of extrinsicEvents) {
      if (client.events.ownership.Transfer.is(event)) {
        const { amount: eventAmount, to } = event.data;
        if (eventAmount.toBigInt() === amount && to.toHuman() === toAccount) {
          return true;
        }
      }
    }
    return false;
  }

  public static isTransfer(data: {
    client: ArgonQueryClient;
    event: GenericEvent;
    extrinsicEvents: GenericEvent[];
    extrinsicIndex?: number;
    accountFilter?: (accountId: AccountId32) => boolean;
    isFromInternal?: (from: AccountId32) => boolean;
  }): IBalanceTransfer | undefined {
    const {
      client,
      event,
      extrinsicIndex,
      extrinsicEvents,
      accountFilter = () => true,
      isFromInternal = () => false,
    } = data;
    if (client.events.balances.BalanceSet.is(event) && extrinsicIndex !== undefined) {
      const { who, free } = event.data;
      if (accountFilter(who)) {
        return {
          to: who.toHuman(),
          transferType: 'faucet',
          isInbound: true,
          amount: free.toBigInt(),
          isInternal: false,
          currency: 'argon',
          extrinsicIndex,
        };
      }
    } else if (client.events.ownership.BalanceSet.is(event) && extrinsicIndex !== undefined) {
      const { who, free } = event.data;
      if (accountFilter(who)) {
        return {
          to: who.toHuman(),
          transferType: 'faucet',
          isInbound: true,
          amount: free.toBigInt(),
          isInternal: false,
          currency: 'argonot',
          extrinsicIndex,
        };
      }
    } else if (client.events.crosschainTransfer.TransferToArgonSettled.is(event) && extrinsicIndex !== undefined) {
      const { transfer } = event.data;
      if (accountFilter(transfer.to)) {
        return {
          to: transfer.to.toHuman(),
          transferType: 'ethereum',
          isInbound: true,
          amount: transfer.amount.toBigInt(),
          isInternal: false,
          currency: transfer.asset.isArgon ? 'argon' : 'argonot',
          extrinsicIndex,
        };
      }
    }
    // NOTE: a balance transfer can be emitted as part of lots of operations. It's not necessarily a "user transfer". Will check later
    else if (client.events.balances.Transfer.is(event) && extrinsicIndex !== undefined) {
      const { to, from, amount } = event.data;
      const isValidTransfer = AccountEventsFilter.isBalanceTransferEventset(extrinsicEvents);
      if (!isValidTransfer) {
        return undefined;
      }
      if (accountFilter(to) || accountFilter(from)) {
        const isInbound = accountFilter(to);
        return {
          to: to.toHuman(),
          from: from.toHuman(),
          transferType: 'transfer',
          isInbound,
          amount: amount.toBigInt(),
          isInternal: isFromInternal(from),
          currency: 'argon',
          extrinsicIndex,
        };
      }
    } else if (client.events.ownership.Transfer.is(event) && extrinsicIndex !== undefined) {
      const { to, from, amount } = event.data;
      const isValidTransfer = AccountEventsFilter.isBalanceTransferEventset(extrinsicEvents);
      if (!isValidTransfer) {
        return undefined;
      }
      if (accountFilter(to) || accountFilter(from)) {
        const isInbound = accountFilter(to);
        return {
          to: to.toHuman(),
          from: from.toHuman(),
          transferType: 'transfer',
          amount: amount.toBigInt(),
          isInternal: isFromInternal(from),
          isInbound,
          currency: 'argonot',
          extrinsicIndex,
        };
      }
    }
    return undefined;
  }

  private static isBalanceTransferEventset(events: GenericEvent[]): boolean {
    const allowedTransferEvents: Record<string, string | string[]> = {
      utility: '*', // allow via batch
      proxy: '*', // allow via proxy
      multisig: '*', // allow via multisig
      system: ['ExtrinsicSuccess', 'NewAccount', 'KilledAccount'],
      // Withdraw/Deposit are for fees
      balances: ['Withdraw', 'Deposit', 'Transfer', 'Endowed'],
      ownership: ['Transfer', 'Endowed', 'Deposit', 'Withdraw'],
      transactionPayment: '*',
    };
    return events.every(x => {
      const allowed = allowedTransferEvents[x.section];
      if (!allowed) {
        return false;
      }
      if (allowed === '*') {
        return true;
      }
      return allowed.includes(x.method);
    });
  }
}
