import {
  type ArgonClient,
  createKeyringPair,
  getClient,
  mnemonicGenerate,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import { sudo, teardown } from '@argonprotocol/testing';
import { Accountset, parseSubaccountRange } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startArgonTestNetwork } from './startArgonTestNetwork.js';

afterAll(teardown);

describe
  .skipIf(() => Boolean(JSON.parse(process.env.SKIP_E2E ?? '0')))
  .sequential('Accountset tests', {}, () => {
    let client: ArgonClient;
    let mainchainUrl: string;
    const sessionMiniSecretOrMnemonic = mnemonicGenerate();
    beforeAll(async () => {
      const network = await startArgonTestNetwork('accountset', { profiles: ['bob'] });

      mainchainUrl = network.archiveUrl;
      client = await getClient(mainchainUrl);
    });

    it('can derive multiple accounts', async () => {
      const seedAccount = createKeyringPair({});
      const accountset = new Accountset({
        client,
        seedAccount,
        subaccountRange: parseSubaccountRange('0-49'),
        sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
      });

      expect(Object.keys(accountset.subAccountsByAddress).length).toBe(50);
      expect(accountset.accountRegistry.getName(seedAccount.address)).toContain('//seed');
      for (const i of Object.keys(accountset.subAccountsByAddress)) {
        expect(accountset.accountRegistry.getName(i)).toBeTruthy();
      }
    });

    it.sequential('can register keys from a mnemonic', async () => {
      const seedAccount = sudo();
      const accountset = new Accountset({
        client,
        seedAccount,
        subaccountRange: parseSubaccountRange('0-49'),
        sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
      });

      await expect(accountset.registerKeys(mainchainUrl)).resolves.toBeUndefined();
    });

    it.sequential('can submit bids', async () => {
      const seedAccount = sudo();
      const accountset = new Accountset({
        client,
        seedAccount,
        subaccountRange: parseSubaccountRange('0-49'),
        sessionMiniSecretOrMnemonic: sessionMiniSecretOrMnemonic,
      });
      const txSubmitter = new TxSubmitter(
        client,
        client.tx.sudo.sudo(client.tx.ownership.forceSetBalance(seedAccount.address, 500_000)),
        seedAccount,
      );
      await txSubmitter.submit({ waitForBlock: true });

      const nextSeats = await accountset.getAvailableMinerAccounts(5);
      expect(nextSeats).toHaveLength(5);
      const existingBids = await accountset.bids();
      expect(existingBids.filter(x => x.bidPlace !== undefined)).toHaveLength(0);
      {
        const result = await accountset.createMiningBids({
          bidAmount: 1000n,
          subaccountRange: [0, 1, 2, 3, 4],
          tip: 100n,
        });
        expect(result).toBeTruthy();
        expect(result.finalFee).toBeGreaterThan(6000);
        expect(result.successfulBids).toBe(0);
        expect(result.bidError?.stack).toMatch('InvalidBidAmount');
      }
      const result = await accountset.createMiningBids({
        bidAmount: 10_000n,
        subaccountRange: [0, 1, 2, 3, 4],
        tip: 100n,
      });
      console.log('Mining bid result', result);
      expect(result).toBeTruthy();
      expect(result.finalFee).toBeGreaterThan(6000);
      expect(result.successfulBids).toBe(5);
      expect(result.bidError).toBeFalsy();
      // check for bids or registered seats
      const seats = await accountset.miningSeats(result.blockHash);
      expect(seats.filter(x => !!x.seat || x.hasWinningBid)).toHaveLength(5);
    });

    it.sequential('can will handle a subset of failed bids', async () => {
      const alice = sudo();
      const secondAccount = createKeyringPair({});

      const api = client;
      const txSubmitter = new TxSubmitter(
        api,
        api.tx.sudo.sudo(
          api.tx.utility.batchAll([
            api.tx.balances.forceSetBalance(secondAccount.address, 5_000_000),
            api.tx.ownership.forceSetBalance(secondAccount.address, 500_000),
          ]),
        ),
        alice,
      );
      await txSubmitter.submit({ waitForBlock: true });
      const startingCohortStartingFrameId = await api.query.miningSlot.nextFrameId().then(x => x.toNumber());
      await new Promise(resolve =>
        api.query.miningSlot.nextFrameId(x => {
          if (x.toNumber() > startingCohortStartingFrameId) {
            resolve(true);
          }
        }),
      );

      const account = new Accountset({
        client,
        seedAccount: alice,
        subaccountRange: parseSubaccountRange('0-49'),
        sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      });
      const subaccounts = await account.getAvailableMinerAccounts(7);
      const alice_result = await account.createMiningBids({
        bidAmount: 2_000_000n,
        subaccountRange: subaccounts.map(x => x.index),
      });
      expect(alice_result.bidError).toBeFalsy();
      expect(alice_result.successfulBids).toBe(7);

      const second_bids = await new Accountset({
        client,
        seedAccount: secondAccount,
        subaccountRange: parseSubaccountRange('0-49'),
        sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      }).createMiningBids({
        bidAmount: 500_000n,
        subaccountRange: [0, 1, 2, 3, 4],
        tip: 100n,
      });
      expect(second_bids).toBeTruthy();
      expect(second_bids.finalFee).toBeGreaterThan(6000n);
      expect(second_bids.successfulBids).toBe(3);
      expect(second_bids.bidError?.stack).toMatch('BidTooLow');
    });
  });
