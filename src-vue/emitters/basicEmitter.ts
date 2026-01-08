import mitt, { type Emitter } from 'mitt';
import Importer from '../lib/Importer.ts';
import { WalletType } from '../lib/Wallet.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';

type IBasicEmitter = {
  openWalletOverlay: { walletType: WalletType.miningHold | WalletType.vaulting; screen: string };
  openMoveCapitalOverlay: { walletType: WalletType.miningHold | WalletType.vaulting };

  openBotEditOverlay: void;
  openServerRemoveOverlay: void;
  openSecuritySettingsOverlay: void;
  openProvisioningCompleteOverlay: void;
  openServerConnectOverlay: void;
  closeAllOverlays: void;
  openAboutOverlay: void;
  openJurisdictionOverlay: void;
  openTroubleshootingOverlay: {
    screen: 'server-diagnostics' | 'data-and-log-files' | 'options-for-restart' | 'overview';
  };
  openImportingOverlay: { importer: Importer; dataRaw: string };
  openCheckForAppUpdatesOverlay: void;
  openHowMiningWorksOverlay: void;
  openHowVaultingWorksOverlay: void;
  openWelcomeOverlay: void;

  openPortfolioPanel: PortfolioTab;
  openImportAccountOverlay: void;
};

const basicEmitter: Emitter<IBasicEmitter> = mitt<IBasicEmitter>();

export default basicEmitter;
