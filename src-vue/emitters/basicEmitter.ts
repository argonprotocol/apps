import mitt, { type Emitter } from 'mitt';
import Importer from '../lib/Importer.ts';
import { IWalletType } from '../lib/Wallet.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';

type IBasicEmitter = {
  openWalletOverlay: { walletType: IWalletType; screen: string };
  openBotEditOverlay: void;
  openServerRemoveOverlay: void;
  openSecuritySettingsOverlay: void;
  openProvisioningCompleteOverlay: void;
  openServerConnectOverlay: void;
  closeAllOverlays: void;
  openAboutOverlay: void;
  openComplianceOverlay: void;
  openTroubleshootingOverlay: {
    screen: 'server-diagnostics' | 'data-and-log-files' | 'options-for-restart' | 'overview';
  };
  openImportingOverlay: { importer: Importer; dataRaw: string };
  openCheckForAppUpdatesOverlay: void;
  openHowMiningWorksOverlay: void;
  openHowVaultingWorksOverlay: void;
  openWelcomeOverlay: void;

  openPortfolioPanel: PortfolioTab;
};

const basicEmitter: Emitter<IBasicEmitter> = mitt<IBasicEmitter>();

export default basicEmitter;
