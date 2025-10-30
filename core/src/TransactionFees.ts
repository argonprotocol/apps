import {
  type ArgonClient,
  dispatchErrorToExtrinsicError,
  type ExtrinsicError,
  type FrameSystemEventRecord,
  type SpRuntimeDispatchError,
  type GenericEvent,
} from '@argonprotocol/mainchain';

type IsMatchingEventFn = (
  event: GenericEvent,
  registryError?: { section: string; method: string; index: number; name: string },
) => boolean;
export class TransactionFees {
  public static async findFromEvents(args: {
    client: ArgonClient;
    blockHash: Uint8Array;
    accountAddress: string;
    isMatchingEvent: IsMatchingEventFn;
    onlyMatchExtrinsicIndex?: number;
    events?: FrameSystemEventRecord[];
  }): Promise<{ tip: bigint; fee: bigint; error?: ExtrinsicError; extrinsicEvents: GenericEvent[] } | undefined> {
    const { client, blockHash, accountAddress, isMatchingEvent, onlyMatchExtrinsicIndex } = args;
    let events = args.events;
    if (!events) {
      const api = await client.at(blockHash);

      events = await api.query.system.events();
    }
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
        if (onlyMatchExtrinsicIndex !== undefined && extrinsicIndex !== onlyMatchExtrinsicIndex) continue;

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
