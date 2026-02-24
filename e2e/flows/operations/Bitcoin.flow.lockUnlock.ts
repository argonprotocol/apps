import { createBitcoinFlowContext, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import bitcoinEnsureLockFundingDetails from './Bitcoin.op.ensureLockFundingDetails.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
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
  async inspect() {
    return {
      chainState: {},
      uiState: {},
      isRunnable: true,
      isComplete: false,
      blockers: [],
    };
  },
  async run({ flow, flowName }, _state, api) {
    const vaultingContext = createVaultingFlowContext(flow, flowName);
    await flow.runOperations(vaultingContext, [vaultingOnboarding]);
    await api.run(bitcoinEnsureLockFundingDetails);
    await api.run(bitcoinFundLockExact);
    await api.run(bitcoinWaitUnlockReady);
    await api.run(bitcoinUnlockBitcoin);
  },
});
