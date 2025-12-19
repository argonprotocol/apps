import { AccountEventsFilter } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';

const client = await getClient(process.env.MAINCHAIN_URL ??'wss://rpc.argon.network');

const blockHash = process.argv[2];
console.log('Analyzing block', blockHash);
const events = await client.query.system.events.at(blockHash);

const groupedEvents = AccountEventsFilter.groupEventsByExtrinsic(events);
for (const { extrinsicEvents, extrinsicIndex } of groupedEvents) {
  console.log(`Extrinsic #${extrinsicIndex ?? '-'}:`);
  for (const event of extrinsicEvents) {
    const transfer = AccountEventsFilter.isTransfer({ client, event, extrinsicIndex, extrinsicEvents });
    if (transfer) {
      console.log(`Transfer #${extrinsicIndex}`, transfer);
    } else {
      console.log(`... ${event.section}.${event.method}`);
    }
  }
}

await client.disconnect();
