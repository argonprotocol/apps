import type { Tx } from '@mempool/mempool.js/lib/interfaces/bitcoin/transactions';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '@argonprotocol/apps-core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import BitcoinMempool from '../lib/BitcoinMempool.ts';

afterEach(() => {
  setFetchImplementation();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BitcoinMempool', () => {
  it('recovers when the native HTTP response body ignores cancellation', async () => {
    vi.useFakeTimers();
    const blockHash = '12'.repeat(32);
    let requests = 0;
    const sentBodyChunks = new Set<number>();
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { rid: number }) => {
          if (command === 'plugin:http|fetch') return ++requests;
          if (command === 'plugin:http|fetch_send') {
            return { status: 200, statusText: 'OK', url: 'https://example.invalid', headers: [], rid: args.rid };
          }
          if (command === 'plugin:http|fetch_read_body') {
            if (args.rid === 1) return new Promise(() => {});
            if (sentBodyChunks.has(args.rid)) return new Uint8Array([1]).buffer;
            sentBodyChunks.add(args.rid);
            return new Uint8Array([...new TextEncoder().encode(blockHash), 0]).buffer;
          }
          if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body') return;
          throw new Error(`Unexpected native HTTP command: ${command}`);
        },
      },
    });
    setFetchImplementation(tauriFetch);

    const mempool = new BitcoinMempool('https://example.invalid');
    let result: string | undefined;
    const reading = mempool.getBlockHash(100).then(hash => {
      result = hash;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result).toBe(`0x${blockHash}`);
    await reading;
    expect(requests).toBe(2);
  });

  it.each(['text', 'json'])(
    'recovers a timed-out %s read when Tauri rejects with a cancellation string',
    async format => {
      vi.useFakeTimers();
      const blockHash = '12'.repeat(32);
      const transport = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (transport.mock.calls.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject('Request canceled'), { once: true });
          });
        }
        return Promise.resolve(new Response(format === 'text' ? blockHash : '100'));
      });
      setFetchImplementation(transport);

      const mempool = new BitcoinMempool('https://example.invalid');
      const reading = format === 'text' ? mempool.getBlockHash(100) : mempool.getTipHeight();
      await Promise.all([
        expect(reading).resolves.toBe(format === 'text' ? `0x${blockHash}` : 100),
        vi.advanceTimersByTimeAsync(15_000),
      ]);
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['read', 'broadcast'])('bounds a persistent timeout for a Bitcoin %s', async operation => {
    vi.useFakeTimers();
    const transport = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject('Request canceled'), { once: true });
      });
    });
    setFetchImplementation(transport);

    const mempool = new BitcoinMempool('https://example.invalid');
    const request = operation === 'read' ? mempool.getBlockHash(100) : mempool.broadcastTx('00', 10_000);
    await Promise.all([
      expect(request).rejects.toThrow('The Bitcoin service timed out. Please try again.'),
      vi.advanceTimersByTimeAsync(20_000),
    ]);
    expect(transport).toHaveBeenCalledTimes(operation === 'read' ? 2 : 1);
  });

  it('distinguishes missing transactions from pending and confirmed transactions', async () => {
    const txid = createMempoolTxid();
    const transaction: Pick<Tx, 'status'> = {
      status: { confirmed: false, block_height: 0, block_time: 0, block_hash: '' },
    };
    const server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      response.setHeader('Content-Type', 'application/json');
      if (path.endsWith('/status')) {
        // Electrs returns this even when the transaction does not exist.
        response.end(JSON.stringify({ confirmed: false }));
      } else if (path === `/tx/${txid}`) {
        response.end(JSON.stringify(transaction));
      } else {
        response.statusCode = 404;
        response.end('Transaction not found');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const mempool = new BitcoinMempool(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      expect(await mempool.getTxStatus(`0x${'ab'.repeat(32)}`, 100)).toBeUndefined();
      expect(await mempool.getTxStatus(`0x${reverseHexTxid(txid)}`, 100)).toMatchObject({
        isConfirmed: false,
        argonBitcoinHeight: 100,
      });

      transaction.status = { confirmed: true, block_height: 123, block_time: 456, block_hash: '12'.repeat(32) };
      expect(await mempool.getTxStatus(txid, 100)).toEqual({
        isConfirmed: true,
        transactionBlockHeight: 123,
        transactionBlockTime: 456,
        transactionBlockHash: `0x${'12'.repeat(32)}`,
        argonBitcoinHeight: 100,
      });
      expect(await mempool.getTxStatus(reverseHexTxid(txid), 100)).toMatchObject({
        isConfirmed: true,
        transactionBlockHeight: 123,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it('converts mempool transaction and block hashes to canonical argon order for address utxos', async () => {
    const mempool = new BitcoinMempool('https://example.invalid');
    const mempoolTxid = createMempoolTxid();
    const blockHash = '0123456789abcdef'.repeat(4);
    const fetchJson = vi.fn().mockResolvedValue([
      {
        txid: mempoolTxid,
        vout: 1,
        value: 1_000,
        status: {
          confirmed: true,
          block_height: 123,
          block_time: 0,
          block_hash: blockHash,
        },
      },
    ]);
    Object.defineProperty(mempool, 'fetchJson', { value: fetchJson, configurable: true });

    const utxos = await mempool.getAddressUtxos('bc1qexample');

    expect(utxos).toHaveLength(1);
    expect(utxos[0].txid).toBe(`0x${reverseHexTxid(mempoolTxid)}`);
    expect(utxos[0].status.block_hash).toBe(`0x${reverseHexTxid(blockHash)}`);
  });

  it('finds the confirmed transaction that spent a canonical funding outpoint', async () => {
    const mempool = new BitcoinMempool('https://example.invalid');
    const fundingMempoolTxid = createMempoolTxid();
    const spendingMempoolTxid = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
    const fetchJson = vi.fn().mockResolvedValue({
      spent: true,
      txid: spendingMempoolTxid,
      vin: 0,
      status: {
        confirmed: true,
        block_height: 321,
        block_time: 654,
        block_hash: '00'.repeat(32),
      },
    });
    Object.defineProperty(mempool, 'fetchJson', { value: fetchJson, configurable: true });

    const result = await mempool.getOutspendStatus(`0x${reverseHexTxid(fundingMempoolTxid)}`, 2, 300);

    expect(fetchJson).toHaveBeenCalledWith(`tx/${fundingMempoolTxid}/outspend/2`, 10_000);
    expect(result).toEqual({
      txid: `0x${reverseHexTxid(spendingMempoolTxid)}`,
      isConfirmed: true,
      transactionBlockHeight: 321,
      transactionBlockTime: 654,
      argonBitcoinHeight: 300,
    });
  });
});

function createMempoolTxid(): string {
  return '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
}

function reverseHexTxid(hex: string): string {
  return hex.match(/../g)?.reverse().join('') ?? hex;
}
