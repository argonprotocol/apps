import Path from 'node:path';
import { parseArgs } from 'node:util';
import { JsonRpcProvider, Wallet } from 'ethers';
import BigNumber from 'bignumber.js';
import { getDevPaths, resolveDevProfile } from '../session.ts';
import { acquireDevLock } from '../lock.ts';
import { DEV_ETHEREUM_ADMIN_ACCOUNT, readDevEthereumRuntimeState } from '../../e2e/devEthereum.ts';
import { setDevEthereumPoolPrice } from '../../e2e/devEthereumStabilization.ts';

export async function run(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string' },
      instance: { type: 'string' },
      join: { type: 'string' },
      argon: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn dev price --argon PRICE [options]

Move the local Uniswap pool to a price in USDC per ARGN:
  --argon PRICE   Positive price, with at most 6 decimal places
  --profile NAME  Account profile (default: default; alias: --instance)
  --join NAME     Owning local environment
  -h, --help      Show this help

Uses the local admin's tokens to trade the pool in either direction.
The Rust oracle observes the new spot price; its TWAP catches up over time.
Example: yarn dev price --argon 0.95`);
    return;
  }
  if (!values.argon) throw new Error('Choose the pool price with --argon, for example --argon 0.95.');
  const profile = resolveDevProfile(values);
  const paths = getDevPaths(profile);
  const owner = profile.join ?? profile.instance;
  const release = acquireDevLock(Path.join(paths.networkDir, `.${owner}.dev-environment.lock`), 'Pool price update');
  let provider: JsonRpcProvider | undefined;
  try {
    const ethereum = await readDevEthereumRuntimeState(undefined, Path.join(paths.ownerDir, 'dev-ethereum'));
    if (!ethereum || ethereum.setupStatus !== 'ready') {
      throw new Error('Start this profile with yarn dev start before changing its pool price.');
    }
    provider = new JsonRpcProvider(ethereum.executionRpcUrl, Number(BigInt(ethereum.chainId)), { cacheTimeout: -1 });
    const result = await setDevEthereumPoolPrice({
      signer: new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider),
      ethereum,
      priceUsdc: values.argon,
    });
    const pool = ethereum.stabilization!.deployment!.pool;
    const rawRatio = new BigNumber(result.sqrtPriceX96.toString()).div((1n << 96n).toString()).pow(2);
    let observedPrice = rawRatio.times(1e12);
    if (pool.key.currency0.toLowerCase() === ethereum.usdcTokenAddress.toLowerCase()) {
      observedPrice = new BigNumber(1e12).div(rawRatio);
    }
    if (result.transactionHash) {
      console.info(`Pool moved to ${observedPrice.toFixed(6)} USDC per ARGN (${result.transactionHash}).`);
      console.info('The oracle will pick up the spot price; the TWAP adjusts over time.');
    } else {
      console.info(`Pool is already at approximately ${observedPrice.toFixed(6)} USDC per ARGN.`);
    }
  } finally {
    provider?.destroy();
    release();
  }
}
