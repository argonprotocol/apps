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
    Fs.writeFileSync(
      Path.join(tempDir, 'docker'),
      `#!/bin/sh
echo "bitcoin RPC failure"
echo "compose warning" >&2
exit 17
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tempDir}:${originalPath}`;

    expect(() => runBtcCli(['getblockchaininfo'])).toThrow(
      'btc-cli failed (getblockchaininfo) with exit code 17:\ncompose warning\nbitcoin RPC failure',
    );
  });
});
