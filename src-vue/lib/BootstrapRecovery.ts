import {
  type TxSigner,
  createBootstrapRecoveryProof,
  createBootstrapEndpointUpdate,
  decryptBootstrapEndpoint,
  decryptBootstrapRecovery,
  encryptBootstrapEndpoint,
  encryptBootstrapRecovery,
  getBootstrapEndpointPubkey,
  type IBootstrapEndpointPayload,
  type IBootstrapRecoveryPayload,
  ArgonClient,
} from '@argonprotocol/apps-core';
import { hexToU8a, Keyring, type SubmittableExtrinsic, u8aEq, u8aToHex } from '@argonprotocol/mainchain';
import type { WalletKeys } from './WalletKeys.ts';
import type { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType } from '../interfaces/ITransactionRecord.ts';
import type { Config } from './Config.ts';

export type IRecoveredBootstrapEndpoint = IBootstrapEndpointPayload &
  Pick<IBootstrapRecoveryPayload, 'ssh'> & {
    bootstrapEndpointSecret: string;
    bootstrapEndpointIndex?: number;
  };

export enum BootstrapRecoveryContext {
  Upstream = 'upstream',
  OwnServer = 'own-server',
}

export class BootstrapRecovery {
  constructor(private readonly walletKeys: WalletKeys) {}

  public async publishOwnServer({
    config,
    client,
    transactionTracker,
  }: {
    config: Config;
    client: ArgonClient;
    transactionTracker: TransactionTracker;
  }): Promise<void> {
    if (!config.isServerInstalled) return;
    const { ipAddress, sshUser } = config.serverDetails;
    if (!ipAddress || !sshUser) return;

    const account = await client.query.system.account(this.walletKeys.defaultArgonAddress);
    if (account.data.free <= 0n) return;

    await this.publishOwnServerRecovery({ config, client, transactionTracker });
    await this.publishOwnServerEndpoint({ config, client, transactionTracker });
  }

  public async publishOwnServerRecovery({
    config,
    client,
    transactionTracker,
  }: {
    config: Config;
    client: ArgonClient;
    transactionTracker: TransactionTracker;
  }): Promise<void> {
    const { sshUser, sshPort, bootstrapEndpointIndex = 0 } = config.serverDetails;
    if (!config.isServerInstalled || !config.serverDetails.ipAddress || !sshUser) return;

    const bootstrapEndpointSecret = await this.walletKeys.getOwnServerBootstrapEndpointSecret(bootstrapEndpointIndex);
    await this.publishRecovery({
      client,
      transactionTracker,
      context: BootstrapRecoveryContext.OwnServer,
      bootstrapEndpointSecret,
      bootstrapEndpointIndex,
      ssh: { user: sshUser, port: sshPort ?? 22 },
    });
  }

  public async publishOwnServerEndpoint({
    config,
    client,
    transactionTracker,
  }: {
    config: Config;
    client: ArgonClient;
    transactionTracker: TransactionTracker;
  }): Promise<void> {
    const { ipAddress, gatewayPort, bootstrapEndpointIndex = 0 } = config.serverDetails;
    if (!config.isServerInstalled || !ipAddress) return;

    const bootstrapEndpointSecret = await this.walletKeys.getOwnServerBootstrapEndpointSecret(bootstrapEndpointIndex);
    const endpoint = await this.publishEndpoint({
      client,
      transactionTracker,
      bootstrapEndpointSecret,
      host: ipAddress,
      port: gatewayPort ?? 443,
    });
    if (!endpoint) return;

    config.serverDetails = {
      ...config.serverDetails,
      bootstrapEndpointIndex,
      bootstrapEndpointSequence: endpoint.sequence,
    };
    await config.save();
  }

  public async publishEndpoint(args: {
    client: ArgonClient;
    transactionTracker: TransactionTracker;
    host: string;
    port: number;
    bootstrapEndpointSecret: string;
  }): Promise<IBootstrapEndpointPayload | undefined> {
    const endpointOwner = await this.walletKeys.getDefaultArgonSigner();
    const [endpointTx, endpoint] = await this.buildEndpointPublication(
      args.client,
      endpointOwner,
      args.host,
      args.port,
      args.bootstrapEndpointSecret,
    );
    if (!endpointTx) return endpoint;
    await submitBootstrapTransaction(
      args.transactionTracker,
      args.client,
      endpointTx,
      endpointOwner,
      ExtrinsicType.BootstrapPublishEndpoint,
    );

    return endpoint;
  }

