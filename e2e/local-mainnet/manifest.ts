import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import Path from 'node:path';

export interface LocalMainnetArchive {
  url: string;
  blockNumber: number;
  blockHash: string;
  deployedSpecVersion: number;
  chopsticksDatabasePath: string;
  sha256: string;
}

export interface LocalMainnetIndexerSeed {
  databasePath: string;
  blockNumber: number;
  blockHash: string;
  sha256: string;
}

export interface LocalMainnetManifest {
  formatVersion: 1;
  network: 'mainnet';
  archive: LocalMainnetArchive;
  indexer: LocalMainnetIndexerSeed;
}

export function loadLocalMainnetManifest(path: string): LocalMainnetManifest {
  return parseLocalMainnetManifest(readManifest(path), Path.dirname(realpathSync(path)));
}

function readManifest(path: string): Record<string, unknown> {
  const manifestPath = existingPath(path, 'manifestPath', 'file');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid manifestPath: ${(error as Error).message}`);
  }
  return record(value, 'manifest');
}

function parseLocalMainnetManifest(manifest: Record<string, unknown>, directory: string): LocalMainnetManifest {
  const formatVersion = integer(manifest.formatVersion, 'formatVersion', 1);
  if (formatVersion !== 1) invalid('formatVersion', 'must be 1');
  const network = string(manifest.network, 'network');
  if (network !== 'mainnet') invalid('network', 'must be mainnet');

  const archiveValue = record(manifest.archive, 'archive');
  const indexerValue = record(manifest.indexer, 'indexer');

  const archive: LocalMainnetArchive = {
    url: archiveUrl(archiveValue.url),
    blockNumber: integer(archiveValue.blockNumber, 'archive.blockNumber', 0),
    blockHash: hash(archiveValue.blockHash, 'archive.blockHash', true),
    deployedSpecVersion: integer(archiveValue.deployedSpecVersion, 'archive.deployedSpecVersion', 1),
    chopsticksDatabasePath: existingPath(
      Path.resolve(directory, string(archiveValue.chopsticksDatabasePath, 'archive.chopsticksDatabasePath')),
      'archive.chopsticksDatabasePath',
      'file',
    ),
    sha256: hash(archiveValue.sha256, 'archive.sha256', false),
  };
  const indexer: LocalMainnetIndexerSeed = {
    databasePath: existingPath(
      Path.resolve(directory, string(indexerValue.databasePath, 'indexer.databasePath')),
      'indexer.databasePath',
      'file',
    ),
    blockNumber: integer(indexerValue.blockNumber, 'indexer.blockNumber', 0),
    blockHash: hash(indexerValue.blockHash, 'indexer.blockHash', true),
    sha256: hash(indexerValue.sha256, 'indexer.sha256', false),
  };
  if (archive.blockNumber !== indexer.blockNumber) {
    invalid('indexer.blockNumber', `must match archive.blockNumber ${archive.blockNumber}`);
  }
  if (archive.blockHash !== indexer.blockHash) {
    invalid('indexer.blockHash', 'must match archive.blockHash');
  }
  return {
    formatVersion: 1,
    network: 'mainnet',
    archive,
    indexer,
  };
}

export function resolveMainchainDirectory(args: {
  appsRoot: string;
  explicitDirectory?: string;
  environmentDirectory?: string;
}): string {
  const configuredDirectory = args.explicitDirectory?.trim() || args.environmentDirectory?.trim();
  const selectedDirectory = configuredDirectory || projectsSiblingMainchain(args.appsRoot);
  const mainchainDirectory = existingPath(selectedDirectory, 'mainchainDirectory', 'directory');

  let gitRoot: string;
  try {
    gitRoot = realpathSync(
      execFileSync('git', ['-C', mainchainDirectory, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    );
  } catch (error) {
    invalid('mainchainDirectory', `is not a Git repository: ${(error as Error).message}`);
  }
  if (gitRoot !== mainchainDirectory) {
    invalid('mainchainDirectory', `must be the Mainchain Git root, got Git root ${gitRoot}`);
  }

  existingPath(Path.join(mainchainDirectory, 'Cargo.toml'), 'mainchainDirectory.Cargo.toml', 'file');
  const runtimeDirectory = Path.join(mainchainDirectory, 'runtime', 'argon');
  const runtimeManifestPath = existingPath(
    Path.join(runtimeDirectory, 'Cargo.toml'),
    'mainchainDirectory.runtime.Cargo.toml',
    'file',
  );
  existingPath(Path.join(runtimeDirectory, 'src', 'lib.rs'), 'mainchainDirectory.runtime.lib', 'file');
  if (!/^name\s*=\s*["']argon-runtime["']\s*$/m.test(readFileSync(runtimeManifestPath, 'utf8'))) {
    invalid('mainchainDirectory.runtime', 'runtime package must be named argon-runtime');
  }
  return mainchainDirectory;
}

function projectsSiblingMainchain(appsRoot: string): string {
  const canonicalAppsRoot = existingPath(appsRoot, 'appsRoot', 'directory');
  let gitCommonDirectory: string;
  try {
    gitCommonDirectory = execFileSync(
      'git',
      ['-C', canonicalAppsRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (error) {
    invalid('appsRoot', `is not an Apps Git checkout: ${(error as Error).message}`);
  }

  const canonicalCommonDirectory = existingPath(gitCommonDirectory, 'appsRoot.gitCommonDirectory', 'directory');
  if (Path.basename(canonicalCommonDirectory) !== '.git') {
    invalid('appsRoot.gitCommonDirectory', `expected a .git directory, got ${canonicalCommonDirectory}`);
  }
  const primaryAppsRoot = Path.dirname(canonicalCommonDirectory);
  return Path.join(Path.dirname(primaryAppsRoot), 'mainchain');
}

function archiveUrl(value: unknown): string {
  const url = string(value, 'archive.url');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    invalid('archive.url', 'must be an absolute URL');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname) {
    invalid('archive.url', 'must use HTTP or WebSocket transport');
  }
  return url;
}

function existingPath(value: unknown, field: string, kind: 'file' | 'directory'): string {
  const path = string(value, field);
  if (!Path.isAbsolute(path)) invalid(field, 'must be an absolute path');

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
  } catch (error) {
    invalid(field, `does not exist: ${(error as Error).message}`);
  }

  const stats = statSync(canonicalPath);
  if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) {
    invalid(field, `must be a ${kind}`);
  }
  return canonicalPath;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field, 'must be a non-empty string');
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(field, `must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function hash(value: unknown, field: string, prefixed: boolean): string {
  const hash = string(value, field);
  const pattern = prefixed ? /^0x[0-9a-fA-F]{64}$/ : /^[0-9a-fA-F]{64}$/;
  if (!pattern.test(hash)) invalid(field, `must be a ${prefixed ? '0x-prefixed ' : ''}32-byte hexadecimal hash`);
  return hash.toLowerCase();
}

function invalid(field: string, message: string): never {
  throw new Error(`Invalid ${field}: ${message}`);
}
