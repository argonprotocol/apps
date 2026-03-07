import mitt, { type Emitter } from 'mitt';
import Importer from '../lib/Importer.ts';
import { WalletType } from '../lib/Wallet.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import { OperationalStepId } from '../stores/operationsController.ts';

type IBasicEmitter = {
  openWalletOverlay: { walletType: WalletType.miningHold | WalletType.vaulting; screen: string };
  openMoveCapitalOverlay: { walletType: WalletType.miningHold | WalletType.vaulting };

  openBotEditOverlay: void;
  openServerRemoveOverlay: void;
  openSecuritySettingsOverlay: { screen: 'overview' | 'mnemonics' | 'ssh' | 'encrypt' | 'export' } | undefined;
  openProvisioningCompleteOverlay: void;
  openServerConnectPanel: void;
  closeAllOverlays: void;
  openAboutOverlay: void;
  openJurisdictionOverlay: void;
  openTroubleshootingOverlay: {
    screen: 'server-diagnostics' | 'data-and-log-files' | 'options-for-restart' | 'overview' | 'find-missing-data';
  };
  openCheckForAppUpdatesOverlay: void;
  openWelcomeOverlay: void;

  openPortfolioPanel: PortfolioTab;

  openImportAccountOverlay: void;
  openImportingAccountOverlay: { importer: Importer; dataRaw: string };

  openProfileOverlay: void;

  openVaultCouponsOverlay: void;

  openServerOverlay: void;
  openOperationalOverlay: OperationalStepId;
  openOperationalFinishOverlay: void;
};

const basicEmitter: Emitter<IBasicEmitter> = mitt<IBasicEmitter>();

export default basicEmitter;
