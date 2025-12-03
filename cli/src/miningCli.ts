import { Command } from '@commander-js/extra-typings';
import { CohortBidder, MainchainClients, Mining } from '@argonprotocol/apps-core';
import { getClient, type KeyringPair, MICROGONS_PER_ARGON, TxSubmitter } from '@argonprotocol/mainchain';

import { accountsetFromCli, globalOptions, saveKeyringPair } from './index.js';

export default function miningCli() {
  const program = new Command('mining').description('Watch mining seats or setup bidding');

  program
    .command('bid')
    .description('Submit mining bids within a range of parameters')
    .option('--min-bid <amount>', 'The minimum bid amount to use', parseFloat)
    .option('--max-bid <amount>', 'The maximum bid amount to use', parseFloat)
    .option('--max-seats <n>', 'The maximum number of seats to bid on for the slot', parseInt)
    .option(
      '--max-balance <argons>',
      "Use a maximum amount of the user's balance for the slot. If this ends in a percent, it will be a percent of the funds",
    )
    .option('--bid-increment <argons>', 'The bid increment', parseFloat, 0.01)
    .option('--bid-delay <ticks>', 'Delay between bids in ticks', parseInt, 0)
    .option('--run-continuous', 'Keep running and rebid every day')
    .option(
      '--proxy-for-address <address>',
      'The seed account to proxy for (eg: 5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty)',
    )
    .action(
      async ({ maxSeats, runContinuous, maxBid, minBid, maxBalance, bidDelay, bidIncrement, proxyForAddress }) => {
        const accountset = await accountsetFromCli(program, proxyForAddress);

        const miningBids = new Mining(new MainchainClients('', () => true, accountset.client));
        const biddersByFrames: { [frameId: number]: CohortBidder } = {};

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
            const balance = await accountset.balance();
            const feeWiggleRoom = BigInt(25e3);
            const amountAvailable = balance - feeWiggleRoom;
            let maxBidAmount = maxBid ? BigInt(maxBid * MICROGONS_PER_ARGON) : undefined;
            let maxBalanceToUse = amountAvailable;
            if (maxBalance !== undefined) {
              if (maxBalance.endsWith('%')) {
                const maxBalancePercent = parseInt(maxBalance);
                let amountToBid = (amountAvailable * BigInt(maxBalancePercent)) / 100n;
                if (amountToBid > balance) {
                  amountToBid = balance;
                }
                maxBalanceToUse = amountToBid;
              } else {
                maxBalanceToUse = BigInt(Math.floor(parseFloat(maxBalance) * MICROGONS_PER_ARGON));
              }

              maxBidAmount ??= maxBalanceToUse / BigInt(seatsToWin);
            }
            if (maxBalanceToUse > amountAvailable) {
              maxBalanceToUse = amountAvailable;
            }
            if (!maxBidAmount) {
              console.error('No max bid amount set');
              process.exit(1);
            }
            const subaccountRange = await accountset.getAvailableMinerAccounts(seatsToWin);

            await stopBidder(cohortStartingFrameId - 1, unsubscribe);
            const cohortBidder = new CohortBidder(accountset, cohortStartingFrameId, subaccountRange, {
              maxBid: maxBidAmount,
              minBid: BigInt((minBid ?? 0) * MICROGONS_PER_ARGON),
              bidIncrement: BigInt(Math.floor(bidIncrement * MICROGONS_PER_ARGON)),
              sidelinedWalletMicrogons: amountAvailable - maxBalanceToUse,
              bidDelay,
            });
            biddersByFrames[cohortStartingFrameId] = cohortBidder;
            await cohortBidder.start();
          },
        });
      },
    );

  program
    .command('create-bid-proxy')
    .description('Create a mining-bid proxy account for your main account')
    .requiredOption('--outfile <path>', 'The file to use to store the proxy account json (eg: proxy.json)')
    .requiredOption(
      '--fee-argons <argons>',
      'How many argons should be sent to the proxy account for fees (proxies must pay fees)',
      parseFloat,
    )
    .option('--proxy-passphrase <passphrase>', 'The passphrase for your proxy account')
    .action(async ({ outfile, proxyPassphrase, feeArgons }) => {
      const { mainchainUrl } = globalOptions(program);
      const client = await getClient(mainchainUrl);

      const keyringPair = await saveKeyringPair({
        filePath: outfile,
        passphrase: proxyPassphrase,
      });
      const address = keyringPair.address;
      console.log(`✅ Created proxy account at "${outfile}" with address ${address}`);
      const tx = client.tx.utility.batchAll([
        client.tx.proxy.addProxy(address, 'MiningBid', 0),
        client.tx.balances.transferAllowDeath(address, BigInt(feeArgons * MICROGONS_PER_ARGON)),
      ]);
      let keypair: KeyringPair;
      try {
        const accountset = await accountsetFromCli(program);
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
