import { Command } from '@commander-js/extra-typings';
import { VaultMonitor } from '@argonprotocol/apps-core';
import { BitcoinLocks, formatArgons, hexToU8a, MICROGONS_PER_ARGON, PriceIndex } from '@argonprotocol/mainchain';
import { accountsetFromCli } from './index.js';

export default function bitcoinCli() {
  const program = new Command('bitcoin').description('Wait for bitcoin space');

  program
    .command('watch')
    .requiredOption('-a, --argons <argons>', 'Alert when bitcoin space exceeds this amount', parseFloat)
    .description('Watch for bitcoin space available')
    .action(async ({ argons }) => {
      const accountset = await accountsetFromCli(program);
      const bot = new VaultMonitor(accountset, {
        bitcoinSpaceAvailable: argons ? BigInt(argons * MICROGONS_PER_ARGON) : 1n,
      });
      bot.events.on('bitcoin-space-above', async (vaultId, amount) => {
        const vault = bot.vaultsById[vaultId];
        const fee = vault.calculateBitcoinFee(amount);
        const ratio = (100n * fee) / amount;
        console.log(
          `Vault ${vaultId} has ${formatArgons(amount)} argons available for bitcoin. Fee ratio is ${ratio}%`,
        );
      });
      await bot.monitor();
    });

  program
    .command('wait-for-space')
    .description('Lock bitcoin when available at a given rate')
    .requiredOption(
      '-a, --argons <amount>',
      'Bitcoin argons needed. NOTE: your account must have enough to cover fees + tip after this amount.',
      parseFloat,
    )
    .requiredOption('--bitcoin-xpub <xpub>', 'The xpub key to use for bitcoin locking')
    .option('--max-lock-fee <argons>', "The max lock fee you're willing to pay", parseFloat)
    .option('--tip <amount>', 'The tip to include with the transaction', parseFloat, 0.0)
    .action(async ({ argons, bitcoinXpub, maxLockFee, tip }) => {
      const argonAmount = BigInt(argons * MICROGONS_PER_ARGON);
      const accountset = await accountsetFromCli(program);
      const vaults = new VaultMonitor(accountset, {
        bitcoinSpaceAvailable: argonAmount,
      });
      const bitcoinXpubBuffer = hexToU8a(bitcoinXpub);
      const maxFeeMicrogons = maxLockFee !== undefined ? BigInt(maxLockFee * MICROGONS_PER_ARGON) : undefined;
      const finalTip = BigInt(tip * MICROGONS_PER_ARGON);
      const priceIndex = new PriceIndex();
      await priceIndex.load(accountset.client);

      vaults.events.on('bitcoin-space-above', async (vaultId, amount) => {
        const vault = vaults.vaultsById[vaultId];
        const fee = vault.calculateBitcoinFee(amount);
        console.log(
          `Vault ${vaultId} has ${formatArgons(amount)} argons available for bitcoin. Lock fee is ${formatArgons(fee)}`,
        );
        if (maxFeeMicrogons !== undefined && fee > maxFeeMicrogons) {
          console.log(`Skipping vault ${vaultId} due to high lock fee: ${formatArgons(maxFeeMicrogons)}`);
          return;
        }

        try {
          const bitcoinLock = new BitcoinLocks(accountset.client);
          let satoshis = await bitcoinLock.requiredSatoshisForArgonLiquidity(priceIndex, amount);
          satoshis -= 500n;
          const { securityFee, txResult } = await bitcoinLock.initializeLock({
            vault,
            priceIndex,
            satoshis,
            argonKeyring: accountset.txSubmitterPair,
            ownerBitcoinPubkey: bitcoinXpubBuffer,
            tip: finalTip,
          });

          console.log(
            `Locked ${satoshis} satoshis in vault ${vaultId}. Tx fee=${formatArgons(
              txResult.finalFee ?? 0n,
            )}, Lock fee=${formatArgons(securityFee)}.`,
          );
          process.exit(0);
        } catch (err) {
          console.error('Error submitting bitcoin lock tx:', err);
          process.exit(1);
        } finally {
          vaults.stop();
        }
      });
      await vaults.monitor();
    });

  return program;
}
