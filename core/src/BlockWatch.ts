import {
  type ArgonClient,
  type GenericEvent,
  getAuthorFromHeader,
  getTickFromHeader,
  type Header,
  type SignedBlock,
} from '@argonprotocol/mainchain';
import { createNanoEvents, formatArgons } from './utils.js';

function eventDataToJson(event: GenericEvent): any {
  const obj = {} as any;
  event.data.forEach((data, index) => {
    const name = event.data.names?.[index];
    obj[name ?? `${index}`] = data.toJSON();
  });
  return obj;
}

export type BlockWatchEvents = {
  block: (header: Header, digests: { tick: number; author: string }, events: GenericEvent[]) => void;
  'vaults-updated': (header: Header, vaultIds: Set<number>) => void;
  'bitcoin-verified': (
    header: Header,
    lockedBitcoin: { utxoId: number; vaultId: number; liquidityPromised: bigint; peggedPrice: bigint },
  ) => void;
  'mining-bid': (header: Header, bid: { amount: bigint; accountId: string }) => void;
  'mining-bid-ousted': (
    header: Header,
    bid: {
      preservedArgonotHold: boolean;
      accountId: string;
    },
  ) => void;
  event: (header: Header, event: GenericEvent) => void;
};

export class BlockWatch {
  public readonly events = createNanoEvents<BlockWatchEvents>();
  public readonly locksById: {
    [utxoId: number]: {
      vaultId: number;
      peggedPrice: bigint;
      liquidityPromised: bigint;
    };
  } = {};
  private unsubscribe?: () => void;

  constructor(
    private readonly mainchain: ArgonClient,
    private options: {
      finalizedBlocks?: boolean;
      shouldLog?: boolean;
    } = {},
  ) {
    this.options.shouldLog ??= true;
    this.options.finalizedBlocks ??= false;
  }

  public stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  public async start() {
    await this.watchBlocks();
  }

  private async watchBlocks() {
    const client = this.mainchain;
    const onBlock = async (header: Header) => {
      try {
        await this.processBlock(header);
      } catch (e) {
        console.error('Error processing block', e);
      }
    };
    if (this.options.finalizedBlocks) {
      this.unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(onBlock);
    } else {
      this.unsubscribe = await client.rpc.chain.subscribeNewHeads(onBlock);
    }
  }

