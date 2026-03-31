import type { AddressTxsUtxo } from '@mempool/mempool.js/lib/interfaces/bitcoin/addresses';
import type { TxStatus } from '@mempool/mempool.js/lib/interfaces/bitcoin/transactions';

export interface IMempoolTxStatus {
  isConfirmed: boolean;
  transactionBlockHeight: number;
  transactionBlockTime: number;
  argonBitcoinHeight: number;
}

export interface IMempoolFeeRate {
  feeRate: bigint; // sat/vB
  estimatedMinutes: number; // estimated time in minutes for the transaction to be included
}

export interface IMempoolFeeRates {
  fast: IMempoolFeeRate;
  medium: IMempoolFeeRate;
  slow: IMempoolFeeRate;
}

interface IMempoolFeeResponse {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
}

export default class BitcoinMempool {
  constructor(private readonly baseUrl?: string) {}

  public async getAddressUtxos(address: string): Promise<AddressTxsUtxo[]> {
    const utxos = await this.fetchJson<AddressTxsUtxo[]>(`address/${address}/utxo`);
    return utxos.map(utxo => ({ ...utxo, txid: this.convertBoundaryTxid(utxo.txid, 'argon') }));
  }

  public async getTipHeight(): Promise<number> {
    return await this.fetchJson<number>('blocks/tip/height');
  }

  public async getTxStatus(
    txid: string,
    oracleBitcoinBlockHeight: number,
    timeoutMs: number = 10e3,
  ): Promise<IMempoolTxStatus | undefined> {
    let status: TxStatus | undefined;
    let lastError: unknown;
    for (const mempoolTxid of this.toMempoolTxidCandidates(txid)) {
      try {
        status = await this.fetchJson<TxStatus>(`tx/${mempoolTxid}/status`, timeoutMs);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!status) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? '');
      console.warn(`Transaction status for txid ${txid} not found in mempool. ${message}`);
      console.warn(`Transaction status for txid ${txid} not found.`);
      return;
    }

    return {
      isConfirmed: status.confirmed,
      transactionBlockHeight: status.block_height,
      transactionBlockTime: status.block_time,
      argonBitcoinHeight: oracleBitcoinBlockHeight,
    };
  }

  public async broadcastTx(hexTx: string, timeoutMs: number = 20e3): Promise<string> {
    const response = await this.fetchText('tx', {
      timeoutMs,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: hexTx,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to broadcast transaction: ${response.status} ${response.statusText} - ${errorText}`);
    }
    const mempoolTxid = (await response.text()).trim();
    if (!mempoolTxid.match(/^[0-9a-fA-F]{64}$/)) {
      throw new Error(`Invalid transaction ID returned from broadcast: ${mempoolTxid}`);
    }
    return this.convertBoundaryTxid(mempoolTxid, 'argon');
  }

  public async getFeeRates(): Promise<IMempoolFeeRates> {
    const data = await this.fetchJson<IMempoolFeeResponse>('v1/fees/recommended');
    return {
      fast: { feeRate: BigInt(data.fastestFee), estimatedMinutes: 10 },
      medium: { feeRate: BigInt(data.halfHourFee), estimatedMinutes: 30 },
      slow: { feeRate: BigInt(data.hourFee), estimatedMinutes: 60 },
    };
  }

  public txUrl(txid: string): string {
    const mempoolTxid = this.convertBoundaryTxid(txid, 'mempool');
    const base = (this.baseUrl ?? 'https://mempool.space/api').replace(/\/api\/?$/, '');
    return `${base}/tx/${mempoolTxid}`;
  }

  public displayTxid(txid: string): string {
    const mempoolTxid = this.convertBoundaryTxid(txid, 'mempool');
    return `${mempoolTxid.slice(0, 8)}...${mempoolTxid.slice(-8)}`;
  }

  private getApiUrl(path: string): string {
    const baseUrl = this.baseUrl ?? 'https://mempool.space/api';
    return `${baseUrl}/${path}`;
  }

  private convertBoundaryTxid(txid: string, target: 'mempool' | 'argon'): string {
    const normalized = this.normalizeHexTxid(txid);
    if (!normalized) {
      return txid;
    }
    if (target === 'argon') {
      if (this.isPrefixedHex(txid)) return `0x${normalized}`;
      return `0x${this.reverseHexTxid(normalized)}`;
    }
    if (this.isPrefixedHex(txid)) return this.reverseHexTxid(normalized);
    return normalized;
  }

  private toMempoolTxidCandidates(txid: string): string[] {
    const normalized = this.normalizeHexTxid(txid);
    if (!normalized) return [txid];
    if (this.isPrefixedHex(txid)) {
      return [this.reverseHexTxid(normalized)];
    }
    const reversed = this.reverseHexTxid(normalized);
    if (reversed === normalized) return [normalized];
    return [normalized, reversed];
  }

  private normalizeHexTxid(txid: string): string | undefined {
    const normalized = (this.isPrefixedHex(txid) ? txid.slice(2) : txid).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) return;
    return normalized;
  }

  private isPrefixedHex(txid: string): boolean {
    return txid.startsWith('0x') || txid.startsWith('0X');
  }

  private reverseHexTxid(hex: string): string {
    return hex.match(/../g)?.reverse().join('') ?? hex;
  }

  private async fetchJson<T>(path: string, timeoutMs: number = 15e3): Promise<T> {
    const url = this.getApiUrl(path);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = (await response.text()).trim();
        } catch {
          // ignore
        }
        const suffix = errorBody ? ` - ${errorBody}` : '';
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}${suffix}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchText(path: string, options: RequestInit & { timeoutMs: number }): Promise<Response> {
    const { timeoutMs, signal: callerSignal, ...init } = options;
    const url = this.getApiUrl(path);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort();
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        cache: init.cache ?? 'no-store',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Fetch to ${url} aborted due to timeout after ${timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (callerSignal && !callerSignal.aborted) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    }
  }
}
