import Path from 'node:path';
import Fs from 'node:fs';
import { configureDevEnvironment } from './environment.ts';
import { acquireDevLock } from './lock.ts';
import { DevOutput } from './output.ts';
import { readDevSession } from './session.ts';
import { formatUnits, getAddress, parseUnits } from 'viem';
import type { WalletKeys } from '../src-vue/lib/WalletKeys.ts';
import type { DevProfile } from './session.ts';
import { walletFileSchema, type IWalletFile } from '../src-vue/interfaces/IWalletFile.ts';

export interface FundingOptions {
  argons?: string;
  argonots?: string;
  ethArgons?: string;
  ethArgonots?: string;
  eth?: string;
  usdc?: string;
  to?: string;
  ethTo?: string;
}

export async function fundExistingDevAccount(options: FundingOptions & DevProfile): Promise<void> {
  const amounts = getDevFundingAmounts(options);
  const { paths, context } = await configureDevEnvironment(options);
  const owner = options.join ?? options.instance;
  const release = acquireDevLock(Path.join(paths.networkDir, `.${owner}.dev-environment.lock`), 'Environment funding');
  try {
    const state = readDevSession(options);
    const archiveUrl = state?.networkConfigOverride?.archiveUrl;
    if (!archiveUrl) throw new Error('Start this profile with yarn dev start before funding it.');
    const { readComposePortWithRetry } = await import('../e2e/scripts/devUpstreamServer.ts');
    const port = await readComposePortWithRetry({ context, service: 'archive-rpc', port: 9944, timeoutMs: 2_000 });
    if (archiveUrl !== `ws://127.0.0.1:${port}`) {
      throw new Error('The local network changed. Restart this profile before funding it.');
    }
    const output = new DevOutput(paths.logPath);
    try {
      const walletPath = Path.join(paths.instanceDir, 'wallet.json');
      let meta: IWalletFile['meta'];
      if (Fs.existsSync(walletPath)) {
        meta = walletFileSchema.parse(JSON.parse(Fs.readFileSync(walletPath, 'utf8'))).meta;
      }
      let walletKeys: Pick<WalletKeys, 'defaultArgonAddress' | 'coreEthereumAddress'>;
      const needsEthereumAddress =
        !options.ethTo && (amounts.ethArgons > 0n || amounts.ethArgonots > 0n || amounts.eth > 0n || amounts.usdc > 0n);
      if (meta && (!needsEthereumAddress || meta.ethereumAddress)) {
        walletKeys = { defaultArgonAddress: meta.vaultingAddress, coreEthereumAddress: meta.ethereumAddress };
      } else {
        const { readDevWalletKeys } = await import('./wallet.ts');
        walletKeys = await readDevWalletKeys(options);
      }
      await fundDevAccount({
        options,
        progress: message => output.progress(message),
        walletKeys,
        archiveUrl,
        executionRpcUrl: state.networkConfigOverride?.ethereumNetwork?.executionRpcUrls?.[0],
      });
    } catch (error) {
      output.progress((error as Error).message);
      throw error;
    } finally {
      output.close();
    }
  } finally {
    release();
  }
}

