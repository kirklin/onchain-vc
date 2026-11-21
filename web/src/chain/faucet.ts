"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useChainId, useConnection } from "wagmi";
import { networkOf } from "./config";
import { formatAmount } from "./format";

interface FaucetResponse {
  status: "funded" | "sufficient" | "limit" | "exhausted";
  amount?: string;
}

/** Asks the server to top up the connected account. `available` is false on chains without a faucet. */
export function useFaucet() {
  const { address } = useConnection();
  const chainId = useChainId();
  const queryClient = useQueryClient();
  const t = useTranslations("faucet");
  const [pending, setPending] = useState(false);

  const network = networkOf(chainId);
  const available = network?.faucet !== undefined && address !== undefined;

  const request = useCallback(async () => {
    if (network === undefined || address === undefined) {
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId, address }),
      });
      if (!response.ok) {
        throw new Error(`Faucet request failed with HTTP ${response.status}.`);
      }
      const result = await response.json() as FaucetResponse;
      if (result.status === "funded") {
        await queryClient.invalidateQueries();
        toast.success(t("funded", { amount: formatAmount(BigInt(result.amount ?? "0")), symbol: network.chain.nativeCurrency.symbol }));
      } else {
        toast.info(t(result.status));
      }
    } catch (error) {
      console.error(error);
      toast.error(t("failed"));
    } finally {
      setPending(false);
    }
  }, [network, address, chainId, queryClient, t]);

  return { available, pending, request };
}
