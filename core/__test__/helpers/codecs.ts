export function boolCodec(value: boolean) {
  return {
    toPrimitive: () => value,
  };
}

export function bigintCodec(value: bigint) {
  return {
    toBigInt: () => value,
    toString: () => value.toString(),
  };
}

export function humanCodec<T>(value: T) {
  return {
    toHuman: () => value,
    toString: () => String(value),
  };
}

export function hexCodec(value: string) {
  return {
    toHex: () => value,
    toString: () => value,
  };
}

export function numberCodec(value: number) {
  return {
    toNumber: () => value,
  };
}

export function optionCodec<T>(value?: T) {
  return {
    isNone: value === undefined,
    isSome: value !== undefined,
    unwrap: () => value!,
  };
}
