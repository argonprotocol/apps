import {
  type ApiDecoration,
  type ArgonClient,
  getClient,
  getOfflineRegistry,
  Keyring,
  type KeyringPair,
  MICROGONS_PER_ARGON,
  type SubmittableExtrinsic,
  TxSubmitter,
  u8aToHex,
} from '@argonprotocol/mainchain';
import { blake2AsU8a, ed25519DeriveHard, keyExtractSuri, mnemonicToMiniSecret } from '@polkadot/util-crypto';
import { DEV_PHRASE } from '@polkadot/keyring';
import { Mining } from './Mining.js';

export type SubaccountRange = readonly number[];

export interface ISubaccountMiner {
  address: string;
  subaccountIndex: number;
  seat?: IMiningIndex;
  isLastDay: boolean;
}

const registry = getOfflineRegistry();

export interface IMiningIndex {
  startingFrameId: number;
  index: number;
  bidAmount: bigint;
}

export const MINING_BID_PROXY_FEE_FLOAT = 1n * BigInt(MICROGONS_PER_ARGON);

export type MiningBidProxySetupMetadata = {
  fundingAccountId: string;
  proxyAccountId: string;
};

export type MiningBidProxySetupPlan =
  | { kind: 'ready' }
  | { kind: 'insufficientFunds'; error: string }
  | {
      kind: 'tx';
      tx: SubmittableExtrinsic;
      metadata: MiningBidProxySetupMetadata;
    };

export class Accountset {
  public txSubmitterPair: KeyringPair;
  public isProxy = false;
  public fundingAccountId: string;
  public subAccountsByAddress: {
    [address: string]: { index: number };
  } = {};
  public readonly client: ArgonClient;

  public sessionMiniSecretOrMnemonic: string | undefined;

  constructor(
    options: {
      client: ArgonClient;
      subaccountRange?: SubaccountRange;
      sessionMiniSecretOrMnemonic?: string;
      name?: string;
    } & (
      | { seedAccount: KeyringPair }
      | {
          fundingAccountId: string;
          isProxy: true;
          txSubmitter: KeyringPair;
        }
    ),
  ) {
    if ('seedAccount' in options) {
      this.txSubmitterPair = options.seedAccount;
      this.fundingAccountId = options.seedAccount.address;
      this.isProxy = false;
    } else {
      this.isProxy = options.isProxy;
      this.txSubmitterPair = options.txSubmitter;
      this.fundingAccountId = options.fundingAccountId;
    }
    this.sessionMiniSecretOrMnemonic = options.sessionMiniSecretOrMnemonic;
    this.client = options.client;
    const defaultRange = options.subaccountRange ?? getRange();
    for (const i of defaultRange) {
      const hashedAccount = Accountset.createMiningSubaccount(this.fundingAccountId, i);
      this.subAccountsByAddress[hashedAccount] = { index: i };
    }
  }

  public static createMiningSubaccount(address: string, index: number): string {
    const address32 = registry.createType('AccountId32', address).toU8a();
    const index16 = registry.createType('u16', index).toU8a();
    const bytes = Uint8Array.from([...address32, ...index16]);
    const hash = blake2AsU8a(bytes, 256);
    return registry.createType('AccountId32', hash).toHuman();
  }

  public async submitterBalance(blockHash?: Uint8Array): Promise<bigint> {
    const client = this.client;
    const api = blockHash ? await client.at(blockHash) : client;
    const accountData = await api.query.system.account(this.fundingAccountId);

    return accountData.data.free.toBigInt();
  }

  public async accountMicronots(blockHash?: Uint8Array): Promise<bigint> {
    const client = this.client;
    const api = blockHash ? await client.at(blockHash) : client;
    const accountData = await api.query.ownership.account(this.fundingAccountId);

    return accountData.free.toBigInt();
  }

  public async balance(blockHash?: Uint8Array): Promise<bigint> {
    const client = this.client;
    const api = blockHash ? await client.at(blockHash) : client;
    const accountData = await api.query.system.account(this.fundingAccountId);

    return accountData.data.free.toBigInt();
  }

  public async getAvailableMinerAccounts(
    maxSeats: number,
  ): Promise<{ index: number; isRebid: boolean; address: string }[]> {
    const miningSeats = await this.miningSeatsAndBids();
    const subaccountRange = [];
    for (const seat of miningSeats) {
      if (seat.hasWinningBid) {
        continue;
      }
      if (seat.isLastDay || seat.seat === undefined) {
        subaccountRange.push({
          index: seat.subaccountIndex,
          isRebid: seat.seat !== undefined,
          address: seat.address,
        });
        if (subaccountRange.length >= maxSeats) {
          break;
        }
      }
    }
    return subaccountRange;
  }

  public async loadRegisteredMiners(api: ApiDecoration<'promise'>): Promise<ISubaccountMiner[]> {
    const addressToMiningIndex = await Mining.fetchMiningSeatsForAccount(this.fundingAccountId, api);

    return Object.entries(this.subAccountsByAddress).map(([address, { index }]) => {
      return {
        ...addressToMiningIndex[address],
        address,
        // this can be -1 if the miner was registered in older version where subaccounts were calculated differently
        subaccountIndex: index ?? -1,
      };
    });
  }

