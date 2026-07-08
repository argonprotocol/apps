import { expect, it } from 'vitest';
import { InviteEnvelope } from '../lib/InviteEnvelope.ts';

it('round-trips a member invite envelope', () => {
  const encoded = InviteEnvelope.encode({
    host: '127.0.0.1',
    port: '9944',
    inviteCode: 'member-invite-1',
  });

  expect(encoded).toBe('MTI3LjAuMC4xOjk5NDQ6bWVtYmVyLWludml0ZS0x');
  expect(InviteEnvelope.decode(encoded)).toEqual({
    host: '127.0.0.1',
    ipAddress: '127.0.0.1',
    port: '9944',
    inviteCode: 'member-invite-1',
  });
});

it('round-trips a localhost member invite envelope', () => {
  const encoded = InviteEnvelope.encode({
    host: '10.0.0.4',
    port: '443',
    inviteCode: 'member-invite-2',
  });

  expect(InviteEnvelope.decode(encoded)).toEqual({
    host: '10.0.0.4',
    ipAddress: '10.0.0.4',
    port: '443',
    inviteCode: 'member-invite-2',
  });
});

it('round-trips a padded member invite envelope without "=" characters', () => {
  const encoded = InviteEnvelope.encode({
    host: '1.1.1.1',
    port: '443',
    inviteCode: 'x',
  });

  expect(encoded.includes('=')).toBe(false);
  expect(InviteEnvelope.decode(encoded)).toEqual({
    host: '1.1.1.1',
    ipAddress: '1.1.1.1',
    port: '443',
    inviteCode: 'x',
  });
});

it('decodes legacy hex invite envelopes', () => {
  expect(
    InviteEnvelope.decode(
      '0x789cab562a53b232d251cac82f2e51b2523234d0034113251da582fc22908889893190939957965992ea9c9f920a14ca4dcd4d4a2dd28588e91a29d502008e021423',
    ),
  ).toEqual({
    host: '10.0.0.4',
    ipAddress: '10.0.0.4',
    port: '443',
    inviteCode: 'member-invite-2',
  });
});

it('marks malformed invite envelopes as invalid', () => {
  expect(InviteEnvelope.decode('0xdeadbeef')).toEqual({ hasError: true });
});