  private async processBlock(header: Header) {
    const client = this.mainchain;

    if (this.options.shouldLog) {
      console.log(`-------------------------------------
BLOCK #${header.number.toNumber()}, ${header.hash.toHuman()}`);
    }
    const blockHash = header.hash;
    const api = await client.at(blockHash);
    const isBlockVote = await api.query.blockSeal.isBlockFromVoteSeal();
    if (!isBlockVote) {
      console.warn('> Compute reactivated!');
    }
    const events = await api.query.system.events();
    const reloadVaults = new Set<number>();
    let block: SignedBlock | undefined = undefined;

    for (const { event, phase } of events) {
      const data = eventDataToJson(event);
      if (data.vaultId) {
        const vaultId = data.vaultId as number;
        reloadVaults.add(vaultId);
      }

      let logEvent = false;

      if (event.section === 'treasury') {
        if (client.events.treasury.BidPoolDistributed.is(event)) {
          const { bidPoolBurned, bidPoolDistributed } = event.data;
          data.burned = formatArgons(bidPoolBurned.toBigInt());
          data.distributed = formatArgons(bidPoolDistributed.toBigInt());
          logEvent = true;
        } else if (client.events.treasury.NextBidPoolCapitalLocked.is(event)) {
          const { totalActivatedCapital } = event.data;
          data.totalActivatedCapital = formatArgons(totalActivatedCapital.toBigInt());
          logEvent = true;
        }
      } else if (event.section === 'bitcoinLocks') {
        if (client.events.bitcoinLocks.BitcoinLockCreated.is(event)) {
          const { liquidityPromised, peggedPrice, utxoId, accountId, vaultId } = event.data;
          this.locksById[utxoId.toNumber()] = {
            vaultId: vaultId.toNumber(),
            peggedPrice: peggedPrice.toBigInt(),
            liquidityPromised: liquidityPromised.toBigInt(),
          };
          data.liquidityPromised = formatArgons(liquidityPromised.toBigInt());
          data.peggedPrice = formatArgons(peggedPrice.toBigInt());
          data.accountId = accountId.toHuman();
          reloadVaults.add(vaultId.toNumber());
        }
        logEvent = true;
      } else if (event.section === 'mint') {
        logEvent = true;
        if (client.events.mint.MiningMint.is(event)) {
          const { amount } = event.data;
          data.amount = formatArgons(amount.toBigInt());
        }
      } else if (event.section === 'miningSlot') {
        logEvent = true;
        if (client.events.miningSlot.SlotBidderAdded.is(event)) {
          data.amount = formatArgons(event.data.bidAmount.toBigInt());
          this.events.emit('mining-bid', header, {
            amount: event.data.bidAmount.toBigInt(),
            accountId: event.data.accountId.toString(),
          });
        } else if (client.events.miningSlot.SlotBidderDropped.is(event)) {
          this.events.emit('mining-bid-ousted', header, {
            accountId: event.data.accountId.toString(),
            preservedArgonotHold: event.data.preservedArgonotHold.toPrimitive(),
          });
        }
      } else if (event.section === 'bitcoinUtxos') {
        logEvent = true;
        if (client.events.bitcoinUtxos.UtxoVerified.is(event)) {
          const { utxoId } = event.data;
          const details = await this.getBitcoinLockDetails(utxoId.toNumber(), blockHash);
          this.events.emit('bitcoin-verified', header, {
            utxoId: utxoId.toNumber(),
            vaultId: details.vaultId,
            liquidityPromised: details.liquidityPromised,
            peggedPrice: details.peggedPrice,
          });

          data.liquidityPromised = formatArgons(details.liquidityPromised);
          data.peggedPrice = formatArgons(details.peggedPrice);
          reloadVaults.add(details.vaultId);
        }
      } else if (event.section === 'system') {
        if (client.events.system.ExtrinsicFailed.is(event)) {
          const { dispatchError } = event.data;
          if (dispatchError.isModule) {
            const decoded = api.registry.findMetaError(dispatchError.asModule);
            const { name, section } = decoded;
            block ??= await client.rpc.chain.getBlock(header.hash);
            const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
            const ext = block.block.extrinsics[extrinsicIndex];
            // translate dispatchInfo into readable tx
            if (this.options.shouldLog) {
              console.log(
                `> [Failed Tx] ${section}.${name} -> ${ext.method.section}.${ext.method.method} (nonce=${ext.nonce.toNumber()})`,
                (ext.toHuman() as any)?.method?.args,
              );
            }
          } else {
            // Other, CannotLookup, BadOrigin, no extra info
            if (this.options.shouldLog) {
              console.log(`x [Failed Tx]`, dispatchError.toJSON());
            }
          }
        }
      }
      if (this.options.shouldLog && logEvent) {
        console.log(`> ${event.section}.${event.method}`, data);
      }
      this.events.emit('event', header, event);
    }
    if (reloadVaults.size) this.events.emit('vaults-updated', header, reloadVaults);

    const tick = getTickFromHeader(client, header)!;
    const author = getAuthorFromHeader(client, header)!;

    this.events.emit(
      'block',
      header,
      { tick, author },
      events.map(x => x.event),
    );
  }

  private async getBitcoinLockDetails(
    utxoId: number,
    blockHash: Uint8Array,
  ): Promise<{ vaultId: number; peggedPrice: bigint; liquidityPromised: bigint }> {
    const client = this.mainchain;
    const api = await client.at(blockHash);
    if (!this.locksById[utxoId]) {
      const lock = await api.query.bitcoinLocks.locksByUtxoId(utxoId);
      this.locksById[utxoId] = {
        vaultId: lock.value.vaultId.toNumber(),
        peggedPrice: lock.value.peggedPrice.toBigInt(),
        liquidityPromised: lock.value.liquidityPromised.toBigInt(),
      };
    }
    return this.locksById[utxoId];
  }
}
