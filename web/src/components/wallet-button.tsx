"use client";

import type { Address } from "viem";
import type { Connector } from "wagmi";
import { ChevronRightIcon, CopyIcon, DropletsIcon, ExternalLinkIcon, FlameIcon, LogOutIcon, SmartphoneIcon, WalletIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useBalance, useChainId, useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { BURNER_CONNECTOR_ID } from "~/chain/burner/connector";
import { networkOf } from "~/chain/config";
import { useFaucet } from "~/chain/faucet";
import { formatAmount } from "~/chain/format";
import { isWalletlessMobile, metamaskDappLink } from "~/chain/mobile";
import { AccountAvatar, AccountName } from "~/components/identity";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";

export function WalletButton() {
  const { address } = useConnection();
  return address === undefined ? <ConnectDialog /> : <AccountMenu address={address} />;
}

/**
 * Wallets that announce themselves get their own entry. The generic injected connector is
 * only a fallback for wallets that do not, so it is hidden once any wallet has announced itself.
 */
function selectable(connectors: readonly Connector[]): Connector[] {
  const announced = connectors.some(connector => connector.type === "injected" && connector.id !== "injected");
  return connectors.filter(connector => !(announced && connector.id === "injected"));
}

function ConnectDialog() {
  const t = useTranslations("connect");
  const connectors = selectable(useConnectors());
  const { connect, isPending, error, reset } = useConnect();
  const [open, setOpen] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <WalletIcon />
          {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-6 rounded-3xl border-0 bg-popover p-6 shadow-modal sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-heading">{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {connectors.map(connector => (
            <button
              key={connector.uid}
              type="button"
              disabled={isPending}
              onClick={() => connect({ connector }, { onSuccess: () => setOpen(false) })}
              className="group flex items-center gap-3 rounded-xl bg-fill p-3 text-left transition-colors outline-none hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <ConnectorIcon connector={connector} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">{connectorName(connector, t)}</span>
                {connector.id === BURNER_CONNECTOR_ID && (
                  <span className="text-xs text-muted-foreground">{t("burnerHint")}</span>
                )}
              </span>
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          ))}
          {/* A phone's own browser has no wallet in it. This reopens the page inside one. */}
          {open && isWalletlessMobile() && (
            <a
              href={metamaskDappLink(new URL(window.location.href))}
              className="group flex items-center gap-3 rounded-xl bg-fill p-3 transition-colors outline-none hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <SmartphoneIcon className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">{t("openInMetaMask")}</span>
                <span className="text-xs text-muted-foreground">{t("openInMetaMaskHint")}</span>
              </span>
              <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </a>
          )}
        </div>
        {error !== null && <p role="alert" className="text-sm text-destructive">{t("failed")}</p>}
      </DialogContent>
    </Dialog>
  );
}

function connectorName(connector: Connector, t: ReturnType<typeof useTranslations<"connect">>): string {
  if (connector.id === BURNER_CONNECTOR_ID) {
    return t("burner");
  }
  return connector.id === "injected" ? t("browserWallet") : connector.name;
}

function ConnectorIcon({ connector }: { connector: Connector }) {
  if (connector.icon !== undefined) {
    // A data URI supplied by the wallet extension itself.
    // eslint-disable-next-line next/no-img-element
    return <img src={connector.icon} alt="" className="size-10 rounded-lg" />;
  }
  const Icon = connector.id === BURNER_CONNECTOR_ID ? FlameIcon : WalletIcon;
  return (
    <span className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
      <Icon className="size-5" />
    </span>
  );
}

function AccountMenu({ address }: { address: Address }) {
  const t = useTranslations("connect");
  const tCommon = useTranslations("common");
  const chainId = useChainId();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address });
  const faucet = useFaucet();

  const explorer = networkOf(chainId)?.chain.blockExplorers?.default.url;
  const balanceText = balance === undefined ? undefined : `${formatAmount(balance.value, balance.decimals, 3)} ${balance.symbol}`;

  async function copy() {
    await navigator.clipboard.writeText(address);
    toast.success(tCommon("copied"));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-10 items-center gap-2.5 rounded-full bg-fill pr-4 pl-1.5 text-sm font-semibold transition-colors outline-none hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AccountAvatar address={address} className="size-7" />
          <AccountName address={address} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-64 rounded-2xl border-0 p-2 shadow-popover">
        <div className="flex items-center gap-3 px-2 py-3">
          <AccountAvatar address={address} className="size-10" />
          <div className="flex flex-col">
            <AccountName address={address} className="text-sm font-semibold" />
            {balanceText !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{balanceText}</span>}
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={copy}>
          <CopyIcon />
          {t("copyAddress")}
        </DropdownMenuItem>
        {explorer !== undefined && (
          <DropdownMenuItem asChild>
            <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              {tCommon("viewOnExplorer")}
            </a>
          </DropdownMenuItem>
        )}
        {faucet.available && (
          <DropdownMenuItem disabled={faucet.pending} onSelect={faucet.request}>
            <DropletsIcon />
            {t("getTestFunds")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => disconnect()}>
          <LogOutIcon />
          {t("disconnect")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
