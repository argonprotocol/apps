export default interface IStabilizerBuyData {
  throughDate: string;
  ethereumBlockNumber: number;
  argonTokenAddress: string;
  usdcTokenAddress: string;
  pools: { version: 2 | 3 | 4; id: string; createdAt: number; createdAtBlock: number; argonIsToken0: boolean }[];
  rewardFunding?: {
    frameRange: [number, number];
    argonBlockRange: [number, number];
    frameCount: number;
    averageArgonsPerFrame: string;
  };
  days: {
    date: string;
    buyCount: number;
    argonBought: string;
    usdcSpent: string;
    costInTargetArgons: string;
    ethereumPurchaseBlockRange?: [number, number];
    argonPriceBlockRange?: [number, number];
  }[];
}
