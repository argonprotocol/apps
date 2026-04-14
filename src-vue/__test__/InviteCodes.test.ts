import { expect, it } from 'vitest';
import { InviteCodes, UserRole } from '@argonprotocol/apps-core';

it('derives the same code from the same invite secret', () => {
  const inviteSecret = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';

  expect(InviteCodes.getCode(inviteSecret)).toBe(InviteCodes.getCode(inviteSecret));
});

it('creates mnemonic invite secrets and hex-encoded invite codes', () => {
  const { inviteSecret, inviteCode } = InviteCodes.create();

  expect(inviteSecret.split(' ')).toHaveLength(12);
  expect(inviteCode).toMatch(/^0x[0-9a-f]+$/);
  expect(inviteCode).toHaveLength(66);
  expect(inviteCode).toBe(InviteCodes.getCode(inviteSecret));
});

it('signs and verifies invite open proofs', () => {
  const { inviteSecret, inviteCode } = InviteCodes.create();
  const accountId = '5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y';
  const signature = InviteCodes.signOpen(inviteSecret, UserRole.OperationalPartner, accountId);

  expect(
    InviteCodes.verifyOpen({
      inviteCode,
      role: UserRole.OperationalPartner,
      accountId,
      signature,
    }),
  ).toBe(true);

  expect(
    InviteCodes.verifyOpen({
      inviteCode,
      role: UserRole.OperationalPartner,
      accountId: '5DAAnrj7VHTz5b2f4m65tQ6X3YfK6Y8sQw1bS8vW6oQ6mG7R',
      signature,
    }),
  ).toBe(false);
});
