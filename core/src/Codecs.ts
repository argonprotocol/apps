export interface IBooleanCodec {
  toPrimitive(): boolean;
}

export interface IBigIntCodec {
  toBigInt(): bigint;
}

export interface INumberCodec {
  toNumber(): number;
}
