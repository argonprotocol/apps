import { describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync }));

import { runBtcCli } from './helpers/bitcoinCli.ts';

describe('bitcoin CLI', () => {
  it('preserves the useful process result when Docker fails', () => {
    spawnSync.mockReturnValue({
      status: 17,
      signal: null,
      error: undefined,
      stderr: 'compose warning\n',
      stdout: 'bitcoin RPC failure\n',
    });

    expect(() => runBtcCli(['getblockchaininfo'])).toThrow(
      'btc-cli failed (getblockchaininfo) with exit code 17:\ncompose warning\nbitcoin RPC failure',
    );
  });
});
