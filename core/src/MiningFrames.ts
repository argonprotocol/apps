import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { NetworkConfig } from './NetworkConfig.js';
import { type ArgonClient, getTickFromHeader, type Header } from '@argonprotocol/mainchain';

dayjs.extend(utc);

/**
 * A frame is the period from noon EDT to the next noon EDT that a cohort of
 * miners rotates. The first frame (frame 0) was the period between bidding start and Frame 1 beginning.
 */
export class MiningFrames {
  public static get tickMillis() {
    return this.getConfig().tickMillis;
  }

  public static get ticksPerCohort() {
    return this.ticksPerFrame * 10;
  }

  public static get ticksPerFrame() {
    return this.getConfig().ticksBetweenFrames;
  }

  public static networkName: keyof typeof NetworkConfig | undefined = undefined;

  public static canFrameBeZero() {
    return this.networkName === 'localnet' || this.networkName === 'dev-docker';
  }

  public static getForTick(tick: number) {
    const { ticksBetweenFrames, biddingStartTick } = this.getConfig();

    const ticksSinceMiningStart = tick - biddingStartTick;

    return Math.floor(ticksSinceMiningStart / ticksBetweenFrames);
  }

  public static frameToDateRange(frameId: number): [Date, Date] {
    const { tickMillis } = this.getConfig();
    const [start, end] = this.getTickRangeForFrame(frameId);
    return [new Date(start * tickMillis), new Date(end * tickMillis)];
  }

  public static getForHeader(client: ArgonClient, header: Header) {
    if (header.number.toNumber() === 0) return 0;
    const tick = getTickFromHeader(client, header);
    if (tick === undefined) return undefined;
    return this.getForTick(tick);
  }

  public static setNetwork(networkName: keyof typeof NetworkConfig) {
    if (!(networkName in NetworkConfig)) {
      throw new Error(`${networkName} is not a valid Network chain name`);
    }
    this.networkName = networkName as any;
  }

  public static calculateCohortProgress(cohortActivationFrameId: number): number {
    const endingTick = this.getTickRangeForFrame(cohortActivationFrameId + 9)[1];
    const currentTick = this.calculateCurrentTickFromSystemTime();
    if (currentTick > endingTick) {
      return 1;
    }
    const startingTick = this.getTickRangeForFrame(cohortActivationFrameId)[0];
    const progress = (currentTick - startingTick) / (endingTick - startingTick);
    return Math.min(Math.max(progress, 0), 1);
  }

  public static getTickRangeForFrame(frameId: number): [number, number] {
    const { ticksBetweenFrames, biddingStartTick } = this.getConfig();

    const startingTick = biddingStartTick + Math.floor(frameId * ticksBetweenFrames);
    const endingTick = startingTick + ticksBetweenFrames - 1;

    return [startingTick, endingTick];
  }

  public static calculateCurrentTickFromSystemTime(): number {
    const config = this.getConfig();
    return Math.floor(Date.now() / config.tickMillis);
  }

  public static calculateCurrentFrameIdFromSystemTime(): number {
    const config = this.getConfig();
    const currentTick = this.calculateCurrentTickFromSystemTime();
    const { ticksBetweenFrames, biddingStartTick } = config;
    const ticksSinceSlotOne = currentTick - biddingStartTick;
    return Math.floor(ticksSinceSlotOne / ticksBetweenFrames);
  }

  public static getConfig(): IMiningFrameConfig {
    if (!this.networkName) {
      throw new Error(`Network name must be defined prior to loading configs`);
    }
    const config = NetworkConfig[this.networkName];
    if (!config) {
      throw new Error(`Network name ${this.networkName} is not a key of the app configs`);
    }

    return config;
  }

  public static async updateConfig(client: ArgonClient): Promise<void> {
    if (!this.networkName) {
      throw new Error(`Network name must be defined prior to loading configs`);
    }
    const updates = await this.loadConfigs(client);
    Object.assign(NetworkConfig[this.networkName], updates);
  }

  /**
   * Function used to retrieve configs that will update the stored config values
   * in the NetworkConfig object.
   * @param client
   */
  public static async loadConfigs(client: ArgonClient): Promise<IMiningFrameConfig> {
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

export interface IMiningFrameConfig {
  ticksBetweenFrames: number;
  slotBiddingStartAfterTicks: number;
  genesisTick: number;
  tickMillis: number;
  biddingStartTick: number;
}
