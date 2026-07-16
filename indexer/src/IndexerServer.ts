import cors from 'cors';
import express from 'express';
import * as Fs from 'node:fs';
import * as http from 'node:http';
import Path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { u8aToHex } from '@polkadot/util';
import { type ArgonClient, getClient } from '@argonprotocol/mainchain';
import type { IAccountActivityQuery, IIndexerSpec } from '@argonprotocol/apps-core';
import { IndexerDb, ACCOUNT_ACTIVITY_DEFINITION_VERSION } from './IndexerDb.ts';
import { AccountActivityIndexer } from './AccountActivityIndexer.ts';
import { FinalizedBlockIndexer } from './FinalizedBlockIndexer.ts';
import { LegacyIndexerDb, WalletTransferCurrency, WalletTransferSource } from './LegacyIndexerDb.ts';

export class IndexerServer {
  public port: number;
  public network: string;

  private server!: http.Server;
  private readonly blockIndexer?: FinalizedBlockIndexer;
  private readonly legacyDb?: LegacyIndexerDb;
  private readonly db?: IndexerDb;
  private readonly activityIndexer?: AccountActivityIndexer;
  private readonly clientPromise: Promise<ArgonClient>;
  private activityStartupError?: Error;
  private legacyStartup?: Promise<void>;

  constructor(args: { port: number; dbDir: string; network: string; mainchainUrl: string }) {
    this.port = args.port;
    this.network = args.network;

    const legacyDatabasePath = Path.join(args.dbDir, `${args.network}.db`);
    if (Fs.existsSync(legacyDatabasePath)) {
      this.legacyDb = new LegacyIndexerDb(legacyDatabasePath);
      this.blockIndexer = new FinalizedBlockIndexer(this.legacyDb);
    }

    try {
      copySeedIfNeeded(args.dbDir, `${args.network}-activity-v2.db`);
      this.db = new IndexerDb(Path.join(args.dbDir, `${args.network}-activity-v2.db`));
      this.activityIndexer = new AccountActivityIndexer(this.db);
    } catch (error) {
      this.activityStartupError = error instanceof Error ? error : new Error(String(error));
      console.error('Account activity is unavailable', this.activityStartupError);
    }

    this.clientPromise = getClient(args.mainchainUrl);
  }

