import { describe, expect, it } from 'vitest';
import { getUniconDefinition } from '../lib/Unicon.ts';

describe('Unicon', () => {
  it('normalizes address casing before selecting the icon', () => {
    const lowerCase = getUniconDefinition('0x000000000000000000000000000000000000dead');
    const checksummed = getUniconDefinition('0x000000000000000000000000000000000000dEaD');

    expect(lowerCase).toEqual(checksummed);
  });

  it('uses the Uniswap light and dark palettes without changing the shape', () => {
    const light = getUniconDefinition('0x000000000000000000000000000000000000dEaD');
    const dark = getUniconDefinition('0x000000000000000000000000000000000000dEaD', true);

    expect(light.color).toBe('#78E744');
    expect(dark.color).toBe('#B1F13C');
    expect(light.paths).toBe(dark.paths);
    expect(light.paths[0]).toMatch(/^M/);
  });

  it('rejects invalid Ethereum addresses', () => {
    expect(() => getUniconDefinition('not-an-address')).toThrow();
  });
});
