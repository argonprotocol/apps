import { Keyring } from '@argonprotocol/mainchain';
import { expect, it, vi } from 'vitest';
import { ensureMiningBidProxySetup } from '../lib/MiningAccount.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(),
}));

it('submits mining bid proxy registration through the archive client', async () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const fundingAccount = keyring.addFromUri('//MiningFunding');
  const proxyAccount = keyring.addFromUri('//MiningProxy');
  const tx = {};
  const archiveClient = {
    query: {
      proxy: {
        proxies: vi.fn().mockResolvedValue([[]]),
      },
      system: {
        account: vi.fn().mockResolvedValue({
          data: {
            free: {
              toBigInt: () => 2_000_000n,
            },
          },
        }),
      },
    },
    tx: {
      balances: {
        transferAllowDeath: vi.fn().mockReturnValue('fund-proxy'),
      },
      proxy: {
        addProxy: vi.fn().mockReturnValue('register-proxy'),
      },
      utility: {
        batchAll: vi.fn().mockReturnValue(tx),
      },
    },
  };
  const transactionTracker = {
    findLatestTxInfo: vi.fn(),
    submitAndWatch: vi.fn().mockResolvedValue({ tx: { id: 1 } }),
  };
  const walletKeys = {
    getMiningBotKeypair: vi.fn().mockResolvedValue(fundingAccount),
    getMiningBidProxyKeypair: vi.fn().mockResolvedValue(proxyAccount),
  };
  vi.mocked(getMainchainClient).mockResolvedValue(archiveClient as any);

  await ensureMiningBidProxySetup({
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
  });

  expect(getMainchainClient).toHaveBeenCalledWith(true);
  expect(transactionTracker.submitAndWatch).toHaveBeenCalledWith({
    client: archiveClient,
    tx,
    txSigner: fundingAccount,
    useLatestNonce: true,
    extrinsicType: ExtrinsicType.MiningBidProxySetup,
    metadata: {
      fundingAccountId: fundingAccount.address,
      proxyAccountId: proxyAccount.address,
    },
  });
});
