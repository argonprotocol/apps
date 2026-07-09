export function boolCodec(value: boolean) {
  return {
    toPrimitive: () => value,
  };
}

export function bigintCodec(value: bigint) {
  return {
    toBigInt: () => value,
  };
}

export function numberCodec(value: number) {
  return {
    toNumber: () => value,
  };
}
