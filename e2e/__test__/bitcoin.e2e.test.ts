import { describe, expect, it } from 'vitest';
import { createFlowSession, type IFlowSession } from '../flows/session.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

type BitcoinFlowName = 'Bitcoin.flow.lockUnlock';

async function runIsolatedFlow(flowName: BitcoinFlowName): Promise<number> {
  const sessionName = `bitcoin-spec-${flowName}`;
  const session: IFlowSession = await createFlowSession({
    useTestNetwork: true,
    sessionName,
  });

  try {
    const result = await session.run(flowName);
    return result.elapsedMs;
  } finally {
    await session.close();
  }
}

describe.skipIf(skipE2E).sequential('Bitcoin Operation Flows', () => {
  it(
    'bitcoin lock/unlock',
    async () => {
      const elapsedMs = await runIsolatedFlow('Bitcoin.flow.lockUnlock');
      expect(elapsedMs).toBeGreaterThan(0);
    },
    45 * 60_000,
  );
});
