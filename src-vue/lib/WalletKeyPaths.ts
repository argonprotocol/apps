export const walletKeyPaths = {
  mining: '//mining',
  operational: '//operational',
  miningProxy: '//mining//proxy',
  vaultDelegate: '//vaulting//delegate',
  bootstrapEndpoint: '//bootstrap-endpoint',
  ownServerRecovery: '//bootstrap-recovery//own-server',
  upstreamRecovery: '//bootstrap-recovery//upstream',
  routerRestoreSealing: '//router-restore-sealing',
  miningSessions: '//mining//sessions',
} as const;

export function bootstrapEndpointPath(index = 0): string {
  return `${walletKeyPaths.bootstrapEndpoint}//${index}`;
}
