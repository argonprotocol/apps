import { Command, Option } from '@commander-js/extra-typings';
import accountCli from './accountCli.js';
import { configDotenv } from 'dotenv';
import Path from 'node:path';
import vaultCli from './vaultCli.js';
import miningCli from './miningCli.js';
import treasuryCli from './treasuryCli.js';
import bitcoinCli from './bitcoinCli.js';
import { Accountset, MiningFrames, parseSubaccountRange } from '@argonprotocol/apps-core';
import { getClient, keyringFromSuri, type KeyringPair } from '@argonprotocol/mainchain';
import { keyringFromFile, saveKeyringPair } from './keyringStore.js';

export { accountCli, vaultCli, miningCli, treasuryCli, bitcoinCli, keyringFromFile, saveKeyringPair };

export function globalOptions(program: Command) {
  return program.optsWithGlobals() as IGlobalOptions;
}

export function buildCli() {
  return new Command('Argon CLI')
    .option('-e, --env <path>', 'The path to the account .env file to load')
    .addOption(
      new Option('-u, --mainchain-url <url>', 'The mainchain URL to connect to')
        .default('wss://rpc.argon.network')
        .env('MAINCHAIN_URL'),
    )
    .addOption(
      new Option('--network <name>', 'The network to connect to')
        .choices(['mainnet', 'testnet', 'dev-docker', 'localnet'])
        .env('ARGON_NETWORK_NAME'),
    )
    .addOption(
      new Option('--account-file-path <jsonPath>', 'The path to your json seed file from polkadotjs').env(
        'ACCOUNT_JSON_PATH',
      ),
    )
    .addOption(
      new Option('--account-suri <secretUri>', 'A secret uri (suri) to use for the account').env('ACCOUNT_SURI'),
    )
    .addOption(
      new Option('--account-passphrase <password>', 'The password for your seed file').env('ACCOUNT_PASSPHRASE'),
    )
    .addOption(new Option('--account-passphrase-file <path>', 'The path to a password for your seed file'))
    .addOption(
      new Option('--session-mini-secret-or-mnemonic <value>', 'A mini secret or mnemonic for session keys').env(
        'SESSION_MINI_SECRET',
      ),
    )
    .addOption(
      new Option('-s, --subaccounts <range>', 'Restrict this operation to a subset of the subaccounts (eg, 0-10)')
        .env('SUBACCOUNT_RANGE')
        .argParser(parseSubaccountRange),
    )
    .addCommand(accountCli())
    .addCommand(vaultCli())
    .addCommand(miningCli())
    .addCommand(treasuryCli())
    .addCommand(bitcoinCli());
}

export async function accountsetFromCli(program: Command, proxyForAddress?: string): Promise<Accountset> {
  const opts = program.parent?.optsWithGlobals() as unknown as IGlobalOptions;

  let keypair: KeyringPair | undefined;
  if (opts.accountSuri) {
    keypair = keyringFromSuri(opts.accountSuri);
  }
  if (opts.accountFilePath) {
    keypair = await keyringFromFile({
      filePath: opts.accountFilePath,
      passphrase: opts.accountPassphrase,
      passphraseFile: opts.accountPassphraseFile,
    });
  }
  if (!keypair) {
    throw new Error('No ACCOUNT account loaded (either ACCOUNT_SURI or ACCOUNT_JSON_PATH required)');
  }

  const client = await getClient(opts.mainchainUrl, { throwOnConnect: true });
  if (!opts.network) {
    const chain = await client.rpc.system.chain().then(x => x.toString());
    if (chain === 'Argon Testnet') {
      opts.network = 'testnet';
    } else if (chain === 'Argon') {
      opts.network = 'mainnet';
    } else if (chain.includes('Local Testnet')) {
      opts.network = 'localnet';
    } else if (chain.includes('Development')) {
      opts.network = 'dev-docker';
    }
    if (!opts.network) {
      throw new Error(`No --network provided and could not infer from chain name: ${chain}`);
    }
    process.env.ARGON_NETWORK_NAME = opts.network;
    process.env.ARGON_CHAIN = opts.network;
    MiningFrames.setNetwork(opts.network);
  }

  if (proxyForAddress) {
    return new Accountset({
      client,
      isProxy: true,
      seedAddress: proxyForAddress,
      txSubmitter: keypair,
      sessionMiniSecretOrMnemonic: opts.sessionMiniSecretOrMnemonic,
      subaccountRange: opts.subaccounts,
    });
  } else {
    return new Accountset({
      seedAccount: keypair,
      client,
      sessionMiniSecretOrMnemonic: opts.sessionMiniSecretOrMnemonic,
      subaccountRange: opts.subaccounts,
    });
  }
}

export type IGlobalOptions = ReturnType<ReturnType<typeof buildCli>['opts']>;

export function addGlobalArgs(program: ReturnType<typeof buildCli>) {
  for (const command of program.commands) {
    command.configureHelp({
      showGlobalOptions: true,
    });
    for (const nested of command.commands) {
      nested.configureHelp({
        showGlobalOptions: true,
      });
    }
  }
}

export function applyEnv(program: ReturnType<typeof buildCli>): string | undefined {
  program.parseOptions(process.argv);
  const { env } = program.optsWithGlobals();
  if (env) {
    const envPath = Path.resolve(process.cwd(), env);
    const res = configDotenv({ path: envPath });
    if (res.parsed?.ACCOUNT_JSON_PATH) {
      // ensure path is relative to the env file if provided that way
      process.env.ACCOUNT_JSON_PATH = Path.resolve(Path.dirname(envPath), process.env.ACCOUNT_JSON_PATH!);
    }
  }
  return env;
}
