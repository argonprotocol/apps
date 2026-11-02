import { NetworkConfig } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { encodeAddress } from '@polkadot/util-crypto';
import { describe, expect, it } from 'vitest';
import { findFinancialHistoryActivity } from '../lib/recovery/index.ts';

describe.runIf(process.env.FINANCIAL_HISTORY_LIVE_SMOKE === '1')(
  'Live financial history services',
  { tags: ['no-argon-network'] },
  () => {
    it('provides indexed history through a fixed finalized RPC cutoff', { timeout: 90_000 }, async () => {
      const previousNetwork = NetworkConfig.networkName!;
      const client = await getClient('https://rpc.argon.network');
      try {
        NetworkConfig.setNetwork('mainnet');
        const finalizedHash = await client.rpc.chain.getFinalizedHead();
        const finalizedHeader = await client.rpc.chain.getHeader(finalizedHash);
        const cutoff = finalizedHeader.number.toNumber();
        const accountId = encodeAddress(new Uint8Array(32).fill(0x22));

        await expect
          .poll(
            async () => {
              const history = await findFinancialHistoryActivity(accountId, 'bonds', {
                afterBlock: 0,
                toBlock: cutoff,
              });
              return Math.min(history.asOfBlock, history.coverage.toBlock);
            },
            { timeout: 60_000, interval: 2_000 },
          )
          .toBeGreaterThanOrEqual(cutoff);
      } finally {
        await client.disconnect();
        NetworkConfig.setNetwork(previousNetwork);
      }
    });
  },
);
