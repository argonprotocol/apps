import { parseArgs } from 'node:util';
import BigNumber from 'bignumber.js';
import { keyringFromSuri, MICROGONS_PER_ARGON, waitForLoad } from '@argonprotocol/mainchain';
import { Accountset, getRange, miniSecretFromUri } from '../../../core/src/Accountset.js';
import { CohortBidder } from '../../../core/src/CohortBidder.js';
import type { CohortBidderBase } from '../../../core/src/CohortBidderBase.js';
import { createDeferred } from '../../../core/src/Deferred.js';
import { MainchainClients } from '../../../core/src/MainchainClients.js';
import { Mining } from '../../../core/src/Mining.js';
import { MiningFrames } from '../../../core/src/MiningFrames.js';
import { NetworkConfig } from '../../../core/src/NetworkConfig.js';
import { TxSigner } from '../../../core/src/TxSigner.js';

try {
  await main();
} catch (error) {
  console.error('dev-miner failed:', error);
  process.exit(1);
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      'node-url': { type: 'string' },
      'account-suri': { type: 'string' },
      subaccounts: { type: 'string', default: '100' },
      'max-bid': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(`Development mining only:
  dev-miner --node-url <url> --account-suri <suri> --max-bid <argons>

Accepts --subaccounts <count> (default: 100).
Registers keys on the supplied node, then bids continuously.`);
    return;
  }

  const nodeUrl = values['node-url'];
  const accountSuri = values['account-suri'];
  if (!nodeUrl) throw new Error('--node-url is required');
  if (!accountSuri) throw new Error('--account-suri is required');

  const subaccountCount = Number(values.subaccounts);
  if (!Number.isInteger(subaccountCount) || subaccountCount < 1 || subaccountCount > 65_536) {
    throw new Error('--subaccounts must be a count between 1 and 65536');
  }
  const maxBid = new BigNumber(values['max-bid'] ?? '0').times(MICROGONS_PER_ARGON);
  if (!maxBid.isInteger() || !maxBid.isGreaterThan(0)) {
    throw new Error('--max-bid must be a positive amount in argons with at most 6 decimal places');
  }

  await waitForLoad();
  const clients = new MainchainClients(nodeUrl, () => false);
  let miningFrames: MiningFrames | undefined;
  try {
    const client = await clients.archiveClientPromise;
    const accountset = new Accountset({
      client,
      txSubmitter: new TxSigner(keyringFromSuri(accountSuri)),
      subaccountRange: getRange(0, subaccountCount),
      sessionMiniSecretOrMnemonic: miniSecretFromUri(`${accountSuri}//session`),
    });
    await accountset.registerKeys(nodeUrl);
    console.log('Development miner keys registered');

    NetworkConfig.setNetwork('dev-docker');
    await NetworkConfig.updateConfig(client);
    miningFrames = new MiningFrames(clients);
    await miningFrames.load();
    await bidContinuously(accountset, miningFrames, BigInt(maxBid.toFixed(0)), new Mining(clients));
  } finally {
    await miningFrames?.stop();
    await clients.disconnect();
  }
}

async function bidContinuously(accountset: Accountset, miningFrames: MiningFrames, maxBid: bigint, mining: Mining) {
  const stopped = createDeferred<void>(false);
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
    stopped.resolve();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const bidders = new Map<number, Promise<CohortBidderBase>>();
  let unsubscribe: (() => void) | undefined;
  try {
    ({ unsubscribe } = await mining.onCohortChange({
      onBiddingStart(frameId) {
        if (shutdown.signal.aborted || bidders.has(frameId)) return Promise.resolve();

        const pending = mining.fetchNextCohortSize().then(async seats => {
          const subaccounts = await accountset.getAvailableMinerAccounts(seats);
          const bidder = await CohortBidder.create(accountset, miningFrames, frameId, subaccounts, {
            minBid: 0n,
            maxBid,
            bidIncrement: 10_000n,
            bidDelay: 0,
          });
          if (!shutdown.signal.aborted) await bidder.start();
          return bidder;
        });
        bidders.set(frameId, pending);
        return pending.then(() => undefined).catch(error => stopped.reject(error));
      },
      async onBiddingEnd(frameId) {
        try {
          const bidder = await bidders.get(frameId);
          if (!bidder) return;

          // Finalizing this cohort must not delay bidding in the next one.
          const result = await bidder.stop(true, shutdown.signal);
          bidders.delete(frameId);
          console.log('Final bidding result', { frameId, bids: result });
        } catch (error) {
          stopped.reject(error);
        }
      },
    }));
    await stopped.promise;
  } finally {
    shutdown.abort();
    unsubscribe?.();
    await Promise.allSettled(
      [...bidders.values()].map(async pending => {
        const bidder = await pending;
        await bidder.stop(false);
      }),
    );
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
