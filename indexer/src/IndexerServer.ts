import { FinalizedBlockIndexer } from './FinalizedBlockIndexer.ts';
import cors from 'cors';
import express from 'express';
import { IndexerDb, WalletTransferCurrency, WalletTransferSource } from './IndexerDb.ts';
import * as http from 'node:http';
import { type ArgonClient, getClient } from '@argonprotocol/mainchain';
import { type IIndexerSpec } from '@argonprotocol/apps-core';
import Path from 'path';

export class IndexerServer {
  public port: number;
  public network: string;
  private server!: http.Server;
  private readonly blockIndexer: FinalizedBlockIndexer;
  private readonly db: IndexerDb;
  private readonly clientPromise: Promise<ArgonClient>;

  constructor(args: { port: number; dbDir: string; network: string; mainchainUrl: string }) {
    this.port = args.port;
    const { dbDir, mainchainUrl } = args;
    IndexerDb.copySeedIfNeeded(dbDir, args.network);
    this.db = new IndexerDb(Path.join(dbDir, `${args.network}.db`));
    this.network = args.network;
    this.blockIndexer = new FinalizedBlockIndexer(this.db);
    this.clientPromise = getClient(mainchainUrl);
  }

  public async start() {
    const app = express();
    const indexer = this.blockIndexer;
    const client = await this.clientPromise;
    const chain = await client.rpc.system.chain().then(x => x.toString());
    if (this.network === 'mainnet') {
      if (chain !== 'Argon') throw new Error(`Indexer network mismatch: expected Argon, got ${chain}`);
    } else if (this.network === 'testnet') {
      if (chain !== 'Argon Testnet') throw new Error(`Indexer network mismatch: expected Argon Testnet, got ${chain}`);
    }

    await indexer.start(client);

    app.use(cors({ origin: true, methods: ['GET'] }));

    app.get('/transfers/:address', async (req, res) => {
      const address = req.params.address;
      const transfers = this.db.findAddressTransfers(address).map(x => {
        return {
          blockNumber: x.blockNumber,
          fromAddress: x.fromAddress,
          toAddress: x.toAddress,
          source: {
            [WalletTransferSource.Transfer]: 'transfer',
            [WalletTransferSource.Faucet]: 'faucet',
            [WalletTransferSource.TokenGateway]: 'tokenGateway',
          }[x.source],
          currency: {
            [WalletTransferCurrency.Argon]: 'argon',
            [WalletTransferCurrency.Argonot]: 'argonot',
          }[x.currency],
        };
      });

      res
        .status(200)
        .type('application/json')
        .send({
          transfers,
          asOfBlock: this.db.latestSyncedBlock,
        } as IIndexerSpec['/transfer/:address']['responseType']);
    });

    app.get('/vault-collects/:address', async (req, res) => {
      const address = req.params.address;
      const vaultCollects = this.db.findVaultCollects(address);

      res
        .status(200)
        .type('application/json')
        .send({
          vaultCollects,
          asOfBlock: this.db.latestSyncedBlock,
        } as IIndexerSpec['/vault-collects/:address']['responseType']);
    });

    app.use((_req, res) => {
      res.status(404).send('Not Found');
    });

    await new Promise<void>(resolve => {
      this.server = app.listen(this.port, '0.0.0.0', () => {
        const addressInfo = this.server.address();
        if (typeof addressInfo === 'object' && addressInfo) {
          this.port = addressInfo.port;
        }
        console.log(`Server is running on port ${this.port}`);
        resolve();
      });
    });
  }

  public async stop() {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.blockIndexer.close();
    const client = await this.clientPromise;
    await client.disconnect();
  }
}
