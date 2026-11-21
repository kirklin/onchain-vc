"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { NetworkSwitcher } from "./network-switcher";
import { SettingsMenu } from "./settings-menu";
import { WalletButton } from "./wallet-button";

export function SiteHeader() {
  const t = useTranslations();

  return (
    <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-18 w-full max-w-6xl items-center gap-8 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight whitespace-nowrap">
          <Logo />
          {t("app.name")}
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <NetworkSwitcher />
          <WalletButton />
          <SettingsMenu />
        </div>
      </div>
    </header>
  );
}

/** Four seats around a table, in the solid inverse colour. */
function Logo() {
  return (
    <svg aria-hidden viewBox="0 0 28 28" className="size-7">
      <rect width="28" height="28" rx="8" fill="var(--primary)" />
      <rect x="10" y="10" width="8" height="8" rx="2" fill="var(--primary-foreground)" />
      <circle cx="14" cy="6.5" r="1.75" fill="var(--primary-foreground)" />
      <circle cx="14" cy="21.5" r="1.75" fill="var(--primary-foreground)" />
      <circle cx="6.5" cy="14" r="1.75" fill="var(--primary-foreground)" />
      <circle cx="21.5" cy="14" r="1.75" fill="var(--primary-foreground)" />
    </svg>
  );
}
