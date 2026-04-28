import mitt, { type Emitter } from 'mitt';
import { WalletType } from '../lib/Wallet.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import { OperationalStepId } from '../stores/operationsController.ts';
import { MoveTo } from '@argonprotocol/apps-core';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import type { SignClientTypes } from '@walletconnect/types';

type IBasicEmitter = {
  openWalletOverlayOld: {
    walletType: WalletType.miningHold | WalletType.vaulting;
    screen: 'receive' | 'receive-onboarding';
  };
  openWalletOverlay: {
    walletType: WalletType.miningHold | WalletType.vaulting | WalletType.investment | WalletType.ethereum;
  };
  openSigningOverlay: SignClientTypes.EventArguments['session_request'];
  openMoveCapitalOverlay: {
    walletType: WalletType.miningHold | WalletType.vaulting;
    moveTo?: MoveTo;
    maxAmount?: bigint;
  };

  openBotEditOverlay: void;
  openServerRemoveOverlay: void;
  openSecuritySettingsOverlay: { screen: 'overview' | 'mnemonics' | 'ssh' | 'encrypt' } | undefined;
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

  openProfileOverlay: void;

  openVaultsOverlay: void;

  openVaultCollect: void;
  openVaultMembersOverlay: void;
  openTreasuryBondsOverlay: void;
  openBitcoinLock: { lock?: IBitcoinLockRecord } | undefined;
  openBitcoinUnlock: IBitcoinLockRecord;
  resumeBitcoinFunding: IBitcoinLockRecord;

  openServerOverlay: void;
  openOperationalOverlay: OperationalStepId;
  openOperationalRewardsOverlay:
    | { screen?: 'activate' | 'congratulations' | 'overview' | 'claim'; section?: 'create' | 'unlock' | 'outbound' }
    | undefined;
  openOperationalFinishOverlay: void;
};

const basicEmitter: Emitter<IBasicEmitter> = mitt<IBasicEmitter>();

export default basicEmitter;
