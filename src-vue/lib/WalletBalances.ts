import { Accountset, ArgonClient, MainchainClients, parseSubaccountRange } from '@argonprotocol/apps-core';
import { FrameSystemAccountInfo, KeyringPair, PalletBalancesAccountData } from '@argonprotocol/mainchain';
import { createDeferred } from './Utils';
import {
  IMiningAccountPreviousHistoryBid,
  IMiningAccountPreviousHistoryRecord,
  IMiningAccountPreviousHistorySeat,
} from '../interfaces/IConfig';
import { FrameIterator } from '@argonprotocol/apps-core/src/FrameIterator.ts';
import IVaultingRules from '../interfaces/IVaultingRules.ts';
import { VaultRecoveryFn } from './MyVaultRecovery.ts';

export interface IWallet {
  address: string;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  reservedMicrogons: bigint;
  reservedMicronots: bigint;
}

export class WalletBalances {
  private clients: MainchainClients;
  private subscriptions: VoidFunction[] = [];
  private deferredLoading = createDeferred<void>(false);

  public onBalanceChange?: () => void;
  public onLoadHistoryProgress?: (loadPct: number) => void;

  public miningWallet: IWallet = {
    address: '',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
  };

  public vaultingWallet: IWallet = {
    address: '',
    availableMicrogons: 0n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
  };

  public totalWalletMicrogons: bigint = 0n;
  public totalWalletMicronots: bigint = 0n;

  constructor(mainchainClients: MainchainClients) {
    this.clients = mainchainClients;
  }

  public async load(accountData: { miningAccountAddress: string; vaultingAccountAddress: string }) {
    if (this.deferredLoading.isRunning || this.deferredLoading.isSettled) {
      return this.deferredLoading.promise;
    }
    this.deferredLoading.setIsRunning(true);

    const { miningAccountAddress, vaultingAccountAddress } = accountData;
    this.miningWallet.address = miningAccountAddress;
    this.vaultingWallet.address = vaultingAccountAddress;

    await this.updateBalances(false);
    this.deferredLoading.resolve();
  }

  public async updateBalances(waitForLoad = true) {
    if (waitForLoad) await this.deferredLoading.promise;

    const walletsToUpdate = [this.miningWallet, this.vaultingWallet].filter(x => x.address);

    for (const wallet of walletsToUpdate) {
      await Promise.all([this.loadMicrogonBalance(wallet), this.loadMicronotBalance(wallet)]);
    }

    this.onBalanceChange?.();
  }

  public async subscribeToBalanceUpdates() {
    await this.deferredLoading.promise;

    if (this.subscriptions.length) {
      this.subscriptions.forEach(x => x());
      this.subscriptions.length = 0;
    }

    const walletsToSubscribe = [this.miningWallet, this.vaultingWallet].filter(x => x.address);

    for (const wallet of walletsToSubscribe) {
      const client = await this.clients.prunedClientOrArchivePromise;
      const [subMicrogon, subMicronot] = await Promise.all([
        client.query.system.account(wallet.address, result => {
          this.handleMicrogonBalanceChange(result, wallet);
        }),
        client.query.ownership.account(wallet.address, result => {
          this.handleMicronotBalanceChange(result, wallet);
        }),
      ]);
      this.subscriptions.push(subMicrogon, subMicronot);
    }
  }

  private async loadMiningHistory(
    liveClient: ArgonClient,
    miningAccount: KeyringPair,
    onProgress: (progressPct: number) => void,
  ): Promise<IMiningAccountPreviousHistoryRecord[] | undefined> {
    const dataByFrameId: Record<string, IMiningAccountPreviousHistoryRecord> = {};

    const accountSubaccounts = Accountset.getSubaccounts(miningAccount, parseSubaccountRange('0-99')!);

    const currentFrameBids: IMiningAccountPreviousHistoryBid[] = [];
    const latestFrameId = await liveClient.query.miningSlot.nextFrameId().then(x => x.toNumber() - 1);
    const earliestPossibleFrameId = 150; // this is hard coded based on the spec version needing to be > 124. Doesn't need to be exact.

    const bidsRaw = await liveClient.query.miningSlot.bidsForNextSlotCohort();
    for (const [bidPosition, bidRaw] of bidsRaw.entries()) {
      const address = bidRaw.accountId.toHuman();
      const isOurAccount = !!accountSubaccounts[address];
      if (!isOurAccount) continue;

      currentFrameBids.push({
        bidPosition,
        microgonsBid: bidRaw.bid.toBigInt(),
        micronotsStaked: bidRaw.argonots.toBigInt(),
      });
    }

    const framesToProcess = latestFrameId - earliestPossibleFrameId;
    await new FrameIterator(this.clients, 'MiningHistory').iterateFramesByEpoch(
      async (frameId, _firstBlockMeta, api, _abortController) => {
        console.log(`[MiningHistory] Loading frame ${frameId} (oldest ${earliestPossibleFrameId})`);
        const seatsByFrameId = await this.fetchSeatData(api as ArgonClient, accountSubaccounts);
        for (const [frameIdStr, seats] of Object.entries(seatsByFrameId)) {
          if (!seats.length) continue;
          dataByFrameId[frameIdStr] = {
            frameId: Number(frameIdStr),
            bids: [],
            seats,
          };
        }
        const framesProcessed = latestFrameId - frameId;
        const progress = Math.max((100 * framesProcessed) / framesToProcess, 0);
        onProgress(progress);
        console.log(`[MiningHistory] Progress: ${progress}`);
      },
    );
    if (currentFrameBids.length) {
      dataByFrameId[latestFrameId] ??= { frameId: latestFrameId, seats: [], bids: [] };
      dataByFrameId[latestFrameId].bids = currentFrameBids;
    }
    console.log('[MiningHistory] Finished loading history', dataByFrameId);

    onProgress(100);

    const miningHistory = Object.values(dataByFrameId);
    if (miningHistory.length) {
      return miningHistory;
    }
  }

