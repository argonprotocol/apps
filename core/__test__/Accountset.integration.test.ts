import { integrationNetwork as network } from './integration.setup.ts';
import { createKeyringPair, ExtrinsicError, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { SKIP_E2E, teardown } from '@argonprotocol/testing';
import { Accountset, type ArgonClient, getRange, TxSubmitter, TxSigner } from '../src/index.ts';
import { it, beforeAll, afterAll, describe, expect, inject } from 'vitest';
import { integrationAccountUri } from './integrationNetwork.ts';
import { waitFor } from './helpers/waitFor.ts';
import { getTestMainchainClient } from './helpers/mainchain.ts';
import { runtimeClient, type LiveRuntimeQueries } from '@argonprotocol/runtime-client';

afterAll(teardown);

describe.skipIf(SKIP_E2E)('Public mining bid transactions', { tags: ['mining-auction'] }, () => {
  let client: ArgonClient;
  const sessionMiniSecretOrMnemonic = mnemonicGenerate();
  const fundingAccount = new Keyring({ type: 'sr25519' }).addFromUri(
    integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded'),
  );

  beforeAll(async () => {
    client = await getTestMainchainClient(network.archiveUrl);
  });

  it.each([
    { mode: 'direct', firstMinerIndex: 0 },
    { mode: 'proxy', firstMinerIndex: 5 },
  ])(
    'awards the selected miners from a $mode public bid and charges its funder',
    async ({ mode, firstMinerIndex }) => {
      const signer = mode === 'proxy' ? createKeyringPair({}) : fundingAccount;
      const accountset = new Accountset({
        client,
        txSubmitter: new TxSigner(signer),
        fundingAccountId: fundingAccount.address,
        isProxy: mode === 'proxy',
        subaccountRange: getRange(firstMinerIndex, firstMinerIndex + 5),
        sessionMiniSecretOrMnemonic,
      });
      await accountset.registerKeys(network.archiveUrl);

      if (accountset.isProxy) {
        const setup = await accountset.planMiningBidProxySetup();
        if (setup.kind !== 'tx') throw new Error(`Expected proxy setup transaction, got ${setup.kind}`);
        const result = await new TxSubmitter(client, setup.tx, new TxSigner(fundingAccount)).submit({
          useLatestNonce: true,
        });
        await result.waitForFinalizedBlock;
        expect(await accountset.planMiningBidProxySetup()).toEqual({ kind: 'ready' });
      }
      const signerBalanceBefore = (await client.query.system.account(signer.address)).data.free;

      const miners = await accountset.getAvailableMinerAccounts(5);
      expect(miners).toHaveLength(5);
      const minerAddresses = new Set(Object.keys(accountset.subAccountsByAddress));
      expect(miners.map(miner => miner.address).sort()).toEqual([...minerAddresses].sort());

      let lastAttemptedFrame = await client.query.miningSlot.nextFrameId();
      const { frameId, result } = await waitFor(
        120_000,
        'finalized public bid in an accepting auction',
        async () => {
          const snapshot = await client.at(await client.rpc.chain.getBlockHash());
          const api = runtimeClient<typeof snapshot.raw, LiveRuntimeQueries>(snapshot.raw);
          const [frameId, open, admissionClosed] = await Promise.all([
            api.query.miningSlot.nextFrameId(),
            api.query.miningSlot.isNextSlotBiddingOpen(),
            api.query.miningSlot.auctionAdmissionClosed(),
          ]);
          if (frameId <= lastAttemptedFrame || frameId <= 1) return;
          if (!open || admissionClosed) return;

          lastAttemptedFrame = frameId;
          const submitter = await accountset.createMiningBidTx({ bidAmount: 10_000n, subaccounts: miners, frameId });
          const result = await submitter.submit({ useLatestNonce: true });
          try {
            await result.waitForFinalizedBlock;
          } catch (error) {
            // Admission can close or the frame can change before execution.
            // Retry only when the first call failed, so this batch placed no partial bids.
            if (!(error instanceof ExtrinsicError)) throw error;
            if (error.batchInterruptedIndex !== 0) throw error;
            if (error.errorCode === 'miningSlot.SlotNotTakingBids' || error.errorCode === 'miningSlot.WrongBidFrame') {
              return;
            }
            throw error;
          }
          return { frameId, result };
        },
        { retryErrors: false },
      );
      expect(result.extrinsicError).toBeUndefined();
      expect(result.batchInterruptedIndex).toBeUndefined();

      const payment = result.events.find(
        event => event.section === 'transactionPayment' && event.method === 'TransactionFeePaid',
      );
      if (!payment || payment.section !== 'transactionPayment' || payment.method !== 'TransactionFeePaid') {
        throw new Error('Finalized mining bid fee payment is missing');
      }
      expect(payment.data.who).toBe(fundingAccount.address);
      expect(payment.data.actualFee).toBeGreaterThan(0n);

      const winners = await waitFor(90_000, 'finalized public bid winners', async () => {
        const finalizedHash = await client.rpc.chain.getFinalizedHead();
        const api = await client.at(finalizedHash);
        const cohort = (await api.query.miningSlot.minersByCohort(frameId)) ?? [];
        const selected = cohort.filter(miner => minerAddresses.has(miner.accountId));
        if (selected.length === miners.length) return selected;
      });
      expect(winners.map(miner => miner.accountId).sort()).toEqual([...minerAddresses].sort());
      for (const winner of winners) {
        expect(winner.externalFundingAccount).toBe(fundingAccount.address);
        expect(winner.bid).toBe(10_000n);
      }

      if (accountset.isProxy) {
        expect((await client.query.system.account(signer.address)).data.free).toBe(signerBalanceBefore);
      }
    },
    180_000,
  );
});
