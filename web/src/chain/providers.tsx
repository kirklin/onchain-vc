"use client";

import type { ReactNode } from "react";
import type { State } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { ActivityWatcher } from "./activity-watcher";
import { createWagmiConfig } from "./config";

/** `initialState` comes from the request's cookies, so the first render already knows the connection. */
export function ChainProviders({ children, initialState }: { children: ReactNode; initialState: State | undefined }) {
  const [config] = useState(createWagmiConfig);
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <ActivityWatcher />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
