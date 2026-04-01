import * as pako from 'pako';

export class VaultInvites {
  public static encodeInviteCode(ipAddress: string, port: string, privateKey: string) {
    const input = `${ipAddress};${port};${privateKey}`;
    const out = pako.deflate(input);
    const hex = Array.from(out, (byte: number) => byte.toString(16).padStart(2, '0')).join('');
    return `0x${hex}`;
  }

  public static decodeInviteCode(hex: string): {
    ipAddress?: string;
    port?: string;
    privateKey?: string;
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
      const [ipAddress, port, privateKey] = decoded.split(';');
      if (!ipAddress || !port || !privateKey) return { hasError: true };

      return { ipAddress, port, privateKey };
    } catch (error) {
      console.error('Error decoding access code:', error);
      return { hasError: true };
    }
  }
}