  public async loadHistory(
    miningAccount: KeyringPair,
    bitcoinXprivSeed: Uint8Array,
    loadVaultHistory?: VaultRecoveryFn,
  ): Promise<{ miningHistory?: IMiningAccountPreviousHistoryRecord[]; vaultingRules?: IVaultingRules }> {
    await this.deferredLoading.promise;

    const hasVaultHistory = WalletBalances.doesWalletHaveValue(this.vaultingWallet);
    const hasMiningHistory = WalletBalances.doesWalletHaveValue(this.miningWallet);

    let vaultProgress = hasVaultHistory ? 0 : 100;
    let miningProgress = hasMiningHistory ? 0 : 100;
    this.onLoadHistoryProgress?.(0);
    const onProgress = (source: 'miner' | 'vault', progressPct: number) => {
      if (source === 'miner') miningProgress = progressPct;
      else vaultProgress = progressPct;
      this.onLoadHistoryProgress?.(Math.round(100 * ((vaultProgress + miningProgress) / 2)) / 100);
    };

    let miningHistoryPromise: Promise<IMiningAccountPreviousHistoryRecord[] | undefined> = Promise.resolve(undefined);
    if (hasMiningHistory) {
      const liveClient = await this.clients.archiveClientPromise;
      miningHistoryPromise = this.loadMiningHistory(liveClient, miningAccount, pct => onProgress('miner', pct));
    }

    let vaultingHistoryPromise: Promise<IVaultingRules | undefined> = Promise.resolve(undefined);
    if (hasVaultHistory) {
      if (!loadVaultHistory) {
        throw new Error('No vault history loader provided');
      }
      vaultingHistoryPromise = loadVaultHistory({
        vaultingAddress: this.vaultingWallet.address,
        bitcoinXprivSeed,
        onProgress: pct => onProgress('vault', pct),
      });
    }
    const [miningHistory, vaultingRules] = await Promise.all([miningHistoryPromise, vaultingHistoryPromise]);
    this.onLoadHistoryProgress?.(100);
    return {
      miningHistory,
      vaultingRules,
    };
  }

  private async fetchSeatData(
    api: ArgonClient,
    accountSubaccounts: Record<string, any>,
  ): Promise<Record<number, IMiningAccountPreviousHistorySeat[]>> {
    const minersByCohort = await api.query.miningSlot.minersByCohort.entries();

    const seatsByFrameId = {} as Record<number, IMiningAccountPreviousHistorySeat[]>;
    for (const [frameIdRaw, seatsInFrame] of minersByCohort) {
      const frameId = frameIdRaw.args[0].toNumber();
      for (const [seatPosition, seatRaw] of seatsInFrame.entries()) {
        const address = seatRaw.accountId.toHuman();
        const isOurAccount = !!accountSubaccounts[address];
        if (!isOurAccount) continue;
        seatsByFrameId[frameId] ??= [];
        seatsByFrameId[frameId].push({
          seatPosition,
          microgonsBid: seatRaw.bid.toBigInt(),
          micronotsStaked: seatRaw.argonots.toBigInt(),
        });
      }
    }
    return seatsByFrameId;
  }

  private async loadMicrogonBalance(wallet: IWallet) {
    const client = await this.clients.prunedClientOrArchivePromise;
    const result = await client.query.system.account(wallet.address);
    this.handleMicrogonBalanceChange(result, wallet);
  }

  private async loadMicronotBalance(wallet: IWallet) {
    const client = await this.clients.prunedClientOrArchivePromise;
    const result = await client.query.ownership.account(wallet.address);
    this.handleMicronotBalanceChange(result, wallet);
  }

  private handleMicrogonBalanceChange(result: FrameSystemAccountInfo, wallet: IWallet) {
    const availableMicrogons = result.data.free.toBigInt();
    const reservedMicrogons = result.data.reserved.toBigInt();
    const availableMicrogonsDiff = availableMicrogons + reservedMicrogons - wallet.availableMicrogons;

    wallet.availableMicrogons = availableMicrogons;
    wallet.reservedMicrogons = reservedMicrogons;

    this.totalWalletMicrogons += availableMicrogonsDiff;
    this.onBalanceChange?.();
  }

  private handleMicronotBalanceChange(result: PalletBalancesAccountData, wallet: IWallet) {
    const availableMicronots = result.free.toBigInt();
    const reservedMicronots = result.reserved.toBigInt();
    const micronotsDiff = availableMicronots + reservedMicronots - wallet.availableMicronots;

    wallet.availableMicronots = availableMicronots;
    wallet.reservedMicronots = reservedMicronots;

    this.totalWalletMicronots += micronotsDiff;
    this.onBalanceChange?.();
  }

  public static doesWalletHaveValue(wallet: IWallet): boolean {
    if (wallet.availableMicrogons > 0n) return true;
    if (wallet.availableMicronots > 0n) return true;
    if (wallet.reservedMicronots > 0n) return true;
    if (wallet.reservedMicrogons > 0n) return true;
    return false;
  }
}
