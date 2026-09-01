import { describe, expect, it } from 'vitest';
import { createKnownCrosschainSourceIdentities, getCrosschainAccessState } from '../lib/CrosschainTransferView.ts';

describe('CrosschainTransferView', () => {
  it('does not activate Crosschain for a registered signer outside the active council', () => {
    expect(
      getCrosschainAccessState({
        hasActivatedCrosschain: false,
        authorityCount: 1,
        isActiveCouncilMember: false,
      }),
    ).toEqual({ hasAccess: false, hasMintingAuthority: true });
  });

  it('activates Crosschain for an active council member without a minting authority', () => {
    expect(
      getCrosschainAccessState({
        hasActivatedCrosschain: false,
        authorityCount: 0,
        isActiveCouncilMember: true,
      }),
    ).toEqual({ hasAccess: true, hasMintingAuthority: false });
  });

  it('retains Crosschain access after it has been activated', () => {
    expect(
      getCrosschainAccessState({
        hasActivatedCrosschain: true,
        authorityCount: 0,
        isActiveCouncilMember: false,
      }),
    ).toEqual({ hasAccess: true, hasMintingAuthority: false });
  });

  it('resolves a created vault across local account roles and a configured upstream by vault id', () => {
    const defaultAccount = `0x${'11'.repeat(32)}`;
    const vaultingAccount = `0x${'22'.repeat(32)}`;
    const ownOperatorAccount = `0x${'33'.repeat(32)}`;
    const upstreamOperatorAccount = `0x${'44'.repeat(32)}`;
    const createdVault = {
      vaultId: 1,
      operatorAccountId: ownOperatorAccount,
    };
    const upstreamVault = {
      operatorAccountId: upstreamOperatorAccount,
    };

    const identities = createKnownCrosschainSourceIdentities({
      networkName: 'dev-docker',
      createdVault,
      vaultsById: { 1: createdVault, 2: upstreamVault },
      operatorNamesByVaultId: { 1: 'Atlas', 2: 'Beacon' },
      localAccountIds: [defaultAccount, vaultingAccount],
      upstreamOperator: { name: 'Beacon', vaultId: 2 },
    });

    expect(identities.get(defaultAccount)).toEqual({ name: 'Atlas', kind: 'vault' });
    expect(identities.get(vaultingAccount)).toEqual({ name: 'Atlas', kind: 'vault' });
    expect(identities.get(ownOperatorAccount)).toEqual({ name: 'Atlas', kind: 'vault' });
    expect(identities.get(upstreamOperatorAccount)).toEqual({ name: 'Beacon', kind: 'vault' });
  });

  it('uses normalized operator names and falls back to the upstream name for local minting requests', () => {
    const localAccount = `0x${'55'.repeat(32)}`;
    const upstreamAccount = `0x${'66'.repeat(32)}`;
    const identities = createKnownCrosschainSourceIdentities({
      networkName: 'dev-docker',
      vaultsById: {
        2: {
          operatorAccountId: upstreamAccount,
        },
      },
      operatorNamesByVaultId: { 2: 'dev-docker-On-chain Operator' },
      localAccountIds: [localAccount],
      upstreamOperator: { name: 'Configured Upstream', vaultId: 2 },
    });

    const localIdentity = identities.get(localAccount);
    const upstreamIdentity = identities.get(upstreamAccount);

    expect(localIdentity).toEqual({ name: 'Configured Upstream', kind: 'upstream' });
    expect(upstreamIdentity).toEqual({ name: 'On-chain Operator', kind: 'vault' });
  });

  it('shows a remote transfer source name with its upstream sponsor', () => {
    const sourceAccount = `0x${'77'.repeat(32)}`;
    const sponsorVaultAccount = `0x${'88'.repeat(32)}`;
    const identities = createKnownCrosschainSourceIdentities({
      networkName: 'dev-docker',
      vaultsById: {
        3: {
          operatorAccountId: sponsorVaultAccount,
        },
        4: {
          operatorAccountId: sourceAccount,
        },
      },
      operatorNamesByVaultId: { 3: 'dev-docker-JC', 4: 'dev-docker-Source vault' },
      localAccountIds: [],
      sourceOperatorDetailsByAccount: new Map([
        [sourceAccount, { name: 'Ada', upstreamVaultAccount: sponsorVaultAccount }],
      ]),
    });

    const sourceIdentity = identities.get(sourceAccount);

    expect(sourceIdentity).toEqual({ name: 'Ada', kind: 'operator', upstreamName: 'JC' });
  });
});
