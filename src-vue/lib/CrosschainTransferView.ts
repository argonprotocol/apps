import { stripNetworkPrefix, type Vault } from '@argonprotocol/apps-core';
import type { CrosschainTransferGlobalIssuanceCouncilByHashResultSpec151 } from '@argonprotocol/runtime-client';
import type { IConnectedVault } from '../interfaces/IConfig.ts';
import type { IGlobalCouncilQueueItem } from './GlobalCouncil.ts';
import type { ICrosschainSourceOperatorDetails } from './MintingAuthorities.ts';

export type ICrosschainSourceIdentity = {
  name: string;
  kind: 'vault' | 'operator' | 'upstream';
  upstreamName?: string;
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
  council: CrosschainTransferGlobalIssuanceCouncilByHashResultSpec151 | undefined,
  accountId: string,
): boolean {
  return !!council && Object.values(council.members).some(member => member.accountId === accountId);
}

export function createKnownCrosschainSourceIdentities(args: {
  networkName: string;
  createdVault?: Pick<Vault, 'vaultId' | 'operatorAccountId'>;
  vaultsById: Record<number, Pick<Vault, 'operatorAccountId'>>;
  operatorNamesByVaultId: Record<number, string | undefined>;
  localAccountIds: string[];
  upstreamOperator?: IConnectedVault;
  sourceOperatorDetailsByAccount?: ReadonlyMap<string, ICrosschainSourceOperatorDetails>;
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

  for (const [vaultId, vault] of Object.entries(args.vaultsById)) {
    addIdentity(vault.operatorAccountId, args.operatorNamesByVaultId[Number(vaultId)], 'vault');
  }

  const createdOperatorName = args.operatorNamesByVaultId[args.createdVault?.vaultId ?? -1];
  if (args.createdVault && createdOperatorName) {
    addIdentity(args.createdVault.operatorAccountId, createdOperatorName, 'vault');
    for (const accountId of args.localAccountIds) {
      addIdentity(accountId, createdOperatorName, 'vault');
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

  for (const [sourceAccount, details] of args.sourceOperatorDetailsByAccount ?? []) {
    const sourceName = stripNetworkPrefix(details.name?.trim() ?? '', args.networkName);
    const upstreamName = details.upstreamVaultAccount ? identities.get(details.upstreamVaultAccount)?.name : undefined;
    const identity = identities.get(sourceAccount);
    const configuredUpstreamName = identity?.kind === 'upstream' ? identity.name : undefined;
    const sourceUpstreamName = upstreamName ?? configuredUpstreamName;
    if (sourceName) {
      identities.set(sourceAccount, {
        name: sourceName,
        kind: 'operator',
        ...(sourceUpstreamName && sourceUpstreamName !== sourceName ? { upstreamName: sourceUpstreamName } : {}),
      });
    } else if (identity) {
      if (upstreamName && !identity.upstreamName && identity.name !== upstreamName) {
        identities.set(sourceAccount, { ...identity, upstreamName });
      }
    } else if (upstreamName) {
      identities.set(sourceAccount, { name: upstreamName, kind: 'upstream' });
    }
  }

  return identities;
}

export function formatCouncilTarget(targetKind: IGlobalCouncilQueueItem['targetKind']) {
  if (targetKind === 'mintingAuthorityActivation') return 'Activate minting authority';
  if (targetKind === 'mintingAuthorityDeactivation') return 'Deactivate minting authority';
  return 'Rotate global issuance council';
}
