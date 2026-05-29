import type { GlobalCouncil } from '../lib/GlobalCouncil.ts';
import type { MintingAuthorities } from '../lib/MintingAuthorities.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';

type IMyVaultWalletKeysQueryRef = Pick<
  WalletKeys,
  | 'councilSignerEthereumHdPath'
  | 'vaultingAddress'
  | 'ethereumAddress'
  | 'getEthereumAddresses'
  | 'getMintingAuthorityEthereumHdPath'
  | 'getVaultDelegateKeypair'
  | 'getVaultingKeypair'
  | 'signEthereumPersonalMessage'
>;

type IMyVaultGlobalCouncilQueryRef = Pick<
  GlobalCouncil,
  'refresh' | 'relayApprovedGatewayUpdates' | 'buildRegisterCouncilSignerTx'
> & {
  data: Pick<GlobalCouncil['data'], 'pendingApprovals'>;
};

type IMyVaultMintingAuthoritiesQueryRef = Pick<MintingAuthorities, 'refresh' | 'register' | 'restoreSignerIndexes'> & {
  data: Pick<MintingAuthorities['data'], 'authorities'>;
};

export type IMyVaultQueryRef = Pick<MyVault, 'collect' | 'load' | 'vaultId'> & {
  walletKeys: IMyVaultWalletKeysQueryRef;
  globalCouncil: IMyVaultGlobalCouncilQueryRef;
  mintingAuthorities: IMyVaultMintingAuthoritiesQueryRef;
};
