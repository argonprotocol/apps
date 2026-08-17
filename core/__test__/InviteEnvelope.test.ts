import { expect, it } from 'vitest';
import { InviteEnvelope, MAX_INVITE_INPUT_LENGTH } from '../src/InviteEnvelope.ts';

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
    host: 'localhost',
    port: '443',
    inviteCode: 'member-invite-2',
  });

  expect(InviteEnvelope.decode(encoded)).toEqual({
    host: 'localhost',
    ipAddress: 'localhost',
    port: '443',
    inviteCode: 'member-invite-2',
  });
});

it('decodes a raw member invite', () => {
  expect(InviteEnvelope.decode('10.0.0.4:443:member-invite-2')).toEqual({
    host: '10.0.0.4',
    ipAddress: '10.0.0.4',
    port: '443',
    inviteCode: 'member-invite-2',
  });
});

it('round-trips an IPv6 member invite envelope', () => {
  const encoded = InviteEnvelope.encode({
    host: '2001:db8::1',
    port: '443',
    inviteCode: 'member-invite-2',
  });

  expect(InviteEnvelope.decode(encoded)).toEqual({
    host: '2001:db8::1',
    ipAddress: '2001:db8::1',
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

it('marks malformed invite envelopes as invalid', () => {
  expect(InviteEnvelope.decode('0xdeadbeef')).toEqual({ hasError: true });
});

it.each([
  ['a hostname', 'operator.example:443:member-invite-1'],
  ['a URL-shaped host', 'https://127.0.0.1:443:member-invite-1'],
  ['credentials in the port', '127.0.0.1:443@operator.example:member-invite-1'],
  ['a non-canonical port', '127.0.0.1:00443:member-invite-1'],
  ['an out-of-range port', '127.0.0.1:65536:member-invite-1'],
  ['control characters', '127.0.0.1:443:member-invite-1\nignored'],
  ['path characters', '127.0.0.1:443:../member-invite-1'],
  ['non-canonical base64', '!!!!'],
])('rejects %s', (_case, invite) => {
  expect(InviteEnvelope.decode(invite)).toEqual({ hasError: true });
});

it('rejects oversized pasted values', () => {
  expect(InviteEnvelope.decode('A'.repeat(MAX_INVITE_INPUT_LENGTH + 1))).toEqual({ hasError: true });
});
