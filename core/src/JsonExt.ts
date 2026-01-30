/**
 * JSON with support for BigInt in JSON.stringify and JSON.parse
 */
export class JsonExt {
  public static stringify(obj: any, space?: number): string {
    return JSON.stringify(
      obj,
      (_, v) => {
        if (typeof v === 'bigint') {
          return `${v}n`; // Append 'n' to indicate BigInt
        }
        // convert Uint8Array objects to a JSON representation
        if (v instanceof Uint8Array) {
          return {
            type: 'Buffer',
            data: Array.from(v), // Convert Uint8Array to an array of numbers
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return v;
      },
      space,
    );
  }

  public static parse<T = any>(str: string): T {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return JSON.parse(str, (_, v) => {
      if (typeof v === 'string' && v.match(/^-?\d+n$/)) {
        return BigInt(v.slice(0, -1));
      }
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v)) {
        return new Date(v);
      }
      // rehydrate Uint8Array objects
      if (typeof v === 'object' && v !== null && v.type === 'Buffer' && Array.isArray(v.data)) {
        return Uint8Array.from(v.data);
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return v;
    });
  }
}
