export interface IMyVaultQueryRef {
  load(reload?: boolean): Promise<void>;
  vaultId?: number;
}
