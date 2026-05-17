import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import type { ApplyExtrinsicResult } from '@polkadot/types/interfaces/system';
import type { IEthereumInboundRelayRequest } from '@argonprotocol/apps-core';
import { HttpError } from '../src/HttpError.ts';

type IMockSignedTx = {
  toHex: () => string;
};

type IMockSubmitResult = {
  extrinsic: {
    signedHash: string;
    submittedAtBlockNumber: number;
    submittedTime: Date;
  };
};

const mainchainMock = vi.hoisted(() => {
  const sign = vi.fn<(options?: { nonce?: number }) => Promise<IMockSignedTx>>();
  const submitSigned = vi.fn<(signedTx: IMockSignedTx) => Promise<IMockSubmitResult>>();

  class TxSubmitter {
    public sign(options?: { nonce?: number }): Promise<IMockSignedTx> {
      return sign(options);
    }

    public submitSigned(signedTx: IMockSignedTx): Promise<IMockSubmitResult> {
      return submitSigned(signedTx);
    }
  }

  return {
    sign,
    submitSigned,
    TxSubmitter,
  };
});

vi.mock('@argonprotocol/mainchain', async () => {
  const actual = await vi.importActual<typeof import('@argonprotocol/mainchain')>('@argonprotocol/mainchain');

  return {
    ...actual,
    TxSubmitter: mainchainMock.TxSubmitter,
  };
});

import { MINTING_GATEWAY_BURN_FOR_TRANSFER_EVENT_NAME, mintingGatewayArtifact } from '@argonprotocol/mainchain';
import { DelegateSubmitLane } from '../src/DelegateSubmitLane.ts';
import { EthereumProofRelayService } from '../src/EthereumProofRelayService.ts';

const relayKeypair = { address: '5RelayDelegate' } as any;
const gatewayAddress: `0x${string}` = `0x${'33'.repeat(20)}`;
const argonTokenAddress: `0x${string}` = `0x${'11'.repeat(20)}`;
const argonotTokenAddress: `0x${string}` = `0x${'22'.repeat(20)}`;

describe('EthereumProofRelayService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces verifier unavailability from the local node api', async () => {
    const eventLog = createBurnEventLog(argonTokenAddress);
    const client = createClient({
      verifyEventLogResult: errResult('VerifierUnavailable'),
    });
    const service = new EthereumProofRelayService(createSubmitLane(client));

    await expect(service.relayTransferProof(createRequest(eventLog))).rejects.toEqual(
      new HttpError('Bot local node Ethereum proof verification API is unavailable.', 503),
    );

    expect(client.call.ethereumApis.verifyEventLog).toHaveBeenCalledWith(eventLog, createProof());
    expect(client.tx.crosschainTransfer.proveTransfer).not.toHaveBeenCalled();
    expect(mainchainMock.sign).not.toHaveBeenCalled();
  });

  it('rejects invalid proofs before building or signing the relay tx', async () => {
    const eventLog = createBurnEventLog(argonTokenAddress);
    const client = createClient({
      verifyEventLogResult: errResult('InvalidProof'),
    });
    const service = new EthereumProofRelayService(createSubmitLane(client));

    await expect(service.relayTransferProof(createRequest(eventLog))).resolves.toEqual({
      outcome: 'Rejected',
      reason: 'InvalidProof',
    });

    expect(client.tx.crosschainTransfer.proveTransfer).not.toHaveBeenCalled();
    expect(mainchainMock.sign).not.toHaveBeenCalled();
    expect(mainchainMock.submitSigned).not.toHaveBeenCalled();
  });

  it('rejects proofs that fail dry-run before submission', async () => {
    const eventLog = createBurnEventLog(argonTokenAddress);
    const signedTx = {
      toHex: () => '0xsigned',
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveTransfer' }) },
      nonce: { toNumber: () => 4 },
    };
    const client = createClient({
      verifyEventLogResult: okResult(),
      dryRunResult: dispatchErrResult('Module.ProofAlreadyProcessed'),
    });

    mainchainMock.sign.mockResolvedValue(signedTx);

    const service = new EthereumProofRelayService(createSubmitLane(client));

    await expect(service.relayTransferProof(createRequest(eventLog))).resolves.toEqual({
      outcome: 'Rejected',
      reason: 'Module.ProofAlreadyProcessed',
      estimatedFee: 7n,
    });

    expect(client.call.ethereumApis.verifyEventLog).toHaveBeenCalledWith(eventLog, createProof());
    expect(client.rpc.system.accountNextIndex).toHaveBeenCalledWith(relayKeypair.address);
    expect(mainchainMock.sign).toHaveBeenCalledWith({ nonce: 4 });
    expect(mainchainMock.submitSigned).not.toHaveBeenCalled();
  });

  it('submits a relay only after runtime proof verification and dry-run succeed', async () => {
    const eventLog = createBurnEventLog(argonTokenAddress);
    const tx = {
      paymentInfo: vi.fn(async () => ({
        partialFee: {
          toBigInt: () => 11n,
        },
      })),
    };
    const signedTx = {
      toHex: () => '0xsigned',
      method: { toHuman: () => ({ section: 'crosschainTransfer', method: 'proveTransfer' }) },
      nonce: { toNumber: () => 9 },
    };
    const client = createClient({
      tx,
      verifyEventLogResult: okResult(),
      dryRunResult: okDryRunResult(),
      accountNextNonce: 9,
    });

    mainchainMock.sign.mockResolvedValue(signedTx);
    mainchainMock.submitSigned.mockResolvedValue({
      extrinsic: {
        signedHash: '0xrelaytx',
        submittedAtBlockNumber: 321,
        submittedTime: new Date('2026-05-13T16:00:00.000Z'),
      },
    });

    const service = new EthereumProofRelayService(createSubmitLane(client));

    const result = await service.relayTransferProof(createRequest(eventLog));

    expect(result).toEqual({
      outcome: 'Submitted',
      delegateAddress: '5RelayDelegate',
      argonTxHash: '0xrelaytx',
      extrinsicMethodJson: { section: 'crosschainTransfer', method: 'proveTransfer' },
      txNonce: 9,
      txSubmittedAtBlockHeight: 321,
      txSubmittedAtTime: new Date('2026-05-13T16:00:00.000Z'),
      estimatedFee: 11n,
    });

    expect(client.call.ethereumApis.verifyEventLog).toHaveBeenCalledWith(eventLog, createProof());
    expect(client.rpc.system.accountNextIndex).toHaveBeenCalledWith(relayKeypair.address);
    expect(mainchainMock.sign).toHaveBeenCalledWith({ nonce: 9 });
    expect(mainchainMock.submitSigned).toHaveBeenCalledWith(signedTx);
  });
});

