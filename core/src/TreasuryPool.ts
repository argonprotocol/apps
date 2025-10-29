import { filterUndefined, formatArgons, formatPercent } from './utils.js';
import { Table } from 'console-table-printer';
import BigNumber from 'bignumber.js';
import { BlockWatch } from './BlockWatch.js';
import {
  type ArgonClient,
  type ArgonPrimitivesBlockSealMiningRegistration,
  type PalletTreasuryTreasuryPool,
  type PalletTreasuryTreasuryCapital,
  fromFixedNumber,
  PERMILL_DECIMALS,
  type KeyringPair,
  TxResult,
  TxSubmitter,
  type u32,
  type u64,
  Vault,
  type Vec,
} from '@argonprotocol/mainchain';
import { AccountRegistry } from './AccountRegistry.js';

const EMPTY_TABLE = {
  headerBottom: { left: ' ', mid: ' ', other: '─', right: ' ' },
  headerTop: { left: ' ', mid: ' ', other: ' ', right: ' ' },
  rowSeparator: { left: ' ', mid: ' ', other: ' ', right: ' ' },
  tableBottom: { left: ' ', mid: ' ', other: ' ', right: ' ' },
  vertical: ' ',
};

interface IBondHolder {
  address: string;
  startingBalance: bigint;
  earnings: bigint;
  amount: bigint;
}

interface IVaultMiningBondFund {
  activatedCapital: bigint;
  bondHolders?: IBondHolder[];
  vaultSharingPercent?: BigNumber;
  earnings?: bigint;
}

export class TreasuryPool {
  public miningAuctionAmount: bigint = 0n;
  public nextFrameId: number = 1;
  public poolVaultCapitalByFrame: {
    [frameId: number]: {
      [vaultId: number]: IVaultMiningBondFund;
    };
  } = {};

  private vaultSecuritization: {
    vaultId: number;
    activatedSecuritization: bigint;
    bitcoinSpace: bigint;
    vaultSharingPercent: BigNumber;
  }[] = [];
  private printTimeout?: NodeJS.Timeout;
  private blockWatch: BlockWatch;
  private vaultsById: { [id: number]: Vault } = {};
  private tickDuration?: number;
  private lastDistributedFrameId?: number;

  private FrameSubscriptions: { [frameId: number]: () => void } = {};

  constructor(
    readonly client: ArgonClient,
    readonly keypair: KeyringPair,
    readonly accountRegistry: AccountRegistry = AccountRegistry.factory(),
  ) {
    this.blockWatch = new BlockWatch(client, { shouldLog: false });
  }

  private async onVaultsUpdated(blockHash: Uint8Array, vaultIdSet: Set<number>) {
    const client = this.client;

    this.tickDuration ??= (await client.query.ticks.genesisTicker()).tickDurationMillis.toNumber();
    const api = await client.at(blockHash);
    const vaultIds = [...vaultIdSet];
    const rawVaults = await api.query.vaults.vaultsById.multi(vaultIds);
    for (let i = 0; i < vaultIds.length; i += 1) {
      const rawVault = rawVaults[i];
      if (rawVault.isNone) continue;
      const vaultId = vaultIds[i];
      this.vaultsById[vaultId] = new Vault(vaultId, rawVault.unwrap(), this.tickDuration);
    }

    const vaults = Object.entries(this.vaultsById);
    const newSecuritization: TreasuryPool['vaultSecuritization'] = [];
    for (const [vaultId, vault] of vaults) {
      const amount = vault.activatedSecuritizationPerSlot();
      newSecuritization.push({
        vaultId: Number(vaultId),
        bitcoinSpace: vault.availableBitcoinSpace(),
        activatedSecuritization: amount,
        vaultSharingPercent: vault.terms.treasuryProfitSharing,
      });
    }
    newSecuritization.sort((a, b) => {
      const diff2 = b.activatedSecuritization - a.activatedSecuritization;
      if (diff2 !== 0n) return Number(diff2);
      return a.vaultId - b.vaultId;
    });
    this.vaultSecuritization = newSecuritization;
    this.printDebounce();
  }

