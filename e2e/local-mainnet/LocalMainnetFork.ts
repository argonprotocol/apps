import { createHash } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import Path from 'node:path';
import {
  BuildBlockMode,
  ChopsticksProvider,
  compactHex,
  destroyWorker,
  setupWithServer,
  type Block,
  type InherentProvider,
  type RuntimeVersion,
} from '@acala-network/chopsticks';
import { GenericExtrinsic } from '@polkadot/types';
import { stringToHex, u8aToHex } from '@polkadot/util';
import { blake2AsHex } from '@polkadot/util-crypto';
import type { RuntimeMigrationManifest } from './manifest.ts';

const CHOPSTICKS_FALLBACK_SLOT_MILLIS = 12_000n;
const RUNTIME_STAGES = ['deployed', 'upgrade', 'migration', 'candidate'] as const;
type RuntimeStage = (typeof RUNTIME_STAGES)[number];
type ChopsticksServer = Awaited<ReturnType<typeof setupWithServer>>;

export interface ProducedBlock {
  number: number;
  hash: string;
  runtimeSpecVersion: number;
  metadataSpecVersion: number;
  includedTransactionHashes: string[];
  events: string[];
}

export class LocalMainnetFork {
  public readonly archiveUrl: string;
  private nextStage = 0;
  private submittedUpgradeHash: string | undefined;
  private closed = false;

  private constructor(
    private readonly chopsticks: ChopsticksServer,
    private readonly provider: ChopsticksProvider,
    private readonly argonInherents: ArgonInherents,
  ) {
    this.archiveUrl = `ws://${chopsticks.addr}`;
  }

  public static async start(args: {
    manifest: RuntimeMigrationManifest;
    runDirectory: string;
  }): Promise<LocalMainnetFork> {
    const { manifest, runDirectory } = args;
    if (!Path.isAbsolute(runDirectory)) {
      throw new Error('Runtime migration runDirectory must be an absolute path');
    }
    LocalMainnetFork.verifySha256(manifest.archive.chopsticksDatabasePath, manifest.archive.sha256);

    mkdirSync(runDirectory, { recursive: true });
    const databasePath = Path.join(runDirectory, 'chopsticks.sqlite');
    copyFileSync(manifest.archive.chopsticksDatabasePath, databasePath, constants.COPYFILE_EXCL);

    const chopsticks = await setupWithServer({
      endpoint: manifest.archive.url,
      block: manifest.archive.blockNumber,
      db: databasePath,
      port: 0,
      host: '127.0.0.1',
      'build-block-mode': BuildBlockMode.Manual,
      'mock-signature-host': true,
      'save-blocks': true,
    });
    const provider = new ChopsticksProvider(chopsticks.chain);
    try {
      await provider.isReady;
      const initialRuntime = await LocalMainnetFork.runtimeVersion(provider, chopsticks.chain.head.hash);
      if (
        chopsticks.chain.head.number !== manifest.archive.blockNumber ||
        chopsticks.chain.head.hash !== manifest.archive.blockHash ||
        initialRuntime.specVersion !== manifest.archive.deployedSpecVersion
      ) {
        throw new Error('Restored Chopsticks head does not match the runtime migration manifest');
      }

      const inherentProviders = chopsticks.chain.getInherents();
      if (inherentProviders[0]?.constructor.name !== 'SetTimestamp') {
        throw new Error('Pinned Chopsticks timestamp inherent was not found');
      }
      const argonInherents = await ArgonInherents.create(chopsticks.chain.head);
      inherentProviders.splice(0, 1, ...argonInherents.providers);
      return new LocalMainnetFork(chopsticks, provider, argonInherents);
    } catch (error) {
      await chopsticks.close().catch(() => undefined);
      await destroyWorker().catch(() => undefined);
      throw error;
    }
  }

  public async submitRuntimeUpgrade(wasm: Uint8Array): Promise<string> {
    if (this.nextStage !== 1 || this.submittedUpgradeHash) {
      throw new Error('Runtime upgrade must be submitted after the deployed block and only once');
    }
    const extrinsic = await LocalMainnetFork.createRuntimeUpgradeExtrinsic(this.chopsticks.chain.head, wasm);
    const hash = await this.chopsticks.chain.submitExtrinsic(extrinsic);
    this.submittedUpgradeHash = hash;
    return hash;
  }