function createSubmitLane(client: ReturnType<typeof createClient>) {
  const lane = new DelegateSubmitLane(relayKeypair);
  lane.client = client as any;
  return lane;
}

function createClient(
  args: {
    tx?: { paymentInfo: ReturnType<typeof vi.fn> };
    verifyEventLogResult?: { isErr: boolean; isOk: boolean; asErr?: { toString: () => string } };
    dryRunResult?: ApplyExtrinsicResult;
    accountNextNonce?: number;
  } = {},
) {
  const tx =
    args.tx ??
    ({
      paymentInfo: vi.fn(async () => ({
        partialFee: {
          toBigInt: () => 7n,
        },
      })),
    } as const);

  return {
    tx: {
      crosschainTransfer: {
        proveTransfer: vi.fn(() => tx),
      },
    },
    query: {
      crosschainTransfer: {
        chainConfigBySourceChain: vi.fn(async () => ({
          isNone: false,
          unwrap: () => ({
            isEthereum: true,
            asEthereum: {
              argonToken: { toHex: () => argonTokenAddress },
              argonotToken: { toHex: () => argonotTokenAddress },
            },
          }),
        })),
      },
    },
    call: {
      ethereumApis: {
        verifyEventLog: vi.fn(async () => args.verifyEventLogResult ?? okResult()),
      },
    },
    rpc: {
      system: {
        accountNextIndex: vi.fn(async () => ({
          toNumber: () => args.accountNextNonce ?? 4,
        })),
        dryRun: vi.fn(async () => args.dryRunResult ?? okDryRunResult()),
      },
    },
  };
}

function createRequest(eventLog: ReturnType<typeof createBurnEventLog>): IEthereumInboundRelayRequest {
  return {
    transferProof: {
      Ethereum: {
        sourceChain: 'Ethereum',
        eventLog,
        proof: createProof(),
      },
    },
  } as unknown as IEthereumInboundRelayRequest;
}

function createBurnEventLog(tokenAddress: `0x${string}`, fromAddress = `0x${'aa'.repeat(20)}`) {
  const topics = encodeEventTopics({
    abi: mintingGatewayArtifact.abi,
    eventName: MINTING_GATEWAY_BURN_FOR_TRANSFER_EVENT_NAME,
    args: {
      from: fromAddress,
      token: tokenAddress,
    },
  });
  const data = encodeAbiParameters(
    [
      { type: 'uint256', name: 'amount_base_units' },
      { type: 'bytes32', name: 'argon_destination' },
      { type: 'uint64', name: 'account_nonce' },
    ],
    [25n, `0x${'00'.repeat(32)}`, 7n],
  );

  return {
    address: gatewayAddress,
    topics: topics.filter(Boolean) as `0x${string}`[],
    data,
  };
}

function createProof() {
  return {
    executionBlockProof: {
      anchorBlockHash: `0x${'66'.repeat(32)}`,
      targetToAnchorHeaderChain: [],
    },
    receiptProof: {
      transactionIndex: 0,
      nodes: [],
    },
  };
}

function okResult() {
  return {
    isErr: false,
    isOk: true,
  };
}

function errResult(reason: string) {
  return {
    isErr: true,
    isOk: false,
    asErr: {
      toString: () => reason,
    },
  };
}

function okDryRunResult() {
  return {
    isErr: false,
    asOk: {
      isErr: false,
    },
  } as ApplyExtrinsicResult;
}

function dispatchErrResult(reason: string) {
  return {
    isErr: false,
    asOk: {
      isErr: true,
      asErr: {
        toString: () => reason,
      },
    },
  } as ApplyExtrinsicResult;
}
