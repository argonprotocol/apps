import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const helpersPath = fileURLToPath(new URL('../../server/scripts/helpers.sh', import.meta.url));
const testDirectories: string[] = [];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('installer disk failures', () => {
  it('stops an active service and records a failure before disk is exhausted', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'argon-installer-'));
    testDirectories.push(logsDir);

    const result = runHelpersScript(
      logsDir,
      `
        df() {
          printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 104857600 99614720 5242880 95%% /test\\n'
        }
        sudo() {
          printf '%s\\n' "$*" > "$TEST_LOGS_DIR/stopped-service"
        }
        ensure_free_disk_space /test 10 argon-miner
      `,
    );

    expect(result.status).toBe(1);
    expect(readFileSync(join(logsDir, 'stopped-service'), 'utf8')).toContain('docker compose stop argon-miner');
    expect(readFileSync(join(logsDir, 'step-ArgonInstall.Failed'), 'utf8')).toContain(
      'Server is running out of disk space (5 GiB available; 10 GiB required)',
    );
  });

  it('reports a disk-specific failure when a command reaches ENOSPC', () => {
    const logsDir = mkdtempSync(join(tmpdir(), 'argon-installer-'));
    testDirectories.push(logsDir);

    const result = runHelpersScript(
      logsDir,
      `run_command "printf 'write failed: No space left on device\\n' >&2; exit 1"`,
    );

    expect(result.status).toBe(1);
    expect(readFileSync(join(logsDir, 'step-ArgonInstall.Failed'), 'utf8')).toContain(
      'Server ran out of disk space while installing. Free disk space and retry.',
    );
  });
});

function runHelpersScript(logsDir: string, script: string) {
  return spawnSync(
    'bash',
    [
      '-c',
      `
        logs_dir="$TEST_LOGS_DIR"
        source "$HELPERS_PATH"
        akey="ArgonInstall"
        ${script}
      `,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HELPERS_PATH: helpersPath,
        TEST_LOGS_DIR: logsDir,
      },
    },
  );
}
