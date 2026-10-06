import { describe, expect, it } from 'vitest';
import { FlowSession } from '../FlowSession.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

type OnboardingFlowName = 'Mining.flow.onboarding' | 'Vaulting.flow.onboarding';

async function runIsolatedFlow(flowName: OnboardingFlowName): Promise<void> {
  const sessionName = `onboarding-spec-${flowName}`;
  const session = await FlowSession.start({
    useTestNetwork: true,
    sessionName,
  });

  try {
    if (flowName === 'Vaulting.flow.onboarding') {
      const result = await session.run(flowName, { securitizationArgons: '2400', securitizationArgonots: '50' });
      expect(result.data.createdVaultCapital).toEqual({
        argons: '2400000000',
        argonots: '50000000',
        configuredArgonots: '50000000',
      });
      const settings = await session.run('Vaulting.flow.settings');
      expect(settings.data.updatedVaultSettings).toEqual({
        argons: '2400000000',
        argonots: '60000000',
        flatFee: '3000000',
        configuredFlatFee: '3000000',
      });
    } else {
      await session.run(flowName);
    }
  } finally {
    await session.close();
  }
}

describe.skipIf(skipE2E).sequential('Operational Flows', () => {
  it(
    'mining onboarding',
    async () => {
      await runIsolatedFlow('Mining.flow.onboarding');
    },
    45 * 60_000,
  );

  it(
    'vaulting onboarding',
    async () => {
      await runIsolatedFlow('Vaulting.flow.onboarding');
    },
    45 * 60_000,
  );
});
