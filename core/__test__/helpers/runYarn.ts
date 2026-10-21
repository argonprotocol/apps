import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import Path from 'node:path';

export function runYarn(args: string[], options: ExecFileSyncOptions = {}): void {
  execFileSync('yarn', args, {
    cwd: Path.resolve(import.meta.dirname, '../../..'),
    shell: process.platform === 'win32',
    stdio: 'inherit',
    ...options,
  });
}
