import { createBitcoinFlowContext, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import bitcoinClaimOrphan, { readBitcoinOrphanReturnState } from './Bitcoin.op.claimOrphan.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
import bitcoinReadLockFundingDetails from './Bitcoin.op.readLockFundingDetails.ts';
import bitcoinStartBitcoinLock from './Bitcoin.op.startBitcoinLock.ts';
import bitcoinUnlockBitcoin from './Bitcoin.op.unlockBitcoin.ts';
import bitcoinWaitUnlockReady from './Bitcoin.op.waitUnlockReady.ts';
import { OperationalFlow } from './index.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';

type IOrphanClaimState = IE2EOperationInspectState<
  { orphanExists: boolean; returnComplete: boolean },
  Record<string, never>
>;

export default new OperationalFlow<IBitcoinFlowContext, IOrphanClaimState>(import.meta, {
  description: 'Claim a late Bitcoin deposit sent to a completed lock receive address.',
  defaultTimeoutMs: 20_000,
  createContext: createBitcoinFlowContext,
  async inspect({ flow, state }) {
    const orphanState = await readBitcoinOrphanReturnState(flow, state.orphanDepositTxid);
    return {
      chainState: orphanState,
      uiState: {},
      state: orphanState.returnComplete ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow, flowName }) {
    const vaultingContext = createVaultingFlowContext(flow, flowName);
    await flow.run(vaultingContext, vaultingOnboarding);
    await flow.run(bitcoinStartBitcoinLock);
    await flow.run(bitcoinReadLockFundingDetails);
    await flow.run(bitcoinFundLockExact);
    await flow.run(bitcoinWaitUnlockReady);
    await flow.run(bitcoinUnlockBitcoin);
    await flow.run(bitcoinClaimOrphan);
  },
});
