import {
  type AccountId32,
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
} from '@argonprotocol/mainchain';

export type IEventInfo = {
  pallet: string;
  method: string;
  data: any;
};
export type IInboundTransfer = {
  to: string;
  from: string;
  amount: bigint;
  isOwnership: boolean;
  events: IEventInfo[];
};

export type IExtrinsicEvent = [extrinsicIndex: number | null, ...events: IEventInfo[]];
export class AccountEventsFilter {
  public eventsByExtrinsic: IExtrinsicEvent[] = [];
  public inboundTransfers: IInboundTransfer[] = [];

  constructor(
    public readonly address: string,
    public type: 'mining' | 'vaulting' | 'holding',
  ) {}

  public process(client: ArgonClient, events: FrameSystemEventRecord[]) {
    let iAmMiner = false;
    if (this.type === 'mining') {
      for (const { event, phase } of events) {
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

    const groupedEvents = this.groupEventsByExtrinsic(events);

    for (const { events, extrinsicIndex } of groupedEvents) {
      let isMine = false;
      let inboundTransfer: IInboundTransfer | undefined;
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

        if (client.events.balances.Transfer.is(event) && extrinsicIndex !== undefined) {
          const { to, from, amount } = event.data;
          if (this.isAccountIdMe(to)) {
            inboundTransfer = {
              to: to.toHuman(),
              from: from.toHuman(),
              amount: amount.toBigInt(),
              isOwnership: false,
              events: [],
            };
          }
        }
        if (client.events.ownership.Transfer.is(event) && extrinsicIndex !== undefined) {
          const { to, from, amount } = event.data;
          if (this.isAccountIdMe(to)) {
            inboundTransfer = {
              to: to.toHuman(),
              from: from.toHuman(),
              amount: amount.toBigInt(),
              isOwnership: true,
              events: [],
            };
          }
        }
        if (iAmMiner) {
          if (client.events.blockRewards.RewardCreated.is(event)) {
            isMine = true;
          }
        }

        if (client.events.treasury.BidPoolDistributed.is(event) && this.type === 'vaulting') {
          isMine = true;
        }
      }

      if (isMine) {
        const eventGroup: IExtrinsicEvent = [extrinsicIndex ?? null];
        for (const event of events) {
          eventGroup.push(this.toEventInfo(event));
        }
        this.eventsByExtrinsic.push(eventGroup);
      }
      if (inboundTransfer && this.isLikelyTransfer(events)) {
        // do we just broadcast this? or store it?
        this.inboundTransfers.push({
          ...inboundTransfer,
          events: events.map(event => this.toEventInfo(event)),
        });
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

  private isLikelyTransfer(events: GenericEvent[]): boolean {
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
      return allowed.includes(x.method);
    });
  }
}