  public static async getActiveCapital(
    client: ArgonClient,
    vaultId: number,
  ): Promise<{
    totalActivatedCapital: bigint;
    vaultActivatedCapital: bigint;
  }> {
    let totalCapitalRaised = 0n;
    let vaultCapital = 0n;

    for (const entrant of await client.query.treasury.capitalActive()) {
      totalCapitalRaised += entrant.activatedCapital.toBigInt();
      if (entrant.vaultId.toNumber() === vaultId) {
        vaultCapital += entrant.activatedCapital.toBigInt();
      }
    }
    return {
      totalActivatedCapital: totalCapitalRaised,
      vaultActivatedCapital: vaultCapital,
    };
  }

  public static async getTreasuryPayoutPotential(client: ArgonClient): Promise<bigint> {
    const revenue = await TreasuryPool.getAuctionRevenue(client);
    const treasuryTake = client.consts.treasury.bidPoolBurnPercent.toBigInt();
    return (revenue * treasuryTake) / 100n;
  }

  public static async getAuctionRevenue(client: ArgonClient): Promise<bigint> {
    const balanceBytes = await client.rpc.state.call('MiningSlotApi_bid_pool', '');
    const balance = client.createType('U128', balanceBytes);
    return balance.toBigInt();
  }

  public async loadAt(blockHash?: Uint8Array) {
    const client = this.client;
    blockHash ??= new Uint8Array((await client.rpc.chain.getHeader()).hash);
    const api = await client.at(blockHash);
    const rawVaultIds = await api.query.vaults.vaultsById.keys();
    const vaultIds = rawVaultIds.map(x => x.args[0].toNumber());
    this.miningAuctionAmount = await TreasuryPool.getAuctionRevenue(this.client);
    this.nextFrameId = (await api.query.miningSlot.nextFrameId()).toNumber();

    const contributors = await api.query.treasury.vaultPoolsByFrame.entries();
    for (const [frameId, funds] of contributors) {
      const FrameIdNumber = frameId.args[0].toNumber();
      this.loadFrameData(FrameIdNumber, funds);
    }
    for (const entrant of await api.query.treasury.capitalActive()) {
      this.setVaultFrameData(entrant.frameId.toNumber(), entrant.vaultId.toNumber(), {
        activatedCapital: entrant.activatedCapital.toBigInt(),
      });
    }
    for (const entrant of await api.query.treasury.capitalRaising()) {
      this.setVaultFrameData(entrant.frameId.toNumber(), entrant.vaultId.toNumber(), {
        activatedCapital: entrant.activatedCapital.toBigInt(),
      });
    }
    await this.onVaultsUpdated(blockHash, new Set(vaultIds));
    this.print();
  }

  public async watch(): Promise<{ unsubscribe: () => void }> {
    await this.loadAt();
    await this.blockWatch.start();
    this.blockWatch.events.on('vaults-updated', (b, v) => this.onVaultsUpdated(b.hash, v));
    const api = this.client;
    this.blockWatch.events.on('event', async (_, event) => {
      if (api.events.treasury.BidPoolDistributed.is(event)) {
        const { frameId: rawFrameId } = event.data;
        this.lastDistributedFrameId = rawFrameId.toNumber();
        this.miningAuctionAmount = await TreasuryPool.getAuctionRevenue(this.client);

        this.FrameSubscriptions[rawFrameId.toNumber()]?.();
        const entrant = await api.query.treasury.vaultPoolsByFrame(rawFrameId);
        this.loadFrameData(rawFrameId.toNumber(), entrant);
        this.printDebounce();
      }
      if (api.events.treasury.NextBidPoolCapitalLocked.is(event)) {
        const { frameId } = event.data;

        const id = frameId.toNumber() + 1;
        if (!this.FrameSubscriptions[id]) {
          this.FrameSubscriptions[id] = await api.query.treasury.vaultPoolsByFrame(id, async entrant => {
            this.loadFrameData(id, entrant);
            this.printDebounce();
          });
        }
      }
    });

    const unsubscribe = await api.queryMulti<
      [
        Vec<ArgonPrimitivesBlockSealMiningRegistration>,
        u64,
        Vec<PalletTreasuryTreasuryCapital>,
        Vec<PalletTreasuryTreasuryCapital>,
      ]
    >(
      [
        api.query.miningSlot.bidsForNextSlotCohort as any,
        api.query.miningSlot.nextFrameId as any,
        api.query.treasury.capitalActive as any,
        api.query.treasury.capitalRaising as any,
      ],
      async ([_bids, nextFrameId, activePoolCapital, raisingPoolCapital]) => {
        this.miningAuctionAmount = await TreasuryPool.getAuctionRevenue(this.client);
        this.nextFrameId = nextFrameId.toNumber();
        for (const entrant of [...activePoolCapital, ...raisingPoolCapital]) {
          this.setVaultFrameData(entrant.frameId.toNumber(), entrant.vaultId.toNumber(), {
            activatedCapital: entrant.activatedCapital.toBigInt(),
          });
        }
        this.printDebounce();
      },
    );

    return { unsubscribe };
  }

