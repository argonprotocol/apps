import * as tar from 'tar';
import * as fs from 'node:fs';
import * as Path from 'path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'crypto';
import { version as packageVersion } from '../package.json';
import type { WriteEntry } from 'tar';

function getGitExecutablePaths(repoRoot: string): Set<string> {
  const result = spawnSync('git', ['ls-files', '--stage', 'server'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const details = result.error?.message || result.stderr || result.stdout || 'unknown error';
    throw new Error(`Unable to read git file modes for server bundle: ${details}`);
  }

  const executablePaths = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^100755\s+\S+\s+\d+\t(.+)$/.exec(line);
    if (!match) continue;

    const repoPath = match[1].replace(/\\/g, '/');
    if (!repoPath.startsWith('server/')) continue;
    executablePaths.add(repoPath.slice('server/'.length));
  }
  return executablePaths;
}

(async () => {
  const dirname = import.meta.dirname;
  const repoRoot = Path.join(dirname, '..');
  const resourcesDir = Path.join(dirname, '../resources');
  const files = fs.readdirSync(resourcesDir);
  const serverFiles = files.filter(file => file.startsWith('server-') || file === 'SHASUM256');
  for (const file of serverFiles) {
    fs.unlinkSync(Path.join('resources', file));
  }
  const version = `${packageVersion}`;
  const fileName = `server-${version}.tar.gz`;
  const filePath = Path.join('resources', fileName);
  const stagingDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'argon-server-bundle-'));
  const serverSourceDir = Path.join(dirname, '../server');
  const executablePaths = getGitExecutablePaths(repoRoot);
  try {
    fs.cpSync(serverSourceDir, stagingDir, { recursive: true });
    await tar.create(
      {
        gzip: { mtime: 0 } as any,
        portable: true,
        noMtime: true, // need for deterministic hashes
        file: filePath,
        cwd: stagingDir,
        onWriteEntry: (entry: WriteEntry) => {
          const normalizedPath = entry.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
          if (!executablePaths.has(normalizedPath) || !entry.stat) return;
          entry.stat.mode |= 0o111;
        },
      },
      [''],
    );

    // Compute SHA256 checksum
    const checksum = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    console.log(`SHA256: ${checksum}`);
    fs.writeFileSync(Path.join(resourcesDir, 'SHASUM256'), `${checksum}  ${fileName}\n`);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
})();
