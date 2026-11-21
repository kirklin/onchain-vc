import type { Abi, Account, Address, Chain, Client, Hash, Hex, TransactionReceipt, Transport } from "viem";
import { encodeFunctionData } from "viem";
import { getCapabilities, sendCalls, sendTransaction, waitForCallsStatus, waitForTransactionReceipt } from "viem/actions";

/** One step of a batch: a contract call, or a plain transfer when only `to` and `value` are given. */
export type BatchCall
  = | { to: Address; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }
    | { to: Address; data?: Hex; value?: bigint };

type WalletClient = Client<Transport, Chain, Account>;

/** Thrown when a batch, or one transaction of it, was included but reverted. */
export class BatchRevertedError extends Error {
  override name = "BatchRevertedError";
}

/**
 * Whether the wallet can execute several calls as one transaction (EIP-5792). Wallets that
 * predate the standard reject the question itself, which counts as a no.
 */
export async function supportsAtomicBatch(wallet: WalletClient): Promise<boolean> {
  try {
    const capabilities = await getCapabilities(wallet, { account: wallet.account, chainId: wallet.chain.id });
    const status = (capabilities as { atomic?: { status?: string } }).atomic?.status;
    return status === "supported" || status === "ready";
  } catch {
    return false;
  }
}

/**
 * Sends `calls` in order and resolves with their receipts once all are confirmed.
 *
 * A wallet that supports EIP-5792 executes them as one transaction, all or nothing, with a
 * single confirmation. Any other wallet is asked to confirm them one at a time, each sent
 * only after the one before it is confirmed. A failure then leaves the earlier ones in
 * place, so order the calls so that stopping part-way is safe, as with approve then spend.
 *
 * `wallet` signs and sends. `reader` is the client the receipts are read through. `onHash`
 * is called with each transaction hash as soon as there is one.
 */
export async function sendBatch(parameters: {
  wallet: WalletClient;
  reader: Client<Transport, Chain>;
  calls: readonly BatchCall[];
  onHash?: (hash: Hash) => void;
}): Promise<TransactionReceipt[]> {
  const { wallet, reader, calls, onHash } = parameters;

  if (await supportsAtomicBatch(wallet)) {
    const { id } = await sendCalls(wallet, { calls: calls as never, forceAtomic: true });
    const result = await waitForCallsStatus(wallet, { id, timeout: 120_000 });
    const receipts = (result.receipts ?? []) as unknown as TransactionReceipt[];
    for (const receipt of receipts) {
      onHash?.(receipt.transactionHash);
    }
    if (result.status !== "success") {
      throw new BatchRevertedError("The batch reverted.");
    }
    return receipts;
  }

  const receipts: TransactionReceipt[] = [];
  for (const [index, call] of calls.entries()) {
    const data = "abi" in call ? encodeFunctionData({ abi: call.abi as Abi, functionName: call.functionName, args: call.args }) : call.data;
    const hash = await sendTransaction(wallet, { to: call.to, data, value: call.value });
    onHash?.(hash);
    const receipt = await waitForTransactionReceipt(reader, { hash });
    if (receipt.status !== "success") {
      throw new BatchRevertedError(`Call ${index + 1} of ${calls.length} reverted.`);
    }
    receipts.push(receipt);
  }
  return receipts;
}
