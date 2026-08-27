import { type FrameSystemEventRecord, type GenericEvent } from '@argonprotocol/mainchain';
import type { RuntimeSystemEventRecord } from './BlockWatch.js';
import type { HistoricalEvent } from '@argonprotocol/runtime-client/events';

export type IEventInfo = {
  pallet: string;
  method: string;
  data: unknown;
};

export type IBalanceTransfer = {
  to: string;
  from?: string;
  transferType: 'transfer' | 'faucet' | 'tokenGateway' | 'ethereum';
  currency: 'argon' | 'argonot';
  isInternal: boolean;
  isInbound: boolean;
  amount: bigint;
  extrinsicIndex: number;
  tokenGatewayCommitmentHash?: string;
};

export type IExtrinsicEvent = [extrinsicIndex: number | null, ...events: IEventInfo[]];

export class AccountEventsFilter {
  public eventsByExtrinsic: IExtrinsicEvent[] = [];
  public transfers: IBalanceTransfer[] = [];

  constructor(
    private readonly address: string,
    private readonly ownedAddresses: readonly string[],
  ) {}

  public process(allEvents: readonly RuntimeSystemEventRecord[]): void {
    for (const { extrinsicEvents, extrinsicIndex } of groupEventsByExtrinsic(allEvents)) {
      let isMine = false;
      const groupTransfers: IBalanceTransfer[] = [];

      for (let eventIndex = 0; eventIndex < extrinsicEvents.length; eventIndex += 1) {
        const event = extrinsicEvents[eventIndex];
        if (event.section === 'transactionPayment' && event.method === 'TransactionFeePaid') {
          if (this.isAccountIdMe(event.data.who)) isMine = true;
        }

        const transfer = this.readTransfer(event, eventIndex, extrinsicEvents, extrinsicIndex);
        if (!transfer) continue;

        const existing =
          transfer.transferType === 'transfer'
            ? groupTransfers.find(candidate => {
                return (
                  candidate.transferType === transfer.transferType &&
                  candidate.from === transfer.from &&
                  candidate.to === transfer.to &&
                  candidate.currency === transfer.currency &&
                  candidate.amount === transfer.amount &&
                  candidate.isInbound === transfer.isInbound &&
                  candidate.isInternal === transfer.isInternal
                );
              })
            : undefined;
        if (existing) existing.amount += transfer.amount;
        else groupTransfers.push(transfer);
        isMine = true;
      }

      this.transfers.push(...groupTransfers);
      if (!isMine) continue;

      this.eventsByExtrinsic.push([
        extrinsicIndex ?? null,
        ...extrinsicEvents.map(event => ({
          pallet: event.section,
          method: event.method,
          data: event.data,
        })),
      ]);
    }
  }

  private readTransfer(
    event: HistoricalEvent,
    eventIndex: number,
    extrinsicEvents: readonly HistoricalEvent[],
    extrinsicIndex?: number,
  ): IBalanceTransfer | undefined {
    if (extrinsicIndex === undefined) return;

    if (event.section === 'balances' && event.method === 'BalanceSet') {
      const { who, free } = event.data;
      if (!this.isAccountIdMe(who)) return;
      return this.createInboundTransfer(who, free, 'faucet', 'argon', extrinsicIndex);
    }
    if (event.section === 'ownership' && event.method === 'BalanceSet') {
      const { who, free } = event.data;
      if (!this.isAccountIdMe(who)) return;
      return this.createInboundTransfer(who, free, 'faucet', 'argonot', extrinsicIndex);
    }
    if (event.section === 'crosschainTransfer' && event.method === 'TransferToArgonSettled') {
      const { transfer } = event.data;
      if (!this.isAccountIdMe(transfer.to)) return;
      return this.createInboundTransfer(
        transfer.to,
        transfer.amount,
        'ethereum',
        transfer.asset.type === 'Argon' ? 'argon' : 'argonot',
        extrinsicIndex,
      );
    }
    if (event.section === 'crosschainTransfer' && event.method === 'TransferOutStarted') {
      const { accountId, amount, asset, destinationChain, transferId } = event.data;
      if (!this.isAccountIdMe(accountId)) return;

      return {
        to: destinationChain.type,
        from: accountId,
        transferType: 'ethereum',
        amount,
        isInternal: false,
        isInbound: false,
        currency: asset.type === 'Argon' ? 'argon' : 'argonot',
        extrinsicIndex,
        tokenGatewayCommitmentHash: transferId,
      };
    }

    if (event.section === 'tokenGateway' && (event.method === 'AssetReceived' || event.method === 'AssetRefunded')) {
      const { beneficiary, amount } = event.data;
      if (beneficiary !== this.address) return;

      const next = extrinsicEvents[eventIndex + 1];
      const commitment =
        next?.section === 'ismp' && next.method === 'PostRequestHandled' ? next.data[0].commitment : undefined;
      return {
        ...this.createInboundTransfer(
          beneficiary,
          amount,
          'tokenGateway',
          extrinsicEvents[eventIndex - 1]?.section === 'ownership' ? 'argonot' : 'argon',
          extrinsicIndex,
        ),
        tokenGatewayCommitmentHash: commitment,
      };
    }

    if (event.section === 'tokenGateway' && event.method === 'AssetTeleported') {
      const { from, to, amount, commitment } = event.data;
      if (from !== this.address) return;

      const hasArgonotBurn = extrinsicEvents.some(candidate => {
        if (candidate.section !== 'ownership' || candidate.method !== 'Burned') return false;
        return candidate.data.who === from && candidate.data.amount === amount;
      });
      return {
        to,
        from,
        transferType: 'tokenGateway',
        amount,
        isInternal: false,
        isInbound: false,
        currency: hasArgonotBurn ? 'argonot' : 'argon',
        extrinsicIndex,
        tokenGatewayCommitmentHash: commitment,
      };
    }

    if (!isUserTransferEventSet(extrinsicEvents, eventIndex)) return;
    if (event.section === 'balances' && event.method === 'Transfer') {
      const { from, to, amount } = event.data;
      return this.createTransfer(from, to, amount, 'argon', extrinsicIndex);
    }
    if (event.section === 'ownership' && event.method === 'Transfer') {
      const { from, to, amount } = event.data;
      return this.createTransfer(from, to, amount, 'argonot', extrinsicIndex);
    }
  }

