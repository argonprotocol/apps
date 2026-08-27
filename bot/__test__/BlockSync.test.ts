import { describe, expect, it } from 'vitest';
import { BlockSync } from '../src/BlockSync.ts';

describe('BlockSync mining transaction fees', () => {
  it.each([
    ['funding account', 'funding-account'],
    ['proxy signer', 'proxy-account'],
  ])('tracks a mining fee paid by the %s', async (_label, accountAddress) => {
    const feeEvent = {
      section: 'transactionPayment',
      method: 'TransactionFeePaid',
      data: { who: accountAddress, actualFee: 12_345n, tip: 0n },
    };
    const miningBidEvent = {
      section: 'miningSlot',
      method: 'SlotBidderAdded',
      data: {},
    };
    const blockSync = Object.create(BlockSync.prototype) as BlockSync;
    blockSync.accountset = {
      fundingAccountId: 'funding-account',
      txSubmitterPair: { address: 'proxy-account' },
    } as BlockSync['accountset'];

    const fee = await (
      blockSync as unknown as {
        extractOwnPaidTransactionFee(client: unknown, event: unknown, events: unknown[]): Promise<bigint>;
      }
    ).extractOwnPaidTransactionFee({} as any, feeEvent, [{ event: miningBidEvent }]);

    expect(fee).toBe(12_345n);
  });
});
