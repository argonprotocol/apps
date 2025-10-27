import {
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
  type SpRuntimeDispatchError,
} from '@argonprotocol/mainchain';

type IsMatchingEventFn = (
  event: GenericEvent,
  registryError?: { section: string; method: string; index: number; name: string },
) => boolean;
export class TransactionFees {
  static async findFromEvents(args: {
    client: ArgonClient;
    blockHash: Uint8Array;
    accountAddress: string;
    isMatchingEvent: IsMatchingEventFn;
    events?: FrameSystemEventRecord[];
  }): Promise<bigint | undefined> {
    const { client, blockHash, accountAddress, isMatchingEvent } = args;
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
      const [account, fee] = event.data;
      if (account.toHuman() !== accountAddress) {
        continue;
      }
      // now we're filtered to only fees paid by this account
      const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
      for (const extrinsicEvent of applyExtrinsicEvents) {
        // .. match only on the events for this extrinsic
        if (extrinsicEvent.phase.asApplyExtrinsic.toNumber() !== extrinsicIndex) continue;

        let dispatchError: SpRuntimeDispatchError | undefined;
        if (client.events.utility.BatchInterrupted.is(extrinsicEvent.event)) {
          const [_index, error] = extrinsicEvent.event.data;
          dispatchError = error;
        }
        if (client.events.system.ExtrinsicFailed.is(extrinsicEvent.event)) {
          dispatchError = extrinsicEvent.event.data[0];
        }
        const registryError = dispatchError?.isModule
          ? client.registry.findMetaError(dispatchError.asModule)
          : undefined;
        if (isMatchingEvent(extrinsicEvent.event, registryError)) {
          return fee.toBigInt();
        }
      }
    }
    return undefined;
  }
}
