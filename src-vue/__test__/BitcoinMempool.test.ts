import type { Tx } from '@mempool/mempool.js/lib/interfaces/bitcoin/transactions';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import BitcoinMempool from '../lib/BitcoinMempool.ts';

describe('BitcoinMempool', () => {
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
