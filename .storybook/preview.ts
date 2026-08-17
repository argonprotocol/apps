import type { Preview } from '@storybook/vue3-vite';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { sb } from 'storybook/test';
import '../src-vue/main.css';

NetworkConfig.setNetwork('localnet');

sb.mock(import('@tauri-apps/plugin-dialog'));
sb.mock(import('../src-vue/stores/argonBonds.ts'), { spy: true });
sb.mock(import('../src-vue/stores/basics.ts'), { spy: true });
sb.mock(import('../src-vue/stores/bitcoin.ts'), { spy: true });
sb.mock(import('../src-vue/stores/bot.ts'), { spy: true });
sb.mock(import('../src-vue/stores/config.ts'));
sb.mock(import('../src-vue/stores/currency.ts'));
sb.mock(import('../src-vue/stores/financials.ts'), { spy: true });
sb.mock(import('../src-vue/stores/helpers/dbPromise.ts'), { spy: true });
sb.mock(import('../src-vue/stores/installer.ts'), { spy: true });
sb.mock(import('../src-vue/stores/mainchain.ts'), { spy: true });
sb.mock(import('../src-vue/stores/server.ts'), { spy: true });
sb.mock(import('../src-vue/stores/miningAssetBreakdown.ts'), { spy: true });
sb.mock(import('../src-vue/stores/miningStats.ts'));
sb.mock(import('../src-vue/stores/myMiningSeats.ts'), { spy: true });
sb.mock(import('../src-vue/stores/moveFromEthereum.ts'), { spy: true });
sb.mock(import('../src-vue/stores/moveToEthereum.ts'), { spy: true });
sb.mock(import('../src-vue/stores/tour.ts'), { spy: true });
sb.mock(import('../src-vue/stores/transactions.ts'), { spy: true });
sb.mock(import('../src-vue/stores/upstreamOperator.ts'), { spy: true });
sb.mock(import('../src-vue/stores/vaultingStats.ts'));
sb.mock(import('../src-vue/stores/vaultingAssetBreakdown.ts'), { spy: true });
sb.mock(import('../src-vue/stores/vaults.ts'));
sb.mock(import('../src-vue/stores/wallets.ts'), { spy: true });
sb.mock(import('../src-vue/lib/EthereumClient.ts'));
sb.mock(import('../src-vue/tauri-controls/utils/os.ts'));
sb.mock(import('../src-vue/lib/OperationalAccount.ts'), { spy: true });

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
  },
};

export default preview;
