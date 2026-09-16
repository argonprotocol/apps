import { afterEach, describe, expect, it, vi } from 'vitest';
import basicEmitter from '../emitters/basicEmitter.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';

describe('wallet disconnect events', () => {
  afterEach(() => {
    basicEmitter.all.clear();
  });

  it('carries the canonical wallet when opening the disconnect overlay', () => {
    const listener = vi.fn();
    basicEmitter.on('openWalletDisconnectOverlay', listener);
    const wallet = new WalletForEthereum('0x0000000000000000000000000000000000000001');

    basicEmitter.emit('openWalletDisconnectOverlay', { wallet });

    expect(listener).toHaveBeenCalledWith({ wallet });
    expect(Object.keys(listener.mock.calls[0][0])).toEqual(['wallet']);
  });
});
