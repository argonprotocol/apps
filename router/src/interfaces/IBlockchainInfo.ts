export interface IBlockchainInfo {
  blocks: number;
  time: number;
  chain: string;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  mediantime: number;
  verificationprogress: number;
  initialblockdownload: boolean;
  chainwork: string;
  size_on_disk: number;
  pruned: boolean;
  pruneheight?: number;
  automatic_pruning?: boolean;
  prune_target_size?: number;
  softforks: any[];
  bip9_softforks: Record<string, { status: string; startTime: number; timeout: number; since: number }>;
  warnings: string;
}
