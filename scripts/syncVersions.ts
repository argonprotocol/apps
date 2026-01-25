import * as fs from 'node:fs';
import * as Path from 'path';
import { version as packageVersion } from '../package.json';
import { readReleaseNotes } from './utils.ts';

(async () => {
  for (const app of ['operations', 'capital']) {
    updateFile('src-tauri/tauri.conf.json')
    updateFile(`src-tauri/tauri.${app}.experimental.conf.json`)
  }
  const releaseNotes = readReleaseNotes(packageVersion, false);
  if (!releaseNotes) {
    console.info(`You need to add release notes for version ${packageVersion} in RELEASE_NOTES.md`);
    process.exit(1);
  }
})();

function updateFile(fileName: string) {
  const dirname = Path.join(import.meta.dirname, '..');
  const filePath = Path.join(dirname, fileName);
  const fileData = fs.readFileSync(filePath, 'utf-8');
  const tauriConf = JSON.parse(fileData);
  tauriConf.version = packageVersion;
  fs.writeFileSync(filePath, JSON.stringify(tauriConf, null, 2));
}