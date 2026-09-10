import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBtcCli } from './helpers/bitcoinCli.ts';

describe('bitcoin CLI', () => {
  const originalPath = process.env.PATH;
  let tempDir: string | undefined;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (tempDir) Fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves the useful process result when Docker fails', () => {
    tempDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-bitcoin-cli-'));
    const dockerExecutable = process.platform === 'win32' ? 'docker.cmd' : 'docker';
    const dockerFailure =
      process.platform === 'win32'
        ? '@echo off\r\necho bitcoin RPC failure\r\necho compose warning 1>&2\r\nexit /b 17\r\n'
        : `#!/bin/sh
echo "bitcoin RPC failure"
echo "compose warning" >&2
exit 17
`;
    Fs.writeFileSync(Path.join(tempDir, dockerExecutable), dockerFailure, { mode: 0o755 });
    process.env.PATH = `${tempDir}${Path.delimiter}${originalPath ?? ''}`;

    expect(() => runBtcCli(['getblockchaininfo'])).toThrow(
      'btc-cli failed (getblockchaininfo) with exit code 17:\ncompose warning\nbitcoin RPC failure',
    );
  });
});
