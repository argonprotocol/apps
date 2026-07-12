import { describe, expect, it } from 'vitest';
import { BlockSync } from '../src/BlockSync.ts';

describe('BlockSync mining transaction fees', () => {
  it.each([
    ['funding account', 'funding-account'],
    ['proxy signer', 'proxy-account'],
  ])('tracks a mining fee paid by the %s', async (_label, accountAddress) => {
    const feeEvent = {
      type: 'fee',
      data: [{ toHuman: () => accountAddress }, { toBigInt: () => 12_345n }],
    };
    const miningBidEvent = { type: 'mining-bid' };
    const client = {
      events: {
        transactionPayment: {
          TransactionFeePaid: { is: (event: { type: string }) => event.type === 'fee' },
        },
        utility: {
          BatchInterrupted: { is: () => false },
        },
        system: {
          ExtrinsicFailed: { is: () => false },
        },
        miningSlot: {
          SlotBidderAdded: { is: (event: { type: string }) => event.type === 'mining-bid' },
        },
      },
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
    ).extractOwnPaidTransactionFee(client, feeEvent, [{ event: miningBidEvent }]);

    expect(fee).toBe(12_345n);
  });
});
