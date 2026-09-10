import { Keyring } from '@argonprotocol/mainchain';
import { expect, it, vi } from 'vitest';

import { MiningBidProxySetup } from '../lib/txs/MiningBidProxy.setup.ts';

it('recognizes the configured mining bid proxy without submitting another transaction', async () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const fundingAccount = keyring.addFromUri('//MiningFunding');
  const proxyAccount = keyring.addFromUri('//MiningProxy');
  const client = {
    query: {
      proxy: {
        proxies: vi.fn(async (accountId: string) => {
          if (accountId !== fundingAccount.address) throw new Error('Unexpected funding account.');
          return [
            [
              {
                delegate: proxyAccount.address,
                proxyType: { type: 'MiningBidRealPaysFee' },
              },
            ],
          ];
        }),
      },
      system: {
        account: vi.fn().mockResolvedValue({ data: { free: 2_000_000n } }),
      },
    },
  };
  const walletKeys = {
    getMiningBotKeypair: vi.fn().mockResolvedValue(fundingAccount),
    getMiningBidProxyKeypair: vi.fn().mockResolvedValue(proxyAccount),
  };
  const transactionTracker = {
    data: { txInfos: [] },
    pendingBlockTxInfosAtLoad: [],
    load: vi.fn(),
  };
  const operation = new MiningBidProxySetup(walletKeys as any, transactionTracker as any);

  await expect(operation.ensure(client as any)).resolves.toEqual({ kind: 'ready' });
});
