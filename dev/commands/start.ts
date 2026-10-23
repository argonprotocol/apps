import Fs from 'node:fs';
import Path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readDevEnvironment,
  selectDevEnvironment,
  saveDevEnvironment,
  readOwnedEthereumStates,
  recordEthereumContainers,
  resumeOwnedEthereum,
  configureDevEnvironment,
} from '../environment.ts';
import { ensureDockerComposeAssets } from '../../core/__test__/helpers/ensureDockerComposeAssets.ts';
import { DevOutput } from '../output.ts';
import { acquireDevLock } from '../lock.ts';
import { parseArgs } from 'node:util';
import { getDevFundingAmounts, type FundingOptions } from '../funding.ts';
import type { AppVaultOperator } from '../../e2e/actors/AppVaultOperator.ts';
import {
  getDevPaths,
  readDevSession,
  requestDevSession,
  resolveDevProfile,
  startDevControl,
  type DevProfile,
} from '../session.ts';

export interface DevStartOptions extends DevProfile, FundingOptions {
  chainSpec?: string;
  startEthereum: boolean;
  runUpstream: boolean;
  fundAccount: boolean;
  operationallyCertified: boolean;
  detachUpstreamApp: boolean;
}

export async function run(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    allowNegative: true,
    options: {
      profile: { type: 'string' },
      instance: { type: 'string' },
      join: { type: 'string' },
      full: { type: 'boolean' },
      'chain-spec': { type: 'string' },
      'start-ethereum': { type: 'boolean' },
      'run-upstream': { type: 'boolean' },
      'fund-account': { type: 'boolean' },
      'operationally-certified': { type: 'boolean' },
      'detach-upstream-app': { type: 'boolean' },
      argons: { type: 'string' },
      argonots: { type: 'string' },
      'eth-argons': { type: 'string' },
      'eth-argonots': { type: 'string' },
      eth: { type: 'string' },
      usdc: { type: 'string' },
      to: { type: 'string' },
      'eth-to': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn dev [start] [options]

Start desktop with reusable local Argon, Bitcoin, and indexer services.
Ethereum, upstream, account funding, and certification are off by default.
Enable them with the flags below or their ARGON_DEV_* environment variables.

Startup options:
  --profile NAME   Desktop account (default: default; alias: --instance)
  --join NAME      Share another profile's local environment
  --full           Start Ethereum and upstream, fund both chains, and certify this account
  --chain-spec FILE
  --start-ethereum Start the local Ethereum bridge and upstream operator
  --run-upstream   Start the upstream operator
  --fund-account   Add development funds to this account
  --operationally-certified  Grant this user operational access without creating a vault
  --detach-upstream-app      Attach the upstream account to a replacement server
  --argons AMOUNT --argonots AMOUNT             On Argon
  --eth-argons AMOUNT --eth-argonots AMOUNT      On Ethereum
  --eth AMOUNT --usdc AMOUNT                    On Ethereum
  --to ADDRESS --eth-to ADDRESS                Funding recipient overrides
  -h, --help       Show this help

Funding amounts use whole-token decimal units. With no amounts, --fund-account
adds 1,000 ARGN and 1,000 ARGNOT on Argon. Use --no-<flag> to disable inherited flags.

--full adds 1,000 ARGN and 1,000 ARGNOT on each chain, plus 1 ETH for gas.
Both recipients derive from the profile's mnemonic. Amount flags override each
full-setup default; --to and --eth-to override recipients.

Examples:
  yarn dev --full
  yarn dev --start-ethereum --run-upstream
  yarn dev --fund-account --operationally-certified
  yarn dev --profile second --join default

Use yarn dev help <command> for command-specific options.`);
    return;
  }
  const profile = resolveDevProfile(values);
  const readBoolean = (value: string | undefined) =>
    ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
  const options: DevStartOptions = {
    ...profile,
    startEthereum: values['start-ethereum'] ?? readBoolean(process.env.ARGON_DEV_ETHEREUM),
    runUpstream: values['run-upstream'] ?? readBoolean(process.env.ARGON_DEV_UPSTREAM),
    fundAccount: values['fund-account'] ?? readBoolean(process.env.ARGON_DEV_FUND_ACCOUNT),
    operationallyCertified:
      values['operationally-certified'] ?? readBoolean(process.env.ARGON_DEV_OPERATIONALLY_CERTIFIED),
    detachUpstreamApp: values['detach-upstream-app'] ?? readBoolean(process.env.ARGON_DEV_DETACH_UPSTREAM_APP),
    argons: values.argons,
    argonots: values.argonots,
    ethArgons: values['eth-argons'],
    ethArgonots: values['eth-argonots'],
    eth: values.eth,
    usdc: values.usdc,
    to: values.to,
    ethTo: values['eth-to'],
  };
  if (values.full) {
    options.startEthereum = true;
    options.operationallyCertified = true;
    options.argons ??= '1000';
    options.argonots ??= '1000';
    options.ethArgons ??= '1000';
    options.ethArgonots ??= '1000';
    options.eth ??= '1';
  }
  const chainSpec = values['chain-spec'] ?? process.env.ARGON_CHAIN_SPEC_PATH;
  if (chainSpec !== undefined) {
    if (!chainSpec.trim() || /[\0\r\n]/.test(chainSpec)) throw new Error('--chain-spec must name a valid file path.');
    options.chainSpec = Path.resolve(chainSpec);
  }
  getDevFundingAmounts(options);
  if ([options.ethArgons, options.ethArgonots, options.eth, options.usdc].some(amount => amount !== undefined))
    options.startEthereum = true;
  if (options.operationallyCertified) options.fundAccount = true;
  if (options.startEthereum || options.detachUpstreamApp) options.runUpstream = true;
  await startDev(options);
}

export async function startDev(requested: DevStartOptions): Promise<void> {
  if (requested.detachUpstreamApp && process.platform === 'win32') {
    throw new Error('The upstream app handoff requires SIGUSR2 and is not supported on Windows.');
  }
  const options = { ...requested };
  let existing = readDevSession(options);
  if (existing) {
    if (options.join && options.join !== existing.owner) {
      throw new Error(
        `Instance ${options.instance} already uses environment ${existing.owner}. Use a fresh --instance or reset it before selecting ${options.join}.`,
      );
    }
    if (!options.join && existing.owner !== options.instance) options.join = existing.owner;
  }
  const owner = options.join ?? options.instance;
  if (options.detachUpstreamApp) {
    if (!options.join) options.instance = `${owner}-operator`;
    options.join = owner;
    options.port = undefined;
    existing = readDevSession(options);
    if (existing && existing.owner !== owner) {
      throw new Error(`Upstream app ${options.instance} already uses environment ${existing.owner}.`);
    }
  }
  const paths = getDevPaths(options);
  if (existing) {
    const running = await requestDevSession(existing, 'status').catch(() => undefined);
    if (running) {
      if (running.owner !== owner)
        throw new Error(
          `Instance ${options.instance} already uses environment ${running.owner}. Stop it before selecting ${owner}.`,
        );
      if (options.chainSpec) selectDevEnvironment(options);
      if (options.fundAccount || options.startEthereum || options.runUpstream || options.operationallyCertified) {
        throw new Error(
          `Instance ${options.instance} is running. Use yarn dev fund, or stop it before changing startup options.`,
        );
      }
      process.stdout.write(
        `Instance ${options.instance} is ${running.ready ? 'ready' : 'starting'}. Logs: ${paths.logPath}\n`,
      );
      return;
    }
  }
  const releaseEnvironment = acquireDevLock(
    Path.join(paths.networkDir, `.${owner}.dev-environment.lock`),
    'Environment startup',
  );
  try {
    const previousEnvironment = readDevEnvironment(options);
    const environment = selectDevEnvironment(options);
    const upstreamApp = previousEnvironment?.upstreamApp;
    let visibleUpstreamReady = false;
    let visibleEthereumReady = false;
    if (upstreamApp) {
      const upstreamFile = Path.join(paths.networkDir, upstreamApp, 'dev-cli.json');
      if (Fs.existsSync(upstreamFile)) {
        const state = JSON.parse(Fs.readFileSync(upstreamFile, 'utf8')) as import('../session.ts').DevSessionState;
        const running = await requestDevSession(state, 'status').catch(() => undefined);
        visibleUpstreamReady = !!running?.ready;
        visibleEthereumReady = !!running?.ethereumReady;
      }
      if (!options.detachUpstreamApp && options.runUpstream) {
        if (!visibleUpstreamReady)
          throw new Error(
            `The upstream is owned by app ${upstreamApp}. Start it with yarn dev --instance ${owner} --detach-upstream-app before starting a downstream app.`,
          );
        if (options.startEthereum && !visibleEthereumReady)
          throw new Error(`Restart the upstream app with --start-ethereum before using the Ethereum bridge.`);
      }
    }
    Fs.mkdirSync(paths.instanceDir, { recursive: true });
    saveDevEnvironment(options, environment);
    const output = new DevOutput(paths.logPath);
    const control = await startDevControl(options).catch(error => {
      output.close();
      throw error;
    });
    const cleanup = () => control.close();
    process.once('exit', cleanup);

    try {
      output.progress(`Preparing ${options.network}, instance ${options.instance}`);
      await output.run('yarn', ['generate:runtime-client']);
      Object.assign(process.env, {
        ARGON_APP_INSTANCE_DIR: paths.instanceDir,
        ARGON_DEV_ETHEREUM: options.startEthereum ? '1' : '0',
        ARGON_DEV_UPSTREAM: options.runUpstream && !visibleUpstreamReady && !options.detachUpstreamApp ? '1' : '0',
      });
      if (options.network === 'dev-docker') {
        const inherited = process.env.ARGON_NETWORK_CONFIG_OVERRIDE;
        if (inherited) {
          throw new Error(
            'CLI local startup selects its RPCs from the owning Docker environment. Unset ARGON_NETWORK_CONFIG_OVERRIDE before starting it.',
          );
        }
        if (environment.ethereumNetwork && !options.startEthereum) {
          process.env.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify({ ethereumNetwork: environment.ethereumNetwork });
        }
      }
      if (options.network === 'dev-docker') {
        const { context, composeArgs } = await configureDevEnvironment(options);
        output.progress('Building local services');
        await output.run('yarn', ['workspace', '@argonprotocol/apps-indexer', 'run', 'build']);
        await output.run('yarn', ['build:server']);
        await ensureDockerComposeAssets();
        output.progress('Starting or reusing Argon, Bitcoin, and indexer');
        await output.run('docker', [...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '180'], {
          env: context.composeEnv,
          cwd: context.composeDir,
        });
      }

      if (options.network === 'dev-docker' && (options.startEthereum || readOwnedEthereumStates(options).length)) {
        await resumeOwnedEthereum(environment, output);
      }
      const { startDesktop } = await import('../desktop.ts');
      await startDesktop({
        logFd: output.fd,
        visibleEthereumReady,
        deferEthereumRelay: options.detachUpstreamApp,
        progress: stage => output.progress(stage),
        onStarted() {
          control.state.ready = true;
          control.save();
          output.progress(`Desktop started: ${options.network}, instance ${options.instance}.`);
          output.progress(`Logs: ${pathToFileURL(paths.logPath).href} (yarn dev logs --instance ${options.instance})`);
        },
        async beforeLaunch(runtimeEnv, devEthereum) {
          if (runtimeEnv.ARGON_NETWORK_CONFIG_OVERRIDE) {
            control.state.networkConfigOverride = JSON.parse(runtimeEnv.ARGON_NETWORK_CONFIG_OVERRIDE);
            control.save();
            environment.ethereumNetwork = control.state.networkConfigOverride?.ethereumNetwork;
            saveDevEnvironment(options, environment);
          }
          if (options.network === 'dev-docker' && options.startEthereum) {
            recordEthereumContainers(options, environment);
          }
          const needsAccountSetup = options.fundAccount || options.operationallyCertified || options.detachUpstreamApp;
          if (options.network === 'dev-docker' && needsAccountSetup) {
            const { readDevWalletKeys } = await import('../wallet.ts');
            const walletKeys = await readDevWalletKeys(options, true);
            const archiveUrl = control.state.networkConfigOverride?.archiveUrl;
            if (!archiveUrl) throw new Error('The selected local chain has no resolved archive RPC.');
            if (options.operationallyCertified || options.detachUpstreamApp) {
              const { MainchainClients } = await import('@argonprotocol/apps-core');
              const clients = new MainchainClients(archiveUrl, () => false);
              try {
                const client = await clients.get(false);
                if (options.detachUpstreamApp) {
                  output.progress('Handing upstream to its app and replacement server');
                  const { AppVaultOperator } = await import('../../e2e/actors/AppVaultOperator.ts');
                  const { prepareDevUpstreamApp } = await import('../../e2e/scripts/prepareDevUpstreamApp.ts');
                  let actor: AppVaultOperator | undefined;
                  try {
                    actor = await AppVaultOperator.load({
                      clients,
                      walletKeys,
                      networkConfigOverride: control.state.networkConfigOverride,
                    });
                    await prepareDevUpstreamApp({
                      instance: options.instance,
                      visibleAppDir: paths.instanceDir,
                      devUpstreamDir: paths.upstreamDir,
                      actor,
                      client,
                      runtimeEnv,
                      output,
                      devEthereum,
                    });
                  } finally {
                    await actor?.dispose();
                  }
                  if (options.startEthereum) control.state.ethereumReady = true;
                  control.save();
                } else {
                  output.progress('Granting local user operational access');
                  const { certifyDevAccount } = await import('../certification.ts');
                  await certifyDevAccount({ client, walletKeys });
                }
              } finally {
                await clients.disconnect();
              }
            }
            if (options.fundAccount) {
              output.progress('Funding account');
              const { fundDevAccount } = await import('../funding.ts');
              await fundDevAccount({
                options,
                progress: message => output.progress(message),
                walletKeys,
                archiveUrl,
                executionRpcUrl: control.state.networkConfigOverride?.ethereumNetwork?.executionRpcUrls?.[0],
              });
            }
          }
          releaseEnvironment();
        },
      });
    } catch (error) {
      output.progress(`Failed: ${(error as Error).message}. Logs: ${paths.logPath}`);
      throw error;
    } finally {
      process.off('exit', cleanup);
      control.close();
      output.close();
    }
  } finally {
    releaseEnvironment();
  }
}