  public async publishRecovery(
    args: {
      client: ArgonClient;
      transactionTracker: TransactionTracker;
    } & (
      | {
          context: BootstrapRecoveryContext.Upstream;
          encryptedRecovery: Uint8Array;
        }
      | {
          context: BootstrapRecoveryContext.OwnServer;
          bootstrapEndpointSecret: string;
          bootstrapEndpointIndex: number;
          ssh: NonNullable<IBootstrapRecoveryPayload['ssh']>;
        }
    ),
  ): Promise<void> {
    const writer = await this.walletKeys.getDefaultArgonSigner();
    const tx = await this.buildRecoveryPublication({
      ...args,
      writer,
    });
    if (!tx) return;
    await submitBootstrapTransaction(
      args.transactionTracker,
      args.client,
      tx,
      writer,
      ExtrinsicType.BootstrapPublishRecovery,
    );
  }

  public async recoverEndpoint(
    client: ArgonClient,
    context: BootstrapRecoveryContext,
    minimumSequence = 0,
  ): Promise<IRecoveredBootstrapEndpoint | undefined> {
    let recoverySeed: string;
    if (context === BootstrapRecoveryContext.Upstream) {
      recoverySeed = await this.walletKeys.getUpstreamEndpointRecoverySeed();
    } else {
      recoverySeed = await this.walletKeys.getOwnServerEndpointRecoverySeed();
    }
    const recoveryKeypair = new Keyring({ type: 'ed25519' }).addFromSeed(hexToU8a(recoverySeed));
    try {
      const encryptedRecovery = await client.query.bootstrap.encryptedRecoveryPayloadByPubkey(
        recoveryKeypair.publicKey,
      );
      if (!encryptedRecovery) return;

      const recovery = await decryptBootstrapRecovery(encryptedRecovery, recoverySeed);
      let bootstrapEndpointSecret = recovery.endpointSecret;
      if (context === BootstrapRecoveryContext.OwnServer) {
        if (recovery.endpointIndex === undefined) {
          throw new Error('The own-server bootstrap recovery payload is missing its endpoint index.');
        }

        bootstrapEndpointSecret = await this.walletKeys.getOwnServerBootstrapEndpointSecret(recovery.endpointIndex);
        if (bootstrapEndpointSecret !== recovery.endpointSecret) {
          throw new Error('The own-server bootstrap recovery payload does not match its endpoint index.');
        }
      }

      const endpoint = await this.resolveEndpoint(client, bootstrapEndpointSecret, minimumSequence);
      if (!endpoint) return;

      return {
        ...endpoint,
        ...(context === BootstrapRecoveryContext.OwnServer ? { bootstrapEndpointIndex: recovery.endpointIndex } : {}),
        ssh: recovery.ssh,
      };
    } finally {
      recoveryKeypair.lock();
    }
  }

  public async resolveEndpoint(
    client: ArgonClient,
    bootstrapEndpointSecret: string,
    minimumSequence = 0,
  ): Promise<IRecoveredBootstrapEndpoint | undefined> {
    const bootstrapEndpointPubkey = getBootstrapEndpointPubkey(bootstrapEndpointSecret);
    const encryptedEndpoint = await client.query.bootstrap.encryptedEndpointByPubkey(bootstrapEndpointPubkey);
    if (!encryptedEndpoint) return;

    const endpoint = await decryptBootstrapEndpoint(encryptedEndpoint, bootstrapEndpointSecret);
    if (endpoint.sequence < minimumSequence) {
      throw new Error('The recovered upstream endpoint is older than the cached endpoint.');
    }

    return {
      ...endpoint,
      bootstrapEndpointSecret,
    };
  }

