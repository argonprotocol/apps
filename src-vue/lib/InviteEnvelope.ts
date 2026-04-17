import { UserRole } from '@argonprotocol/apps-core';
import * as pako from 'pako';
import type { InviteRole } from '@argonprotocol/apps-router';
import type { IOperationalReferral } from '../interfaces/IConfig.ts';

type IInviteEnvelopePayload = {
  v: 1;
  role: InviteRole;
  host: string;
  port: string;
  secret: string;
  operationalReferral?: IOperationalReferral;
};

type IDecodedInviteEnvelope = {
  role?: InviteRole;
  host?: string;
  ipAddress?: string;
  port?: string;
  secret?: string;
  operationalReferral?: IOperationalReferral;
  hasError?: boolean;
  isEmpty?: boolean;
};

const inviteRoles = new Set<InviteRole>([UserRole.TreasuryUser, UserRole.OperationalPartner]);

export class InviteEnvelope {
  public static encode(args: {
    host: string;
    port: string;
    role: InviteRole;
    secret: string;
    operationalReferral?: IOperationalReferral;
  }): string {
    const payload: IInviteEnvelopePayload = {
      v: 1,
      role: args.role,
      host: args.host,
      port: args.port,
      secret: args.secret,
    };
    if (args.operationalReferral) payload.operationalReferral = args.operationalReferral;

    const out = pako.deflate(JSON.stringify(payload));
    const hex = Array.from(out, byte => byte.toString(16).padStart(2, '0')).join('');
    return `0x${hex}`;
  }

  public static decode(hex: string): IDecodedInviteEnvelope {
    if (!hex) return { isEmpty: true };

    try {
      const normalizedHex = hex.replace(/^0x/, '');
      const int = normalizedHex.match(/.{1,2}/g)?.map(h => parseInt(h, 16));
      if (!int) return { hasError: true };

      const bytes = Uint8Array.from(int);
      const decoded = pako.inflate(bytes, { to: 'string' });
      const payload = JSON.parse(decoded) as Partial<IInviteEnvelopePayload>;
      if (
        payload.v !== 1 ||
        !payload.host ||
        !payload.port ||
        !payload.secret ||
        !payload.role ||
        !inviteRoles.has(payload.role)
      ) {
        return { hasError: true };
      }

      const result: IDecodedInviteEnvelope = {
        role: payload.role,
        host: payload.host,
        ipAddress: payload.host,
        port: payload.port,
        secret: payload.secret,
      };
      if (isOperationalReferral(payload.operationalReferral)) {
        result.operationalReferral = payload.operationalReferral;
      }
      return result;
    } catch {
      return { hasError: true };
    }
  }
}

function isOperationalReferral(value: unknown): value is IOperationalReferral {
  if (!value || typeof value !== 'object') return false;

  const referral = value as Partial<IOperationalReferral>;
  return (
    typeof referral.sponsor === 'string' &&
    typeof referral.expiresAtFrame === 'number' &&
    typeof referral.sponsorSignature === 'string'
  );
}
