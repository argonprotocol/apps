import { describe, expect, it, vi } from 'vitest';
import BitcoinMempool from '../lib/BitcoinMempool.ts';

describe('BitcoinMempool', () => {
  it('queries tx status using mempool-order txids as-is', async () => {
    const mempool = new BitcoinMempool('https://example.invalid');
    const fetchJson = vi.fn().mockResolvedValue({
      confirmed: true,
      block_height: 123,
      block_time: 456,
    });
    Object.defineProperty(mempool, 'fetchJson', { value: fetchJson, configurable: true });

    const txid = createMempoolTxid();
    const result = await mempool.getTxStatus(txid, 100);

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith(`tx/${txid}/status`, 10_000);
    expect(result).toEqual({
      isConfirmed: true,
      transactionBlockHeight: 123,
      transactionBlockTime: 456,
      argonBitcoinHeight: 100,
    });
  });

  it('falls back to reversed txid for legacy argon-order hex without 0x', async () => {
    const mempool = new BitcoinMempool('https://example.invalid');
    const mempoolTxid = createMempoolTxid();
    const argonOrderNoPrefix = reverseHexTxid(mempoolTxid);
    const fetchJson = vi.fn().mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({
      confirmed: false,
      block_height: 0,
      block_time: 0,
    });
    Object.defineProperty(mempool, 'fetchJson', { value: fetchJson, configurable: true });

    await mempool.getTxStatus(argonOrderNoPrefix, 100);

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchJson).toHaveBeenNthCalledWith(1, `tx/${argonOrderNoPrefix}/status`, 10_000);
    expect(fetchJson).toHaveBeenNthCalledWith(2, `tx/${mempoolTxid}/status`, 10_000);
  });

  it('converts mempool txids to canonical argon order for address utxos', async () => {
    const mempool = new BitcoinMempool('https://example.invalid');
    const mempoolTxid = createMempoolTxid();
    const fetchJson = vi.fn().mockResolvedValue([
      {
        txid: mempoolTxid,
        vout: 1,
        value: 1_000,
        status: {
          confirmed: false,
          block_height: 0,
          block_time: 0,
          block_hash: '',
        },
      },
    ]);
    Object.defineProperty(mempool, 'fetchJson', { value: fetchJson, configurable: true });

    const utxos = await mempool.getAddressUtxos('bc1qexample');

    expect(utxos).toHaveLength(1);
    expect(utxos[0].txid).toBe(`0x${reverseHexTxid(mempoolTxid)}`);
  });
});

function createMempoolTxid(): string {
  return '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
}

function reverseHexTxid(hex: string): string {
  return hex.match(/../g)?.reverse().join('') ?? hex;
}
