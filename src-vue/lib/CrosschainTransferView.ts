import { stripNetworkPrefix } from '@argonprotocol/apps-core';
import type { PalletCrosschainTransferGlobalIssuanceCouncil, Vault } from '@argonprotocol/mainchain';
import type { IConnectedVault } from '../interfaces/IConfig.ts';
import type { IGlobalCouncilQueueItem } from './GlobalCouncil.ts';

export type ICrosschainSourceIdentity = {
  name: string;
  kind: 'vault' | 'upstream';
};

export function getCrosschainAccessState(args: {
  hasActivatedCrosschain: boolean;
  authorityCount: number;
  isActiveCouncilMember: boolean;
}) {
  const hasMintingAuthority = args.authorityCount > 0;

  return {
    hasAccess: args.hasActivatedCrosschain || args.isActiveCouncilMember,
    hasMintingAuthority,
  };
}

export function isAccountInGlobalIssuanceCouncil(
  council: PalletCrosschainTransferGlobalIssuanceCouncil | undefined,
  accountId: string,
): boolean {
  return !!council && [...council.members.values()].some(member => member.accountId.toString() === accountId);
}

export function createKnownCrosschainSourceIdentities(args: {
  networkName: string;
  createdVault?: Pick<Vault, 'name' | 'operatorAccountId'>;
  vaultsById: Record<number, Pick<Vault, 'name' | 'operatorAccountId'>>;
  localAccountIds: string[];
  upstreamOperator?: IConnectedVault;
  sourceUpstreamVaultAccountsByAccount?: ReadonlyMap<string, string>;
}): Map<string, ICrosschainSourceIdentity> {
  const identities = new Map<string, ICrosschainSourceIdentity>();
  const addIdentity = (
    accountId: string | undefined,
    name: string | undefined,
    kind: ICrosschainSourceIdentity['kind'],
  ) => {
    const trimmedName = stripNetworkPrefix(name?.trim() ?? '', args.networkName);
    if (!accountId || !trimmedName) return;

    identities.set(accountId, { name: trimmedName, kind });
  };

  for (const vault of Object.values(args.vaultsById)) {
    addIdentity(vault.operatorAccountId, vault.name, 'vault');
  }

  if (args.createdVault?.name?.trim()) {
    addIdentity(args.createdVault.operatorAccountId, args.createdVault.name, 'vault');
    for (const accountId of args.localAccountIds) {
      addIdentity(accountId, args.createdVault.name, 'vault');
    }
  } else {
    for (const accountId of args.localAccountIds) {
      addIdentity(accountId, args.upstreamOperator?.name, 'upstream');
    }
  }

  const upstreamVault = args.vaultsById[args.upstreamOperator?.vaultId ?? -1];
  if (args.upstreamOperator?.accountId && !identities.has(args.upstreamOperator.accountId)) {
    addIdentity(args.upstreamOperator.accountId, args.upstreamOperator.name, 'upstream');
  }
  if (upstreamVault && !identities.has(upstreamVault.operatorAccountId)) {
    addIdentity(upstreamVault.operatorAccountId, args.upstreamOperator?.name, 'upstream');
  }

  for (const [sourceAccount, upstreamVaultAccount] of args.sourceUpstreamVaultAccountsByAccount ?? []) {
    const upstreamIdentity = identities.get(upstreamVaultAccount);
    if (!identities.has(sourceAccount) && upstreamIdentity) {
      identities.set(sourceAccount, { name: upstreamIdentity.name, kind: 'upstream' });
    }
  }

  return identities;
}

export function formatCrosschainSourceIdentity(identity: ICrosschainSourceIdentity) {
  return identity.kind === 'upstream' ? `Upstream: ${identity.name}` : identity.name;
}

export function formatCouncilTarget(targetKind: IGlobalCouncilQueueItem['targetKind']) {
  if (targetKind === 'mintingAuthorityActivation') return 'Activate minting authority';
  if (targetKind === 'mintingAuthorityDeactivation') return 'Deactivate minting authority';
  return 'Rotate global issuance council';
}
