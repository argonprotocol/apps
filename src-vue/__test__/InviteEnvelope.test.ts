import { expect, it } from 'vitest';
import { UserRole } from '@argonprotocol/apps-core';
import { InviteEnvelope } from '../lib/InviteEnvelope.ts';

it('round-trips an operational invite envelope', () => {
  const encoded = InviteEnvelope.encode({
    host: '127.0.0.1',
    port: '9944',
    role: UserRole.OperationalPartner,
    secret: '0x1234abcd',
  });

  expect(InviteEnvelope.decode(encoded)).toEqual({
    role: UserRole.OperationalPartner,
    host: '127.0.0.1',
    ipAddress: '127.0.0.1',
    port: '9944',
    secret: '0x1234abcd',
  });
});

it('round-trips a treasury invite envelope', () => {
  const encoded = InviteEnvelope.encode({
    host: '10.0.0.4',
    port: '3000',
    role: UserRole.TreasuryUser,
    secret: 'treasury-code',
  });

  expect(InviteEnvelope.decode(encoded)).toEqual({
    role: UserRole.TreasuryUser,
    host: '10.0.0.4',
    ipAddress: '10.0.0.4',
    port: '3000',
    secret: 'treasury-code',
  });
});

it('marks malformed invite envelopes as invalid', () => {
  expect(InviteEnvelope.decode('0xdeadbeef')).toEqual({ hasError: true });
});
