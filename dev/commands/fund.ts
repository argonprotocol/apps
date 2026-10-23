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
      to: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn dev fund [options]

Add native Argon assets to an existing local dev account:
  --profile NAME    Account profile (default: default; alias: --instance)
  --join NAME       Owning local environment
  --argons AMOUNT   ARGN on Argon
  --argonots AMOUNT ARGNOT on Argon
  --to ADDRESS     Recipient override
  -h, --help       Show this help

Amounts use whole-token decimal units. Only named assets are funded.
No amounts: add 1,000 ARGN and 1,000 ARGNOT on Argon.
Use yarn dev fund-ethereum for ETH and Ethereum tokens.`);
    return;
  }
  await fundExistingDevAccount({
    ...resolveDevProfile(values),
    argons: values.argons,
    argonots: values.argonots,
    to: values.to,
  });
}
