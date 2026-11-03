import Fs from 'node:fs';
import Path from 'node:path';
import { mnemonicGenerate, waitForLoad } from '@argonprotocol/mainchain';
import { WalletKeys } from '../src-vue/lib/WalletKeys.ts';
import { getDevPaths, type DevProfile } from './session.ts';

export async function readDevWalletKeys(
  options: DevProfile & { detachUpstreamApp?: boolean },
  create = false,
): Promise<WalletKeys> {
  const { instanceDir } = getDevPaths(options);
  const mnemonicPath = Path.join(instanceDir, 'mnemonic');
  if (!Fs.existsSync(mnemonicPath)) {
    if (!create || Fs.existsSync(Path.join(instanceDir, 'wallet.json'))) {
      throw new Error(
        'The selected instance has no local development mnemonic. Open it first, or select a fresh dev instance.',
      );
    }
    await waitForLoad();
    let mnemonic = mnemonicGenerate();
    if (options.detachUpstreamApp) {
      const { DEV_UPSTREAM_MASTER_MNEMONIC } = await import('../e2e/scripts/devUpstreamServer.ts');
      mnemonic = DEV_UPSTREAM_MASTER_MNEMONIC;
    }
    Fs.mkdirSync(instanceDir, { recursive: true });
    Fs.writeFileSync(mnemonicPath, `${mnemonic}\n`, { flag: 'wx', mode: 0o600 });
  }
  await waitForLoad();
  const mnemonic = Fs.readFileSync(mnemonicPath, 'utf8').trim();
  return WalletKeys.fromMnemonic(mnemonic);
}