  private async buildRecoveryPublication(
    args: {
      client: ArgonClient;
      writer: TxSigner;
    } & (
      | {
          context: BootstrapRecoveryContext.Upstream;
          encryptedRecovery: Uint8Array;
        }
      | {
          context: BootstrapRecoveryContext.OwnServer;
          bootstrapEndpointSecret: string;
          bootstrapEndpointIndex: number;
          ssh: NonNullable<IBootstrapRecoveryPayload['ssh']>;
        }
    ),
  ): Promise<SubmittableExtrinsic | undefined> {
    let recoverySeed: string;
    if (args.context === BootstrapRecoveryContext.Upstream)
      recoverySeed = await this.walletKeys.getUpstreamEndpointRecoverySeed();
    else recoverySeed = await this.walletKeys.getOwnServerEndpointRecoverySeed();
    const recoveryKeypair = new Keyring({ type: 'ed25519' }).addFromSeed(hexToU8a(recoverySeed));
    try {
      const current = await args.client.query.bootstrap.encryptedRecoveryPayloadByPubkey(recoveryKeypair.publicKey);
      if (args.context === BootstrapRecoveryContext.Upstream && current && u8aEq(current, args.encryptedRecovery)) {
        return;
      }
      if (args.context === BootstrapRecoveryContext.OwnServer && current) {
        const currentRecovery = await decryptBootstrapRecovery(current, recoverySeed);
        if (
          currentRecovery.endpointSecret === args.bootstrapEndpointSecret &&
          currentRecovery.endpointIndex === args.bootstrapEndpointIndex &&
          currentRecovery.ssh?.user === args.ssh.user &&
          currentRecovery.ssh?.port === args.ssh.port
        ) {
          return;
        }
      }

      let encryptedRecovery: Uint8Array;
      if (args.context === BootstrapRecoveryContext.Upstream) {
        encryptedRecovery = args.encryptedRecovery;
      } else {
        encryptedRecovery = await encryptBootstrapRecovery(
          {
            version: 1,
            endpointSecret: args.bootstrapEndpointSecret,
            endpointIndex: args.bootstrapEndpointIndex,
            ssh: args.ssh,
          },
          recoverySeed,
        );
      }

      return args.client.tx.bootstrap.setRecoveryPayload(
        recoveryKeypair.publicKey,
        createBootstrapRecoveryProof(recoveryKeypair, args.writer.address, encryptedRecovery),
        u8aToHex(encryptedRecovery),
      );
    } finally {
      recoveryKeypair.lock();
    }
  }

  private async buildEndpointPublication(
    client: ArgonClient,
    endpointOwner: TxSigner,
    host: string,
    port: number,
    bootstrapEndpointSecret: string,
  ): Promise<[SubmittableExtrinsic | undefined, IBootstrapEndpointPayload | undefined]> {
    const bootstrapEndpointPubkey = getBootstrapEndpointPubkey(bootstrapEndpointSecret);
    const [currentEncryptedEndpoint, currentOwner] = await Promise.all([
      client.query.bootstrap.encryptedEndpointByPubkey(bootstrapEndpointPubkey),
      client.query.bootstrap.endpointOwnerByPubkey(bootstrapEndpointPubkey),
    ]);
    if (currentOwner && currentOwner !== endpointOwner.address) {
      throw new Error('The bootstrap endpoint is owned by a different account.');
    }

    const currentEndpoint = currentEncryptedEndpoint
      ? await decryptBootstrapEndpoint(currentEncryptedEndpoint, bootstrapEndpointSecret)
      : undefined;
    const endpoint = createBootstrapEndpointUpdate(currentEndpoint, host, port);
    if (!endpoint) return [undefined, currentEndpoint];

    const encryptedEndpoint = await encryptBootstrapEndpoint(endpoint, bootstrapEndpointSecret);
    return [client.tx.bootstrap.setEndpoint(bootstrapEndpointPubkey, u8aToHex(encryptedEndpoint)), endpoint];
  }
}

async function submitBootstrapTransaction(
  transactionTracker: TransactionTracker,
  client: ArgonClient,
  tx: SubmittableExtrinsic | undefined,
  signer: TxSigner,
  extrinsicType: ExtrinsicType,
): Promise<void> {
  if (!tx) return;

  const txInfo = await transactionTracker.submitAndWatch({
    client,
    tx,
    txSigner: signer,
    useLatestNonce: true,
    extrinsicType,
  });
  await txInfo.txResult.waitForFinalizedBlock;
  const error = txInfo.txResult.submissionError ?? txInfo.txResult.extrinsicError;
  if (error) throw error;
}
