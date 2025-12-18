import NetworkConfigSettings from '../network.config.json' with { type: 'json' };
import type { ArgonClient } from '@argonprotocol/mainchain';

export { NetworkConfigSettings };

export class NetworkConfig {
  public static networkName: keyof typeof NetworkConfigSettings | undefined = undefined;

  public static get tickMillis() {
    return this.get().tickMillis;
  }

  public static canFrameBeZero() {
    return this.networkName === 'localnet' || this.networkName === 'dev-docker';
  }

  public static get ticksPerCohort() {
    return this.rewardTicksPerFrame * 10;
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

  public static get(): INetworkConfig {
    if (!this.networkName) {
      throw new Error(`Network name must be defined prior to loading configs`);
    }
    const config = NetworkConfigSettings[this.networkName];
    if (!config) {
      throw new Error(`Network name ${this.networkName} is not a key of the app configs`);
    }

    return config as INetworkConfig;
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
  ): Promise<Omit<INetworkConfig, 'esploraHost' | 'archiveUrl' | 'bitcoinBlockMillis' | 'indexerHost'>> {
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
  indexerHost: string;
  bitcoinBlockMillis: 20000;
  esploraHost: string;
}
