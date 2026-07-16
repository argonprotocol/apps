import { describe, expect, it } from 'vitest';
import { isUserTransferEventSet } from '../src/WalletTransferEvents.ts';

describe('legacy wallet transfer events', () => {
  it('accepts direct, batched, and proxied wallet transfers', () => {
    const transfer = { section: 'balances', method: 'Transfer' };
    const success = { section: 'system', method: 'ExtrinsicSuccess' };

    expect(isUserTransferEventSet([transfer, success])).toBe(true);
    expect(isUserTransferEventSet([{ section: 'utility', method: 'BatchCompleted' }, transfer, success])).toBe(true);
    expect(isUserTransferEventSet([{ section: 'proxy', method: 'ProxyExecuted' }, transfer, success])).toBe(true);
  });

  it('does not index a balance movement emitted by another operation as a wallet transfer', () => {
    expect(
      isUserTransferEventSet([
        { section: 'balances', method: 'Transfer' },
        { section: 'vaults', method: 'VaultCollected' },
        { section: 'system', method: 'ExtrinsicSuccess' },
      ]),
    ).toBe(false);
  });
});
