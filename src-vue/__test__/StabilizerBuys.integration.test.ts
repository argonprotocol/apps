import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Keyring, u8aToHex } from '@argonprotocol/mainchain';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { toHex } from 'viem';
import {
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';
import { sudoSubmitAndFinalize } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { BlockWatch, MainchainClients, StabilizerBuy, type ArgonClient } from '@argonprotocol/apps-core';
import { setMainchainClients } from '../stores/mainchain.ts';
import { createTestDb } from './helpers/db.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { StabilizerBuys } from '../lib/StabilizerBuys.ts';
import { StabilizerBuyBid } from '../lib/txs/StabilizerBuy.bid.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';

describe('Stabilizer buy manual bids', { tags: ['isolated-argon-network'] }, () => {
  let network: StartedArgonTestNetwork;
  let client: ArgonClient;
  let clients: MainchainClients;
  let blockWatch: BlockWatch;
  let buys: StabilizerBuys;

  beforeAll(async () => {
    network = await startArgonTestNetwork(`stabilizer-bids-${randomUUID()}`, {
      profiles: ['bob'],
      ticksBetweenSlots: 1_000_000,
    });
    clients = new MainchainClients(network.archiveUrl);
    setMainchainClients(clients);
    client = await clients.get(false);
  }, 240_000);

  afterAll(async () => {
    await buys?.close();
    blockWatch?.destroy();
    await clients?.disconnect();
    await network?.stop();
  });

  it('bids on held principal, revises, and opts out without resetting the submission limit', async () => {
    const signer = new Keyring({ type: 'sr25519' }).addFromUri(
      integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'bidder'),
    );
    const request = { client, account: signer.address, admissionFrame: 12, rewardPercent: 33 };
    const spec = client.runtimeVersion.specVersion.toNumber();
    expect(spec).toBe(Number(process.env.ARGON_TEST_RUNTIME_SPEC ?? 161));
    if (spec === 160) {
      await expect(StabilizerBuy.buildBidTx(request)).rejects.toThrow('runtime upgrade');
      await expect(StabilizerBuy.getForAccount(client, signer.address)).rejects.toThrow('runtime upgrade');
      return;
    }

    // This scenario owns its chain. Seed an admitted purchase and funded auction; the real
    // runtime bid then decides acceptance, writes the ranked bid, and updates its counter.
    const raw = client.raw;
    const setup = await sudoSubmitAndFinalize(
      client,
      client.tx.utility.batchAll([
        client.tx.balances.forceSetBalance(signer.address, 100_000_000n),
        client.tx.system.setStorage([
          [raw.query.miningSlot.nextFrameId.key(), u8aToHex(client.registry.createType('u64', 14).toU8a())],
          [
            raw.query.stabilizerBuys.auctions.key(12),
            client.registry
              .createType('PalletStabilizerBuysAuction', {
                matchingRate: 750_000,
                totalMatchingBasis: 75,
                budget: 0,
                remainingBudget: 0,
                remainingMatchingBasis: 67,
                maturesAtFrame: 42,
              })
              .toHex(),
          ],
          [
            raw.query.stabilizerBuys.buysByAccountAndFrame.key(signer.address, toHex(12, { size: 8 })),
            client.registry
              .createType('PalletStabilizerBuysAccountFrameBuys', {
                pendingLiquidRepays: 0n,
                liquidRepaymentRewardRate: null,
                principal: 100_000_000n,
                capturedDiscount: 101,
                bidRate: 0,
                positiveBidCount: 0,
              })
              .toHex(),
          ],
          [
            raw.query.stabilizerBuys.payoutStateByAccount.key(signer.address),
            client.registry
              .createType('PalletStabilizerBuysAccountPayoutState', {
                payableReward: 37,
                nextPayoutFrame: null,
              })
              .toHex(),
          ],
        ]),
      ]),
      { useLatestNonce: true },
    );
    if (setup.extrinsicError) throw setup.extrinsicError;
    await waitFor(30_000, 'the current admission frame', async () => {
      return (await client.query.miningSlot.nextFrameId()) === 14;
    });

    const db = await createTestDb();
    blockWatch = new BlockWatch(clients);
    buys = new StabilizerBuys(blockWatch, signer.address, Promise.resolve(db));
    await buys.load();
    const tracker = new TransactionTracker(Promise.resolve(db), blockWatch);
    await tracker.load();
    const operation = new StabilizerBuyBid(buys, tracker);
    for (const rewardPercent of [33, 10, 20, 30]) {
      const result = await operation.submit({ client, txSigner: signer, admissionFrame: 12, rewardPercent });
      await result.waitForPostProcessing;
    }
    const snapshot = runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead()));
    const account = await StabilizerBuy.getForAccount(snapshot, signer.address);
    expect(account.payableReward).toBe(37n);
    expect(account.positions).toHaveLength(1);
    expect(account.positions[0].purchase).toMatchObject({ principal: 100_000_000n, positiveBidCount: 4 });
    expect(account.positions[0].matchingBasis).toBe(75n);
    expect(account.positions[0].requestedReward).toBe(22n);
    expect(await StabilizerBuy.getBids(snapshot, 12)).toEqual([
      { ownerAccount: signer.address, latestBid: 30, matchingBasis: 75n },
    ]);
    expect(buys.data.positions[0].requestedReward).toBe(22n);
    const records = await db.transactionsTable.fetchAll();
    expect(records).toHaveLength(4);
    expect(
      records.every(
        record =>
          record.extrinsicType === ExtrinsicType.StabilizerBuyBid && record.status === TransactionStatus.Finalized,
      ),
    ).toBe(true);
    await expect(StabilizerBuy.buildBidTx({ ...request, rewardPercent: 50 })).rejects.toThrow('positive bids');

    const optOut = await operation.submit({ client, txSigner: signer, admissionFrame: 12, rewardPercent: 0 });
    await optOut.waitForPostProcessing;
    const optedOut = await StabilizerBuy.getForAccount(
      runtimeClient(await client.raw.at(await client.rpc.chain.getFinalizedHead())),
      signer.address,
    );
    expect(optedOut.positions[0].purchase.positiveBidCount).toBe(4);
    expect(optedOut.positions[0].requestedReward).toBe(0n);
    expect(optedOut.positions[0].purchase.principal).toBe(100_000_000n);
    expect(optedOut.payableReward).toBe(37n);
    expect(buys.data.positions[0].requestedReward).toBe(0n);
    expect(buys.data.positions[0].purchase.positiveBidCount).toBe(4);
    expect(buys.heldPrincipal).toBe(100_000_000n);
    await db.sql.close();
  });
});
