import { parseArgs } from 'node:util';
import { resolveDevProfile } from '../session.ts';
import { fundExistingDevAccount } from '../funding.ts';

export async function run(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string' },
      instance: { type: 'string' },
      join: { type: 'string' },
      argons: { type: 'string' },
      argonots: { type: 'string' },
      eth: { type: 'string' },
      usdc: { type: 'string' },
      to: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn dev fund-ethereum [options]

Add assets on the selected local Ethereum network:
  --profile NAME    Account profile (default: default; alias: --instance)
  --join NAME       Owning local environment
  --eth AMOUNT      ETH
  --argons AMOUNT   ARGN on Ethereum
  --argonots AMOUNT ARGNOT on Ethereum
  --usdc AMOUNT     USDC
  --to ADDRESS     Ethereum recipient override
  -h, --help       Show this help

Provide at least one amount in whole-token decimal units.
Start Ethereum first with yarn dev --start-ethereum.`);
    return;
  }
  if ([values.eth, values.argons, values.argonots, values.usdc].every(amount => amount === undefined)) {
    throw new Error('Choose an amount with --eth, --argons, --argonots, or --usdc.');
  }
  await fundExistingDevAccount({
    ...resolveDevProfile(values),
    eth: values.eth,
    ethArgons: values.argons,
    ethArgonots: values.argonots,
    usdc: values.usdc,
    ethTo: values.to,
  });
}
