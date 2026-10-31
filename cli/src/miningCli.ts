import { Command } from '@commander-js/extra-typings';
import {
  CohortBidder,
  type CohortBidderBase,
  createArgonClient,
  MainchainClients,
  Mining,
  MiningFrames,
  TxSubmitter,
} from '@argonprotocol/apps-core';
import { getClient, type KeyringPair, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';

import { accountsetFromCli, globalOptions, saveKeyringPair } from './index.js';

export default function miningCli() {
  const program = new Command('mining').description('Watch mining seats or setup bidding');

  program
    .command('bid')
    .description('Submit mining bids within a range of parameters')
    .option('--min-bid <amount>', 'The minimum bid amount to use', parseFloat)
    .option('--max-bid <amount>', 'The maximum bid amount to use', parseFloat)
    .option('--max-seats <n>', 'The maximum number of seats to bid on for the slot', parseInt)
    .option('--bid-increment <argons>', 'The bid increment', parseFloat, 0.01)
    .option('--bid-delay <ticks>', 'Delay between bids in ticks', parseInt, 0)
    .option('--run-continuous', 'Keep running and rebid every day')
    .option(
      '--proxy-for-address <address>',
      'The seed account to proxy for (eg: 5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty)',
    )
    .action(async ({ maxSeats, runContinuous, maxBid, minBid, bidDelay, bidIncrement, proxyForAddress }) => {
      const { mainchainUrl } = globalOptions(program);
      const clients = new MainchainClients(mainchainUrl, () => true);
      const accountset = await accountsetFromCli(program, {
        proxyForAddress,
        client: await clients.archiveClientPromise,
      });

      const miningBids = new Mining(clients);
      const biddersByFrames: Record<number, CohortBidderBase> = {};
      const miningFrames = new MiningFrames(clients);
      await miningFrames.load();

      const stopBidder = async (cohortStartingFrameId: number, unsubscribe: () => void) => {
        const cohortBidder = biddersByFrames[cohortStartingFrameId];
        delete biddersByFrames[cohortStartingFrameId];
        if (cohortBidder) {
          const stats = await cohortBidder.stop();
          console.log('Final bidding result', {
            cohortStartingFrameId,
            ...stats,
          });
          if (!runContinuous) {
            unsubscribe();
            process.exit();
          }
        }
      };
      const { unsubscribe } = await miningBids.onCohortChange({
        async onBiddingEnd(cohortStartingFrameId) {
          await stopBidder(cohortStartingFrameId, unsubscribe);
        },
        async onBiddingStart(cohortStartingFrameId) {
          const seatsToWin = maxSeats ?? (await miningBids.fetchNextCohortSize());
          const maxBidAmount = maxBid ? BigInt(maxBid * MICROGONS_PER_ARGON) : undefined;
          if (!maxBidAmount) {
            console.error('No max bid amount set');
            process.exit(1);
          }
          const subaccountRange = await accountset.getAvailableMinerAccounts(seatsToWin);

          await stopBidder(cohortStartingFrameId - 1, unsubscribe);
          const cohortBidder = await CohortBidder.create(
            accountset,
            miningFrames,
            cohortStartingFrameId,
            subaccountRange,
            {
              maxBid: maxBidAmount,
              minBid: BigInt((minBid ?? 0) * MICROGONS_PER_ARGON),
              bidIncrement: BigInt(Math.floor(bidIncrement * MICROGONS_PER_ARGON)),
              bidDelay,
            },
          );
          biddersByFrames[cohortStartingFrameId] = cohortBidder;
          await cohortBidder.start();
        },
      });
    });

  program
    .command('create-bid-proxy')
    .description('Create a mining-bid proxy account for your main account')
    .requiredOption('--outfile <path>', 'The file to use to store the proxy account json (eg: proxy.json)')
    .requiredOption(
      '--fee-argons <argons>',
      'How many argons should be sent to the proxy account during setup',
      parseFloat,
    )
    .option('--proxy-passphrase <passphrase>', 'The passphrase for your proxy account')
    .action(async ({ outfile, proxyPassphrase, feeArgons }) => {
      const { mainchainUrl } = globalOptions(program);
      const client = createArgonClient(await getClient(mainchainUrl));

      const keyringPair = await saveKeyringPair({
        filePath: outfile,
        passphrase: proxyPassphrase,
      });
      const address = keyringPair.address;
      console.log(`✅ Created proxy account at "${outfile}" with address ${address}`);
      const tx = client.tx.utility.batchAll([
        client.tx.proxy.addProxy(address, 'MiningBidRealPaysFee', 0),
        client.tx.balances.transferAllowDeath(address, BigInt(feeArgons * MICROGONS_PER_ARGON)),
      ]);
      let keypair: KeyringPair;
      try {
        const accountset = await accountsetFromCli(program, { client });
        keypair = accountset.txSubmitterPair;
      } catch (e) {
        const polkadotLink = `https://polkadot.js.org/apps/?rpc=${mainchainUrl}#/extrinsics/decode/${tx.toHex()}`;
        console.log(`Complete the registration at this link:`, polkadotLink);
        process.exit(0);
      }
      try {
        const res = await new TxSubmitter(client, tx, keypair).submit();
        await res.waitForInFirstBlock;

        console.log('Mining bid proxy added and funded.');
        process.exit();
      } catch (error) {
        console.error('Error adding mining proxy', error);
        process.exit(1);
      }
    });
  return program;
}
