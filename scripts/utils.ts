import fs from 'node:fs';
import { createServer } from 'node:net';
import { version as packageVersion } from '../package.json';

export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export function reserveEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to reserve an ephemeral port')));
        return;
      }
      const { port } = address;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

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