  public async start(): Promise<void> {
    const app = express();
    const client = await this.clientPromise;
    const chain = await client.rpc.system.chain().then(x => x.toString());
    if (this.network === 'mainnet' && chain !== 'Argon') {
      throw new Error(`Indexer network mismatch: expected Argon, got ${chain}`);
    }
    if (this.network === 'testnet' && chain !== 'Argon Testnet') {
      throw new Error(`Indexer network mismatch: expected Argon Testnet, got ${chain}`);
    }

    if (this.activityIndexer) {
      try {
        await this.activityIndexer.start(client);
      } catch (error) {
        this.activityStartupError = error instanceof Error ? error : new Error(String(error));
        console.error('Account activity failed to start', this.activityStartupError);
        await this.activityIndexer.close();
      }
    }
    if (this.blockIndexer) {
      // V1 remains available for already-synced deployments, but neither its
      // subscription setup nor its historical catch-up may delay v2 or HTTP.
      this.legacyStartup = this.blockIndexer.start(client).catch(error => {
        console.error('Legacy indexer failed to start', error);
      });
    }

    app.use(cors({ origin: true, methods: ['GET'] }));

    const legacyDb = this.legacyDb;
    if (legacyDb) {
      app.get('/transfers/:address', (req, res) => {
        const transfers = legacyDb.findAddressTransfers(req.params.address).map(record => ({
          blockNumber: record.blockNumber,
          fromAddress: record.fromAddress,
          toAddress: record.toAddress,
          source: {
            [WalletTransferSource.Transfer]: 'transfer',
            [WalletTransferSource.Faucet]: 'faucet',
            [WalletTransferSource.TokenGateway]: 'tokenGateway',
            [WalletTransferSource.Ethereum]: 'ethereum',
          }[record.source],
          currency: {
            [WalletTransferCurrency.Argon]: 'argon',
            [WalletTransferCurrency.Argonot]: 'argonot',
          }[record.currency],
        }));

        res
          .status(200)
          .type('application/json')
          .send({
            transfers,
            asOfBlock: legacyDb.latestSyncedBlock,
          } as IIndexerSpec['/transfers/:address']['responseType']);
      });

      app.get('/vault-collects/:address', (req, res) => {
        res
          .status(200)
          .type('application/json')
          .send({
            vaultCollects: legacyDb.findVaultCollects(req.params.address),
            asOfBlock: legacyDb.latestSyncedBlock,
          } as IIndexerSpec['/vault-collects/:address']['responseType']);
      });
    }

    app.get('/v2/activity/:address', (req, res) => {
      if (!this.db || this.activityStartupError) {
        res.status(503).type('application/json').send({ error: 'Account activity is unavailable' });
        return;
      }

      const afterBlock = Number(req.query.afterBlock ?? 0);
      const toBlock = Number(req.query.toBlock ?? Number.MAX_SAFE_INTEGER);
      const activityMask = Number(req.query.activityMask ?? 0x7fffffff);
      if (![afterBlock, toBlock, activityMask].every(Number.isSafeInteger)) {
        res.status(400).type('application/json').send({ error: 'Invalid activity filters' });
        return;
      }

      const filters: IAccountActivityQuery = {
        afterBlock,
        toBlock,
        activityMask,
      };
      const blocks = this.db.findAddressActivity(req.params.address, filters).map(record => ({
        ...record,
        blockHash: u8aToHex(record.blockHash),
      }));
      res
        .status(200)
        .type('application/json')
        .send({
          blocks,
          asOfBlock: this.db.latestSyncedBlock,
          definitionVersion: ACCOUNT_ACTIVITY_DEFINITION_VERSION,
          coverage: {
            fromBlock: 0,
            toBlock: this.db.latestSyncedBlock,
            gaps: this.activityIndexer?.coverageGap ? [this.activityIndexer.coverageGap] : [],
          },
        } as IIndexerSpec['/v2/activity/:address']['responseType']);
    });

    app.use((_req, res) => res.status(404).send('Not Found'));

    await new Promise<void>(resolve => {
      this.server = app.listen(this.port, '0.0.0.0', () => {
        const addressInfo = this.server.address();
        if (typeof addressInfo === 'object' && addressInfo) this.port = addressInfo.port;
        console.log(`Server is running on port ${this.port}`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.activityIndexer?.close();
    await this.legacyStartup;
    await this.blockIndexer?.close();
    this.db?.close();
    this.legacyDb?.close();

    const client = await this.clientPromise;
    await client.disconnect();
  }
}

function copySeedIfNeeded(dbDir: string, file: string): void {
  const databasePath = Path.join(dbDir, file);
  const seedPath = Path.join(import.meta.dirname, '..', 'seeds', file);
  Fs.mkdirSync(dbDir, { recursive: true });
  if (Fs.existsSync(databasePath)) return;

  try {
    Fs.copyFileSync(seedPath, databasePath, Fs.constants.COPYFILE_EXCL);
    console.info(`Copied seed database from ${seedPath} to ${databasePath}`);
    return;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'EEXIST') throw error;
    if (code === 'EEXIST') return;
  }

  const compressedSeedPath = `${seedPath}.gz`;
  if (!Fs.existsSync(compressedSeedPath)) return;

  const temporaryPath = `${databasePath}.${process.pid}.tmp`;
  try {
    Fs.writeFileSync(temporaryPath, gunzipSync(Fs.readFileSync(compressedSeedPath)));
    if (Fs.existsSync(databasePath)) return;
    Fs.renameSync(temporaryPath, databasePath);
    console.info(`Extracted seed database from ${compressedSeedPath} to ${databasePath}`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'EEXIST') throw error;
  } finally {
    Fs.rmSync(temporaryPath, { force: true });
  }
}
