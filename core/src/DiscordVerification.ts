import type { KeyringPair } from '@argonprotocol/mainchain';
import { hexToU8a, u8aToHex } from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';

export const DISCORD_VERIFICATION_CONFIG = {
  applicationId: '1543010556263407738',
  publicKey: 'e96e5ac1b0f5ce8c4847af70fa293dec98e73d9eff21c8017e2d90c0eeca298b',
  guildId: '1273298218498658459',
  roleNames: {
    treasuryUser: 'Treasury User',
    treasuryCertified: 'Treasury Certified',
    operationallyCertified: 'Operationally Certified',
    coreDeveloper: 'Core Developer',
  },
  roleIds: {
    treasuryUser: '1543316649422094416',
    treasuryCertified: '1543316319368388720',
    operationallyCertified: '1543018787601784882',
    coreDeveloper: '1543315846829707375',
  },
  developerIds: [
    '623538617486278696', // blakeb01
    '623540311074930700', // calebjclark
  ],
  serviceUrl: 'https://verify.argon.network',
} as const;

export const DISCORD_ROLE_ORDER = ['treasuryUser', 'treasuryCertified', 'operationallyCertified'] as const;
export type DiscordEarnedRole = (typeof DISCORD_ROLE_ORDER)[number];
export type DiscordRole = DiscordEarnedRole | 'coreDeveloper';

export interface IDiscordRoleProof {
  version: 1;
  discordApplicationId: string;
  verificationCode: string;
  operationalAccountId: string;
}

export interface IDiscordRoleUpdateProof {
  version: 1;
  discordApplicationId: string;
  signedAt: number;
  operationalAccountId: string;
}

export function signDiscordRoleProof(account: KeyringPair, proof: IDiscordRoleProof): string {
  return u8aToHex(account.sign(getDiscordRoleProofHash(proof), { withType: true }));
}

export function verifyDiscordRoleProof(proof: IDiscordRoleProof, signature: string): boolean {
  return signatureVerify(getDiscordRoleProofHash(proof), hexToU8a(signature), proof.operationalAccountId).isValid;
}

export function signDiscordRoleUpdateProof(account: KeyringPair, proof: IDiscordRoleUpdateProof): string {
  return u8aToHex(account.sign(getDiscordRoleUpdateProofHash(proof), { withType: true }));
}

export function verifyDiscordRoleUpdateProof(proof: IDiscordRoleUpdateProof, signature: string): boolean {
  return signatureVerify(getDiscordRoleUpdateProofHash(proof), hexToU8a(signature), proof.operationalAccountId).isValid;
}

function getDiscordRoleProofHash(proof: IDiscordRoleProof): Uint8Array {
  return blake2AsU8a(
    stringToU8a(
      [
        'argon_discord_role_proof_v1',
        proof.version,
        proof.discordApplicationId,
        proof.verificationCode,
        proof.operationalAccountId,
      ].join(':'),
    ),
    256,
  );
}

function getDiscordRoleUpdateProofHash(proof: IDiscordRoleUpdateProof): Uint8Array {
  return blake2AsU8a(
    stringToU8a(
      [
        'argon_discord_role_update_v1',
        proof.version,
        proof.discordApplicationId,
        proof.signedAt,
        proof.operationalAccountId,
      ].join(':'),
    ),
    256,
  );
}
