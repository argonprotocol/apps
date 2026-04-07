import { encode as rlpEncode } from '@ethereumjs/rlp';
import { Trie } from '@ethereumjs/trie';
import { hexToBytes, toHex, type Address, type Hash, type Hex, type PublicClient } from 'viem';

export interface StableSwapReceiptProof {
  txHash: string;
  blockHash: string;
  receiptRoot: string;
  transactionIndex: number;
  receiptType?: string;
  keyRlp: string;
  receiptRlp: string;
  proof: string[];
}

type StableSwapRawReceipt = {
  blockHash: Hash;
  blockNumber: Hex;
  cumulativeGasUsed: Hex;
  logs: Array<{
    address: Address;
    data: Hex;
    topics: Hex[];
  }>;
  logsBloom: Hex;
  root?: Hex;
  status?: Hex;
  transactionHash: Hash;
  transactionIndex: Hex;
  type?: Hex;
};

export async function buildStableSwapReceiptProofs(args: {
  client: PublicClient;
  blockHash: Hash;
  txHashes: string[];
}): Promise<Record<string, StableSwapReceiptProof>> {
  const { client, blockHash, txHashes } = args;
  const block = await client.getBlock({
    blockHash,
  });

  const trie = await Trie.create();
  const rawReceipts = await mapWithConcurrency(block.transactions, 8, async txHash => {
    return await client.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
  });

  const receiptsByHash = new Map<string, StableSwapRawReceipt>();
  const encodedReceiptsByHash = new Map<string, Uint8Array>();

  for (const rawReceipt of rawReceipts as StableSwapRawReceipt[]) {
    if (!rawReceipt) continue;

    const key = encodeReceiptKey(rawReceipt.transactionIndex);
    const encodedReceipt = encodeEthereumReceipt(rawReceipt);

    receiptsByHash.set(rawReceipt.transactionHash.toLowerCase(), rawReceipt);
    encodedReceiptsByHash.set(rawReceipt.transactionHash.toLowerCase(), encodedReceipt);
    await trie.put(key, encodedReceipt);
  }

  const computedRoot = toHex(trie.root());
  if (!block.receiptsRoot || computedRoot.toLowerCase() !== block.receiptsRoot.toLowerCase()) {
    throw new Error(`Receipt proof root mismatch for Ethereum block ${blockHash}`);
  }

  const proofs: Record<string, StableSwapReceiptProof> = {};
  for (const txHash of txHashes) {
    const normalizedHash = txHash.toLowerCase();
    const receipt = receiptsByHash.get(normalizedHash);
    const encodedReceipt = encodedReceiptsByHash.get(normalizedHash);
    if (!receipt || !encodedReceipt) {
      continue;
    }

    const key = encodeReceiptKey(receipt.transactionIndex);
    const proof = await trie.createProof(key);

    proofs[normalizedHash] = {
      txHash: receipt.transactionHash,
      blockHash,
      receiptRoot: block.receiptsRoot,
      transactionIndex: Number(BigInt(receipt.transactionIndex)),
      receiptType: receipt.type && receipt.type !== '0x0' ? receipt.type : undefined,
      keyRlp: toHex(key),
      receiptRlp: toHex(encodedReceipt),
      proof: proof.map(node => toHex(node)),
    };
  }

  return proofs;
}

function encodeReceiptKey(transactionIndex: Hex): Uint8Array {
  return rlpEncode(BigInt(transactionIndex));
}

function encodeEthereumReceipt(receipt: StableSwapRawReceipt): Uint8Array {
  const payload = rlpEncode([
    receipt.status ?? receipt.root ?? '0x',
    receipt.cumulativeGasUsed,
    receipt.logsBloom,
    receipt.logs.map(log => [log.address, log.topics, log.data]),
  ]);

  if (!receipt.type || receipt.type === '0x0') {
    return payload;
  }

  const prefix = hexToBytes(receipt.type);
  const encoded = new Uint8Array(prefix.length + payload.length);
  encoded.set(prefix, 0);
  encoded.set(payload, prefix.length);
  return encoded;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}
