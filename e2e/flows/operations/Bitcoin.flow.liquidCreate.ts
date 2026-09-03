import { createBitcoinFlowContext, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import bitcoinActivateTab from './Bitcoin.op.activateTab.ts';
import bitcoinCloseLiquid from './Bitcoin.op.closeLiquid.ts';
import bitcoinCreateLiquid from './Bitcoin.op.createLiquid.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
import bitcoinReadLockFundingDetails from './Bitcoin.op.readLockFundingDetails.ts';
import bitcoinRatchetLiquid from './Bitcoin.op.ratchetLiquid.ts';
import bitcoinStartBitcoinLock from './Bitcoin.op.startBitcoinLock.ts';
import bitcoinWaitUnlockReady from './Bitcoin.op.waitUnlockReady.ts';
import { OperationalFlow } from './index.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';

type ILiquidCreateFlowState = IE2EOperationInspectState<
  {
    activeFissionCount: number;
    activeLiquidCount: number;
    archivedLiquidCount: number;
    archivedRatchetHistoryCount: number;
  },
  { detailOverlayVisible: boolean }
>;

export default new OperationalFlow<IBitcoinFlowContext, ILiquidCreateFlowState>(import.meta, {
  description: 'Fund a Bitcoin Lock, then create, ratchet, and close one Liquid through the desktop UI.',
  defaultTimeoutMs: 20_000,
  createContext: createBitcoinFlowContext,
  async inspect({ flow }) {
    const [chainState, detailOverlay] = await Promise.all([
      flow.queryApp(refs => {
        const fissions = refs.getBitcoinFissions();
        const liquids = fissions.getLiquids();
        const archived = liquids.filter(liquid => liquid.isClosed);
        return {
          activeFissionCount: fissions.getAll().length,
          activeLiquidCount: liquids.filter(liquid => !liquid.isClosed).length,
          archivedLiquidCount: archived.length,
          archivedRatchetHistoryCount: archived.filter(liquid => liquid.history.some(entry => entry.kind === 'ratchet'))
            .length,
        };
      }),
      flow.isVisible('BitcoinLiquidDetailOverlay'),
    ]);
    const current = chainState ?? {
      activeFissionCount: 0,
      activeLiquidCount: 0,
      archivedLiquidCount: 0,
      archivedRatchetHistoryCount: 0,
    };
    const isComplete =
      current.activeFissionCount === 0 &&
      current.activeLiquidCount === 0 &&
      current.archivedLiquidCount === 1 &&
      current.archivedRatchetHistoryCount === 1;
    return {
      chainState: current,
      uiState: { detailOverlayVisible: detailOverlay.visible },
      state: isComplete ? 'complete' : 'runnable',
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
    await flow.run(bitcoinActivateTab);
    await flow.run(bitcoinCreateLiquid);
    await flow.run(bitcoinRatchetLiquid);
    await flow.run(bitcoinCloseLiquid);
  },
});
