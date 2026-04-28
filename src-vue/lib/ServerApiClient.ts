import { JsonExt } from '@argonprotocol/apps-core';
import type {
  ICreateOperationalInviteResponse,
  ICreateTreasuryInviteResponse,
  IListOperationalInvitesResponse,
  IOperationalUserInvite,
  IOperationalUserInviteCreateRequest,
  IOperationalUserInviteRegenerateRequest,
  IListTreasuryInvitesResponse,
  IRouterErrorResponse,
  ITreasuryUserInvite,
  ITreasuryUserInviteCreateRequest,
} from '@argonprotocol/apps-router';
import { type IConfigServerDetails, ServerType } from '../interfaces/IConfig.ts';
import { type ServerAuthClient, type ServerAuthOptions } from './ServerAuthClient.ts';

export type ServerGatewayDetails = Pick<IConfigServerDetails, 'ipAddress' | 'gatewayPort' | 'type'>;

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

type RequestOptions = {
  init?: RequestInit;
  timeoutMs?: number;
  adminOperatorAuth?: ServerAuthClient;
};

type ClientRequestOptions = Omit<RequestOptions, 'adminOperatorAuth'> & {
  adminOperatorAuth?: boolean;
};

export class ServerApiClient {
  constructor(
    private readonly getServerDetails: () => ServerGatewayDetails,
    private readonly serverAuthClient: ServerAuthClient,
  ) {}

  public getGatewayHttpUrl(path = ''): string {
    return ServerApiClient.getGatewayHttpUrl(this.getServerDetails(), path);
  }

  public getGatewayWebsocketUrl(path: string): string {
    return ServerApiClient.getGatewayWebsocketUrl(this.getServerDetails(), path);
  }

  public async ensureAdminOperatorSession(options: ServerAuthOptions = {}): Promise<void> {
    await this.serverAuthClient.ensureAdminOperatorSession(this.getGatewayHttpUrl(), options);
  }

  public async isGatewayReady(): Promise<boolean> {
    return await this.request<{ status?: string }>('/', { timeoutMs: 5e3 })
      .then(body => body.status === 'ok')
      .catch(() => false);
  }

