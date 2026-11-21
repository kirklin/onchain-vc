"use client";

import type { Abi, ContractFunctionArgs, ContractFunctionName, ContractFunctionParameters, Hash, TransactionReceipt } from "viem";
import type { BatchCall } from "./batch";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { BaseError, ContractFunctionRevertedError, InsufficientFundsError, TransactionNotFoundError, UserRejectedRequestError, withRetry } from "viem";
import { estimateContractGas } from "viem/actions";
import { useChainId, useConfig, useConnection } from "wagmi";
import { getConnectorClient, getPublicClient, getTransaction, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { addActivity, markSentHere } from "./activity";
import { BatchRevertedError, sendBatch } from "./batch";
import { networkOf } from "./config";
import { connectionSettled } from "./connection";
import { DEFAULT_GAS_MARGIN_PERCENT } from "./networks";
import { RelayRefusedError } from "./relay";

type Mutability = "nonpayable" | "payable";

interface TransactOptions {
  /** What the transaction does, as the activity list will name it: "Transfer tUSD". */
  title?: string;
  /** Shown once the transaction is confirmed. */
  success?: string;
  /** Messages for the contract's custom errors, keyed by error name. */
  errors?: Record<string, string>;
  /** Set when nothing will ask the user to confirm, as when a session key signs. */
  unprompted?: boolean;
}

/**
 * Runs transactions from wallet prompt to confirmation, narrating each step in one toast
 * and refreshing every on-chain read once they land. Each function resolves with what was
 * confirmed, or with undefined when it did not go through, the reason having been shown.
 *
 * - `write` sends one contract call. It is simulated first, so a call that would revert is
 *   reported by the contract's own error before the wallet is asked for anything.
 * - `batch` sends several calls: as one transaction when the wallet can, one after another
 *   when it cannot. See `sendBatch`.
 * - `transact` takes any function that ends in a transaction hash, for flows that sign or
 *   fetch something first.
 */
export function useTransact() {
  const config = useConfig();
  const chainId = useChainId();
  const { address } = useConnection();
  const queryClient = useQueryClient();
  const t = useTranslations("tx");
  const [pending, setPending] = useState(false);

  /** Adds the transaction to the account's activity, where the watcher follows it from. */
  const record = useCallback(async (hash: Hash, title: string) => {
    if (address === undefined) {
      return;
    }
    markSentHere(hash);
    // A node behind a load balancer may take a moment to know a transaction it was just sent.
    const transaction = await withRetry(() => getTransaction(config, { hash, chainId }), {
      delay: networkOf(chainId)?.chain.blockTime ?? 1000,
      retryCount: 5,
      shouldRetry: ({ error }) => error instanceof TransactionNotFoundError,
    });
    addActivity(chainId, address, {
      hash,
      title,
      submittedAt: Date.now(),
      status: "pending",
      sender: { from: transaction.from, nonce: transaction.nonce },
    });
  }, [config, chainId, address]);

  const run = useCallback(async <Result>(
    work: (onHash: (hash: Hash) => void) => Promise<Result>,
    options: TransactOptions,
  ): Promise<Result | undefined> => {
    setPending(true);
    const id = toast.loading(options.unprompted === true ? t("sending") : t("confirmInWallet"));
    const explorer = networkOf(chainId)?.chain.blockExplorers?.default.url;
    let action: { label: string; onClick: () => void } | undefined;
    try {
      await connectionSettled(config);
      const result = await work((hash) => {
        if (explorer !== undefined) {
          action = { label: t("view"), onClick: () => window.open(`${explorer}/tx/${hash}`, "_blank", "noopener") };
        }
        toast.loading(t("waiting"), { id, action });
        record(hash, options.title ?? t("untitled")).catch(console.error);
      });
      await queryClient.invalidateQueries();
      toast.success(options.success ?? t("confirmed"), { id, action });
      return result;
    } catch (error) {
      console.error(error);
      toast.error(describe(error, t, options.errors), { id, action });
      return undefined;
    } finally {
      setPending(false);
    }
  }, [config, chainId, queryClient, t, record]);

  const transact = useCallback((send: () => Promise<Hash>, options: TransactOptions = {}): Promise<TransactionReceipt | undefined> => {
    return run(async (onHash) => {
      const hash = await send();
      onHash(hash);
      let cancelled = false;
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId,
        // What comes back may be the receipt of a transaction sent to replace this one.
        onReplaced: (replacement) => {
          cancelled = replacement.reason === "cancelled";
        },
      });
      if (cancelled) {
        throw new TransactionCancelledError(hash);
      }
      if (receipt.status !== "success") {
        throw new TransactionRevertedError(hash);
      }
      return receipt;
    }, options);
  }, [run, config, chainId]);

  const write = useCallback(<
    const abi extends Abi,
    functionName extends ContractFunctionName<abi, Mutability>,
    const args extends ContractFunctionArgs<abi, Mutability, functionName>,
  >(
    call: ContractFunctionParameters<abi, Mutability, functionName, args> & { value?: bigint },
    options: TransactOptions = {},
  ): Promise<TransactionReceipt | undefined> => {
    return transact(async () => {
      const [{ request }, estimate] = await Promise.all([
        simulateContract(config, { ...call, account: address, chainId } as never),
        estimateContractGas(getPublicClient(config, { chainId })!, { ...call, account: address } as never),
      ]);
      // The limit is set here, with the chain's own margin, so no wallet pads it further.
      // Some wallets fall back to a very high limit, which a chain that bills the limit charges in full.
      const margin = BigInt(networkOf(chainId)?.gasMarginPercent ?? DEFAULT_GAS_MARGIN_PERCENT);
      // The connected wallet sends it. Naming the account again would make a wallet that
      // signs in the page, like the burner, hand the signing to the node instead.
      const { account: _account, ...unsigned } = request as { account?: unknown };
      return writeContract(config, { ...unsigned, gas: estimate + estimate * margin / 100n } as never);
    }, options);
  }, [transact, config, address, chainId]);

  const batch = useCallback((calls: readonly BatchCall[], options: TransactOptions = {}): Promise<TransactionReceipt[] | undefined> => {
    return run(async (onHash) => {
      const wallet = await getConnectorClient(config, { account: address, chainId });
      return sendBatch({ wallet, reader: getPublicClient(config, { chainId })!, calls, onHash });
    }, options);
  }, [run, config, address, chainId]);

  return { transact, write, batch, pending };
}

