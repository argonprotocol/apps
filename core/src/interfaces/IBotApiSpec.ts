import type { IBotState, IBotStateStarting } from './IBotStateFile.ts';
import type { IBitcoinBlockMeta } from './IBitcoinBlockMeta.ts';
import type { IHistoryFile } from './IHistoryFile.ts';
import type { IBidsFile } from './IBidsFile.ts';
import type { IEarningsFile } from './IEarningsFile.ts';

export interface IBotApiSpec {
  '/state': () => Promise<IBotState | IBotStateStarting>;
  '/bitcoin-recent-blocks': () => Promise<IBitcoinBlockMeta[]>;
  '/history': () => Promise<IHistoryFile>;
  '/bids': (cohortBiddingFrameId?: number) => Promise<IBidsFile>;
  '/earnings': (frameId: number) => Promise<IEarningsFile>;
  '/heartbeat': () => Promise<void>;
}

export type IBotApiMethod = keyof IBotApiSpec;
export type IBotApiResponse<M extends IBotApiMethod> = ReturnType<IBotApiSpec[M]>;

export type JsonRpcRequest<M extends IBotApiMethod = IBotApiMethod> = {
  jsonrpc: '2.0';
  id: number;
  method: M;
  params?: Parameters<IBotApiSpec[M]>;
};

export type JsonRpcResponse<M extends IBotApiMethod = IBotApiMethod> =
  | { jsonrpc: '2.0'; id: number; result: Awaited<IBotApiResponse<M>> }
  | { jsonrpc: '2.0'; id: number; error: { code: number; message: string } }
  | { jsonrpc: '2.0'; event: IBotApiMethod; data: Awaited<IBotApiResponse<M>> };