  public async produceBlock(stage: RuntimeStage): Promise<ProducedBlock> {
    if (stage !== RUNTIME_STAGES[this.nextStage]) {
      throw new Error(`Expected runtime migration stage ${RUNTIME_STAGES[this.nextStage]}, got ${stage}`);
    }
    if (stage === 'upgrade' && !this.submittedUpgradeHash) {
      throw new Error('Runtime upgrade must be submitted before producing the upgrade block');
    }

    const parent = this.chopsticks.chain.head;
    const parentRuntime = await LocalMainnetFork.runtimeVersion(this.provider, parent.hash);
    const parentMeta = await parent.meta;
    const restoreHeader = await this.argonInherents.prepare(parent);
    let block: Block;
    try {
      block = await this.chopsticks.chain.newBlock();
    } finally {
      restoreHeader();
    }

    const extrinsics = await block.extrinsics;
    const eventsHex = await block.get(compactHex(parentMeta.query.system.events()));
    const eventRecords = parentMeta.registry.createType('Vec<EventRecord>', eventsHex ?? '0x00');
    const events = [...eventRecords].map(record => {
      const event = record.event;
      return `${event.section}.${event.method}`;
    });
    const blockRuntime = await LocalMainnetFork.runtimeVersion(this.provider, block.hash);
    const includedTransactionHashes = extrinsics.map(hex => blake2AsHex(hex, 256));

    if (stage === 'upgrade' && !includedTransactionHashes.some(hash => hash === this.submittedUpgradeHash)) {
      throw new Error('Runtime upgrade transaction was not included in the upgrade block');
    }

    this.nextStage += 1;
    return {
      number: block.number,
      hash: block.hash,
      runtimeSpecVersion: blockRuntime.specVersion,
      metadataSpecVersion: parentRuntime.specVersion,
      includedTransactionHashes,
      events,
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    const errors: unknown[] = [];
    await this.chopsticks.close().catch(error => errors.push(error));
    await destroyWorker().catch(error => errors.push(error));
    if (errors.length) throw new AggregateError(errors, 'Failed to close the local mainnet fork');
    this.closed = true;
  }

  private static async createRuntimeUpgradeExtrinsic(head: Block, wasm: Uint8Array): Promise<`0x${string}`> {
    if (!wasm.length) throw new Error('Candidate runtime WASM is empty');

    const meta = await head.meta;
    const registry = meta.registry;
    const sudoKeyHex = await head.get(compactHex(meta.query.sudo.key()));
    if (!sudoKeyHex) throw new Error('Pinned runtime has no sudo key');
    const sudoKey = registry.createType('AccountId32', sudoKeyHex);
    const accountInfo = await head.read('AccountInfo', meta.query.system.account, sudoKey);
    const runtime = await head.runtimeVersion;
    const genesisHash = await head.chain.api.getBlockHash(0);
    if (!accountInfo || !genesisHash) throw new Error('Unable to construct the local sudo transaction');

    const call = meta.tx.sudo.sudo(meta.tx.system.setCode(u8aToHex(wasm)));
    const extrinsic = new GenericExtrinsic(registry, call);
    const mockSignature = registry
      .createType('ExtrinsicSignature', { Sr25519: `0xdeadbeef${'cd'.repeat(60)}` })
      .toHex();
    extrinsic.addSignature(sudoKey, mockSignature, {
      blockHash: head.hash,
      era: '0x00',
      genesisHash,
      method: call.toHex(),
      nonce: accountInfo.nonce,
      specVersion: runtime.specVersion,
      tip: 0,
      transactionVersion: runtime.transactionVersion,
    });
    return extrinsic.toHex();
  }

  private static async runtimeVersion(provider: ChopsticksProvider, hash: string): Promise<RuntimeVersion> {
    const version = await provider.send<RuntimeVersion>('state_getRuntimeVersion', [hash]);
    if (!version) throw new Error(`No runtime version at ${hash}`);
    return version;
  }

  private static verifySha256(path: string, expected: string): void {
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== expected) throw new Error(`Runtime migration artifact checksum mismatch at ${path}`);
  }
}

class ArgonInherents {
  readonly providers: InherentProvider[] = [
    { createInherents: block => this.createTimestamp(block) },
    { createInherents: block => this.createBitcoinSync(block) },
    { createInherents: block => this.createNotebook(block) },
    { createInherents: block => this.createBlockSeal(block) },
  ];
  #bitcoinSync: unknown;
  #timestamp = 0n;
  #tickDuration = 0n;
  #restoreHeader: (() => void) | undefined;

  private constructor(bitcoinSync: unknown) {
    this.#bitcoinSync = bitcoinSync;
  }

