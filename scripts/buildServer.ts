import * as tar from 'tar';
import * as fs from 'node:fs';
import * as Path from 'path';
import * as os from 'node:os';
import { createHash } from 'crypto';
import { version as packageVersion } from '../package.json';

(async () => {
  const dirname = import.meta.dirname;
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
  const routerSourceDir = Path.join(dirname, '../router');
  try {
    fs.cpSync(serverSourceDir, stagingDir, { recursive: true });
    fs.cpSync(routerSourceDir, Path.join(stagingDir, 'router'), { recursive: true });
    await tar.create(
      {
        gzip: { mtime: 0 } as any,
        portable: true,
        noMtime: true, // need for deterministic hashes
        file: filePath,
        cwd: stagingDir,
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
