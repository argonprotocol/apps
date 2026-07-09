import { expect, it } from 'vitest';
import { Keyring } from '@argonprotocol/mainchain';
import { createOperationalAccessProof, verifyOperationalAccessProof } from '../src/OperationalAccessProof.ts';

it('creates an operational access proof that verifies for the downstream account', () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const upstreamOperator = keyring.addFromUri('//UpstreamOperator');
  const downstreamOperationalAccount = keyring.addFromUri('//DownstreamOperational');

  const accessProof = createOperationalAccessProof(upstreamOperator, downstreamOperationalAccount.address);

  expect(accessProof.upstreamAccount).toBe(upstreamOperator.address);
  expect(verifyOperationalAccessProof(accessProof, downstreamOperationalAccount.address)).toBe(true);
  expect(verifyOperationalAccessProof(accessProof, keyring.addFromUri('//OtherOperational').address)).toBe(false);
});
