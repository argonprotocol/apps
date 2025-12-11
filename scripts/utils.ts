import fs from 'node:fs';
import { version as packageVersion } from '../package.json';

export function readReleaseNotes(rawVersion: string = packageVersion, logError = true): string | null {
  // normalize: strip leading v, but match with or without
  const version = rawVersion.replace(/^v/, '').trim();
  const dirname = import.meta.dirname;
  // read line by line and look for the version header
  const releaseNotes = fs.readFileSync(`${dirname}/../RELEASE_NOTES.md`, 'utf8');
  const lines = releaseNotes.split(/\r?\n/);
  let versionNotes = '';
  let isInSection = false;
  for (const line of lines) {
    if (line.startsWith(`## [${version}]`)) {
      isInSection = true;
      continue; // Skip the version header line
    }
    if (isInSection) {
      if (/^##\s+/.test(line)) {
        // Reached the next version section
        break;
      }
      versionNotes += line + '\n';
    }
  }
  versionNotes = versionNotes.trim();
  if (!versionNotes) {
    if (logError) console.error(`Release notes for version ${rawVersion} not found.`);
    return null;
  }

  return versionNotes;
}
