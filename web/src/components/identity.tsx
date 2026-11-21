"use client";

import type { CSSProperties } from "react";
import type { Address } from "viem";
import { cn } from "cn";
import { useState } from "react";
import { shortAddress } from "~/chain/format";
import { useProfile } from "~/chain/names";

/** Two hues read from the address, so the same account always gets the same gradient. */
function gradientOf(seed: string): CSSProperties {
  const first = Number.parseInt(seed.slice(2, 8), 16) % 360;
  const second = (first + 50 + (Number.parseInt(seed.slice(8, 12), 16) % 130)) % 360;
  return { background: `linear-gradient(135deg, oklch(0.8 0.14 ${first}), oklch(0.62 0.2 ${second}))` };
}

/**
 * A round gradient that stands in for an account, the way wallets show one. In an otherwise
 * neutral interface it is the one spot of colour, and it belongs to the visitor.
 */
export function AddressAvatar({ address, className }: { address: Address; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-6 shrink-0 rounded-full", className)} style={gradientOf(address)} />;
}

/**
 * An account's picture: the avatar of its ENS name when it has one, and its gradient
 * otherwise, or if the avatar fails to load.
 */
export function AccountAvatar({ address, className }: { address: Address; className?: string }) {
  const { avatar } = useProfile(address);
  const [failed, setFailed] = useState<string>();

  if (avatar === undefined || failed === avatar) {
    return <AddressAvatar address={address} className={className} />;
  }
  return (
    // eslint-disable-next-line next/no-img-element -- an image from wherever the name's owner keeps it
    <img src={avatar} alt="" loading="lazy" onError={() => setFailed(avatar)} className={cn("inline-block size-6 shrink-0 rounded-full bg-fill object-cover", className)} />
  );
}

/** What to call an account: its ENS name when it has one, and its shortened address otherwise. */
export function AccountName({ address, className }: { address: Address; className?: string }) {
  const { name } = useProfile(address);
  return <span className={cn(name === undefined && "font-mono", className)} title={address}>{name ?? shortAddress(address)}</span>;
}

/** A token's round badge, drawn from its symbol. */
export function TokenIcon({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground", className)}
    >
      {symbol.slice(0, 1)}
    </span>
  );
}

/** The pill that names the asset an amount is in. */
export function TokenChip({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-background py-1 pr-3 pl-1 text-[15px] font-semibold shadow-[0_0_0_1px_var(--border)]">
      <TokenIcon symbol={symbol} />
      {symbol}
    </span>
  );
}

/** A small green dot, for things that are live. */
export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full bg-success", className)} />;
}
