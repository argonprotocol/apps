import { Command } from '@commander-js/extra-typings';
import { filterUndefined, miniSecretFromUri, parseSubaccountRange } from '@argonprotocol/apps-core';
import { mnemonicGenerate, waitForLoad } from '@argonprotocol/mainchain';
import { printTable } from 'console-table-printer';
import { writeFileSync } from 'node:fs';
import type Env from './env.js';
import * as process from 'node:process';
import { accountsetFromCli, globalOptions } from './index.js';

export default function accountCli() {
  const program = new Command('accounts').description('Manage subaccounts from a single keypair');

  program
    .command('watch')
    .description('Watch for blocks closed by subaccounts')
    .action(async () => {
      const accountset = await accountsetFromCli(program);
      const accountMiners = await accountset.watchBlocks();

      accountMiners.events.on('mined', (_block, mined) => {
        console.log('Your accounts authored a block', mined);
      });
      accountMiners.events.on('minted', (_block, minted) => {
        console.log('Your accounts minted argons', minted);
      });
    });

  program
    .command('list', { isDefault: true })
    .description('Show subaccounts')
    .option('--addresses', 'Just show a list of ids')
    .action(async ({ addresses }) => {
      const { subaccounts } = globalOptions(program);
      const accountset = await accountsetFromCli(program);

      if (addresses) {
        const addresses = accountset.addresses;
        console.log(addresses.join(','));
        process.exit(0);
      }
      const [argonots, argons, seats, bids] = await Promise.all([
        accountset.totalArgonotsAt(),
        accountset.totalArgonsAt(),
        accountset.miningSeats(),
        accountset.bids(),
      ]);
      const accountSubset = subaccounts ? accountset.getAccountsInRange(subaccounts) : undefined;
      const status = accountset.status({
        argons,
        argonots,
        accountSubset,
        seats,
        bids,
      });
      printTable(status);
      process.exit(0);
    });

  program
    .command('create')
    .description('Create an account "env" file and optionally register keys')
    .requiredOption('--path <path>', 'The path to an env file to create (convention is .env.<name>)')
    .option('--register-keys-to <url>', 'Register the keys to a url (normally this is localhost)')
    .action(async ({ registerKeysTo, path }) => {
      const { accountPassphrase, accountSuri, accountFilePath, subaccounts } = globalOptions(program);
      const accountset = await accountsetFromCli(program);
      if (accountSuri && !accountset.sessionMiniSecretOrMnemonic) {
        const mnemonic = miniSecretFromUri(`${accountSuri}//session`);
        accountset.sessionMiniSecretOrMnemonic = mnemonic;
        process.env.SESSION_MINI_SECRET = mnemonic;
      }
      if (registerKeysTo) {
        await accountset.registerKeys(registerKeysTo);
        console.log('Keys registered to', registerKeysTo);
      }
      let subaccountRange = '0-49';
      if (subaccounts && subaccounts.length > 0) {
        subaccounts.sort((a, b) => a - b);
        if (subaccounts.toString() === Array.from({ length: subaccounts.at(-1)! + 1 }, (_, i) => i).toString()) {
          subaccountRange = `${subaccounts.at(0)}-${subaccounts.at(-1)}`;
        } else {
          subaccountRange = subaccounts.join(',');
        }
      }
      const envData = filterUndefined<Env>({
        ACCOUNT_JSON_PATH: accountFilePath,
        ACCOUNT_SURI: accountSuri,
        ACCOUNT_PASSPHRASE: accountPassphrase,
        SESSION_MINI_SECRET: process.env.SESSION_MINI_SECRET,
        SUBACCOUNT_RANGE: subaccountRange,
      });
      let envfile = '';
      for (const [key, value] of Object.entries(envData)) {
        if (key) {
          const line = `${key}=${String(value)}`;
          envfile += line + '\n';
        }
      }
      writeFileSync(path, envfile);
      console.log('Created env file at', path);
      process.exit();
    });

  program
    .command('new-session-seed')
    .description('Create a new mini secret for runtime session keys')
    .option('--mnemonic <path>', 'Optionally provide a mnemonic to convert to a mini secret')
    .action(async ({ mnemonic }) => {
      await waitForLoad();
      const minisecret = miniSecretFromUri(`${mnemonic ?? mnemonicGenerate()}//session`);
      console.log('New mnemonic (add this to your .env as SESSION_MINI_SECRET):', minisecret);
      process.exit(0);
    });

  program
    .command('register-keys')
    .description('Create an insert-keys script with curl')
    .argument(
      '[node-rpc-url]',
      'The url to your node host (should be installed on machine via localhost)',
      'http://localhost:9944',
    )
    .option('--print-only', 'Output as curl commands instead of direct registration')
    .action(async (nodeRpcUrl, { printOnly }) => {
      const accountset = await accountsetFromCli(program);
      if (printOnly) {
        const { gran, seal } = accountset.keys();
        const commands: string[] = [];
        const data = [
          {
            jsonrpc: '2.0',
            id: 0,
            method: 'author_insertKey',
            params: ['gran', gran.privateKey, gran.publicKey],
          },
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'author_insertKey',
            params: ['seal', seal.privateKey, seal.publicKey],
          },
        ];
        for (const key of data) {
          commands.push(`curl -X POST -H "Content-Type: application/json" -d '${JSON.stringify(key)}' ${nodeRpcUrl}`);
        }

        console.log(commands.join(' && '));
      } else {
        await accountset.registerKeys(nodeRpcUrl);
      }
      process.exit();
    });

  program
    .command('consolidate')
    .description('Consolidate all argons into parent account')
    .option(
      '-s, --subaccounts <range>',
      'Restrict this operation to a subset of the subaccounts (eg, 0-10)',
      parseSubaccountRange,
    )
    .action(async ({ subaccounts }) => {
      const accountset = await accountsetFromCli(program);
      const result = await accountset.consolidate(subaccounts);
      printTable(result);
      process.exit(0);
    });
  return program;
}
