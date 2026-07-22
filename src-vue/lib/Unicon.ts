// Ported from Uniswap Interface's GPL-3.0 Unicon implementation.
import { getAddress, keccak256, stringToBytes } from 'viem';
import { Icons } from './uniconData.ts';

const UNICON_COLORS = [
  ['#F50DB4', '#FC74FE'],
  ['#FFBF17', '#FFF612'],
  ['#FF8934', '#FF4D00'],
  ['#85754A', '#996F01'],
  ['#0C8911', '#21C95E'],
  ['#78E744', '#B1F13C'],
  ['#00C3A0', '#5CFE9D'],
  ['#23A3FF', '#3ADCFF'],
  ['#4981FF', '#0047FF'],
  ['#4300B0', '#9E62FF'],
] as const;

const uniconShapes = Object.values(Icons);

export interface IUniconDefinition {
  color: string;
  backgroundOpacity: number;
  paths: string[];
}

export function getUniconDefinition(address: string, isDark = false): IUniconDefinition {
  const checksummedAddress = getAddress(address);
  const hash = keccak256(stringToBytes(checksummedAddress));
  const hashValue = BigInt(`0x${hash.slice(2, 12)}`);
  const color = UNICON_COLORS[Number(hashValue % BigInt(UNICON_COLORS.length))][isDark ? 1 : 0];
  const paths = uniconShapes[Number(hashValue % BigInt(uniconShapes.length))];

  return {
    color,
    backgroundOpacity: isDark ? 0x29 / 0xff : 0x1f / 0xff,
    paths,
  };
}
