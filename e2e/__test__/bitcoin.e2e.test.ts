import { describe, it } from 'vitest';
import { createFlowSession, type IFlowSession } from '../flows/session.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

type BitcoinFlowName = 'Bitcoin.flow.liquidCreate' | 'Bitcoin.flow.lockUnlock' | 'Bitcoin.flow.orphanClaim';

async function runIsolatedFlow(flowName: BitcoinFlowName): Promise<void> {
  const sessionName = `bitcoin-spec-${flowName}`;
  const session: IFlowSession = await createFlowSession({
    useTestNetwork: true,
    sessionName,
  });

  try {
    await session.run(flowName);
  } finally {
    await session.close();
  }
}

describe.skipIf(skipE2E).sequential('Bitcoin Operation Flows', () => {
  it(
    'bitcoin liquid create, ratchet, and close',
    async () => {
      await runIsolatedFlow('Bitcoin.flow.liquidCreate');
    },
    45 * 60_000,
  );

  it(
    'bitcoin lock/unlock',
    async () => {
      await runIsolatedFlow('Bitcoin.flow.lockUnlock');
    },
    45 * 60_000,
  );

  it(
    'bitcoin orphan claim',
    async () => {
      await runIsolatedFlow('Bitcoin.flow.orphanClaim');
    },
    45 * 60_000,
  );
});
