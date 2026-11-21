"use client";

import type { Locale } from "~/i18n/locales";
import { CheckIcon, SettingsIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { setLocale } from "~/i18n/actions";
import { locales } from "~/i18n/locales";

const THEMES = ["light", "dark", "system"] as const;
const LANGUAGE_NAMES: Record<Locale, string> = { en: "English", zh: "简体中文" };

export function SettingsMenu() {
  const t = useTranslations("settings");
  const { theme, setTheme } = useTheme();
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  function changeLocale(next: Locale) {
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("label")}>
          <SettingsIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-48 rounded-2xl border-0 p-2 shadow-popover">
        <DropdownMenuLabel>{t("theme")}</DropdownMenuLabel>
        {THEMES.map(option => (
          <DropdownMenuItem key={option} onSelect={() => setTheme(option)}>
            {t(option)}
            {theme === option && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("language")}</DropdownMenuLabel>
        {locales.map(option => (
          <DropdownMenuItem key={option} onSelect={() => changeLocale(option)}>
            {LANGUAGE_NAMES[option]}
            {locale === option && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
