import { afterEach, describe, expect, it, vi } from 'vitest';
import basicEmitter from '../emitters/basicEmitter.ts';

describe('wallet disconnect events', () => {
  afterEach(() => {
    basicEmitter.all.clear();
  });

  it('carries only the wallet record ID when opening the disconnect overlay', () => {
    const listener = vi.fn();
    basicEmitter.on('openWalletDisconnectOverlay', listener);

    basicEmitter.emit('openWalletDisconnectOverlay', { walletRecordId: 42 });

    expect(listener).toHaveBeenCalledWith({ walletRecordId: 42 });
    expect(Object.keys(listener.mock.calls[0][0])).toEqual(['walletRecordId']);
  });
});
