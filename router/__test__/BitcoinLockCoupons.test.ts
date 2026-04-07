import { Buffer } from 'buffer';
import { Keyring } from '@argonprotocol/mainchain';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { beforeAll, expect, it } from 'vitest';
import { BitcoinLockCoupons } from '../src/BitcoinLockCoupons.ts';

beforeAll(async () => {
  await cryptoWaitReady();
});

it('creates and verifies a signed bitcoin lock coupon token', () => {
  const signer = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
  const token = BitcoinLockCoupons.createToken(
    {
      vaultId: 42,
      maxSatoshis: 125_000n,
      expiresAfterTicks: 8_640,
      code: 'offer-123',
    },
    signer,
  );

  expect(token.split('.')).toHaveLength(3);

  const parsed = BitcoinLockCoupons.verifyToken(token, signer.address);
  expect(parsed.payload).toStrictEqual({
    version: 'v1',
    vaultId: 42,
    maxSatoshis: 125_000n,
    expiresAfterTicks: 8_640,
    code: 'offer-123',
  });
});

it('rejects a tampered bitcoin lock coupon token', () => {
  const signer = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
  const token = BitcoinLockCoupons.createToken(
    {
      vaultId: 7,
      maxSatoshis: 50_000n,
      expiresAfterTicks: 1_024,
      code: 'offer-abc',
    },
    signer,
  );

  const [version, encodedMessage, encodedSignature] = token.split('.');
  const tamperedMessage = Buffer.from(
    `${encodedMessage.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (encodedMessage.length % 4 || 4)) % 4)}`,
    'base64',
  )
    .toString('utf8')
    .replace('50_000', '60_000')
    .replace('50000', '60000');
  const tamperedToken = [
    version,
    Buffer.from(tamperedMessage, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, ''),
    encodedSignature,
  ].join('.');

  expect(() => BitcoinLockCoupons.verifyToken(tamperedToken, signer.address)).toThrow(
    'Invalid bitcoin lock coupon signature.',
  );
});
