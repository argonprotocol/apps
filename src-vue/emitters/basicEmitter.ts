import mitt, { type Emitter } from 'mitt';
import { ComputedRef } from 'vue';
import Importer from '../lib/Importer';

type IBasicEmitter = {
  openWalletOverlay: { walletId: string; screen: string };
  openBotOverlay: void;
  openServerRemoveOverlay: void;
  openSecuritySettingsOverlay: void;
  openVaultOverlay: void;
  openProvisioningCompleteOverlay: void;
  openServerConnectOverlay: void;
  closeAllOverlays: void;
  openServerConfigureOverlay: void;
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
};

const basicEmitter: Emitter<IBasicEmitter> = mitt<IBasicEmitter>();

export default basicEmitter;
