import { createBitcoinFlowContext, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
import bitcoinOpenLockFundingOverlay from './Bitcoin.op.openLockFundingOverlay.ts';
import bitcoinReadLockFundingDetails from './Bitcoin.op.readLockFundingDetails.ts';
import bitcoinStartBitcoinLock from './Bitcoin.op.startBitcoinLock.ts';
import bitcoinUnlockBitcoin from './Bitcoin.op.unlockBitcoin.ts';
import bitcoinWaitUnlockReady from './Bitcoin.op.waitUnlockReady.ts';
import { OperationalFlow } from './index.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type ILockUnlockState = IE2EOperationInspectState<Record<string, never>, Record<string, never>>;

export default new OperationalFlow<IBitcoinFlowContext, ILockUnlockState>(import.meta, {
  description: 'Perform one bitcoin lock and unlock cycle using an operational vault.',
  defaultTimeoutMs: 20_000,
  createContext: createBitcoinFlowContext,
  async inspect({ state }) {
    return {
      chainState: {},
      uiState: {},
      state: state.isCompleted ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow, flowName, state }) {
    const vaultingContext = createVaultingFlowContext(flow, flowName);
    await flow.run(vaultingContext, vaultingOnboarding);
    await flow.run(bitcoinStartBitcoinLock);
    await flow.run(bitcoinOpenLockFundingOverlay);
    await flow.run(bitcoinReadLockFundingDetails);
    await flow.run(bitcoinFundLockExact);
    await flow.run(bitcoinWaitUnlockReady);
    await flow.run(bitcoinUnlockBitcoin);
    state.isCompleted = true;
  },
});
