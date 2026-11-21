"use client";

import { useEffect } from "react";
import { useConnect, useConnection, useConnectors } from "wagmi";
import { burnerAvailable } from "../config";
import { BURNER_CONNECTOR_ID } from "./connector";

/** Connects the in-browser wallet on its own, for visitors who arrive without one. */
export function useAutoConnect() {
  const { status } = useConnection();
  const connectors = useConnectors();
  const { connect } = useConnect();
  useEffect(() => {
    const burner = connectors.find(connector => connector.id === BURNER_CONNECTOR_ID);
    const hasWallet = typeof window !== "undefined" && "ethereum" in window;
    if (status === "disconnected" && burnerAvailable && burner !== undefined && !hasWallet) {
      connect({ connector: burner });
    }
  }, [status, connectors, connect]);
}
