import { MINING_BID_PROXY_FEE_FLOAT } from '@argonprotocol/apps-core';
import { bigIntMax } from '@argonprotocol/apps-core/src/utils.ts';
import { MiningSetupStatus } from '../../interfaces/IConfig.ts';

export interface IMiningFundingState {
  isFullyFunded: boolean;
  requiredMicrogons: bigint;
  requiredMicronots: bigint;
  additionalMicrogonsNeeded: bigint;
  additionalMicronotsNeeded: bigint;
}

export function getMiningFundingState(args: {
  hasSavedBiddingRules: boolean;
  miningSetupStatus: MiningSetupStatus;
  miningMicrogonsOnHand: bigint;
  miningMicronotsOnHand: bigint;
  initialMicrogonRequirement?: bigint;
  initialMicronotRequirement?: bigint;
}): IMiningFundingState {
  if (!args.hasSavedBiddingRules) {
    return {
      isFullyFunded: false,
      requiredMicrogons: 0n,
      requiredMicronots: 0n,
      additionalMicrogonsNeeded: 0n,
      additionalMicronotsNeeded: 0n,
    };
  }

  const requiredMicrogons =
    (args.initialMicrogonRequirement ?? 0n) +
    (args.miningSetupStatus === MiningSetupStatus.Finished ? 0n : MINING_BID_PROXY_FEE_FLOAT);
  const requiredMicronots = args.initialMicronotRequirement ?? 0n;
  const additionalMicrogonsNeeded = bigIntMax(requiredMicrogons - args.miningMicrogonsOnHand, 0n);
  const additionalMicronotsNeeded = bigIntMax(requiredMicronots - args.miningMicronotsOnHand, 0n);

  return {
    isFullyFunded: additionalMicrogonsNeeded === 0n && additionalMicronotsNeeded === 0n,
    requiredMicrogons,
    requiredMicronots,
    additionalMicrogonsNeeded,
    additionalMicronotsNeeded,
  };
}
