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
  const micronotsNeededRaw = await flow.getAttribute('WalletOverlay.micronotsNeeded', 'data-value');
  const microgonsNeededRaw = await flow.getAttribute('WalletOverlay.microgonsNeeded', 'data-value');
  const address = await readClipboardWithRetries(
    flow,
    () => flow.click('walletAddress.copyContent()'),
    value => isAddress(value),
  );
  if (!address) {
    throw new Error('missing wallet address');
  }

  if (!micronotsNeededRaw) {
    throw new Error('missing micronotsNeeded');
  }
  if (!microgonsNeededRaw) {
    throw new Error('missing microgonsNeeded');
  }

  const micronots = BigInt(micronotsNeededRaw);
  const microgons = BigInt(microgonsNeededRaw);

  return {
    address,
    microgons,
    micronots,
  };
}
