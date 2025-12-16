import { AccountEventsFilter } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';

const client = await getClient('wss://rpc.argon.network');

const blockHash = process.argv[2];
console.log('Analyzing block', blockHash);
const events = await client.query.system.events.at(
  blockHash,
);

const groupedEvents = AccountEventsFilter.groupEventsByExtrinsic(events);
for (const { extrinsicEvents, extrinsicIndex } of groupedEvents) {
  console.log(`Extrinsic #${extrinsicIndex}`);
  for (const event of extrinsicEvents) {
    console.log('Is transfer', AccountEventsFilter.isTransfer({ client, event, extrinsicIndex, extrinsicEvents }));
  }
}

await client.disconnect();
