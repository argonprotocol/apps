import {
  createBootstrapRecoveryProof,
  createBootstrapEndpointUpdate,
  decryptBootstrapEndpoint,
  decryptBootstrapRecovery,
  encryptBootstrapEndpoint,
  encryptBootstrapRecovery,
  getBootstrapEndpointPubkey,
  type IBootstrapEndpointPayload,
  type IBootstrapRecoveryPayload,
} from '@argonprotocol/apps-core';
import {
  type ArgonClient,
  hexToU8a,
  Keyring,
  type KeyringPair,
  type SubmittableExtrinsic,
  u8aToHex,
} from '@argonprotocol/mainchain';
import type { WalletKeys } from './WalletKeys.ts';
import type { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType } from '../interfaces/ITransactionRecord.ts';

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

  public async publishEndpoint(args: {
    client: ArgonClient;
    transactionTracker: TransactionTracker;
    host: string;
    port: number;
    bootstrapEndpointSecret: string;
  }): Promise<IBootstrapEndpointPayload | undefined> {
    const endpointOwner = await this.walletKeys.getDefaultArgonKeypair();
    const [endpointTx, endpoint] = await this.buildEndpointPublication(
      args.client,
      endpointOwner,
      args.host,
      args.port,
      args.bootstrapEndpointSecret,
    );
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
    const writer = await this.walletKeys.getDefaultArgonKeypair();
    const tx = await this.buildRecoveryPublication({
      ...args,
      writer,
    });
    await submitBootstrapTransaction(
      args.transactionTracker,
      args.client,
      tx,
      writer,
      ExtrinsicType.BootstrapPublishRecovery,
    );
  }

  public static isAvailable(client: ArgonClient): boolean {
    return !!(
      Reflect.has(client.query, 'bootstrap') &&
      Reflect.has(client.tx, 'bootstrap') &&
      Reflect.has(client.query.bootstrap, 'encryptedRecoveryPayloadByPubkey') &&
      Reflect.has(client.query.bootstrap, 'encryptedEndpointByPubkey') &&
      Reflect.has(client.query.bootstrap, 'endpointOwnerByPubkey') &&
      Reflect.has(client.tx.bootstrap, 'setRecoveryPayload') &&
      Reflect.has(client.tx.bootstrap, 'setEndpoint')
    );
  }

  public async recoverEndpoint(
    client: ArgonClient,
    context: BootstrapRecoveryContext,
    minimumSequence = 0,
  ): Promise<IRecoveredBootstrapEndpoint | undefined> {
    if (!BootstrapRecovery.isAvailable(client)) return;

    const recoverySeed =
      context === BootstrapRecoveryContext.Upstream
        ? await this.walletKeys.getUpstreamEndpointRecoverySeed()
        : await this.walletKeys.getOwnServerEndpointRecoverySeed();
    const recoveryKeypair = new Keyring({ type: 'ed25519' }).addFromSeed(hexToU8a(recoverySeed));
    const encryptedRecovery = await client.query.bootstrap.encryptedRecoveryPayloadByPubkey(recoveryKeypair.publicKey);
    if (encryptedRecovery.isNone) return;

    const recovery = await decryptBootstrapRecovery(encryptedRecovery.unwrap(), recoverySeed);
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
  }

  public async resolveEndpoint(
    client: ArgonClient,
    bootstrapEndpointSecret: string,
    minimumSequence = 0,
  ): Promise<IRecoveredBootstrapEndpoint | undefined> {
    if (!BootstrapRecovery.isAvailable(client)) return;

    const bootstrapEndpointPubkey = getBootstrapEndpointPubkey(bootstrapEndpointSecret);
    const encryptedEndpoint = await client.query.bootstrap.encryptedEndpointByPubkey(bootstrapEndpointPubkey);
    if (encryptedEndpoint.isNone) return;

    const endpoint = await decryptBootstrapEndpoint(encryptedEndpoint.unwrap(), bootstrapEndpointSecret);
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
      writer: KeyringPair;
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
    if (!BootstrapRecovery.isAvailable(args.client)) return;

    const recoverySeed =
      args.context === BootstrapRecoveryContext.Upstream
        ? await this.walletKeys.getUpstreamEndpointRecoverySeed()
        : await this.walletKeys.getOwnServerEndpointRecoverySeed();
    const recoveryKeypair = new Keyring({ type: 'ed25519' }).addFromSeed(hexToU8a(recoverySeed));
    const current = await args.client.query.bootstrap.encryptedRecoveryPayloadByPubkey(recoveryKeypair.publicKey);
    if (args.context === BootstrapRecoveryContext.Upstream && current.unwrapOrDefault().eq(args.encryptedRecovery)) {
      return;
    }
    if (args.context === BootstrapRecoveryContext.OwnServer && current.isSome) {
      const currentRecovery = await decryptBootstrapRecovery(current.unwrap(), recoverySeed);
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
  }

  private async buildEndpointPublication(
    client: ArgonClient,
    endpointOwner: KeyringPair,
    host: string,
    port: number,
    bootstrapEndpointSecret: string,
  ): Promise<[SubmittableExtrinsic | undefined, IBootstrapEndpointPayload | undefined]> {
    if (!BootstrapRecovery.isAvailable(client)) return [undefined, undefined];

    const bootstrapEndpointPubkey = getBootstrapEndpointPubkey(bootstrapEndpointSecret);
    const [currentEncryptedEndpoint, currentOwner] = await Promise.all([
      client.query.bootstrap.encryptedEndpointByPubkey(bootstrapEndpointPubkey),
      client.query.bootstrap.endpointOwnerByPubkey(bootstrapEndpointPubkey),
    ]);
    if (currentOwner.isSome && currentOwner.unwrap().toString() !== endpointOwner.address) {
      throw new Error('The bootstrap endpoint is owned by a different account.');
    }

    const currentEndpoint = currentEncryptedEndpoint.isSome
      ? await decryptBootstrapEndpoint(currentEncryptedEndpoint.unwrap(), bootstrapEndpointSecret)
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
  signer: KeyringPair,
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
