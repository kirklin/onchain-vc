"use client";

import { CheckIcon, ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useChainId, useConnection, useSwitchChain } from "wagmi";
import { enabledNetworks, networkOf } from "~/chain/config";
import { LiveDot } from "~/components/identity";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";

/**
 * Shows the chain the app is set to and lets the visitor pick another. When the wallet sits
 * on a chain the app does not offer, it asks to switch instead.
 */
export function NetworkSwitcher() {
  const t = useTranslations("connect");
  const chainId = useChainId();
  const { chainId: walletChainId, isConnected } = useConnection();
  const { switchChain, isPending } = useSwitchChain();

  const current = networkOf(chainId) ?? enabledNetworks[0]!;

  if (isConnected && walletChainId !== undefined && walletChainId !== chainId) {
    return (
      <Button variant="destructive" disabled={isPending} onClick={() => switchChain({ chainId })}>
        <TriangleAlertIcon />
        {t("switchTo", { network: current.chain.name })}
      </Button>
    );
  }

  const label = (
    <>
      <LiveDot />
      {current.chain.name}
    </>
  );

  if (enabledNetworks.length === 1) {
    return (
      <span className="hidden h-10 items-center gap-2 px-2 text-sm font-semibold text-muted-foreground sm:inline-flex">
        {label}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" disabled={isPending}>
          {label}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-48 rounded-2xl border-0 p-2 shadow-popover">
        {enabledNetworks.map(network => (
          <DropdownMenuItem key={network.name} onSelect={() => switchChain({ chainId: network.chain.id })}>
            {network.chain.name}
            {network.chain.id === chainId && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
