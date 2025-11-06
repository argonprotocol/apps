import {
  type ArgonClient,
  dispatchErrorToExtrinsicError,
  type ExtrinsicError,
  type FrameSystemEventRecord,
  type GenericEvent,
  type SpRuntimeDispatchError,
} from '@argonprotocol/mainchain';

type IsMatchingEventFn = (
  event: GenericEvent,
  registryError?: { section: string; method: string; index: number; name: string },
) => boolean;

export class TransactionEvents {
  public static async getErrorAndFeeForTransaction(args: {
    client: ArgonClient;
    extrinsicIndex: number;
    events: FrameSystemEventRecord[];
  }): Promise<{ tip: bigint; fee: bigint; error?: ExtrinsicError; extrinsicEvents: GenericEvent[] }> {
    const { client, events, extrinsicIndex } = args;

    const applyExtrinsicEvents = events
      .filter(x => x.phase.isApplyExtrinsic && x.phase.asApplyExtrinsic.toNumber() === extrinsicIndex)
      .map(x => x.event);
    let fee = 0n;
    let tip = 0n;
    let extrinsicError: ExtrinsicError | undefined;

    for (const event of applyExtrinsicEvents) {
      if (client.events.transactionPayment.TransactionFeePaid.is(event)) {
        const { actualFee, tip: t } = event.data;
        fee = actualFee.toBigInt();
        tip = t.toBigInt();
      } else if (client.events.utility.BatchInterrupted.is(event)) {
        const { error, index } = event.data;
        extrinsicError = dispatchErrorToExtrinsicError(client, error as any, index.toNumber());
      } else if (client.events.system.ExtrinsicFailed.is(event)) {
        const { dispatchError } = event.data;
        extrinsicError = dispatchErrorToExtrinsicError(client, dispatchError as any);
      }
    }

    return {
      fee: fee,
      tip: tip,
      error: extrinsicError,
      extrinsicEvents: applyExtrinsicEvents,
    };
  }

  public static async findFromFeePaidEvent(args: {
    client: ArgonClient;
    blockHash: Uint8Array;
    accountAddress: string;
    isMatchingEvent: IsMatchingEventFn;
  }): Promise<{ tip: bigint; fee: bigint; error?: ExtrinsicError; extrinsicEvents: GenericEvent[] } | undefined> {
    const { client, blockHash, accountAddress, isMatchingEvent } = args;
    const api = await client.at(blockHash);

    const events = await api.query.system.events();
    const applyExtrinsicEvents = events.filter(x => x.phase.isApplyExtrinsic);
    for (const { event, phase } of applyExtrinsicEvents) {
      if (!client.events.transactionPayment.TransactionFeePaid.is(event)) {
        continue;
      }
      const { who, actualFee, tip } = event.data;
      if (who.toHuman() !== accountAddress) {
        continue;
      }
      // now we're filtered to only fees paid by this account
      const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
      for (const extrinsicEvent of applyExtrinsicEvents) {
        // .. match only on the events for this extrinsic
        if (extrinsicEvent.phase.asApplyExtrinsic.toNumber() !== extrinsicIndex) continue;

        let dispatchError: SpRuntimeDispatchError | undefined;
        let batchInterruptedIndex: number | undefined;
        if (client.events.utility.BatchInterrupted.is(extrinsicEvent.event)) {
          const { error, index } = extrinsicEvent.event.data;
          dispatchError = error;
          batchInterruptedIndex = index.toNumber();
        }
        if (client.events.system.ExtrinsicFailed.is(extrinsicEvent.event)) {
          ({ dispatchError } = extrinsicEvent.event.data);
        }

        const registryError = dispatchError?.isModule
          ? client.registry.findMetaError(dispatchError.asModule)
          : undefined;
        if (isMatchingEvent(extrinsicEvent.event, registryError)) {
          const extrinsicError = dispatchError
            ? dispatchErrorToExtrinsicError(client, dispatchError as any, batchInterruptedIndex)
            : undefined;
          return {
            fee: actualFee.toBigInt(),
            tip: tip.toBigInt(),
            error: extrinsicError,
            extrinsicEvents: applyExtrinsicEvents
              .filter(x => x.phase.asApplyExtrinsic.toNumber() === extrinsicIndex)
              .map(event => event.event),
          };
        }
      }
    }
    return undefined;
  }
}
