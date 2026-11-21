"use server";

import type { Locale } from "./locales";
import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE } from "./locales";

const ONE_YEAR = 60 * 60 * 24 * 365;

export async function setLocale(locale: Locale) {
  if (!isLocale(locale)) {
    throw new Error(`Unsupported locale "${String(locale)}".`);
  }
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
}
