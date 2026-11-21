import type { Address, Chain, Client, Hex, NonceManager, PrivateKeyAccount, RpcTransactionReceipt, Transport } from "viem";
import { createClient, encodeFunctionData, hexToBigInt, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getCode, sendTransaction, signAuthorization } from "viem/actions";
import { batchExecutorAbi } from "~/contracts/abis";

export type BurnerClient = Client<Transport, Chain, PrivateKeyAccount>;

/** The code of an account that has delegated to `target` under EIP-7702. */
function delegationTo(target: Address): Hex {
  return `0xef0100${target.slice(2).toLowerCase()}`;
}

/** An error shaped like a JSON-RPC one, which viem turns into its matching error class. */
function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

interface SendCallsParameters {
  calls: { to: Address; data?: Hex; value?: Hex }[];
}

/**
 * A viem client that signs with a key held in memory and also answers the wallet methods
 * of EIP-5792, so apps can hand it several calls to execute as one transaction.
 *
 * Batches run through EIP-7702: the account delegates to the BatchExecutor contract, in
 * the same transaction the first time, and calls `execute` on itself. `executor` is that
 * contract's address, or undefined on chains where it is not deployed, in which case the
 * client reports no batching support.
 *
 * Gas estimates are raised by `gasMarginPercent` before a transaction is signed, since a
 * key in memory has no wallet to pad them the way browser wallets do.
 */
export function createBurnerClient(options: {
  key: Hex;
  chain: Chain;
  transport: Transport;
  nonceManager: NonceManager;
  executor: Address | undefined;
  gasMarginPercent: number;
}): BurnerClient {
  const { chain, executor, nonceManager, gasMarginPercent } = options;
  const account = privateKeyToAccount(options.key, { nonceManager });
  const chainId = numberToHex(chain.id);
  // The transport answers batches by sending through the client it belongs to.
  const self: { client?: BurnerClient } = {};

  async function sendCalls({ calls }: SendCallsParameters): Promise<{ id: Hex }> {
    const client = self.client!;
    if (executor === undefined) {
      throw rpcError(4200, `Batches are not available on chain ${chain.id}.`);
    }
    const data = encodeFunctionData({
      abi: batchExecutorAbi,
      functionName: "execute",
      args: [calls.map(call => ({ to: call.to, value: call.value === undefined ? 0n : hexToBigInt(call.value), data: call.data ?? "0x" }))],
    });
    const delegated = (await getCode(client, { address: account.address }))?.toLowerCase() === delegationTo(executor);

    // The nonce is fixed up front because the authorisation has to name the one after it.
    // A mismatch would not fail: the account would stay without code and the call to
    // itself would succeed while doing nothing.
    const nonce = await nonceManager.consume({ address: account.address, chainId: chain.id, client });
    try {
      if (delegated) {
        return { id: await sendTransaction(client, { to: account.address, data, nonce }) };
      }
      const authorization = await signAuthorization(client, { contractAddress: executor, nonce: nonce + 1 });
      const id = await sendTransaction(client, { to: account.address, data, nonce, authorizationList: [authorization] });
      // The authorisation used up a nonce as well.
      nonceManager.increment({ address: account.address, chainId: chain.id });
      return { id };
    } catch (error) {
      nonceManager.reset({ address: account.address, chainId: chain.id });
      throw error;
    }
  }

  const transport: Transport = (parameters) => {
    const inner = options.transport(parameters);

    async function callsStatus(id: Hex) {
      const receipt = await inner.request({ method: "eth_getTransactionReceipt", params: [id] }) as RpcTransactionReceipt | null;
      const base = { version: "2.0.0", id, chainId, atomic: true };
      if (receipt === null) {
        return { ...base, status: 100 };
      }
      return { ...base, status: receipt.status === "0x1" ? 200 : 500, receipts: [receipt] };
    }

    const request = (async ({ method, params }: { method: string; params?: unknown }) => {
      const args = (params ?? []) as unknown[];
      switch (method) {
        case "wallet_getCapabilities":
          return executor === undefined ? {} : { [chainId]: { atomic: { status: "supported" } } };
        case "wallet_sendCalls":
          return sendCalls(args[0] as SendCallsParameters);
        case "wallet_getCallsStatus":
          return callsStatus(args[0] as Hex);
        case "eth_fillTransaction":
          // Declined, so that viem estimates gas itself and the margin below applies.
          throw rpcError(-32601, "eth_fillTransaction is not available.");
        case "eth_estimateGas": {
          const estimate = hexToBigInt(await inner.request({ method, params }) as Hex);
          return numberToHex(estimate + estimate * BigInt(gasMarginPercent) / 100n);
        }
        default:
          return inner.request({ method, params });
      }
    }) as typeof inner.request;

    return { ...inner, request };
  };

  self.client = createClient({ account, chain, transport });
  return self.client;
}
