"use client";

import { cn } from "cn";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isFullScreen } from "./full-screen";
import { NAV_LINKS } from "./nav";
import { NetworkSwitcher } from "./network-switcher";
import { SettingsMenu } from "./settings-menu";
import { WalletButton } from "./wallet-button";

function isActive(pathname: string, href: string): boolean {
  return pathname.startsWith(href) || (href === "/portfolio" && pathname.startsWith("/deals"));
}

export function SiteHeader() {
  const t = useTranslations();
  const pathname = usePathname();
  if (isFullScreen(pathname)) {
    return null;
  }

  const links = NAV_LINKS.map(link => (
    <NavLink key={link.href} href={link.href} active={isActive(pathname, link.href)}>
      {t(`nav.${link.key}`)}
    </NavLink>
  ));

  return (
    <header className="sticky top-0 z-40 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-18 w-full max-w-6xl items-center gap-8 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight whitespace-nowrap">
          <Logo />
          {t("app.name")}
        </Link>
        <nav className="hidden items-center gap-1 lg:flex">{links}</nav>
        <div className="ml-auto flex items-center gap-2">
          <NetworkSwitcher />
          <WalletButton />
          <SettingsMenu />
        </div>
      </div>
      <nav className="flex items-center gap-1 overflow-x-auto px-4 pb-3 lg:hidden">{links}</nav>
    </header>
  );
}

/** Four seats around a table, in the solid inverse colour. */
export function Logo() {
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

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-full px-3.5 py-2 text-[15px] font-semibold whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
        active && "bg-fill text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
