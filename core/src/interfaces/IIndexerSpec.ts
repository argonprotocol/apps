export enum AccountActivityKind {
  /** Direct ARGN or ARGNOT movement between mainchain accounts. */
  Transfer = 1 << 0,
  /** Mining-auction capital changes before a seat is awarded. */
  MiningBid = 1 << 1,
  /** A won mining seat's lifecycle and the value produced by that seat. */
  MiningSeat = 1 << 2,
  /** Vault creation, configuration, securitization, release, or closure. */
  VaultPosition = 1 << 3,
  /** Vault earnings becoming collectible, collected, burned, or failing to record. */
  VaultRevenue = 1 << 4,
  /** Treasury bond purchase, participation, release, or lifecycle failure. */
  BondPosition = 1 << 5,
  /** Bitcoin lock/UTXO lifecycle, including the pre-BitcoinLocks Bonds pallet. */
  BitcoinLock = 1 << 7,
  /** ARGN minted to an account from a funded Bitcoin lock. */
  BitcoinMint = 1 << 8,
  /** Funds entering or leaving mainchain through localchain or cross-chain gateways. */
  Crosschain = 1 << 9,
  /** Rewards paid because an account provides an operational network role. */
  OperationalReward = 1 << 10,
  /** The account that actually paid an extrinsic fee. */
  Fee = 1 << 11,
  /** Other named balance mutation retained for later reclassification. */
  AccountBalance = 1 << 12,
}

export interface IAccountActivityQuery {
  afterBlock?: number;
  toBlock?: number;
  activityMask?: number;
}

export interface IIndexerSpec {
  '/transfers/:address': {
    responseType: {
      transfers: {
        blockNumber: number;
        source: 'transfer' | 'faucet' | 'tokenGateway' | 'ethereum';
        currency: 'argon' | 'argonot';
        toAddress: string;
        fromAddress: string | null;
      }[];
      asOfBlock: number;
    };
  };
  '/vault-collects/:address': {
    responseType: {
      vaultCollects: {
        vaultAddress: string;
        blockNumber: number;
      }[];
      asOfBlock: number;
    };
  };
  '/v2/activity/:address': {
    requestQuery: IAccountActivityQuery;
    responseType: {
      blocks: {
        blockNumber: number;
        blockHash: string;
        specVersion: number;
        activityMask: number;
      }[];
      asOfBlock: number;
      definitionVersion: number;
      coverage: {
        fromBlock: number;
        toBlock: number;
        gaps: { fromBlock: number; toBlock: number; reason: string }[];
      };
    };
  };
}
