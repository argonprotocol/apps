import { isAddress } from '@argonprotocol/mainchain';
import type { ISudoFundWalletInput } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
export {
  sudoFundWallet,
  type ISudoFundWalletInput,
  type ISudoFundWalletResult,
} from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import type { IE2EFlowRuntime } from '../types.ts';
import { readClipboardWithRetries } from './readClipboardWithRetries.ts';

export async function getWalletOverlayFundingNeeded(flow: IE2EFlowRuntime): Promise<ISudoFundWalletInput> {
  const microgonsNeededRaw = await flow.getAttribute('WalletOverlay.microgonsNeeded', 'data-value');
  const micronotsNeededRaw = await flow
    .getAttribute('WalletOverlay.micronotsNeeded', 'data-value', { timeoutMs: 1_000 })
    .catch(() => null);
  const address = await readClipboardWithRetries(
    flow,
    () => flow.click('walletAddress.copyContent()'),
    value => isAddress(value),
  );
  if (!address) {
    throw new Error('missing wallet address');
  }

  if (!microgonsNeededRaw) {
    throw new Error('missing microgonsNeeded');
  }

  const microgons = BigInt(microgonsNeededRaw);
  const micronotsNeeded = BigInt(micronotsNeededRaw ?? '0');

  return {
    address,
    microgons,
    micronots: micronotsNeeded,
  };
}
