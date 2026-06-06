import { describe, it } from 'vitest';
import { createFlowSession } from '../flows/session.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Ethereum transfer-out flow', () => {
  it(
    'waits for the backend authority and transfers ARGN to Ethereum',
    async () => {
      const session = await createFlowSession({
        useTestNetwork: true,
        sessionName: 'ethereum-transfer-out-spec',
        appEnv: {
          ARGON_DEV_ETHEREUM: '1',
          ARGON_DEV_ETHEREUM_MINTING_AUTHORITY: '1',
          ARGON_DEV_ETHEREUM_PRESET: 'minimal',
        },
      });

      try {
        await session.run('Vaulting.flow.transferOutToEthereum');
      } finally {
        await session.close();
      }
    },
    75 * 60_000,
  );
});
