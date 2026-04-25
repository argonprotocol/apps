import { expect, it } from 'vitest';
import { UserRole } from '@argonprotocol/apps-core';
import { InviteEnvelope } from '../lib/InviteEnvelope.ts';

it('round-trips an operational invite envelope', () => {
  const encoded = InviteEnvelope.encode({
    host: '127.0.0.1',
    port: '9944',
    role: UserRole.OperationalPartner,
    secret: '0x1234abcd',
    operationalReferral: {
      sponsor: '5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y',
      expiresAtFrame: 1234,
      sponsorSignature: '0x1234',
    },
  });

  expect(InviteEnvelope.decode(encoded)).toEqual({
    role: UserRole.OperationalPartner,
    host: '127.0.0.1',
    ipAddress: '127.0.0.1',
    port: '9944',
    secret: '0x1234abcd',
    operationalReferral: {
      sponsor: '5F3sa2TJAWMqDhXG6jhV4N8ko9G4vYQ1N1gH1mLNz5nKfY7Y',
      expiresAtFrame: 1234,
      sponsorSignature: '0x1234',
    },
  });
});

it('round-trips a treasury invite envelope', () => {
  const encoded = InviteEnvelope.encode({
    host: '10.0.0.4',
    port: '443',
    role: UserRole.TreasuryUser,
    secret: 'treasury-code',
  });

  expect(InviteEnvelope.decode(encoded)).toEqual({
    role: UserRole.TreasuryUser,
    host: '10.0.0.4',
    ipAddress: '10.0.0.4',
    port: '443',
    secret: 'treasury-code',
  });
});

it('marks malformed invite envelopes as invalid', () => {
  expect(InviteEnvelope.decode('0xdeadbeef')).toEqual({ hasError: true });
});
