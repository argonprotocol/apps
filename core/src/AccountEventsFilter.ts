import { type AccountId32, type FrameSystemEventRecord, type GenericEvent, Struct } from '@argonprotocol/mainchain';
import type { ArgonQueryClient } from './MainchainClients.js';

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

  public process(client: ArgonQueryClient, allEvents: readonly FrameSystemEventRecord[]): void {
    for (const { extrinsicEvents, extrinsicIndex } of groupEventsByExtrinsic(allEvents)) {
      let isMine = false;
      const groupTransfers: IBalanceTransfer[] = [];

      for (let eventIndex = 0; eventIndex < extrinsicEvents.length; eventIndex += 1) {
        const event = extrinsicEvents[eventIndex];
        if (client.events.transactionPayment.TransactionFeePaid.is(event)) {
          const [who] = event.data;
          if (this.isAccountIdMe(who)) isMine = true;
        }

        const transfer = this.readTransfer(client, event, eventIndex, extrinsicEvents, extrinsicIndex);
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
          data: event.data.toHuman(),
        })),
      ]);
    }
  }

  private readTransfer(
    client: ArgonQueryClient,
    event: GenericEvent,
    eventIndex: number,
    extrinsicEvents: readonly GenericEvent[],
    extrinsicIndex?: number,
  ): IBalanceTransfer | undefined {
    if (extrinsicIndex === undefined) return;

    if (client.events.balances.BalanceSet.is(event)) {
      const [who, free] = event.data;
      if (!this.isAccountIdMe(who)) return;
      return this.createInboundTransfer(who, free.toBigInt(), 'faucet', 'argon', extrinsicIndex);
    }
    if (client.events.ownership.BalanceSet.is(event)) {
      const [who, free] = event.data;
      if (!this.isAccountIdMe(who)) return;
      return this.createInboundTransfer(who, free.toBigInt(), 'faucet', 'argonot', extrinsicIndex);
    }
    if (
      event.section === 'crosschainTransfer' &&
      event.method === 'TransferToArgonSettled' &&
      client.events.crosschainTransfer.TransferToArgonSettled.is(event)
    ) {
      const [, transfer] = event.data;
      if (!this.isAccountIdMe(transfer.to)) return;
      return this.createInboundTransfer(
        transfer.to,
        transfer.amount.toBigInt(),
        'ethereum',
        transfer.asset.isArgon ? 'argon' : 'argonot',
        extrinsicIndex,
      );
    }
    if (
      event.section === 'crosschainTransfer' &&
      event.method === 'TransferOutStarted' &&
      client.events.crosschainTransfer.TransferOutStarted.is(event)
    ) {
      const { accountId, amount, asset, destinationChain, transferId } = event.data;
      if (!this.isAccountIdMe(accountId)) return;

      return {
        to: destinationChain.toString(),
        from: accountId.toString(),
        transferType: 'ethereum',
        amount: amount.toBigInt(),
        isInternal: false,
        isInbound: false,
        currency: asset.isArgon ? 'argon' : 'argonot',
        extrinsicIndex,
        tokenGatewayCommitmentHash: transferId.toHex(),
      };
    }

    // Specs 100-150 used tokenGateway before crosschainTransfer. The block's
    // typed API no longer exposes those guards, so use its codec field names.
    if (event.section === 'tokenGateway' && ['AssetReceived', 'AssetRefunded'].includes(event.method)) {
      const beneficiary = readEventField(event, 'beneficiary');
      const amount = readEventField(event, 'amount');
      if (!beneficiary || !amount || beneficiary.toString() !== this.address) return;

      const next = extrinsicEvents[eventIndex + 1];
      const request = next?.section === 'ismp' && next.method === 'PostRequestHandled' ? next.data[0] : undefined;
      const commitment = request instanceof Struct ? request.get('commitment')?.toString() : undefined;
      return {
        ...this.createInboundTransfer(
          beneficiary,
          BigInt(amount.toString()),
          'tokenGateway',
          extrinsicEvents[eventIndex - 1]?.section === 'ownership' ? 'argonot' : 'argon',
          extrinsicIndex,
        ),
        tokenGatewayCommitmentHash: commitment,
      };
    }

    if (event.section === 'tokenGateway' && event.method === 'AssetTeleported') {
      const from = readEventField(event, 'from');
      const to = readEventField(event, 'to');
      const amount = readEventField(event, 'amount');
      const commitment = readEventField(event, 'commitment');
      if (!from || !to || !amount || !commitment || from.toString() !== this.address) return;

      const hasArgonotBurn = extrinsicEvents.some(candidate => {
        if (candidate.section !== 'ownership' || candidate.method !== 'Burned') return false;
        return (
          readEventField(candidate, 'who')?.toString() === from.toString() &&
          readEventField(candidate, 'amount')?.toString() === amount.toString()
        );
      });
      return {
        to: to.toString(),
        from: from.toString(),
        transferType: 'tokenGateway',
        amount: BigInt(amount.toString()),
        isInternal: false,
        isInbound: false,
        currency: hasArgonotBurn ? 'argonot' : 'argon',
        extrinsicIndex,
        tokenGatewayCommitmentHash: commitment.toString(),
      };
    }

    if (!isUserTransferEventSet(extrinsicEvents, eventIndex)) return;
    if (client.events.balances.Transfer.is(event)) {
      const [from, to, amount] = event.data;
      return this.createTransfer(from, to, amount.toBigInt(), 'argon', extrinsicIndex);
    }
    if (client.events.ownership.Transfer.is(event)) {
      const [from, to, amount] = event.data;
      return this.createTransfer(from, to, amount.toBigInt(), 'argonot', extrinsicIndex);
    }
  }

  private createTransfer(
    from: AccountId32,
    to: AccountId32,
    amount: bigint,
    currency: IBalanceTransfer['currency'],
    extrinsicIndex: number,
  ): IBalanceTransfer | undefined {
    if (!this.isAccountIdMe(from) && !this.isAccountIdMe(to)) return;

    const fromAddress = from.toHuman();
    const toAddress = to.toHuman();
    return {
      to: toAddress,
      from: fromAddress,
      transferType: 'transfer',
      isInbound: toAddress === this.address,
      amount,
      isInternal: this.ownedAddresses.includes(fromAddress) && this.ownedAddresses.includes(toAddress),
      currency,
      extrinsicIndex,
    };
  }

  private createInboundTransfer(
    to: { toString(): string },
    amount: bigint,
    transferType: IBalanceTransfer['transferType'],
    currency: IBalanceTransfer['currency'],
    extrinsicIndex: number,
  ): IBalanceTransfer {
    return {
      to: to.toString(),
      transferType,
      isInbound: true,
      amount,
      isInternal: false,
      currency,
      extrinsicIndex,
    };
  }

  private isAccountIdMe(accountId: AccountId32): boolean {
    return accountId.toString() === this.address;
  }
}

export function groupEventsByExtrinsic(events: readonly FrameSystemEventRecord[]) {
  const groups: { extrinsicEvents: GenericEvent[]; extrinsicIndex?: number }[] = [];
  const groupsByExtrinsic = new Map<number, GenericEvent[]>();

  for (const { event, phase } of events) {
    if (!phase.isApplyExtrinsic) {
      groups.push({ extrinsicEvents: [event] });
      continue;
    }

    const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
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
  events: readonly Pick<GenericEvent, 'section' | 'method'>[],
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

export function readEventField(event: Pick<GenericEvent, 'data'>, field: string) {
  const index = (event.data.names ?? []).indexOf(field);
  return index < 0 ? undefined : event.data[index];
}