  public static async create(block: Block): Promise<ArgonInherents> {
    const meta = await block.meta;
    const registry = meta.registry;
    const syncExtrinsic = (await block.extrinsics)
      .map(hex => registry.createType('Extrinsic', hex))
      .find(extrinsic => extrinsic.method.section === 'bitcoinUtxos' && extrinsic.method.method === 'sync');
    if (!syncExtrinsic) throw new Error('Pinned block does not contain bitcoinUtxos.sync');

    const bitcoinSync = syncExtrinsic.method.args[0].toJSON() as {
      funded?: unknown[];
      spent?: unknown[];
    };
    if (bitcoinSync.funded?.length || bitcoinSync.spent?.length) {
      throw new Error('Pinned bitcoinUtxos.sync is not a no-op and cannot be replayed');
    }
    return new ArgonInherents(bitcoinSync);
  }

  public async prepare(parent: Block): Promise<() => void> {
    const meta = await parent.meta;
    const registry = meta.registry;
    const timestamp = await parent.read('u64', meta.query.timestamp.now);
    const currentTick = await parent.read('u64', meta.query.ticks.currentTick);
    const tickerHex = await parent.get(compactHex(meta.query.ticks.genesisTicker()));
    const tickerType = registry.lookup.getTypeDef(meta.query.ticks.genesisTicker.meta.type.asPlain).type;
    const ticker = registry.createType(tickerType, tickerHex);
    const tickDuration = BigInt(
      (ticker as unknown as { tickDurationMillis: { toString(): string } }).tickDurationMillis.toString(),
    );
    if (!timestamp || !currentTick || tickDuration <= 0n) {
      throw new Error('Unable to read the Argon timestamp and tick configuration');
    }

    this.#timestamp = timestamp.toBigInt();
    this.#tickDuration = tickDuration;
    const header = await parent.header;
    const originalDigest = header.digest;
    const preRuntimeLogs = header.digest.logs.filter(log => log.isPreRuntime);
    const author = preRuntimeLogs.find(log => log.asPreRuntime[0].toString() === 'pow_');
    const tick = preRuntimeLogs.find(log => log.asPreRuntime[0].toString() === 'aura');
    if (!author || !tick) throw new Error('Pinned Argon header is missing author or tick digest');

    header.set(
      'digest',
      registry.createType('Digest', {
        logs: [
          author,
          tick,
          registry.createType('DigestItem', { PreRuntime: [stringToHex('vote'), '0x0000'] }),
          registry.createType('DigestItem', { PreRuntime: [stringToHex('book'), '0x00'] }),
        ],
      }),
    );

    const originalRead = parent.read.bind(parent);
    parent.read = (async (type: string, query: { section?: string; method?: string }, ...queryArgs: unknown[]) => {
      if (query.section === 'timestamp' && query.method === 'now') {
        return registry.createType(type, currentTick.toBigInt() * CHOPSTICKS_FALLBACK_SLOT_MILLIS);
      }
      return await originalRead(type, query as Parameters<typeof originalRead>[1], ...queryArgs);
    }) as typeof parent.read;

    let restored = false;
    this.#restoreHeader = () => {
      if (restored) return;
      restored = true;
      parent.read = originalRead;
      header.set('digest', originalDigest);
      this.#restoreHeader = undefined;
    };
    return this.#restoreHeader;
  }

  private async createTimestamp(newBlock: Block): Promise<`0x${string}`[]> {
    const parent = await newBlock.parentBlock;
    if (!parent || !this.#restoreHeader) throw new Error('Argon inherents were not prepared');
    this.#restoreHeader();

    const meta = await parent.meta;
    const registry = meta.registry;
    return [new GenericExtrinsic(registry, meta.tx.timestamp.set(this.#timestamp + this.#tickDuration)).toHex()];
  }

  private async createBitcoinSync(newBlock: Block): Promise<`0x${string}`[]> {
    const meta = await newBlock.meta;
    return [new GenericExtrinsic(meta.registry, meta.tx.bitcoinUtxos.sync(this.#bitcoinSync)).toHex()];
  }

  private async createNotebook(newBlock: Block): Promise<`0x${string}`[]> {
    const meta = await newBlock.meta;
    return [new GenericExtrinsic(meta.registry, meta.tx.notebook.submit([])).toHex()];
  }

  private async createBlockSeal(newBlock: Block): Promise<`0x${string}`[]> {
    const meta = await newBlock.meta;
    return [new GenericExtrinsic(meta.registry, meta.tx.blockSeal.apply('Compute')).toHex()];
  }
}
