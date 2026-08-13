import mitt, { type Emitter } from 'mitt';
import { WalletType } from '../lib/Wallet.ts';
import { PortfolioTab } from '../panels/interfaces/IPortfolioTab.ts';
import type { OperationalStepId } from '../stores/certificationController.ts';
import { ICurrencyKey, type BondLot } from '@argonprotocol/apps-core';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import type { IVaultFlexibleAssetChanges } from '../lib/MyVault.ts';

export type IWalletGuidanceContext = 'mining' | 'vaulting';

export type IOperationalProfileRequest = {
  draftName: string;
  onSelect: (operatorName: string) => void;
};

export type IWalletOverlayRequest = {
  walletType: WalletType.defaultArgon | WalletType.miningBot | WalletType.ethereum;
  ethereumWalletRecordId?: number;
  showGuidance?: boolean;
  guidanceContext?: IWalletGuidanceContext;
};

type IBasicEmitter = {
  openWalletOverlay: IWalletOverlayRequest;
  openWalletDisconnectOverlay: { walletRecordId: number };
  ethereumWalletDisconnected: { walletRecordId: number };
  openEthereumWalletImportOverlay: 'choice' | 'external';
  openSecuritizationOverlay: { returnToInvite?: boolean } | undefined;
  openBotEditOverlay: void;
  openServerRemoveOverlay: void;
  openSecuritySettingsOverlay: { screen: 'overview' | 'mnemonics' | 'encrypt' | 'ethereum-export' } | undefined;
  openProvisioningCompleteOverlay: void;
  openServerConnectPanel: void;
  closeAllOverlays: void;
  openAboutOverlay: void;
  openSoftwareInfoOverlay: void;
  openJurisdictionOverlay: { setCurrencyKey: ICurrencyKey } | undefined;
  openTroubleshootingOverlay: {
    screen:
      | 'server-diagnostics'
      | 'data-and-logs-dir'
      | 'debug-package'
      | 'options-for-restart'
      | 'overview'
      | 'ssh'
      | 'missing-data-scanner';
  };
  openCheckForAppUpdatesOverlay: void;
  openWelcomeOverlay: void;

  openPortfolioPanel: PortfolioTab;

  openImportAccountOverlay: void;

  openOperationalProfileOverlay: IOperationalProfileRequest | void;
  openMemberInviteOverlay: { preserveDraft?: boolean; flexibleAssetChanges?: IVaultFlexibleAssetChanges } | undefined;

  openVaultsOverlay: void;
  openTransactionsOverlay: void;

  openVaultCollect: void;
  openTreasuryBondsOverlay: void;
  openArgonotCommitmentOverlay: void;
  openMintingAuthorityRequestOverlay: void;
  openGatewayRelayOverlay: void;
  openFlexibleAssetsOverlay:
    | { continueToInvite?: boolean; returnToInvite?: boolean; flexibleAssetChanges?: IVaultFlexibleAssetChanges }
    | undefined;
  openBitcoinLock: { lock?: IBitcoinLockRecord } | undefined;
  openBitcoinUnlock: IBitcoinLockRecord;
  resumeBitcoinFunding: IBitcoinLockRecord;

  openBondPurchaseOverlay: void;
  openStakePurchaseOverlay: void;

  openServerOverlay: void;
  openServerSettingsOverlay: void;
  openOperationalOverlay: OperationalStepId;
  openCertificationMenu: void;
  highlightOperationsNavigation: void;
  openOperationalRewardsOverlay: { screen?: 'activate' | 'congratulations' | 'claim' } | undefined;

  openUpgradeToOperationsOverlay: void;
  openWelcomeToOperationsOverlay: void;
  openUpgradeToTreasuryOverlay: void;

  openSponsorOverlay: void;
};

const basicEmitter: Emitter<IBasicEmitter> = mitt<IBasicEmitter>();

export default basicEmitter;