  public async bondArgons(vaultId: number, amount: bigint, options?: { tip: bigint }): Promise<TxResult> {
    const client = this.client;

    const tx = client.tx.treasury.bondArgons(vaultId, amount);
    const txSubmitter = new TxSubmitter(client, tx, this.keypair);
    const affordability = await txSubmitter.canAfford({
      tip: options?.tip,
      unavailableBalance: amount,
    });

    if (!affordability.canAfford) {
      console.warn('Insufficient balance to bond argons to treasury pool', {
        ...affordability,
        argonsNeeded: amount,
      });
      throw new Error('Insufficient balance to bond argons to treasury pool');
    }

    const result = await txSubmitter.submit({
      tip: options?.tip,
      useLatestNonce: true,
    });
    await result.finalizedPromise;
    return result;
  }

  public printDebounce() {
    if (this.printTimeout) {
      clearTimeout(this.printTimeout);
    }
    this.printTimeout = setTimeout(() => {
      this.print();
    }, 100);
  }

  public getOperatorName(vaultId: number): string {
    const vault = this.vaultsById[vaultId];
    return this.accountRegistry.getName(vault.operatorAccountId) ?? vault.operatorAccountId;
  }

  public print() {
    console.clear();
    const lastDistributedFrameId = this.lastDistributedFrameId;
    const distributedFrame = this.poolVaultCapitalByFrame[this.lastDistributedFrameId ?? -1] ?? {};
    if (Object.keys(distributedFrame).length > 0) {
      console.log(`\n\nDistributed (Frame ${lastDistributedFrameId})`);

      const rows = [];
      let maxWidth = 0;
      for (const [key, entry] of Object.entries(distributedFrame)) {
        const { table, width } = this.createBondCapitalTable(
          entry.earnings ?? 0n,
          entry.bondHolders ?? [],
          `Earnings (shared = ${formatPercent(entry.vaultSharingPercent)})`,
        );
        if (width > maxWidth) {
          maxWidth = width;
        }
        rows.push({
          Vault: key,
          Who: this.getOperatorName(Number(key)),
          Balances: table,
        });
      }
      new Table({
        columns: [
          { name: 'Vault', alignment: 'left' },
          { name: 'Who', alignment: 'left' },
          {
            name: 'Balances',
            title: 'Contributor Balances',
            alignment: 'center',
            minLen: maxWidth,
          },
        ],
        rows,
      }).printTable();
    }
    console.log(`\n\nActive Bid Pool: ${formatArgons(this.miningAuctionAmount)} (Frame ${this.nextFrameId})`);
    const Frame = this.poolVaultCapitalByFrame[this.nextFrameId];
    if (Object.keys(Frame ?? {}).length > 0) {
      const rows = [];
      let maxWidth = 0;
      for (const [key, entry] of Object.entries(Frame)) {
        const { table, width } = this.createBondCapitalTable(entry.activatedCapital, entry.bondHolders ?? []);
        if (width > maxWidth) {
          maxWidth = width;
        }
        rows.push({
          Vault: key,
          Who: this.getOperatorName(Number(key)),
          'Pool Capital': table,
        });
      }
      new Table({
        columns: [
          { name: 'Vault', alignment: 'left' },
          { name: 'Who', alignment: 'left' },
          { name: 'Pool Capital', alignment: 'left', minLen: maxWidth },
        ],
        rows,
      }).printTable();
    }

    const raisingFunds = this.poolVaultCapitalByFrame[this.nextFrameId] ?? [];
    let maxWidth = 0;
    const nextCapital = [];
    for (const x of this.vaultSecuritization) {
      const entry = raisingFunds[x.vaultId] ?? {};
      const { table, width } = this.createBondCapitalTable(x.activatedSecuritization, entry.bondHolders ?? []);
      if (width > maxWidth) {
        maxWidth = width;
      }
      nextCapital.push({
        Vault: x.vaultId,
        Owner: this.getOperatorName(x.vaultId),
        'Bitcoin Space': formatArgons(x.bitcoinSpace),
        'Activated Securitization': `${formatArgons(x.activatedSecuritization)} / slot`,
        'Treasury Pool': `${formatPercent(x.vaultSharingPercent)} profit sharing${table}`,
      });
    }
    if (nextCapital.length) {
      console.log(`\n\nRaising Funds (Frame ${this.nextFrameId}):`);
      new Table({
        columns: [
          { name: 'Vault', alignment: 'left' },
          { name: 'Owner', alignment: 'left' },
          { name: 'Bitcoin Space', alignment: 'right' },
          { name: 'Activated Securitization', alignment: 'right' },
          { name: 'Treasury Pool', alignment: 'left', minLen: maxWidth },
        ],
        rows: nextCapital,
      }).printTable();
    }
  }

