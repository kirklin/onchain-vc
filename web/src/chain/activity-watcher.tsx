"use client";

import type { Hash } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useChainId, useConfig, useConnection } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { setActivityStatus, useActivity, wasSentHere } from "./activity";
import { trackTransaction } from "./track";

/**
 * Follows each waiting transaction of the connected account until it settles, and records
 * the outcome. Mounted once for the whole app, so it also picks up transactions that were
 * still waiting when the page was last closed.
 */
export function ActivityWatcher() {
  const config = useConfig();
  const chainId = useChainId();
  const { address } = useConnection();
  const activity = useActivity(chainId, address);
  const queryClient = useQueryClient();
  const t = useTranslations("activity");
  const followingRef = useRef(new Map<Hash, AbortController>());

  useEffect(() => {
    if (address === undefined) {
      return;
    }
    const following = followingRef.current;
    const reader = getPublicClient(config, { chainId })!;
    for (const entry of activity) {
      if (entry.status !== "pending" || entry.sender === undefined || following.has(entry.hash)) {
        continue;
      }
      const controller = new AbortController();
      following.set(entry.hash, controller);
      trackTransaction(reader, { hash: entry.hash, ...entry.sender, signal: controller.signal }).then(
        ({ status }) => {
          following.delete(entry.hash);
          setActivityStatus(chainId, address, entry.hash, status);
          void queryClient.invalidateQueries();
          if (!wasSentHere(entry.hash)) {
            toast[status === "confirmed" ? "success" : "info"](t(`settled.${status}`, { title: entry.title }));
          }
        },
        (error) => {
          following.delete(entry.hash);
          if (!controller.signal.aborted) {
            console.error(error);
          }
        },
      );
    }
  }, [activity, address, chainId, config, queryClient, t]);

  // Another account or chain has a list of its own.
  useEffect(() => {
    const controllers = followingRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort(new Error("The connected account or chain changed."));
      }
      controllers.clear();
    };
  }, [address, chainId]);

  return null;
}
