import * as pako from 'pako';

export class VaultInvites {
  public static encodeInviteCode(ipAddress: string, port: string, code: string) {
    const input = `${ipAddress};${port};${code}`;
    const out = pako.deflate(input);
    const hex = Array.from(out, byte => byte.toString(16).padStart(2, '0')).join('');
    return `0x${hex}`;
  }

  public static decodeInviteCode(hex: string): {
    ipAddress?: string;
    port?: string;
    code?: string;
    hasError?: boolean;
    isEmpty?: boolean;
  } {
    if (!hex) return { isEmpty: true };

    try {
      hex = hex.replace(/^0x/, '');
      const int = hex.match(/.{1,2}/g)?.map(h => parseInt(h, 16));
      if (!int) return { hasError: true };

      const bytes = Uint8Array.from(int);
      const decoded = pako.inflate(bytes, { to: 'string' });
      const [ipAddress, port, code] = decoded.split(';');
      if (!ipAddress || !port || !code) return { hasError: true };

      return {
        ipAddress,
        port,
        code,
      };
    } catch (error) {
      return { hasError: true };
    }
  }
}
