import { Keyring } from '@argonprotocol/mainchain';
import { describe, expect, it } from 'vitest';
import {
  signDiscordRoleProof,
  signDiscordRoleUpdateProof,
  verifyDiscordRoleProof,
  verifyDiscordRoleUpdateProof,
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
});
