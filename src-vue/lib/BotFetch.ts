import {
  type IBidsFile,
  type IBlockNumbers,
  type IBotState,
  type IBotStateError,
  type IBotStateStarting,
  type IEarningsFile,
  type IHistoryFile,
  type IBitcoinBlockMeta,
  JsonExt,
} from '@argonprotocol/apps-core';
import { BotServerError, BotServerIsLoading, BotServerIsSyncing } from '../interfaces/BotErrors.ts';
import { SSH } from './SSH.ts';
import { fetch } from '@tauri-apps/plugin-http';
import { SERVER_ENV_VARS } from './Env.ts';

export class BotFetch {
  private static async botFetch<T>(botPath: string): Promise<{ data: T; status: number }> {
    if (botPath.startsWith('/')) {
      botPath = botPath.slice(1);
    }
    const ipAddress = await SSH.getIpAddress();
    const url = `http://${ipAddress}:${SERVER_ENV_VARS.BOT_PORT}/${botPath}`;
    const abortController = new AbortController();
    const signal = abortController.signal;
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, 10e3);
    const result = await fetch(url, { signal }).catch(e => {
      console.error(`[BOT] Error Fetching ${url}`, e);
      throw e;
    });
    if (!result.ok) {
      console.error(`[BOT] Request Error: ${url}`, result.status, result.statusText);
      throw new Error(`HTTP GET command failed with status ${result.status}`);
    }
    clearTimeout(timeoutId);

    try {
      const body = await result.text();
      const data = JsonExt.parse(body);
      console.log(`[BOT]: ${url}`, { data, status: result.status });

      return {
        status: result.status,
        data,
      };
    } catch (e) {
      console.error('Failed to parse JSON:', result.status, result.statusText, e);
      throw e;
    }
  }

  public static async lastModifiedDate(): Promise<Date | null> {
    try {
      const response = await this.botFetch<{ lastModifiedDate: string } | IBotStateStarting | IBotStateError>(
        `/last-modified`,
      );
      if ('lastModifiedDate' in response.data) {
        return new Date(response.data.lastModifiedDate);
      }
    } catch (error) {
      console.error('Failed to parse JSON:', error);
    }
    return null;
  }

  public static async fetchBotState(retries = 0): Promise<IBotState> {
    try {
      const response = await this.botFetch<IBotState | IBotStateStarting | IBotStateError>(`/state`);

      if ((response.data as IBotStateError).serverError) {
        throw new BotServerError(response.data as IBotStateError);
      } else if (response.data.isSyncing) {
        throw new BotServerIsSyncing(response.data.syncProgress);
      } else if (!response.data.isReady) {
        throw new BotServerIsLoading(response.data);
      }

      return response.data as IBotState;
    } catch (error) {
      if (
        error instanceof BotServerError ||
        error instanceof BotServerIsLoading ||
        error instanceof BotServerIsSyncing
      ) {
        throw error;
      } else if (error === 'ServerUnavailable') {
        throw new BotServerIsLoading({
          isReady: false,
          isStarting: true,
          syncProgress: 0,
          argonBlockNumbers: { localNode: 0, mainNode: 0 },
          bitcoinBlockNumbers: { localNode: 0, mainNode: 0 },
        });
      }

      if (retries > 3) {
        throw error;
      }
      retries += 1;
      const retryIn = Math.pow(2, retries) * 1000;
      console.log(`Error fetching bot status, retrying in ${retryIn / 1000}s...`, error);
      await new Promise(resolve => setTimeout(resolve, retryIn));
      return this.fetchBotState(retries);
    }
  }

  public static async fetchArgonBlockchainStatus(): Promise<IBlockNumbers> {
    const { data } = await this.botFetch<IBlockNumbers>(`/argon-blockchain-status`);
    return { localNode: data.localNode, mainNode: data.mainNode };
  }

  public static async fetchBitcoinBlockchainStatus(): Promise<IBlockNumbers> {
    const { data } = await this.botFetch<IBlockNumbers>(`/bitcoin-blockchain-status`);
    return { localNode: data.localNode, mainNode: data.mainNode };
  }

  public static async fetchLatestBitcoinBlocks(): Promise<IBitcoinBlockMeta[]> {
    const { data } = await this.botFetch<IBitcoinBlockMeta[]>(`/bitcoin-recent-blocks`);
    return data;
  }

  public static async fetchHistory(): Promise<IHistoryFile> {
    const { data } = await this.botFetch<IHistoryFile>(`/history`);

    return data;
  }

  public static async fetchEarningsFile(frameId: number): Promise<IEarningsFile> {
    const { data } = await this.botFetch<IEarningsFile>(`/earnings/${frameId}`);
    return data;
  }

  public static async fetchBidsFile(cohortActivationFrameId?: number): Promise<IBidsFile> {
    let url = `/bids`;
    if (cohortActivationFrameId) {
      const cohortBiddingFrameId = cohortActivationFrameId - 1;
      url += `/${cohortBiddingFrameId}-${cohortActivationFrameId}`;
    }
    const { data } = await this.botFetch<IBidsFile>(url);
    return data;
  }
}
