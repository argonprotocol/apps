import mitt, { type Emitter } from 'mitt';
import { WalletType } from '../lib/Wallet.ts';
import { PortfolioTab } from '../app-operations/panels/interfaces/IPortfolioTab.ts';
import { OperationalStepId } from '../app-operations/stores/controller.ts';
import { ICurrencyKey, MoveTo } from '@argonprotocol/apps-core';
import type { IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';

type IBasicEmitter = {
  openWalletOverlay: {
    walletType: WalletType.miningHold | WalletType.vaulting | WalletType.investment | WalletType.ethereum;
    showGuidance?: boolean;
  };
  openMoveCapitalOverlay: {
    walletType: WalletType.miningHold | WalletType.vaulting;
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
  openVaultMembersOverlay: void;
  openTreasuryBondsOverlay: void;
  openArgonotCommitmentOverlay: void;
  openMintingAuthorityRequestOverlay: void;
  openGatewayRelayOverlay: void;
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
