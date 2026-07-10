import mitt, { type Emitter } from 'mitt';
import { WalletType } from '../lib/Wallet.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import type { OperationalStepId } from '../stores/certificationController.ts';
import { ICurrencyKey, MoveTo } from '@argonprotocol/apps-core';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';

export type IWalletGuidanceContext = 'mining' | 'vaulting';

type IBasicEmitter = {
  openWalletOverlay: {
    walletType: WalletType.defaultArgon | WalletType.ethereum;
    showGuidance?: boolean;
    guidanceContext?: IWalletGuidanceContext;
  };
  openMoveCapitalOverlay: {
    walletType: WalletType.defaultArgon;
    moveTo?: MoveTo;
    maxAmount?: bigint;
  };
  openBotEditOverlay: void;
  openServerRemoveOverlay: void;
  openSecuritySettingsOverlay: { screen: 'overview' | 'mnemonics' | 'ssh' | 'encrypt' | 'ethereum-export' } | undefined;
  openProvisioningCompleteOverlay: void;
  openServerConnectPanel: void;
  closeAllOverlays: void;
  openAboutOverlay: void;
  openSoftwareInfoOverlay: void;
  openJurisdictionOverlay: { setCurrencyKey: ICurrencyKey } | undefined;
  openTroubleshootingOverlay: {
    screen: 'server-diagnostics' | 'data-and-log-files' | 'options-for-restart' | 'overview' | 'find-missing-data';
  };
  openCheckForAppUpdatesOverlay: void;
  openWelcomeOverlay: void;

  openPortfolioPanel: PortfolioTab;

  openImportAccountOverlay: void;

  openProfileOverlay: void;

  openVaultsOverlay: void;
  openTransactionsOverlay: void;

  openVaultCollect: void;
  openTreasuryBondsOverlay: void;
  openArgonotCommitmentOverlay: void;
  openMintingAuthorityRequestOverlay: void;
  openGatewayRelayOverlay: void;
  openBitcoinLock: { lock?: IBitcoinLockRecord } | undefined;
  openBitcoinUnlock: IBitcoinLockRecord;
  resumeBitcoinFunding: IBitcoinLockRecord;

  openServerOverlay: void;
  openServerSettingsOverlay: void;
  openOperationalOverlay: OperationalStepId;
  openOperationalRewardsOverlay: { screen?: 'activate' | 'congratulations' | 'claim' } | undefined;
};

const basicEmitter: Emitter<IBasicEmitter> = mitt<IBasicEmitter>();

export default basicEmitter;
