export function humanCodec<T>(value: T) {
  return {
    toHuman: () => value,
    toString: () => String(value),
  };
}

export function numberCodec(value: number) {
  return {
    toNumber: () => value,
  };
}
