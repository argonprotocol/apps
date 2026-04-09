import { JsonExt } from '@argonprotocol/apps-core';
import type {
  IBitcoinLockCouponStatus,
  ICreateTreasuryInviteResponse,
  IListBitcoinLockCouponStatusesResponse,
  IListTreasuryInvitesResponse,
  IListTreasuryMembersResponse,
  IRouterErrorResponse,
  IRouterProfile,
  IRouterProfileResponse,
  IRouterProfileUpdateRequest,
  ITreasuryUserInvite,
  ITreasuryUserInviteCreateRequest,
  ITreasuryUserInviteSummary,
  ITreasuryUserMember,
} from '@argonprotocol/apps-router';
import { SERVER_ENV_VARS } from './Env.ts';

export interface IBitcoinBlockChainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestBlockHash: string;
  difficulty: number;
  time: number;
  medianTime: number;
  verificationProgress: number;
  initialBlockDownload: boolean;
  chainwork: string;
  sizeOnDisk: number;
  pruned: boolean;
  warnings: string[];
  localNodeBlockNumber: number;
  mainNodeBlockNumber: number;
}

export interface IArgonBlockChainInfo {
  localNodeBlockNumber: number;
  mainNodeBlockNumber: number;
  isComplete: boolean;
}

interface ISyncStatus {
  mainNodeBlockNumber: number;
  localNodeBlockNumber: number;
  syncPercent: number;
}

interface ILatestBlocks {
  mainNodeBlockNumber: number;
  localNodeBlockNumber: number;
}

interface IBitcoinLatestBlocks extends ILatestBlocks {
  localNodeBlockTime: number;
}

export class ServerApiClient {
  public static async getProfile(serverIp: string): Promise<IRouterProfile> {
    const body = await this.request<IRouterProfileResponse>(serverIp, '/profile');
    return body.profile;
  }

  public static async saveProfile(serverIp: string, payload: IRouterProfileUpdateRequest): Promise<IRouterProfile> {
    const body = await this.request<IRouterProfileResponse>(serverIp, '/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JsonExt.stringify(payload),
    });
    return body.profile;
  }

  public static async getTreasuryAppInvites(serverIp: string): Promise<ITreasuryUserInviteSummary[]> {
    const body = await this.request<IListTreasuryInvitesResponse>(serverIp, '/treasury-users/invites');
    return body.invites;
  }

  public static async getTreasuryAppMembers(serverIp: string): Promise<ITreasuryUserMember[]> {
    const body = await this.request<IListTreasuryMembersResponse>(serverIp, '/treasury-users/members');
    return body.members;
  }

  public static async getBitcoinLockCouponStatuses(serverIp: string): Promise<IBitcoinLockCouponStatus[]> {
    const body = await this.request<IListBitcoinLockCouponStatusesResponse>(serverIp, '/bitcoin-lock-coupons');
    return body.bitcoinLocks;
  }

  public static async createTreasuryAppInvite(
    serverIp: string,
    payload: ITreasuryUserInviteCreateRequest,
  ): Promise<ITreasuryUserInvite> {
    const body = await this.request<ICreateTreasuryInviteResponse>(serverIp, '/treasury-users/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JsonExt.stringify(payload),
    });
    return body.invite;
  }

  public static async getBitcoinInstallProgress(serverIp: string): Promise<number> {
    const result = await this.request<ISyncStatus>(serverIp, '/bitcoin/syncstatus', undefined, 30e3).catch(() => null);
    return result?.syncPercent ?? 0;
  }

  public static async getBitcoinBlockChainInfo(serverIp: string): Promise<IBitcoinBlockChainInfo> {
    const blocks = await this.request<IBitcoinLatestBlocks>(serverIp, '/bitcoin/latestblocks', undefined, 30e3);
    const info = await this.request<{
      chain: string;
      blocks: number;
      headers: number;
      bestblockhash: string;
      difficulty: number;
      time: number;
      mediantime: number;
      verificationprogress: number;
      initialblockdownload: boolean;
      chainwork: string;
      size_on_disk: number;
      pruned: boolean;
      warnings: string[];
    }>(serverIp, '/bitcoin/getblockchaininfo', undefined, 30e3);

    return {
      chain: info.chain,
      blocks: info.blocks,
      headers: info.headers,
      bestBlockHash: info.bestblockhash,
      difficulty: info.difficulty,
      time: info.time,
      medianTime: info.mediantime,
      verificationProgress: info.verificationprogress,
      initialBlockDownload: info.initialblockdownload,
      chainwork: info.chainwork,
      sizeOnDisk: info.size_on_disk,
      pruned: info.pruned,
      warnings: info.warnings,
      localNodeBlockNumber: blocks.localNodeBlockNumber,
      mainNodeBlockNumber: blocks.mainNodeBlockNumber,
    };
  }

  public static async getArgonBlockChainInfo(serverIp: string): Promise<IArgonBlockChainInfo> {
    const { localNodeBlockNumber, mainNodeBlockNumber } = await this.request<ILatestBlocks>(
      serverIp,
      '/argon/latestblocks',
      undefined,
      10e3,
    );
    const completeResponse = await this.request<boolean | object>(serverIp, '/argon/iscomplete', undefined, 10e3);

    return {
      localNodeBlockNumber,
      mainNodeBlockNumber,
      isComplete: completeResponse === true,
    };
  }

  public static async getArgonInstallProgress(serverIp: string): Promise<number> {
    const result = await this.request<ISyncStatus>(serverIp, '/argon/syncstatus', undefined, 30e3);
    return result?.syncPercent ?? 0;
  }

  private static async request<T>(serverIp: string, path: string, init?: RequestInit, timeoutMs = 10e3): Promise<T> {
    const baseUrl = `http://${serverIp
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')}:${SERVER_ENV_VARS.ROUTER_PORT}`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? abortController.signal,
      });
      const rawBody = await response.text();
      const body = rawBody ? JsonExt.parse<T | IRouterErrorResponse>(rawBody) : undefined;
      const error =
        body != null &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        'error' in body &&
        typeof body.error === 'string'
          ? body.error
          : undefined;

      if (!response.ok || error) {
        throw new Error(error || `Server API request failed (${response.status}).`);
      }

      return body as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
