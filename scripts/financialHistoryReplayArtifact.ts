import Fs from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import Path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { u8aToHex } from '@polkadot/util';
import { compressSeed, extractSeed, writeAtomically } from '../indexer/src/seedArtifacts.ts';

const command = process.argv[2];
const seedDirectory = Path.join(import.meta.dirname, '../indexer/seeds');
const databaseFile = 'mainnet-financial-history-replay.db';
const compressedFile = `${databaseFile}.gz`;
const manifestFile = 'financial-history-replay-manifest.json';
const databasePath = Path.join(seedDirectory, databaseFile);
const compressedPath = Path.join(seedDirectory, compressedFile);
const manifestPath = Path.join(seedDirectory, manifestFile);

if (command === 'package') {
  const manifest = inspectReplayDatabase(databasePath);
  await compressSeed(databasePath, compressedPath);
  const artifact = {
    formatVersion: 1,
    network: 'mainnet',
    file: compressedFile,
    sizeBytes: Fs.statSync(compressedPath).size,
    databaseSizeBytes: Fs.statSync(databasePath).size,
    sha256: await sha256File(compressedPath),
    ...manifest,
  };
  await writeAtomically(manifestPath, temporaryPath => {
    return Fs.promises.writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
  });
  console.log(`Packaged mainnet financial history replay corpus at block ${artifact.blockNumber}`);
} else if (command === 'extract') {
  await extractAndVerify(compressedPath, manifestPath, databasePath);
  console.log(`Extracted mainnet financial history replay corpus to ${databasePath}`);
} else if (command === 'download') {
  const image = process.argv[3] ?? 'ghcr.io/argonprotocol/financial-history-replay-corpus:latest';
  const downloadDirectory = await mkdtemp(Path.join(seedDirectory, '.financial-history-replay-download-'));
  const downloadedDatabasePath = Path.join(downloadDirectory, databaseFile);
  const downloadedCompressedPath = Path.join(downloadDirectory, compressedFile);
  const downloadedManifestPath = Path.join(downloadDirectory, manifestFile);
  const execFileAsync = promisify(execFile);
  let containerId: string | undefined;

  try {
    await execFileAsync('docker', ['pull', image]);
    containerId = (await execFileAsync('docker', ['create', image])).stdout.trim();
    await execFileAsync('docker', ['cp', `${containerId}:/replay/${compressedFile}`, downloadedCompressedPath]);
    await execFileAsync('docker', ['cp', `${containerId}:/replay/${manifestFile}`, downloadedManifestPath]);
    await extractAndVerify(downloadedCompressedPath, downloadedManifestPath, downloadedDatabasePath);

    await rename(downloadedCompressedPath, compressedPath);
    await rename(downloadedManifestPath, manifestPath);
    await rename(downloadedDatabasePath, databasePath);
    console.log(`Downloaded ${image} to ${databasePath}`);
  } finally {
    if (containerId) await execFileAsync('docker', ['rm', '-f', containerId]).catch(() => undefined);
    await rm(downloadDirectory, { recursive: true, force: true });
  }
} else {
  throw new Error('Usage: financialHistoryReplayArtifact.ts <package|extract|download> [image]');
}

async function extractAndVerify(
  sourcePath: string,
  sourceManifestPath: string,
  destinationPath: string,
): Promise<void> {
  const manifest = JSON.parse(Fs.readFileSync(sourceManifestPath, 'utf8')) as ReturnType<
    typeof inspectReplayDatabase
  > & {
    formatVersion: number;
    network: string;
    file: string;
    sizeBytes: number;
    databaseSizeBytes: number;
    sha256: string;
  };
  if (manifest.formatVersion !== 1 || manifest.network !== 'mainnet' || manifest.file !== compressedFile) {
    throw new Error('Unsupported financial history replay manifest');
  }
  if (Fs.statSync(sourcePath).size !== manifest.sizeBytes || (await sha256File(sourcePath)) !== manifest.sha256) {
    throw new Error('Financial history replay artifact does not match its manifest');
  }

  await extractSeed(sourcePath, destinationPath);
  const database = inspectReplayDatabase(destinationPath);
  const hasMismatchedIdentity = Object.entries(database).some(([key, value]) => {
    return manifest[key as keyof typeof database] !== value;
  });
  if (Fs.statSync(destinationPath).size !== manifest.databaseSizeBytes || hasMismatchedIdentity) {
    throw new Error('Extracted financial history replay database does not match its manifest');
  }
}

function inspectReplayDatabase(path: string) {
  const database = new DatabaseSync(path, { open: true, readOnly: true });
  try {
    const check = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok') throw new Error(`Financial history replay database failed integrity check`);

    const sync = database
      .prepare(`SELECT blockNumber, definitionVersion FROM SyncState WHERE id = 'accountActivity'`)
      .get() as { blockNumber: number; definitionVersion: number } | undefined;
    if (!sync) throw new Error('Financial history replay database has no activity checkpoint');

    const schema = database.prepare('SELECT MAX(version) AS version FROM SchemaVersion').get() as { version: number };
    const blocks = database
      .prepare(
        `SELECT COUNT(*) AS count,
                MIN(blockNumber) AS first,
                MAX(blockNumber) AS last,
                COUNT(systemEvents) AS eventPayloadCount,
                COUNT(DISTINCT specVersion) AS runtimeVersionCount
         FROM Blocks`,
      )
      .get() as {
      count: number;
      first: number;
      last: number;
      eventPayloadCount: number;
      runtimeVersionCount: number;
    };
    if (
      blocks.first !== 1 ||
      blocks.last !== sync.blockNumber ||
      blocks.count !== sync.blockNumber ||
      blocks.eventPayloadCount !== blocks.count
    ) {
      throw new Error('Financial history replay database does not contain contiguous raw block events');
    }

    const metadata = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM RuntimeMetadata
         WHERE specVersion IN (SELECT DISTINCT specVersion FROM Blocks)`,
      )
      .get() as { count: number };
    if (metadata.count !== blocks.runtimeVersionCount) {
      throw new Error('Financial history replay database is missing runtime metadata');
    }

    const checkpoint = database.prepare('SELECT blockHash FROM Blocks WHERE blockNumber = ?').get(sync.blockNumber) as {
      blockHash: Uint8Array;
    };
    const accountBlocks = database.prepare('SELECT COUNT(*) AS count FROM AccountBlocks').get() as { count: number };
    const recoveryStorage = database.prepare('SELECT COUNT(*) AS count FROM RecoveryStorage').get() as {
      count: number;
    };
    const recoveryStorageKeyEnumerations = database
      .prepare('SELECT COUNT(*) AS count FROM RecoveryStorageKeyEnumerations')
      .get() as { count: number };
    const recoveryHeaders = database.prepare('SELECT COUNT(*) AS count FROM RecoveryHeaders').get() as {
      count: number;
    };
    if (!recoveryStorage.count || !recoveryStorageKeyEnumerations.count || !recoveryHeaders.count) {
      throw new Error('Financial history replay database has no captured recovery state');
    }

    return {
      blockNumber: sync.blockNumber,
      blockHash: u8aToHex(checkpoint.blockHash),
      definitionVersion: sync.definitionVersion,
      schemaVersion: schema.version,
      blockCount: blocks.count,
      runtimeVersionCount: blocks.runtimeVersionCount,
      accountBlockCount: accountBlocks.count,
      recoveryStorageCount: recoveryStorage.count,
      recoveryStorageKeyEnumerationCount: recoveryStorageKeyEnumerations.count,
      recoveryHeaderCount: recoveryHeaders.count,
    };
  } finally {
    database.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Fs.createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
