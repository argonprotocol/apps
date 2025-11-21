import { Command } from '@commander-js/extra-typings';
import { filterUndefined, miniSecretFromUri } from '@argonprotocol/apps-core';
import { writeFileSync } from 'node:fs';
import type Env from './env.js';
import * as process from 'node:process';
import { accountsetFromCli, globalOptions } from './index.js';

export default function accountCli() {
  const program = new Command('accounts').description('Manage subaccounts from a single keypair');

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
      let subaccountRange = '0-144';
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

  return program;
}
