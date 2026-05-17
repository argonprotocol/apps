import {
  MINTING_GATEWAY_BURN_FOR_TRANSFER_EVENT_NAME,
  mintingGatewayArtifact,
  TxSubmitter,
  type ArgonClient,
  type EthereumEventProof,
} from '@argonprotocol/mainchain';
import type { ApplyExtrinsicResult } from '@polkadot/types/interfaces/system';
import type { IEthereumInboundRelayRequest, IEthereumInboundRelayResponse } from '@argonprotocol/apps-core';
import { decodeEventLog, getAddress } from 'viem';
import { DelegateSubmitLane } from './DelegateSubmitLane.ts';
import { HttpError } from './HttpError.ts';

type IEthereumRelayEventLog = EthereumEventProof['eventLog'];

export class EthereumProofRelayService {
  private ethereumTokenAddressesPromise?: Promise<{
    argonTokenAddress: string;
    argonotTokenAddress: string;
  }>;

  constructor(private readonly submitLane: DelegateSubmitLane) {}

  public async relayTransferProof(request: IEthereumInboundRelayRequest): Promise<IEthereumInboundRelayResponse> {
    const client = this.submitLane.client;
    if (!client) {
      throw new HttpError('Bot mainchain client is not ready.', 503);
    }

    const transferProof = request.transferProof;
    const ethereumProof =
      transferProof && typeof transferProof === 'object' && 'Ethereum' in transferProof
        ? transferProof.Ethereum
        : undefined;
    if (!ethereumProof) {
      throw new HttpError('An Ethereum transfer proof is required.', 400);
    }
    if (ethereumProof.sourceChain !== 'Ethereum') {
      throw new HttpError('Only Ethereum transfer proofs are supported.', 400);
    }
    if (ethereumProof.eventLog == null || ethereumProof.proof == null) {
      throw new HttpError('Ethereum transfer proofs must include eventLog and proof.', 400);
    }

    const tokenAddress = decodeBurnTokenAddress(ethereumProof.eventLog);
    if (!tokenAddress) {
      return {
        outcome: 'Rejected',
        reason: 'The Ethereum event topics or payload do not match BurnForTransfer.',
      };
    }

    const tokenCheck = await this.validateRelayToken(client, tokenAddress);
    if (tokenCheck) {
      return tokenCheck;
    }

    const verifyResult = await client.call.ethereumApis.verifyEventLog(ethereumProof.eventLog, ethereumProof.proof);
    if (verifyResult.isErr) {
      const reason = verifyResult.asErr.toString();
      if (reason === 'VerifierUnavailable') {
        throw new HttpError('Bot local node Ethereum proof verification API is unavailable.', 503);
      }

      return {
        outcome: 'Rejected',
        reason,
      };
    }

    const estimatedFee = (
      await client.tx.crosschainTransfer.proveTransfer(request.transferProof).paymentInfo(this.submitLane.address)
    ).partialFee.toBigInt();

    try {
      return await this.submitLane.runExclusive(async (client, getNonce) => {
        const tx = client.tx.crosschainTransfer.proveTransfer(request.transferProof);
        const submitter = new TxSubmitter(client, tx, this.submitLane.keypair);
        const signedTx = await submitter.sign({ nonce: await getNonce() });
        const dryRunResult = await client.rpc.system.dryRun(signedTx.toHex());
        const dryRunError = getDryRunError(dryRunResult);

        if (dryRunError) {
          throw new RelayRejectedError(dryRunError);
        }

        const submitted = await submitter.submitSigned(signedTx);

        return {
          outcome: 'Submitted',
          delegateAddress: this.submitLane.address,
          argonTxHash: submitted.extrinsic.signedHash,
          extrinsicMethodJson: signedTx.method.toHuman(),
          txNonce: signedTx.nonce.toNumber(),
          txSubmittedAtBlockHeight: submitted.extrinsic.submittedAtBlockNumber,
          txSubmittedAtTime: submitted.extrinsic.submittedTime,
          estimatedFee,
        };
      });
    } catch (error) {
      if (!(error instanceof RelayRejectedError)) {
        throw error;
      }

      return {
        outcome: 'Rejected',
        reason: error.message,
        estimatedFee,
      };
    }
  }

  private async validateRelayToken(
    client: ArgonClient,
    tokenAddress: string,
  ): Promise<IEthereumInboundRelayResponse | undefined> {
    const { argonTokenAddress, argonotTokenAddress } = await this.getEthereumTokenAddresses(client);
    const normalizedTokenAddress = getAddress(tokenAddress);

    if (normalizedTokenAddress === argonotTokenAddress) {
      return {
        outcome: 'Rejected',
        reason: 'ARGNOT transfers must be submitted directly.',
      };
    }
    if (normalizedTokenAddress !== argonTokenAddress) {
      return {
        outcome: 'Rejected',
        reason: 'Only ARGN burn proofs are eligible for relay.',
      };
    }

    return undefined;
  }

  private async getEthereumTokenAddresses(client: ArgonClient): Promise<{
    argonTokenAddress: string;
    argonotTokenAddress: string;
  }> {
    this.ethereumTokenAddressesPromise ??= (async () => {
      const chainConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
      if (chainConfig.isNone || !chainConfig.unwrap().isEthereum) {
        throw new HttpError('Ethereum transfer gateway is not configured on this network.', 503);
      }

      const ethereumConfig = chainConfig.unwrap().asEthereum;
      return {
        argonTokenAddress: getAddress(ethereumConfig.argonToken.toHex()),
        argonotTokenAddress: getAddress(ethereumConfig.argonotToken.toHex()),
      };
    })();

    try {
      return await this.ethereumTokenAddressesPromise;
    } catch (error) {
      this.ethereumTokenAddressesPromise = undefined;
      throw error;
    }
  }
}

function decodeBurnTokenAddress(eventLog: IEthereumRelayEventLog): string | undefined {
  try {
    const [signature, ...topics] = eventLog.topics;
    if (!signature) {
      return undefined;
    }

    const decodedEvent = decodeEventLog({
      abi: mintingGatewayArtifact.abi,
      eventName: MINTING_GATEWAY_BURN_FOR_TRANSFER_EVENT_NAME,
      data: eventLog.data,
      topics: [signature, ...topics],
    });
    const token = (decodedEvent as { args?: { token?: unknown } }).args?.token;
    return typeof token === 'string' ? getAddress(token) : undefined;
  } catch {
    return undefined;
  }
}

class RelayRejectedError extends Error {}

function getDryRunError(dryRunResult: ApplyExtrinsicResult): string | undefined {
  if (dryRunResult.isErr) {
    return dryRunResult.asErr.toString();
  }
  if (dryRunResult.asOk.isErr) {
    return dryRunResult.asOk.asErr.toString();
  }

  return undefined;
}