/** Thrown when a transaction was included but reverted. */
class TransactionRevertedError extends Error {
  override name = "TransactionRevertedError";

  constructor(hash: Hash) {
    super(`Transaction ${hash} reverted.`);
  }
}

/** Thrown when a transaction was replaced by one that cancels it. */
class TransactionCancelledError extends Error {
  override name = "TransactionCancelledError";

  constructor(hash: Hash) {
    super(`Transaction ${hash} was cancelled.`);
  }
}

/** The revert behind a failed contract call, when a revert is why it failed. */
export function findRevert(error: unknown): ContractFunctionRevertedError | undefined {
  const revert = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : null;
  return revert instanceof ContractFunctionRevertedError ? revert : undefined;
}

function describe(error: unknown, t: ReturnType<typeof useTranslations<"tx">>, custom: Record<string, string> = {}): string {
  if (error instanceof TransactionRevertedError || error instanceof BatchRevertedError) {
    return t("reverted");
  }
  if (error instanceof TransactionCancelledError) {
    return t("cancelled");
  }
  if (error instanceof RelayRefusedError) {
    if (error.reason === "limit") {
      return t("relayLimit");
    }
    if (error.reason === "exhausted") {
      return t("relayExhausted");
    }
    return error.reason === "reverted" ? t("reverted") : t("failed");
  }
  if (!(error instanceof BaseError)) {
    return t("failed");
  }
  if (error.walk(cause => cause instanceof UserRejectedRequestError) !== null) {
    return t("rejected");
  }
  if (error.walk(cause => cause instanceof InsufficientFundsError) !== null) {
    return t("insufficientFunds");
  }
  const revert = findRevert(error);
  if (revert !== undefined) {
    const name = revert.data?.errorName ?? revert.reason;
    if (name !== undefined) {
      return custom[name] ?? t("revertedWith", { reason: name });
    }
    return t("reverted");
  }
  return t("failed");
}
