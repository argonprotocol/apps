export enum MoveFrom {
  DefaultArgon = 'DefaultArgon',
  MiningBot = 'MiningBot',
  VaultingSecurity = 'VaultingSecurity',
}

export enum MoveTo {
  DefaultArgon = 'DefaultArgon',
  MiningBot = 'MiningBot',
  VaultingSecurity = 'VaultingSecurity',
  External = 'External',
}

export enum MoveToken {
  ARGN = 'ARGN',
  ARGNOT = 'ARGNOT',
}

export function isDefaultArgonMoveFrom(value: unknown): value is MoveFrom.DefaultArgon | 'MiningHold' | 'VaultingHold' {
  return value === MoveFrom.DefaultArgon || value === 'MiningHold' || value === 'VaultingHold';
}

export function isDefaultArgonMoveTo(value: unknown): value is MoveTo.DefaultArgon | 'MiningHold' | 'VaultingHold' {
  return value === MoveTo.DefaultArgon || value === 'MiningHold' || value === 'VaultingHold';
}
