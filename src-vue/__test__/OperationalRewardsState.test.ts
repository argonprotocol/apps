import { describe, expect, it } from 'vitest';
import { shouldAutoOpenCertificationComplete } from '../overlays/helpers/OperationalRewardsState.ts';

describe('operational rewards overlay state', () => {
  it('does not open certification complete for restored startup state', () => {
    expect(
      shouldAutoOpenCertificationComplete(
        { hasLoadedInitialProgress: true, isFullyOperational: true },
        { hasLoadedInitialProgress: false, isFullyOperational: false },
      ),
    ).toBe(false);
  });

  it('opens certification complete for a live operational transition after startup', () => {
    expect(
      shouldAutoOpenCertificationComplete(
        { hasLoadedInitialProgress: true, isFullyOperational: true },
        { hasLoadedInitialProgress: true, isFullyOperational: false },
      ),
    ).toBe(true);
  });

  it('does not reopen certification complete for an unchanged operational state', () => {
    expect(
      shouldAutoOpenCertificationComplete(
        { hasLoadedInitialProgress: true, isFullyOperational: true },
        { hasLoadedInitialProgress: true, isFullyOperational: true },
      ),
    ).toBe(false);
  });
});