  public async getTreasuryAppInvites(): Promise<ITreasuryUserInvite[]> {
    const body = await this.request<IListTreasuryInvitesResponse>('/treasury-users/invites', {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invites;
  }

  public async getOperationalInvites(): Promise<IOperationalUserInvite[]> {
    const body = await this.request<IListOperationalInvitesResponse>('/operational-users/invites', {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invites;
  }

  public async createTreasuryAppInvite(payload: ITreasuryUserInviteCreateRequest): Promise<ITreasuryUserInvite> {
    const body = await this.postJson<ICreateTreasuryInviteResponse>('/treasury-users/create', payload, {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invite;
  }

  public async createOperationalInvite(payload: IOperationalUserInviteCreateRequest): Promise<IOperationalUserInvite> {
    const body = await this.postJson<ICreateOperationalInviteResponse>('/operational-users/create', payload, {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invite;
  }

  public async regenerateOperationalInvite(
    inviteCode: string,
    payload: IOperationalUserInviteRegenerateRequest,
  ): Promise<IOperationalUserInvite> {
    const body = await this.postJson<ICreateOperationalInviteResponse>(
      `/operational-users/${encodeURIComponent(inviteCode)}/regenerate`,
      payload,
      {
        timeoutMs: 10e3,
        adminOperatorAuth: true,
      },
    );
    return body.invite;
  }

  private request<T>(path: string, options: ClientRequestOptions = {}): Promise<T> {
    return ServerApiClient.request<T>(this.getServerDetails(), path, {
      ...options,
      adminOperatorAuth: options.adminOperatorAuth ? this.serverAuthClient : undefined,
    });
  }

  private postJson<T>(path: string, payload: unknown, options: ClientRequestOptions = {}): Promise<T> {
    return this.request<T>(path, {
      ...options,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JsonExt.stringify(payload),
      },
    });
  }

  public static getGatewayHttpUrl(serverDetails: ServerGatewayDetails, path = ''): string {
    if (!serverDetails.ipAddress) {
      throw new Error('No server IP address configured');
    }

    const host = getGatewayHost(serverDetails);
    const port = serverDetails.gatewayPort && serverDetails.gatewayPort !== 443 ? `:${serverDetails.gatewayPort}` : '';
    const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
    return `https://${host}${port}${normalizedPath}`;
  }

  public static getGatewayWebsocketUrl(serverDetails: ServerGatewayDetails, path: string): string {
    return this.getGatewayHttpUrl(serverDetails, path).replace(/^http/i, 'ws');
  }

  public static async isGatewayReady(serverDetails: ServerGatewayDetails): Promise<boolean> {
    return await this.request<{ status?: string }>(serverDetails, '/', { timeoutMs: 5e3 })
      .then(body => body.status === 'ok')
      .catch(() => false);
  }

  public static async getBitcoinInstallProgress(serverDetails: ServerGatewayDetails): Promise<number> {
    const result = await this.request<ISyncStatus>(serverDetails, '/bitcoin/syncstatus', { timeoutMs: 30e3 }).catch(
      () => null,
    );
    return result?.syncPercent ?? 0;
  }

  public static async getBitcoinBlockChainInfo(serverDetails: ServerGatewayDetails): Promise<IBitcoinBlockChainInfo> {
    const blocks = await this.request<IBitcoinLatestBlocks>(serverDetails, '/bitcoin/latestblocks', {
      timeoutMs: 30e3,
    });
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
    }>(serverDetails, '/bitcoin/getblockchaininfo', { timeoutMs: 30e3 });

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

  public static async getArgonBlockChainInfo(serverDetails: ServerGatewayDetails): Promise<IArgonBlockChainInfo> {
    const { localNodeBlockNumber, mainNodeBlockNumber } = await this.request<ILatestBlocks>(
      serverDetails,
      '/argon/latestblocks',
      { timeoutMs: 10e3 },
    );
    const completeResponse = await this.request<boolean | object>(serverDetails, '/argon/iscomplete', {
      timeoutMs: 10e3,
    });

    return {
      localNodeBlockNumber,
      mainNodeBlockNumber,
      isComplete: completeResponse === true,
    };
  }

  public static async getArgonInstallProgress(serverDetails: ServerGatewayDetails): Promise<number> {
    const result = await this.request<ISyncStatus>(serverDetails, '/argon/syncstatus', { timeoutMs: 30e3 });
    return result?.syncPercent ?? 0;
  }

  private static async request<T>(
    serverDetails: ServerGatewayDetails,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const baseUrl = this.getGatewayHttpUrl(serverDetails);
    const abortController = new AbortController();
    const timeoutMs = options.timeoutMs ?? 10e3;
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    if (options.adminOperatorAuth) {
      await options.adminOperatorAuth.ensureAdminOperatorSession(baseUrl);
    }

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options.init,
        credentials: options.adminOperatorAuth ? 'include' : options.init?.credentials,
        headers: {
          ...(options.init?.headers as Record<string, string> | undefined),
        },
        signal: options.init?.signal ?? abortController.signal,
      });
      const rawBody = await response.text();
      let body: T | IRouterErrorResponse | string | undefined;
      if (rawBody) {
        try {
          body = JsonExt.parse<T | IRouterErrorResponse>(rawBody);
        } catch (error) {
          if (response.ok) throw error;
          body = rawBody;
        }
      }
      const error =
        body != null &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        'error' in body &&
        typeof body.error === 'string'
          ? body.error
          : !response.ok && typeof body === 'string'
            ? body
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

function getGatewayHost(serverDetails: ServerGatewayDetails): string {
  if (serverDetails.type === ServerType.LocalComputer && isLoopbackIp(serverDetails.ipAddress)) {
    return 'localhost';
  }

  return serverDetails.ipAddress;
}

function isLoopbackIp(ipAddress: string): boolean {
  return ipAddress === '127.0.0.1' || ipAddress === '::1';
}
