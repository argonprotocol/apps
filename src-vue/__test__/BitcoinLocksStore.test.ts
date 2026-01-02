import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardown } from '@argonprotocol/testing';
import BitcoinLocksStore from '../lib/BitcoinLocksStore';
import { createTestDb } from './helpers/db.ts';
import { MainchainClients, NetworkConfig, Currency as CurrencyBase } from '@argonprotocol/apps-core';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { setMainchainClients } from '../stores/mainchain.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import Path from 'path';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { BITCOIN_BLOCK_MILLIS } from '../lib/Env.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';

dayjs.extend(utc);

afterAll(teardown);

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Transaction tracker tests', { timeout: 60e3 }, () => {
  let clients: MainchainClients;
  let mainchainUrl: string;

  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename));

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    setMainchainClients(clients);
    NetworkConfig.setNetwork('dev-docker');
  }, 60e3);

  it('getLockProcessingDetails should update progress ', async () => {
    const currencyBase = new CurrencyBase(clients);
    const db = await createTestDb();
    const blockWatch = new BlockWatch(clients);
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockWatch);
    const walletKeys = createMockWalletKeys();
    const bitcoinLocksStore = new BitcoinLocksStore(
      Promise.resolve(createTestDb()),
      walletKeys,
      blockWatch,
      currencyBase,
      transactionTracker,
    );
    bitcoinLocksStore.data.oracleBitcoinBlockHeight = 103;

    let timeStart = dayjs.utc().subtract(1, 'second');

    const lock: IBitcoinLockRecord = {
      id: 1,
      status: BitcoinLockStatus.LockIsProcessingOnBitcoin,
      lockProcessingOnBitcoinAtBitcoinHeight: undefined,
      lockProcessingOnBitcoinAtOracleBitcoinHeight: 103,
      lockProcessingOnBitcoinAtTime: timeStart.valueOf(),
    } as unknown as IBitcoinLockRecord;

    let details = bitcoinLocksStore.getLockProcessingDetails(lock);

    expect(details.progressPct).toBeGreaterThanOrEqual(0.5);
    expect(details.progressPct).toBeLessThanOrEqual(0.6);
    expect(details.confirmations).toBe(-1);

    timeStart = timeStart.subtract(100, 'milliseconds');
    lock.lockProcessingOnBitcoinAtTime = timeStart.toDate();
    details = bitcoinLocksStore.getLockProcessingDetails(lock);

    expect(details.progressPct).toBeGreaterThanOrEqual(0.5);
    expect(details.progressPct).toBeLessThanOrEqual(0.6);

    timeStart = timeStart.subtract(BITCOIN_BLOCK_MILLIS, 'milliseconds');
    lock.lockProcessingOnBitcoinAtTime = timeStart.toDate();
    details = bitcoinLocksStore.getLockProcessingDetails(lock);

    expect(details.progressPct).toBe(10);

    timeStart = timeStart.subtract(Math.floor(BITCOIN_BLOCK_MILLIS / 2), 'milliseconds');
    lock.lockProcessingOnBitcoinAtBitcoinHeight = 110;
    bitcoinLocksStore.data.oracleBitcoinBlockHeight = 104;
    details = bitcoinLocksStore.getLockProcessingDetails(lock);

    expect(details.progressPct).toBeGreaterThanOrEqual(32);
    expect(details.progressPct).toBeLessThanOrEqual(33);
  });
});