  public async miningSeatsAndBids(api?: ApiDecoration<'promise'>): Promise<
    (ISubaccountMiner & {
      hasWinningBid: boolean;
      bidAmount?: bigint;
    })[]
  > {
    const client = this.client;
    api ??= client;
    const miners = (await this.loadRegisteredMiners(api)).map(x => {
      return { ...x, hasWinningBid: false };
    });

    const nextCohort = await Mining.fetchWinningBids(api);
    for (const bid of nextCohort) {
      if (bid.managedByAddress === this.fundingAccountId) {
        const address = bid.address;
        const existing = miners.find(x => x.address === address);
        const details = {
          hasWinningBid: true,
          bidAmount: bid.microgonsPerSeat,
          address,
          isLastDay: !!existing,
        };
        if (existing) {
          Object.assign(existing, details);
        } else {
          miners.push({
            ...details,
            subaccountIndex: this.subAccountsByAddress[address]?.index ?? Number.NaN,
          });
        }
      }
    }

    return miners;
  }

  public async registerKeys(url: string) {
    const client = await getClient(url.replace('ws:', 'http:'), { throwOnConnect: true });
    const keys = this.keys();
    for (const [name, key] of Object.entries(keys)) {
      console.log('Registering key', name, key.publicKey);
      const result = await client.rpc.author.insertKey(name, key.privateKey, key.publicKey);
      // verify keys
      const saved = await client.rpc.author.hasKey(key.publicKey, name);
      if (!saved) {
        console.error('Failed to register key', name, key.publicKey);
        throw new Error(`Failed to register ${name} key ${key.publicKey}`);
      }
      console.log(`Registered ${name} key`, result.toHuman());
    }
    await client.disconnect();
  }

  public keys(keysVersion?: number): {
    gran: { privateKey: string; publicKey: string; rawPublicKey: Uint8Array };
    seal: { privateKey: string; publicKey: string; rawPublicKey: Uint8Array };
  } {
    const version = keysVersion ?? 0;
    const seed = this.sessionMiniSecretOrMnemonic;
    if (!seed) {
      throw new Error('Keys Mnemonic must be set to register keys.');
    }
    const blockSealKey = `${seed}//block-seal//${version}`;
    const granKey = `${seed}//grandpa//${version}`;
    const blockSealAccount = new Keyring().createFromUri(blockSealKey, {
      type: 'ed25519',
    });
    const grandpaAccount = new Keyring().createFromUri(granKey, {
      type: 'ed25519',
    });
    return {
      seal: {
        privateKey: blockSealKey,
        publicKey: u8aToHex(blockSealAccount.publicKey),
        rawPublicKey: blockSealAccount.publicKey,
      },
      gran: {
        privateKey: granKey,
        publicKey: u8aToHex(grandpaAccount.publicKey),
        rawPublicKey: grandpaAccount.publicKey,
      },
    };
  }

  /**
   * Create but don't submit a mining bid transaction.
   * @param options
   */
  public async createMiningBidTx(options: { subaccounts: { address: string }[]; bidAmount: bigint }) {
    const client = this.client;
    const { bidAmount, subaccounts } = options;

    const batch = client.tx.utility.batch(
      subaccounts.map(x => {
        const keys = this.keys();
        return client.tx.miningSlot.bid(
          bidAmount,
          {
            grandpa: keys.gran.rawPublicKey,
            blockSealAuthority: keys.seal.rawPublicKey,
          },
          x.address,
        );
      }),
    );

    let tx = batch;
    if (this.isProxy) {
      tx = client.tx.proxy.proxy(this.fundingAccountId, 'MiningBidRealPaysFee', batch);
    }
    return new TxSubmitter(client, tx, this.txSubmitterPair);
  }

  public async planMiningBidProxySetup(): Promise<MiningBidProxySetupPlan> {
    if (!this.isProxy) {
      throw new Error('Mining bid proxy setup requires a proxy submitter.');
    }

    const client = this.client;
    const proxyAccountId = this.txSubmitterPair.address;
    const [proxyDefinitions, fundingAccountBalance] = await Promise.all([
      client.query.proxy.proxies(this.fundingAccountId).then(([definitions]) => definitions),
      this.balance(),
    ]);

    const isProxyRegistered = proxyDefinitions.some(def => {
      return def.delegate.toString() === proxyAccountId && def.proxyType.isMiningBidRealPaysFee;
    });
    if (isProxyRegistered) {
      return { kind: 'ready' };
    }

    if (fundingAccountBalance < MINING_BID_PROXY_FEE_FLOAT) {
      return {
        kind: 'insufficientFunds',
        error: 'Mining bid account needs 1 ARGN to seed its bid proxy.',
      };
    }

    return {
      kind: 'tx',
      tx: client.tx.utility.batchAll([
        client.tx.proxy.addProxy(proxyAccountId, 'MiningBidRealPaysFee', 0),
        client.tx.balances.transferAllowDeath(proxyAccountId, MINING_BID_PROXY_FEE_FLOAT),
      ]),
      metadata: {
        fundingAccountId: this.fundingAccountId,
        proxyAccountId,
      },
    };
  }

  public getAccountsInRange(range?: SubaccountRange): IAccountAndIndex[] {
    const entries = new Set(range ?? getRange());
    return Object.entries(this.subAccountsByAddress)
      .filter(([_, account]) => {
        return entries.has(account.index);
      })
      .map(([address, { index }]) => ({ index, address }));
  }
}

export function getRange(start = 0, end = 50): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

export function miniSecretFromUri(uri: string, password?: string): string {
  if (uri.startsWith('//')) {
    uri = DEV_PHRASE + uri;
  }
  const { phrase, path } = keyExtractSuri(uri);
  let mini = mnemonicToMiniSecret(phrase, password); // base 32B
  for (const j of path) {
    if (!j.isHard) throw new Error('ed25519 soft derivation not supported');
    mini = ed25519DeriveHard(mini, j.chainCode);
  }
  return u8aToHex(mini);
}

export type IAccountAndIndex = {
  index: number;
  address: string;
};
