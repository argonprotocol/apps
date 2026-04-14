import { UserRole } from '@argonprotocol/apps-core';
import * as pako from 'pako';
import type { InviteRole } from '@argonprotocol/apps-router';

type IInviteEnvelopePayload = {
  v: 1;
  role: InviteRole;
  host: string;
  port: string;
  secret: string;
};

type IDecodedInviteEnvelope = {
  role?: InviteRole;
  host?: string;
  ipAddress?: string;
  port?: string;
  secret?: string;
  hasError?: boolean;
  isEmpty?: boolean;
};

const inviteRoles = new Set<InviteRole>([UserRole.TreasuryUser, UserRole.OperationalPartner]);

export class InviteEnvelope {
  public static encode(args: { host: string; port: string; role: InviteRole; secret: string }): string {
    const payload: IInviteEnvelopePayload = {
      v: 1,
      role: args.role,
      host: args.host,
      port: args.port,
      secret: args.secret,
    };
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

      return {
        role: payload.role,
        host: payload.host,
        ipAddress: payload.host,
        port: payload.port,
        secret: payload.secret,
      };
    } catch {
      return { hasError: true };
    }
  }
}
