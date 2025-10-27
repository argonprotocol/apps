import { TreasuryPool, VaultMonitor } from '@argonprotocol/apps-core';
import { accountsetFromCli } from './index.js';
import { formatArgons, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { Command } from '@commander-js/extra-typings';

export default function treasuryCli() {
  const program = new Command('treasury-pools').description('Monitor or bond to treasury pools');
  program
    .command('list', { isDefault: true })
    .description('Show or watch the vault bid pool rewards')
    .action(async () => {
      const accountset = await accountsetFromCli(program);
      const bidPool = new TreasuryPool(accountset.client, accountset.txSubmitterPair);
      await bidPool.watch();
    });

  program
    .command('bond')
    .description('Bond argons to a treasury pool')
    .requiredOption('-v, --vault-id <id>', 'The vault id to use', parseInt)
    .requiredOption('-a, --argons <amount>', 'The number of argons to set the vault to', parseFloat)
    .option('--tip <amount>', 'The tip to include with the transaction', parseFloat)
    .action(async ({ tip, argons, vaultId }) => {
      const accountset = await accountsetFromCli(program);
      const resolvedTip = tip ? BigInt(tip * MICROGONS_PER_ARGON) : 0n;

      const microgons = BigInt(argons * MICROGONS_PER_ARGON);
      const bidPool = new TreasuryPool(accountset.client, accountset.txSubmitterPair);
      await bidPool.bondArgons(vaultId, microgons, { tip: resolvedTip });
      console.log('Bonded argons to treasury pool bond');
      process.exit();
    });

  program
    .command('wait-for-space')
    .description('Add bonded argons to a treasury pool when the market rate is favorable')
    .requiredOption('--max-argons <amount>', 'Max daily argons to use per slot', parseFloat)
    .option('--min-pct-sharing <percent>', 'The minimum profit sharing percent to allow', parseInt, 30)
    .option('--tip <amount>', 'The tip to include with the transaction', parseFloat)
    .action(async ({ maxArgons, minPctSharing, tip }) => {
      const maxAmountPerSlot = BigInt(maxArgons * MICROGONS_PER_ARGON);

      const accountset = await accountsetFromCli(program);
      const vaults = new VaultMonitor(
        accountset,
        {
          treasuryPoolSpaceAvailable: 1_000_000n,
        },
        { shouldLog: false },
      );
      const bidPool = new TreasuryPool(accountset.client, accountset.txSubmitterPair);
      const resolvedTip = tip ? BigInt(tip * MICROGONS_PER_ARGON) : 0n;
      console.log('Waiting for treasury pool space...');

      vaults.events.on('treasury-pool-space-above', async (vaultId, amount) => {
        const vault = vaults.vaultsById[vaultId];
        if (vault.terms.treasuryProfitSharing.times(100).toNumber() < minPctSharing) {
          console.info(`Skipping vault ${vaultId} due to lower profit sharing than ${minPctSharing}%`);
          return;
        }
        let amountToAdd = amount;
        if (amountToAdd > maxAmountPerSlot) {
          amountToAdd = maxAmountPerSlot;
        }
        await bidPool.bondArgons(vaultId, amountToAdd, { tip: resolvedTip });
        console.log('Bonding argons to vault treasury pool', {
          vaultId,
          amount: formatArgons(amountToAdd),
        });
      });
      await vaults.monitor();
    });
  return program;
}