  private setVaultFrameData(frameId: number, vaultId: number, data: Partial<IVaultMiningBondFund>) {
    this.poolVaultCapitalByFrame ??= {};
    this.poolVaultCapitalByFrame[frameId] ??= {};
    this.poolVaultCapitalByFrame[frameId][vaultId] ??= {
      activatedCapital: data.activatedCapital ?? data.bondHolders?.reduce((a, b) => a + b.amount, 0n) ?? 0n,
    };

    Object.assign(this.poolVaultCapitalByFrame[frameId][vaultId], filterUndefined(data));
  }

  private createBondCapitalTable(total: bigint, contributors: IBondHolder[], title = 'Total') {
    const table = new Table({
      style: EMPTY_TABLE,
      columns: [
        { name: 'who', title: title, minLen: 10, alignment: 'right' },
        {
          name: 'amount',
          title: formatArgons(total),
          minLen: 7,
          alignment: 'left',
        },
      ],
    });
    for (const x of contributors) {
      table.addRow({
        who: this.accountRegistry.getName(x.address) ?? x.address,
        amount: formatArgons(x.amount),
      });
    }
    const str = table.render();
    const width = str.indexOf('\n');
    return { table: str, width };
  }

  private loadFrameData(frameId: number, vaultFunds: Iterable<[u32, PalletTreasuryTreasuryPool]>): void {
    for (const [vaultId, fund] of vaultFunds) {
      const vaultIdNumber = vaultId.toNumber();
      const bondHolders = fund.bondHolders.map(([a, b]) => ({
        address: a.toHuman(),
        startingBalance: b.startingBalance.toBigInt(),
        earnings: b.earnings.toBigInt(),
        amount: b.startingBalance.toBigInt() + b.earnings.toBigInt(),
      }));
      if (fund.distributedEarnings.isSome) {
        if (frameId > (this.lastDistributedFrameId ?? 0)) {
          this.lastDistributedFrameId = frameId;
        }
      }
      this.setVaultFrameData(frameId, vaultIdNumber, {
        earnings: fund.distributedEarnings.isSome ? fund.distributedEarnings.unwrap().toBigInt() : undefined,
        vaultSharingPercent: fromFixedNumber(fund.vaultSharingPercent.toBigInt(), PERMILL_DECIMALS),
        bondHolders,
      });
    }
  }
}
