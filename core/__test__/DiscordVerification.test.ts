import { Keyring } from '@argonprotocol/mainchain';
import { describe, expect, it } from 'vitest';
import {
  signDiscordRoleProof,
  signDiscordRoleUpdateProof,
  signTreasuryMemberSeal,
  verifyDiscordRoleProof,
  verifyDiscordRoleUpdateProof,
  verifyTreasuryMemberSeal,
} from '../src/DiscordVerification.ts';

describe('Discord role proof', () => {
  it('binds the signature to the application, one-time code, and operational account', () => {
    const keyring = new Keyring({ type: 'sr25519' });
    const operational = keyring.addFromUri('//DiscordOperational');
    const proof = {
      version: 1 as const,
      discordApplicationId: '123456789012345678',
      verificationCode: `ARGON-${'a'.repeat(32)}`,
      operationalAccountId: operational.address,
    };
    const signature = signDiscordRoleProof(operational, proof);

    expect(verifyDiscordRoleProof(proof, signature)).toBe(true);
    expect(verifyDiscordRoleProof({ ...proof, verificationCode: `ARGON-${'b'.repeat(32)}` }, signature)).toBe(false);
    expect(verifyDiscordRoleProof({ ...proof, discordApplicationId: '987654321098765432' }, signature)).toBe(false);
    expect(
      verifyDiscordRoleProof({ ...proof, operationalAccountId: keyring.addFromUri('//Other').address }, signature),
    ).toBe(false);
  });

  it('binds a role update to its application, time, and operational account', () => {
    const keyring = new Keyring({ type: 'sr25519' });
    const operational = keyring.addFromUri('//DiscordOperational');
    const proof = {
      version: 1 as const,
      discordApplicationId: '123456789012345678',
      signedAt: 1_788_000_000_000,
      operationalAccountId: operational.address,
    };
    const signature = signDiscordRoleUpdateProof(operational, proof);

    expect(verifyDiscordRoleUpdateProof(proof, signature)).toBe(true);
    expect(verifyDiscordRoleUpdateProof({ ...proof, signedAt: proof.signedAt + 1 }, signature)).toBe(false);
    expect(verifyDiscordRoleUpdateProof({ ...proof, discordApplicationId: '987654321098765432' }, signature)).toBe(
      false,
    );
    expect(
      verifyDiscordRoleUpdateProof(
        { ...proof, operationalAccountId: keyring.addFromUri('//Other').address },
        signature,
      ),
    ).toBe(false);
  });

  it('binds a treasury member seal to the Discord proof, vault, and signer', () => {
    const keyring = new Keyring({ type: 'sr25519' });
    const delegate = keyring.addFromUri('//TreasuryDelegate');
    const otherDelegate = keyring.addFromUri('//OtherDelegate');
    const operational = keyring.addFromUri('//Operational');
    const claim = {
      discordApplicationId: '123456789012345678',
      verificationCode: `ARGON-${'a'.repeat(32)}`,
      operationalAccountId: operational.address,
    };
    const seal = signTreasuryMemberSeal(delegate, claim, {
      genesisHash: `0x${'11'.repeat(32)}`,
      vaultId: 12,
    });

    expect(verifyTreasuryMemberSeal(claim, seal, delegate.address)).toBe(true);
    expect(verifyTreasuryMemberSeal(claim, { ...seal, genesisHash: `0x${'22'.repeat(32)}` }, delegate.address)).toBe(
      false,
    );
    expect(verifyTreasuryMemberSeal(claim, { ...seal, vaultId: 13 }, delegate.address)).toBe(false);
    expect(
      verifyTreasuryMemberSeal({ ...claim, operationalAccountId: otherDelegate.address }, seal, delegate.address),
    ).toBe(false);
    expect(
      verifyTreasuryMemberSeal({ ...claim, discordApplicationId: '987654321098765432' }, seal, delegate.address),
    ).toBe(false);
    expect(
      verifyTreasuryMemberSeal({ ...claim, verificationCode: `ARGON-${'b'.repeat(32)}` }, seal, delegate.address),
    ).toBe(false);
    expect(verifyTreasuryMemberSeal(claim, seal, otherDelegate.address)).toBe(false);
  });
});