export async function fundDevAccount(args: {
  options: FundingOptions & Pick<DevProfile, 'network'>;
  walletKeys: Pick<WalletKeys, 'defaultArgonAddress' | 'coreEthereumAddress'>;
  archiveUrl: string;
  executionRpcUrl?: string;
  progress: (message: string) => void;
}): Promise<void> {
  const { options, walletKeys, archiveUrl, executionRpcUrl, progress } = args;
  if (options.network !== 'dev-docker') {
    throw new Error('Development funding requires the local dev-docker network.');
  }

  const amounts = getDevFundingAmounts(options);
  const hasEthereumFunding =
    amounts.ethArgons > 0n || amounts.ethArgonots > 0n || amounts.eth > 0n || amounts.usdc > 0n;
  const argonRecipient = options.to ?? walletKeys.defaultArgonAddress;
  const ethereumRecipient = hasEthereumFunding ? getAddress(options.ethTo ?? walletKeys.coreEthereumAddress) : '';
  let usdcTokenAddress: string | undefined;
  if (hasEthereumFunding) {
    if (!executionRpcUrl) {
      throw new Error('Ethereum is unavailable for this environment. Start it with yarn dev start.');
    }
    if (amounts.usdc > 0n) {
      const { readDevEthereumRuntimeState } = await import('../e2e/devEthereum.ts');
      const runtimeState = await readDevEthereumRuntimeState(executionRpcUrl);
      usdcTokenAddress = runtimeState?.usdcTokenAddress;
      if (runtimeState?.setupStatus !== 'ready' || !usdcTokenAddress) {
        throw new Error('The selected Ethereum environment has no ready USDC contract.');
      }
    }
  }

  const labels = {
    argon: `${formatUnits(amounts.argons, 6)} ARGN and ${formatUnits(amounts.argonots, 6)} ARGNOT on Argon`,
    ethereumTokens: `${formatUnits(amounts.ethArgons, 6)} ARGN and ${formatUnits(amounts.ethArgonots, 6)} ARGNOT on Ethereum`,
    eth: `${formatUnits(amounts.eth, 18)} ETH`,
    usdc: `${formatUnits(amounts.usdc, 6)} USDC`,
  };
  for (const asset of ['argon', 'ethereumTokens', 'eth', 'usdc'] as const) {
    if (asset === 'argon' && amounts.argons === 0n && amounts.argonots === 0n) continue;
    if (asset === 'ethereumTokens' && amounts.ethArgons === 0n && amounts.ethArgonots === 0n) continue;
    if ((asset === 'eth' || asset === 'usdc') && amounts[asset] === 0n) continue;

    progress(`Funding ${labels[asset]}`);
    try {
      if (asset === 'argon') {
        const { fundArgonAccount } = await import('./funding/argon.ts');
        await fundArgonAccount({
          to: argonRecipient,
          archiveUrl,
          microgons: amounts.argons,
          micronots: amounts.argonots,
        });
      } else if (asset === 'ethereumTokens') {
        const { fundDevEthereumTokens } = await import('./funding/tokens.ts');
        await fundDevEthereumTokens({
          to: ethereumRecipient,
          rpcUrl: executionRpcUrl,
          archiveUrl,
          argnRuntimeAmount: amounts.ethArgons,
          argnotRuntimeAmount: amounts.ethArgonots,
        });
      } else {
        const { fundDevEthereumAccount } = await import('./funding/ethereum.ts');
        await fundDevEthereumAccount({
          to: ethereumRecipient,
          rpcUrl: executionRpcUrl,
          token: asset === 'eth' ? 'ETH' : 'USDC',
          tokenAddress: usdcTokenAddress,
          amountBaseUnits: amounts[asset],
        });
      }
    } catch (error) {
      throw new Error(`Funding ${labels[asset]} failed: ${(error as Error).message}`, { cause: error });
    }
    progress(`Funded ${labels[asset]}`);
  }
}

export function getDevFundingAmounts(
  options: FundingOptions,
): Record<'argons' | 'argonots' | 'ethArgons' | 'ethArgonots' | 'eth' | 'usdc', bigint> {
  const { argons, argonots, ethArgons, ethArgonots, eth, usdc } = options;
  const amounts = { argons, argonots, ethArgons, ethArgonots, eth, usdc };
  for (const [asset, amount] of Object.entries(amounts)) {
    if (amount === undefined) continue;
    const decimals = asset === 'eth' ? 18 : 6;
    if (!/^\d+(?:\.\d+)?$/.test(amount) || (amount.split('.')[1]?.length ?? 0) > decimals) {
      throw new Error(`${asset} must be a non-negative decimal amount with at most ${decimals} decimal places.`);
    }
  }
  const hasExplicitAmounts = Object.values(amounts).some(amount => amount !== undefined);
  if (!hasExplicitAmounts) {
    return { argons: 1_000_000_000n, argonots: 1_000_000_000n, ethArgons: 0n, ethArgonots: 0n, eth: 0n, usdc: 0n };
  }
  return {
    argons: parseUnits(argons ?? '0', 6),
    argonots: parseUnits(argonots ?? '0', 6),
    ethArgons: parseUnits(ethArgons ?? '0', 6),
    ethArgonots: parseUnits(ethArgonots ?? '0', 6),
    eth: parseUnits(eth ?? '0', 18),
    usdc: parseUnits(usdc ?? '0', 6),
  };
}
