import { describe, expect, it } from 'vitest';
import {
  createCrosschainTransferProgress,
  formatCrosschainBlockStepDetail,
  hydrateCrosschainTransferProgress,
  setOutboundMintingAuthorizationStepProgress,
} from '../lib/CrosschainTransferProgress.ts';
import { getGatewayActivityWaitEstimateMs } from '../lib/EthereumClient.ts';

describe('CrosschainTransferProgress', () => {
  it('smooths waiting-step progress between tracker updates', () => {
    const startedAt = 1_000;
    const progress = setOutboundMintingAuthorizationStepProgress(
      createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
      {
        progressPct: 0,
        detail: 'Waiting for Minting Authorization (0% authorized)',
      },
    );
    progress.steps[1].startedAt = startedAt;

    const displayProgress = hydrateCrosschainTransferProgress(
      progress.steps,
      startedAt + getGatewayActivityWaitEstimateMs() / 2,
    );

    expect(displayProgress.currentStepLabel).toBe('Step 2 of 3: Waiting for Minting Authorization');
    expect(displayProgress.overallProgressPct).toBeGreaterThan(progress.overallProgressPct);
    expect(displayProgress.overallProgressPct).toBeCloseTo(50, 1);
  });

  it('allows confirmation-driven progress to keep moving between updates', () => {
    const progress = setOutboundMintingAuthorizationStepProgress(
      createCrosschainTransferProgress([
        'Finalizing on Argon',
        'Waiting for Minting Authorization',
        'Sending to Ethereum',
      ]),
      {
        progressPct: 33,
        detail: 'Argon block 2 of 4',
        confirmations: 1,
        expectedConfirmations: 3,
      },
    );

    const displayProgress = hydrateCrosschainTransferProgress(
      progress.steps,
      Date.now() + getGatewayActivityWaitEstimateMs() / 2,
    );

    expect(displayProgress.overallProgressPct).toBeCloseTo(50, 1);
  });

  it('clamps block confirmation detail at the final count', () => {
    expect(
      formatCrosschainBlockStepDetail({
        blockType: 'Argon',
        confirmations: 4,
        expectedConfirmations: 4,
      }),
    ).toBe('Argon confirmation 4 of 4');
  });
});
