import { expect, it } from 'vitest';
import { InviteCodes } from '@argonprotocol/apps-core';
import { Keyring, u8aToHex } from '@argonprotocol/mainchain';
import {
  createReferralProof,
  signReferralSponsorGrant,
  verifyReferralSponsorGrant,
} from '../lib/OperationalAccount.ts';

it('signs and verifies referral sponsor grants', () => {
  const sponsor = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
  const { inviteCode } = InviteCodes.create();
  const expiresAtFrame = 1234;

  const sponsorSignature = signReferralSponsorGrant({
    sponsor,
    inviteCode,
    expiresAtFrame,
  });

  expect(
    verifyReferralSponsorGrant({
      sponsor: sponsor.address,
      inviteCode,
      expiresAtFrame,
      sponsorSignature,
    }),
  ).toBe(true);

  expect(
    verifyReferralSponsorGrant({
      sponsor: sponsor.address,
      inviteCode,
      expiresAtFrame: expiresAtFrame + 1,
      sponsorSignature,
    }),
  ).toBe(false);
});

it('builds referral proofs from invite grants', () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const sponsor = keyring.addFromUri('//Alice');
  const account = keyring.addFromUri('//Bob');
  const { inviteSecret, inviteCode } = InviteCodes.create();
  const expiresAtFrame = 1234;

  const sponsorSignature = signReferralSponsorGrant({
    sponsor,
    inviteCode,
    expiresAtFrame,
  });

  const proof = createReferralProof({
    inviteSecret,
    accountId: account.address,
    operationalReferral: {
      sponsor: sponsor.address,
      expiresAtFrame,
      sponsorSignature,
    },
  });

  expect(u8aToHex(proof.referralCode)).toBe(inviteCode);
  expect(proof.sponsor).toBe(sponsor.address);
  expect(proof.expiresAtFrame).toBe(expiresAtFrame);
  expect(u8aToHex(proof.sponsorSignature)).toBe(sponsorSignature);
});
