import type { Address, Chain, Client, Hash, RpcTransactionReceipt, TransactionReceipt, Transport } from "viem";
import { formatTransactionReceipt } from "viem";
import { getTransactionCount, watchBlockNumber } from "viem/actions";

export type TransactionOutcome
  = | { status: "confirmed" | "reverted"; receipt: TransactionReceipt }
    /** Another transaction from the same account took this one's nonce: it was sped up, cancelled or dropped. */
    | { status: "replaced" };

/**
 * Follows a transaction to its end, however long that takes and whenever the following
 * starts, including long after it was sent and after a page reload.
 *
 * It resolves once the transaction is in a block, or once the account has moved past the
 * transaction's nonce without it, which means something else was confirmed in its place.
 * Abort `signal` to stop following.
 *
 * The two facts come from separate reads, and a cache or a second node may show the used
 * nonce before it shows the receipt. So a missing receipt only counts once it has stayed
 * missing for `settleMs` after the nonce was first seen used. The default is three blocks.
 */
export function trackTransaction(reader: Client<Transport, Chain>, parameters: {
  hash: Hash;
  from: Address;
  nonce: number;
  signal?: AbortSignal;
  settleMs?: number;
}): Promise<TransactionOutcome> {
  const { hash, from, nonce, signal } = parameters;
  const settleMs = parameters.settleMs ?? (reader.chain.blockTime ?? 1000) * 3;
  let usedSince: number | undefined;

  /** The outcome, or how long to wait before looking again when no new block prompts it. */
  async function check(): Promise<TransactionOutcome | { retryInMs: number | undefined }> {
    const receipt = await reader.request({ method: "eth_getTransactionReceipt", params: [hash] }) as RpcTransactionReceipt | null;
    if (receipt !== null) {
      return { status: receipt.status === "0x1" ? "confirmed" : "reverted", receipt: formatTransactionReceipt(receipt) };
    }
    if (await getTransactionCount(reader, { address: from, blockTag: "latest" }) <= nonce) {
      usedSince = undefined;
      return { retryInMs: undefined };
    }
    usedSince ??= Date.now();
    const remaining = usedSince + settleMs - Date.now();
    return remaining > 0 ? { retryInMs: remaining } : { status: "replaced" };
  }

  return new Promise((resolve, reject) => {
    let checking = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWatching = () => {};

    function stop() {
      stopWatching();
      clearTimeout(timer);
    }

    async function run() {
      // A prompt that arrives during a check gets a check of its own right after.
      again = true;
      if (checking) {
        return;
      }
      checking = true;
      try {
        while (again) {
          again = false;
          const result = await check();
          if ("status" in result) {
            stop();
            resolve(result);
            return;
          }
          clearTimeout(timer);
          if (result.retryInMs !== undefined) {
            timer = setTimeout(run, result.retryInMs);
          }
        }
      } catch (error) {
        stop();
        reject(error);
      } finally {
        checking = false;
      }
    }

    stopWatching = watchBlockNumber(reader, { emitOnBegin: true, onError: reject, onBlockNumber: run });
    signal?.addEventListener("abort", () => {
      stop();
      reject(signal.reason);
    });
  });
}
