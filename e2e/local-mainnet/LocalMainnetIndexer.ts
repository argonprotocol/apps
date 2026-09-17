import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { u8aToHex } from '@polkadot/util';
import { IndexerServer } from '../../indexer/src/IndexerServer.ts';
import { delay } from '../../scripts/utils.ts';
import type { RuntimeMigrationManifest } from './manifest.ts';

const INDEXER_DATABASE_FILE = 'mainnet-activity-v2.db';
const WAIT_TIMEOUT_MS = 30_000;

export interface LocalMainnetIndexerFacts {
  checkpoint: {
    blockNumber: number;
    blockHash: string;
  };
  blocks: Array<{
    blockNumber: number;
    blockHash: string;
    specVersion: number;
  }>;
  runtimeMetadataSpecVersions: number[];
}

export class LocalMainnetIndexer {
  public readonly url: string;
  private stopped = false;

  private constructor(
    private readonly manifest: RuntimeMigrationManifest,
    private readonly databasePath: string,
    private readonly server: IndexerServer,
  ) {
    this.url = `http://127.0.0.1:${server.port}`;
  }

  public static async start(args: {
    manifest: RuntimeMigrationManifest;
    forkArchiveUrl: string;
    runDirectory: string;
  }): Promise<LocalMainnetIndexer> {
    const { manifest, forkArchiveUrl, runDirectory } = args;
    if (!Path.isAbsolute(runDirectory)) {
      throw new Error('Runtime migration indexer runDirectory must be an absolute path');
    }

    LocalMainnetIndexer.verifySha256(manifest.indexer.databasePath, manifest.indexer.sha256);
    mkdirSync(runDirectory, { recursive: true });
    const databasePath = Path.join(runDirectory, INDEXER_DATABASE_FILE);
    if (!existsSync(databasePath)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const sourcePath = `${manifest.indexer.databasePath}${suffix}`;
        if (existsSync(sourcePath)) {
          copyFileSync(sourcePath, `${databasePath}${suffix}`, constants.COPYFILE_EXCL);
        }
      }
    }

    const initialFacts = LocalMainnetIndexer.inspectDatabase(databasePath, manifest.archive.blockNumber);
    const anchor = initialFacts.blocks[0];
    if (
      initialFacts.checkpoint.blockNumber < manifest.indexer.blockNumber ||
      anchor?.blockNumber !== manifest.indexer.blockNumber ||
      anchor.blockHash !== manifest.indexer.blockHash
    ) {
      throw new Error('Copied indexer database does not match the runtime migration manifest');
    }

    const server = new IndexerServer({
      port: 0,
      dbDir: runDirectory,
      network: 'mainnet',
      mainchainUrl: forkArchiveUrl,
    });
    await server.start();
    return new LocalMainnetIndexer(manifest, databasePath, server);
  }

  public inspect(): LocalMainnetIndexerFacts {
    return LocalMainnetIndexer.inspectDatabase(this.databasePath, this.manifest.archive.blockNumber);
  }

  public async waitForBlock(blockNumber: number): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const facts = this.inspect();
      if (facts.checkpoint.blockNumber >= blockNumber) {
        const response = await fetch(`${this.url}/v2/activity/${this.manifest.capturedDatabase.defaultArgonAccountId}`);
        if (response.ok) {
          const activity = (await response.json()) as { asOfBlock?: unknown };
          if (activity.asOfBlock === facts.checkpoint.blockNumber) return;
        }
      }
      await delay(100);
    }
    throw new Error(`Indexer did not commit block ${blockNumber} within ${WAIT_TIMEOUT_MS}ms`);
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    await this.server.stop();
    this.stopped = true;
  }

  private static inspectDatabase(databasePath: string, firstBlock: number): LocalMainnetIndexerFacts {
    const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
    try {
      const sync = database.prepare(`SELECT blockNumber FROM SyncState WHERE id = 'accountActivity'`).get() as
        | { blockNumber: number }
        | undefined;
      if (!sync) throw new Error('Indexer database has no accountActivity checkpoint');

      const checkpoint = database
        .prepare('SELECT blockNumber, blockHash FROM Blocks WHERE blockNumber = ?')
        .get(sync.blockNumber) as { blockNumber: number; blockHash: Uint8Array } | undefined;
      if (!checkpoint) throw new Error(`Indexer database has no block for checkpoint ${sync.blockNumber}`);

      const blocks = database
        .prepare('SELECT blockNumber, blockHash, specVersion FROM Blocks WHERE blockNumber >= ? ORDER BY blockNumber')
        .all(firstBlock) as unknown as Array<{ blockNumber: number; blockHash: Uint8Array; specVersion: number }>;
      const runtimeMetadata = database
        .prepare('SELECT specVersion FROM RuntimeMetadata ORDER BY specVersion')
        .all() as unknown as Array<{ specVersion: number }>;

      return {
        checkpoint: {
          blockNumber: checkpoint.blockNumber,
          blockHash: u8aToHex(checkpoint.blockHash),
        },
        blocks: blocks.map(block => ({
          blockNumber: block.blockNumber,
          blockHash: u8aToHex(block.blockHash),
          specVersion: block.specVersion,
        })),
        runtimeMetadataSpecVersions: runtimeMetadata.map(record => record.specVersion),
      };
    } finally {
      database.close();
    }
  }

  private static verifySha256(path: string, expected: string): void {
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== expected) throw new Error(`Runtime migration artifact checksum mismatch at ${path}`);
  }
}
