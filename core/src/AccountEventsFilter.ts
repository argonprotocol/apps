import {
  type AccountId32,
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
  type u32,
} from '@argonprotocol/mainchain';

export type IEventInfo = {
  pallet: string;
  method: string;
  data: any;
};

export type IBalanceTransfer = {
  to: string;
  from?: string;
  transferType: 'transfer' | 'faucet' | 'tokenGateway';
  isInternal: boolean;
  isInbound: boolean;
  amount: bigint;
  isOwnership: boolean;
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
    public type: 'mining' | 'vaulting' | 'holding',
    public myOtherAddresses: string[],
    public vaultId?: number,
  ) {}

  public process(client: ArgonClient, allEvents: FrameSystemEventRecord[]) {
    let iAmMiner = false;
    if (this.type === 'mining') {
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

    const groupedEvents = this.groupEventsByExtrinsic(allEvents);

    for (const { events, extrinsicIndex } of groupedEvents) {
      let isMine = false;
      let transfer: IBalanceTransfer | undefined;
      for (const event of events) {
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
        if (client.events.tokenGateway.AssetReceived.is(event) && extrinsicIndex !== undefined) {
          const { beneficiary, amount } = event.data;
          if (this.isAccountIdMe(beneficiary)) {
            transfer = {
              to: beneficiary.toHuman(),
              transferType: 'tokenGateway',
              isInbound: true,
              amount: amount.toBigInt(),
              isInternal: false,
              isOwnership: events.some(x => x.section === 'ownership'),
              extrinsicIndex,
            };
          }
        }
        if (client.events.tokenGateway.AssetTeleported.is(event) && extrinsicIndex !== undefined) {
          const { from, to, amount } = event.data;
          if (this.isAccountIdMe(from)) {
            transfer = {
              to: to.toHex(),
              from: from.toHuman(),
              transferType: 'tokenGateway',
              isInbound: false,
              amount: amount.toBigInt(),
              isInternal: false,
              isOwnership: events.some(x => x.section === 'ownership'),
              extrinsicIndex,
            };
          }
        }
        // Watch for testnet drips (which occur via balance set)
        else if (client.events.balances.BalanceSet.is(event) && extrinsicIndex !== undefined) {
          const { who, free } = event.data;
          if (this.isAccountIdMe(who)) {
            transfer = {
              to: who.toHuman(),
              transferType: 'faucet',
              isInbound: true,
              amount: free.toBigInt(),
              isInternal: false,
              isOwnership: false,
              extrinsicIndex,
            };
          }
        } else if (client.events.ownership.BalanceSet.is(event) && extrinsicIndex !== undefined) {
          const { who, free } = event.data;
          if (this.isAccountIdMe(who)) {
            transfer = {
              to: who.toHuman(),
              transferType: 'faucet',
              isInbound: true,
              amount: free.toBigInt(),
              isInternal: false,
              isOwnership: true,
              extrinsicIndex,
            };
          }
        }
        // NOTE: a balance transfer can be emitted as part of lots of operations. It's not necessarily a "user transfer". Will check later
        else if (client.events.balances.Transfer.is(event) && extrinsicIndex !== undefined) {
          const { to, from, amount } = event.data;
          if (this.isAccountIdMe(to) || this.isAccountIdMe(from)) {
            const isInbound = this.isAccountIdMe(to);
            transfer = {
              to: to.toHuman(),
              from: from.toHuman(),
              transferType: 'transfer',
              isInbound,
              amount: amount.toBigInt(),
              isInternal: this.myOtherAddresses.includes(from.toHuman()),
              isOwnership: false,
              extrinsicIndex,
            };
          }
        } else if (client.events.ownership.Transfer.is(event) && extrinsicIndex !== undefined) {
          const { to, from, amount } = event.data;
          if (this.isAccountIdMe(to) || this.isAccountIdMe(from)) {
            const isInbound = this.isAccountIdMe(to);
            transfer = {
              to: to.toHuman(),
              from: from.toHuman(),
              transferType: 'transfer',
              amount: amount.toBigInt(),
              isInternal: this.myOtherAddresses.includes(from.toHuman()),
              isInbound,
              isOwnership: true,
              extrinsicIndex,
            };
          }
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
          if (client.events.treasury.BidPoolDistributed.is(event)) {
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
              const burnAmount = events
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

      if (transfer?.transferType === 'transfer' && !this.isBalanceTransferEventset(client, events)) {
        transfer = undefined;
      }
      if (isMine || transfer) {
        const eventGroup: IExtrinsicEvent = [extrinsicIndex ?? null];
        for (const event of events) {
          eventGroup.push(this.toEventInfo(event));
        }
        this.eventsByExtrinsic.push(eventGroup);
      }
      if (transfer) {
        // do we just broadcast this? or store it?
        this.transfers.push(transfer);
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

  private groupEventsByExtrinsic(events: FrameSystemEventRecord[]) {
    const groupedEvents: { events: GenericEvent[]; extrinsicIndex?: number }[] = [];
    const categorizedEvents: Set<GenericEvent> = new Set();
    for (const event of events) {
      if (categorizedEvents.has(event.event)) {
        continue;
      }
      if (event.phase.isApplyExtrinsic) {
        const subEvents = events
          .filter(e2 => e2.phase.isApplyExtrinsic && e2.phase.asApplyExtrinsic.eq(event.phase.asApplyExtrinsic))
          .map(e3 => e3.event);
        groupedEvents.push({ events: subEvents, extrinsicIndex: event.phase.asApplyExtrinsic.toNumber() });
        for (const subEvent of subEvents) {
          categorizedEvents.add(subEvent);
        }
      } else {
        groupedEvents.push({ events: [event.event] });
        categorizedEvents.add(event.event);
      }
    }
    return groupedEvents;
  }

  private isAccountIdMe(accountId: AccountId32): boolean {
    const address = accountId.toHuman();
    return address === this.address;
  }

  private isBalanceTransferEventset(client: ArgonClient, events: GenericEvent[]): boolean {
    const allowedTransferEvents: Record<string, string | string[]> = {
      utility: '*', // allow via batch
      proxy: '*', // allow via proxy
      multisig: '*', // allow via multisig
      system: ['ExtrinsicSuccess', 'NewAccount', 'KilledAccount'],
      // Withdraw/Deposit are for fees
      balances: ['Withdraw', 'Deposit', 'Transfer', 'Endowed'],
      ownership: ['Transfer'],
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
      if (!allowed.includes(x.method)) {
        return false;
      }
      // don't count an internal transfer
      if (client.events.balances.Transfer.is(x) || client.events.ownership.Transfer.is(x)) {
        if (this.myOtherAddresses.includes(x.data.from.toHuman())) {
          return false;
        }
      }
      return true;
    });
  }
}