  private createTransfer(
    from: string,
    to: string,
    amount: bigint,
    currency: IBalanceTransfer['currency'],
    extrinsicIndex: number,
  ): IBalanceTransfer | undefined {
    if (!this.isAccountIdMe(from) && !this.isAccountIdMe(to)) return;

    return {
      to,
      from,
      transferType: 'transfer',
      isInbound: to === this.address,
      amount,
      isInternal: this.ownedAddresses.includes(from) && this.ownedAddresses.includes(to),
      currency,
      extrinsicIndex,
    };
  }

  private createInboundTransfer(
    to: string,
    amount: bigint,
    transferType: IBalanceTransfer['transferType'],
    currency: IBalanceTransfer['currency'],
    extrinsicIndex: number,
  ): IBalanceTransfer {
    return {
      to,
      transferType,
      isInbound: true,
      amount,
      isInternal: false,
      currency,
      extrinsicIndex,
    };
  }

  private isAccountIdMe(accountId: string): boolean {
    return accountId === this.address;
  }
}

export function groupEventsByExtrinsic(
  events: readonly RuntimeSystemEventRecord[],
): { extrinsicEvents: HistoricalEvent[]; extrinsicIndex?: number }[];
export function groupEventsByExtrinsic(
  events: readonly FrameSystemEventRecord[],
): { extrinsicEvents: GenericEvent[]; extrinsicIndex?: number }[];
export function groupEventsByExtrinsic(events: readonly (RuntimeSystemEventRecord | FrameSystemEventRecord)[]) {
  const groups: { extrinsicEvents: (HistoricalEvent | GenericEvent)[]; extrinsicIndex?: number }[] = [];
  const groupsByExtrinsic = new Map<number, (HistoricalEvent | GenericEvent)[]>();

  for (const { event, phase } of events) {
    let extrinsicIndex: number | undefined;
    if ('isApplyExtrinsic' in phase) {
      if (phase.isApplyExtrinsic) extrinsicIndex = phase.asApplyExtrinsic.toNumber();
    } else if (phase.type === 'ApplyExtrinsic') {
      extrinsicIndex = phase.value;
    }

    if (extrinsicIndex === undefined) {
      groups.push({ extrinsicEvents: [event] });
      continue;
    }

    const existing = groupsByExtrinsic.get(extrinsicIndex);
    if (existing) existing.push(event);
    else {
      const extrinsicEvents = [event];
      groupsByExtrinsic.set(extrinsicIndex, extrinsicEvents);
      groups.push({ extrinsicEvents, extrinsicIndex });
    }
  }
  return groups;
}

export function isUserTransferEventSet(
  events: readonly { section: string; method: string }[],
  transferEventIndex?: number,
): boolean {
  let relevantEvents = events;
  if (transferEventIndex !== undefined && events.some(event => event.section === 'utility')) {
    let priorBoundary = -1;
    for (let index = transferEventIndex - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.section === 'utility' && event.method.startsWith('Item')) {
        priorBoundary = index;
        break;
      }
    }
    const nextBoundary = events.findIndex((event, index) => {
      return index > transferEventIndex && event.section === 'utility' && event.method.startsWith('Item');
    });
    relevantEvents = events.slice(priorBoundary + 1, nextBoundary < 0 ? events.length : nextBoundary + 1);
  }

  return relevantEvents.every(event => {
    const allowed = allowedTransferEvents[event.section];
    return allowed === '*' || allowed?.includes(event.method) === true;
  });
}

const allowedTransferEvents: Readonly<Record<string, '*' | readonly string[]>> = {
  utility: '*',
  proxy: '*',
  multisig: '*',
  system: ['ExtrinsicSuccess', 'NewAccount', 'KilledAccount'],
  balances: ['Withdraw', 'Deposit', 'Transfer', 'Endowed'],
  ownership: ['Transfer', 'Endowed', 'Deposit', 'Withdraw'],
  transactionPayment: '*',
};
