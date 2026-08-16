import NetworkConfigSettings from '../network.config.json' with { type: 'json' };
import type { ArgonClient } from '@argonprotocol/mainchain';

export { NetworkConfigSettings };
export type INetworkConfigOverride = Partial<Omit<INetworkConfig, 'ethereumNetwork' | 'baseNetwork'>> & {
  ethereumNetwork?: Partial<IEthereumNetworkConfig>;
  baseNetwork?: Partial<IBaseNetworkConfig>;
};

export class NetworkConfig {
  public static networkName: keyof typeof NetworkConfigSettings | undefined = undefined;
  private static runtimeOverrides: Partial<Record<keyof typeof NetworkConfigSettings, INetworkConfig>> = {};

  public static get tickMillis() {
    return this.get().tickMillis;
  }

  public static canFrameBeZero() {
    return this.networkName === 'localnet' || this.networkName === 'dev-docker';
  }

  public static get ticksPerCohort() {
    return this.rewardTicksPerFrame * this.framesPerCohort;
  }

  public static get framesPerCohort() {
    return 10;
  }

  public static get rewardTicksPerFrame() {
    return this.get().ticksBetweenFrames;
  }

  public static setNetwork(networkName: keyof typeof NetworkConfigSettings) {
    if (!(networkName in NetworkConfigSettings)) {
      throw new Error(`${networkName} is not a valid Network chain name`);
    }
    this.networkName = networkName as any;
  }

  public static setRuntimeOverride(
    networkName: keyof typeof NetworkConfigSettings,
    override: INetworkConfigOverride,
  ): void {
    if (!(networkName in NetworkConfigSettings)) {
      throw new Error(`${networkName} is not a valid Network chain name`);
    }
    const baseConfig = NetworkConfigSettings[networkName] as INetworkConfig;
    this.runtimeOverrides[networkName] = {
      ...baseConfig,
      ...override,
      ethereumNetwork: {
        ...baseConfig.ethereumNetwork,
        ...override.ethereumNetwork,
      },
      baseNetwork: {
        ...baseConfig.baseNetwork,
        ...override.baseNetwork,
      },
    };
  }

  public static clearRuntimeOverride(networkName?: keyof typeof NetworkConfigSettings): void {
    if (!networkName) {
      this.runtimeOverrides = {};
      return;
    }
    delete this.runtimeOverrides[networkName];
  }

  public static get(): INetworkConfig {
    if (!this.networkName) {
      throw new Error(`Network name must be defined prior to loading configs`);
    }
    const config = NetworkConfigSettings[this.networkName];
    if (!config) {
      throw new Error(`Network name ${this.networkName} is not a key of the app configs`);
    }

    return this.runtimeOverrides[this.networkName] ?? (config as INetworkConfig);
  }

  public static get websiteHost(): string {
    return this.get().websiteHost;
  }

  public static async updateConfig(client: ArgonClient): Promise<void> {
    if (!this.networkName) {
      throw new Error(`Network name must be defined prior to loading configs`);
    }
    const updates = await this.loadConfigs(client);
    Object.assign(NetworkConfigSettings[this.networkName], updates);
  }

  /**
   * Function used to retrieve configs that will update the stored config values
   * in the NetworkConfig object.
   * @param client
   */
  public static async loadConfigs(
    client: ArgonClient,
  ): Promise<
    Omit<
      INetworkConfig,
      | 'esploraHost'
      | 'archiveUrl'
      | 'bitcoinBlockMillis'
      | 'indexerHost'
      | 'websiteHost'
      | 'ethereumNetwork'
      | 'baseNetwork'
    >
  > {
    const config = await client.query.miningSlot.miningConfig().then(x => ({
      ticksBetweenSlots: x.ticksBetweenSlots.toNumber(),
      slotBiddingStartAfterTicks: x.slotBiddingStartAfterTicks.toNumber(),
    }));
    const genesisTick = await client.query.ticks.genesisTick().then((x: { toNumber: () => number }) => x.toNumber());

    return {
      ticksBetweenFrames: config.ticksBetweenSlots,
      slotBiddingStartAfterTicks: config.slotBiddingStartAfterTicks,
      genesisTick,
      tickMillis: await client.query.ticks.genesisTicker().then(x => x.tickDurationMillis.toNumber()),
      biddingStartTick: genesisTick + config.slotBiddingStartAfterTicks,
    };
  }
}

export interface INetworkConfig {
  ticksBetweenFrames: number;
  slotBiddingStartAfterTicks: number;
  genesisTick: number;
  tickMillis: number;
  biddingStartTick: number;
  archiveUrl: string;
  websiteHost: string;
  indexerHost: string;
  bitcoinBlockMillis: number;
  esploraHost: string;
  ethereumNetwork: IEthereumNetworkConfig;
  baseNetwork: IBaseNetworkConfig;
}

export interface IEthereumNetworkConfig {
  beaconApiUrl: string;
  executionRpcUrls: string[];
  explorerUrl: string;
  finalityBlocks: number;
  usdcTokenAddress: string;
}

export interface IBaseNetworkConfig {
  chainId: number;
  rpcUrl: string;
  usdcTokenAddress: string;
}

export const ETHEREUM_EXECUTION_RPC_TRANSPORT = {
  requestRetryCount: 0,
  fallbackRetryCount: 1,
  timeoutMs: 15_000,
} as const;

export function getEthereumTransactionExplorerUrl(transactionHash: string): string | undefined {
  const explorerUrl = NetworkConfig.get().ethereumNetwork.explorerUrl.trim().replace(/\/$/, '');
  if (!explorerUrl) return;

  return `${explorerUrl}/tx/${transactionHash}`;
}

export function getEthereumExecutionRpcUrls(configuredExecutionRpcUrl?: string): string[] {
  const ethereumNetwork = NetworkConfig.get().ethereumNetwork;
  return Array.from(
    new Set(
      [configuredExecutionRpcUrl, ...ethereumNetwork.executionRpcUrls]
        .map(url => url?.trim())
        .filter((url): url is string => Boolean(url)),
    ),
  );
}

export function logEthereumExecutionRpcFallback(args: {
  executionRpcUrls: string[];
  failedRpcUrl?: string;
  method: string;
}): void {
  const { executionRpcUrls, failedRpcUrl, method } = args;
  if (!failedRpcUrl) {
    return;
  }

  const failedRpcIndex = executionRpcUrls.indexOf(failedRpcUrl);
  if (failedRpcIndex < 0) {
    return;
  }

  const fallbackRpcUrl = executionRpcUrls[failedRpcIndex + 1];
  if (!fallbackRpcUrl) {
    return;
  }

  console.warn(
    `[Ethereum RPC] ${method} failed on ${formatEthereumRpcUrlForLog(failedRpcUrl)}; ` +
      `falling back to ${formatEthereumRpcUrlForLog(fallbackRpcUrl)}.`,
  );
}

function formatEthereumRpcUrlForLog(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    const schemeSeparatorIndex = rpcUrl.indexOf('://');
    const authority = schemeSeparatorIndex >= 0 ? rpcUrl.slice(schemeSeparatorIndex + 3) : rpcUrl;
    return authority.split(/[/?]/)[0];
  }
}
