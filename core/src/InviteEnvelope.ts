import { z } from 'zod';

export const MAX_INVITE_INPUT_LENGTH = 1024;

export class InviteEnvelope {
  public static encode(args: { host: string; port: string; inviteCode: string }): string {
    return encodeBase64Url(new TextEncoder().encode(`${args.host}:${args.port}:${args.inviteCode}`));
  }

  public static decode(inviteEnvelope: string): IDecodedInviteEnvelope {
    const trimmedEnvelope = inviteEnvelope.trim();
    if (!trimmedEnvelope) return { isEmpty: true };
    if (trimmedEnvelope.length > MAX_INVITE_INPUT_LENGTH) return { hasError: true };

    if (trimmedEnvelope.includes(':')) {
      return decodeInviteFields(trimmedEnvelope);
    }

    try {
      if (!BASE64_PATTERN.test(trimmedEnvelope) || trimmedEnvelope.length % 4 === 1) return { hasError: true };

      const normalizedBase64 = trimmedEnvelope.replace(/=+$/, '');
      const standardBase64 = normalizedBase64.replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 = standardBase64.padEnd(Math.ceil(standardBase64.length / 4) * 4, '=');
      const decoded = Uint8Array.from(atob(paddedBase64), character => character.charCodeAt(0));

      if (encodeBase64Url(decoded) !== normalizedBase64) return { hasError: true };
      if (decoded.length > MAX_DECODED_INVITE_LENGTH) return { hasError: true };

      return decodeInviteFields(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    } catch {
      return { hasError: true };
    }
  }
}

export type IDecodedInviteEnvelope = {
  host?: string;
  ipAddress?: string;
  port?: string;
  inviteCode?: string;
  hasError?: boolean;
  isEmpty?: boolean;
};

const MAX_DECODED_INVITE_LENGTH = 512;
const BASE64_PATTERN = /^(?:[A-Za-z0-9_-]+={0,2})$/;
const InviteFieldsSchema = z
  .object({
    host: z.string().ip(),
    port: z
      .string()
      .regex(/^[1-9]\d{0,4}$/)
      .refine(port => Number(port) >= 1 && Number(port) <= 65_535),
    inviteCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

function decodeInviteFields(value: string): IDecodedInviteEnvelope {
  if (value.length > MAX_DECODED_INVITE_LENGTH) return { hasError: true };

  const parts = value.split(':');
  if (parts.length < 3) return { hasError: true };

  const parsed = InviteFieldsSchema.safeParse({
    host: parts.slice(0, -2).join(':'),
    port: parts.at(-2),
    inviteCode: parts.at(-1),
  });
  if (!parsed.success) return { hasError: true };

  return {
    ...parsed.data,
    ipAddress: parsed.data.host,
  };
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
