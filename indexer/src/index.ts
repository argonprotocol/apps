import 'source-map-support/register';
import { IndexerServer } from './IndexerServer.ts';

const dbDir = process.env.DB_DIR ?? './indexer.db';
const rpcUrl = process.env.MAINCHAIN_URL ?? 'ws://localhost:9944';
const network = process.env.ARGON_CHAIN ?? 'dev-docker';
const port = Number(process.env.PORT ?? 3262);
const indexer = new IndexerServer({ port, dbDir, network, mainchainUrl: rpcUrl });
await indexer.start();

const onExit = async () => {
  console.log('Shutting down indexer...');
  await indexer.stop();
  process.exit(0);
};

process.once('SIGINT', onExit);
process.once('SIGTERM', onExit);
process.once('exit', () => onExit());
