import { describe, expect, it } from 'vitest';
import { Keyring } from '@argonprotocol/mainchain';
import {
  signRouterAuthAccountBinding,
  signRouterAuthChallenge,
  verifyRouterAuthAccountBinding,
  verifyRouterAuthChallenge,
} from '../src/RouterAuth.ts';
import { UserRole } from '../src/UserRole.ts';

describe('RouterAuth', () => {
  it('verifies signatures created for the exact router auth challenge', () => {
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const challenge = createChallenge(account.address);
    const signature = signRouterAuthChallenge(account, challenge);

    expect(verifyRouterAuthChallenge(challenge, signature)).toBe(true);
  });

  it.each([
    ['role', (challenge: ReturnType<typeof createChallenge>) => ({ ...challenge, role: UserRole.Member })],
    [
      'authAccountId',
      (challenge: ReturnType<typeof createChallenge>) => ({ ...challenge, authAccountId: otherAddress() }),
    ],
    ['nonce', (challenge: ReturnType<typeof createChallenge>) => ({ ...challenge, nonce: 'other-nonce' })],
    [
      'expiresAt',
      (challenge: ReturnType<typeof createChallenge>) => ({ ...challenge, expiresAt: challenge.expiresAt + 1 }),
    ],
  ])('rejects a signature when %s changes', (_field, mutateChallenge) => {
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const challenge = createChallenge(account.address);
    const signature = signRouterAuthChallenge(account, challenge);

    expect(verifyRouterAuthChallenge(mutateChallenge(challenge), signature)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//RouterOperator');
    const otherAccount = new Keyring({ type: 'sr25519' }).addFromUri('//OtherRouterOperator');
    const challenge = createChallenge(account.address);
    const signature = signRouterAuthChallenge(otherAccount, challenge);

    expect(verifyRouterAuthChallenge(challenge, signature)).toBe(false);
  });

  it('verifies signatures created for the exact router auth account binding', () => {
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const binding = createBinding(account.address);
    const signature = signRouterAuthAccountBinding(account, binding);

    expect(verifyRouterAuthAccountBinding(binding, signature)).toBe(true);
  });

  it('verifies signatures created for the exact router auth account binding without an invite code', () => {
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const binding = createBinding(account.address, undefined);
    const signature = signRouterAuthAccountBinding(account, binding);

    expect(verifyRouterAuthAccountBinding(binding, signature)).toBe(true);
  });

  it.each([
    ['accountId', (binding: ReturnType<typeof createBinding>) => ({ ...binding, accountId: otherAddress() })],
    [
      'operationalAccountId',
      (binding: ReturnType<typeof createBinding>) => ({ ...binding, operationalAccountId: anotherAddress() }),
    ],
    ['authAccountId', (binding: ReturnType<typeof createBinding>) => ({ ...binding, authAccountId: anotherAddress() })],
    ['inviteCode', (binding: ReturnType<typeof createBinding>) => ({ ...binding, inviteCode: 'other-invite' })],
    ['expiresAt', (binding: ReturnType<typeof createBinding>) => ({ ...binding, expiresAt: binding.expiresAt + 1 })],
  ])('rejects an account binding signature when %s changes', (_field, mutateBinding) => {
    const account = new Keyring({ type: 'sr25519' }).addFromUri('//InviteMember');
    const binding = createBinding(account.address);
    const signature = signRouterAuthAccountBinding(account, binding);

    expect(verifyRouterAuthAccountBinding(mutateBinding(binding), signature)).toBe(false);
  });
});

function createChallenge(authAccountId: string) {
  return {
    role: UserRole.AdminOperator,
    authAccountId,
    nonce: 'test-nonce',
    expiresAt: 1_774_536_320_000,
  };
}

function createBinding(accountId: string, inviteCode = 'member-invite-1') {
  return {
    accountId,
    operationalAccountId: otherAddress(),
    authAccountId: otherAddress(),
    inviteCode,
    expiresAt: 1_774_536_320_000,
  };
}

function otherAddress(): string {
  return new Keyring({ type: 'sr25519' }).addFromUri('//OtherRouterOperator').address;
}

function anotherAddress(): string {
  return new Keyring({ type: 'sr25519' }).addFromUri('//AnotherRouterOperator').address;
}
