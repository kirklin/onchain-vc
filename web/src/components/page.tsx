"use client";

import type { ComponentProps, ReactNode } from "react";
import type { ContractName } from "~/chain/contracts";
import { cn } from "cn";
import { WalletIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useChainId } from "wagmi";
import { networkOf } from "~/chain/config";
import { ensEnabled } from "~/chain/names";
import { TokenChip } from "./identity";

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mt-4 mb-10 flex flex-col gap-2">
      <h1 className="text-title">{title}</h1>
      {description !== undefined && <p className="max-w-2xl text-[17px] text-muted-foreground">{description}</p>}
    </div>
  );
}

/** The bordered panel each example lives in. */
export function Section({ title, description, action, className, children }: {
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-6 surface p-5 sm:p-6", className)}>
      {title !== undefined && (
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-heading">{title}</h2>
            {description !== undefined && <p className="text-[15px] text-muted-foreground">{description}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
    </div>
  );
}

/** A labelled recessed row holding one input. */
export function Field({ label, htmlFor, trailing, children }: { label: string; htmlFor: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 well px-4 py-3">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <label htmlFor={htmlFor}>{label}</label>
        {trailing}
      </div>
      {children}
    </div>
  );
}

/** A text button for the `trailing` slot of a field, such as one that fills in the whole balance. */
export function FieldAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="font-semibold text-foreground underline-offset-4 hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}

const bareInput = "w-full min-w-0 bg-transparent outline-none placeholder:text-faint-foreground/70";

/**
 * The large number field of a transfer, with the asset named beside it. Pass `chip` to put
 * something else there, such as a button that changes the asset.
 */
export function AmountInput({ symbol, chip, className, ...props }: ComponentProps<"input"> & { symbol: string; chip?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <input
        inputMode="decimal"
        autoComplete="off"
        placeholder="0"
        className={cn(bareInput, "text-4xl font-semibold tracking-[-0.03em] tabular-nums", className)}
        {...props}
      />
      {chip ?? <TokenChip symbol={symbol} />}
    </div>
  );
}

/** Where a recipient is typed: an address, or a name on apps that look ENS names up. */
export function AddressInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      placeholder={ensEnabled ? "0x… / name.eth" : "0x…"}
      className={cn(bareInput, "font-mono text-base", className)}
      {...props}
    />
  );
}

export function FormError({ children }: { children: ReactNode }) {
  return <p role="alert" className="text-sm text-destructive">{children}</p>;
}

/** Shown in place of a page's content when its contract has no address on the current chain. */
export function NotDeployed({ name }: { name: ContractName }) {
  const t = useTranslations("common");
  const network = networkOf(useChainId())?.chain.name ?? "";

  return (
    <div className="rounded-2xl bg-fill p-10 text-center">
      <p className="font-medium">{t("notDeployed", { name, network })}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t("notDeployedHint")}</p>
    </div>
  );
}

export function ConnectHint() {
  const t = useTranslations("common");
  return (
    <p className="flex items-center gap-2 rounded-xl bg-fill px-4 py-3 text-[15px] text-muted-foreground">
      <WalletIcon className="size-4" />
      {t("connectFirst")}
    </p>
  );
}
