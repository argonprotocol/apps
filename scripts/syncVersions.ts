import * as fs from 'node:fs';
import * as Path from 'path';
import { version as packageVersion } from '../package.json';
import { readReleaseNotes } from './utils.ts';

(async () => {
  const dirname = Path.join(import.meta.dirname, '..');
  let versionFile = 'src-tauri/tauri.conf.json';
  if (packageVersion.includes('-rc')) {
    versionFile = 'src-tauri/tauri.experimental.conf.json';
  }
  const filePath = Path.join(dirname, versionFile);
  const file = fs.readFileSync(filePath, 'utf-8');
  const tauriConf = JSON.parse(file);
  tauriConf.version = packageVersion;
  if (packageVersion.includes('-rc')) {
    tauriConf.bundle.windows = {
      nsis: {
        version: packageVersion.replace('-rc', '.')
      },
    };
  }
  fs.writeFileSync(filePath, JSON.stringify(tauriConf, null, 2));

  const releaseNotes = readReleaseNotes(packageVersion, false);
  if (!releaseNotes) {
    console.info(`You need to add release notes for version ${packageVersion} in RELEASE_NOTES.md`);
    process.exit(1);
  }
})();
