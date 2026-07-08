import * as pako from 'pako';

type IInviteEnvelopePayload = {
  v: 2;
  host: string;
  port: string;
  inviteCode: string;
};

type IDecodedInviteEnvelope = {
  host?: string;
  ipAddress?: string;
  port?: string;
  inviteCode?: string;
  hasError?: boolean;
  isEmpty?: boolean;
};

export class InviteEnvelope {
  public static encode(args: { host: string; port: string; inviteCode: string }): string {
    return Buffer.from(`${args.host}:${args.port}:${args.inviteCode}`, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  public static decode(inviteEnvelope: string): IDecodedInviteEnvelope {
    if (!inviteEnvelope) return { isEmpty: true };

    let decodedInviteEnvelope = inviteEnvelope;
    if (!inviteEnvelope.includes(':')) {
      const normalizedBase64 = inviteEnvelope.replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 = normalizedBase64.padEnd(Math.ceil(normalizedBase64.length / 4) * 4, '=');
      decodedInviteEnvelope = Buffer.from(paddedBase64, 'base64').toString('utf8');
    }

    const parts = decodedInviteEnvelope.split(':');
    if (parts.length >= 3) {
      const inviteCode = parts.at(-1);
      const port = parts.at(-2);
      const host = parts.slice(0, -2).join(':');

      if (host && port && inviteCode) {
        return {
          host,
          ipAddress: host,
          port,
          inviteCode,
        };
      }
    }

    try {
      const normalizedHex = inviteEnvelope.replace(/^0x/, '');
      const int = normalizedHex.match(/.{1,2}/g)?.map(h => parseInt(h, 16));
      if (!int) return { hasError: true };

      const bytes = Uint8Array.from(int);
      const decoded = pako.inflate(bytes, { to: 'string' });
      const payload = JSON.parse(decoded) as Partial<IInviteEnvelopePayload>;
      if (payload.v !== 2 || !payload.host || !payload.port || !payload.inviteCode) {
        return { hasError: true };
      }

      return {
        host: payload.host,
        ipAddress: payload.host,
        port: payload.port,
        inviteCode: payload.inviteCode,
      };
    } catch {
      return { hasError: true };
    }
  }
}
