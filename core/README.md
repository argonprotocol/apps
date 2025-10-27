## Argon Investor Console Core

The library has a few classes that are used to interact with the Argon Protocol.

`clis` - this is a collection of cli commands and helpers. Included here are two helpers to read and
store encrypted wallets from Polkadot.js or a wallet like [Talisman](https://talisman.xyz/).

`Accountset.ts` - manage subaccounts from a single keypair

```typescript
import { Accountset, getClient, type KeyringPair, mnemonicGenerate } from '@argonprotocol/mainchain';
import { keyringFromFile } from '@argonprotocol/mainchain/clis';
import { existsSync, promises as fs } from 'node:fs';

const mnemonicFile = './sessionKeyMnemonic.key';
// generate keys that are used to sign blocks.
if (!existsSync(mnemonicFile)) {
  const sessionKeyMnemonic = mnemonicGenerate();
  await fs.writeFile(sessionKeyMnemonic, 'utf8');
}
const sessionKeyMnemonic = await fs.readFile(mnemonicFile, 'utf8');
const seedAccount = await keyringFromFile({
  filePath: '<path to file>',
  passphrase: 'my password',
});
const mainchainUrl = 'wss://rpc.argon.network';
const client = getClient(mainchainUrl);
this.accountset = new Accountset({
  client,
  seedAccount,
  sessionKeyMnemonic,
  subaccountRange: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
});

// register your keys on your miner
await this.accountset.registerKeys(localRpcUrl);
```

`BidPool.ts` - monitor mining bid pools

`CohortBidder.ts` - create a bidding bot

```typescript
import { CohortBidder } from '@argonprotocol/mainchain';

// on new bidding
const subaccounts = await accountset.getAvailableMinerAccounts(5);
const cohortBidder = new CohortBidder(accountset, cohortFrameId, subaccounts, {
  maxSeats: 5,
  // a budget not to exceed
  maxBudget: 100_000_000,
  // only spend max 1 argon per seat
  maxBid: 1_000_000,
  // start bidding at 0.5 argons
  minBid: 500_000,
  // increment by 0.01 argons each bid
  bidIncrement: 10_000,
  // wait 10 minutes between bids
  bidDelay: 10,
});
```

`MiningBids.ts` - subscribe to the next bidding cohorts

```typescript
import { MiningBids } from '@argonprotocol/mainchain';

const miningBids = new MiningBids(client);
const { unsubscribe } = await miningBids.onCohortChange({
  async onBiddingStart(cohortFrameId) {
    // ...
  },
  async onBiddingEnd(cohortFrameId) {
    // ...
  },
});
```

`VaultMonitor.ts` - watch vaults for available funds/opportunities and calculate fees
