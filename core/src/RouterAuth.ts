import type { KeyringPair } from '@argonprotocol/mainchain';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import type { UserRole } from './UserRole.js';

export type RouterAuthRole = UserRole;

export interface IRouterAuthChallenge {
  role: RouterAuthRole;
  authAccountId: string;
  nonce: string;
  expiresAt: number;
}

export interface IRouterAuthAccountBinding {
  role: RouterAuthRole;
  accountId: string;
  authAccountId: string;
  inviteCode: string;
  expiresAt: number;
}

export function signRouterAuthChallenge(account: KeyringPair, challenge: IRouterAuthChallenge): string {
  return u8aToHex(account.sign(getRouterAuthPayloadHash(challenge), { withType: true }));
}

export function verifyRouterAuthChallenge(challenge: IRouterAuthChallenge, signature: string): boolean {
  return signatureVerify(getRouterAuthPayloadHash(challenge), hexToU8a(signature), challenge.authAccountId).isValid;
}

export function signRouterAuthAccountBinding(account: KeyringPair, binding: IRouterAuthAccountBinding): string {
  return u8aToHex(account.sign(getRouterAuthAccountBindingPayloadHash(binding), { withType: true }));
}

export function verifyRouterAuthAccountBinding(binding: IRouterAuthAccountBinding, signature: string): boolean {
  return signatureVerify(getRouterAuthAccountBindingPayloadHash(binding), hexToU8a(signature), binding.accountId)
    .isValid;
}

function getRouterAuthPayloadHash(challenge: IRouterAuthChallenge): Uint8Array {
  return blake2AsU8a(
    stringToU8a(
      `argon_router_auth_v1:${challenge.role}:${challenge.authAccountId}:${challenge.nonce}:${challenge.expiresAt}`,
    ),
    256,
  );
}

function getRouterAuthAccountBindingPayloadHash(binding: IRouterAuthAccountBinding): Uint8Array {
  return blake2AsU8a(
    stringToU8a(
      `argon_router_auth_account_binding_v1:${binding.role}:${binding.inviteCode}:${binding.accountId}:${binding.authAccountId}:${binding.expiresAt}`,
    ),
    256,
  );
}
