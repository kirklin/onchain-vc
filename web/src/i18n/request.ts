import type { Locale } from "./locales";
import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { defaultLocale, isLocale, LOCALE_COOKIE, locales } from "./locales";

/** The visitor's saved choice, else the first supported language their browser asks for. */
async function resolveLocale(): Promise<Locale> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) {
    return saved;
  }

  const accepted = (await headers()).get("accept-language") ?? "";
  for (const entry of accepted.split(",")) {
    const language = entry.split(";")[0]!.trim().toLowerCase().split("-")[0];
    const match = locales.find(locale => locale === language);
    if (match !== undefined) {
      return match;
    }
  }
  return defaultLocale;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
