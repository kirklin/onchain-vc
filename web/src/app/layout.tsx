import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import { createWagmiConfig } from "~/chain/config";
import { ChainProviders } from "~/chain/providers";
import { SiteHeader } from "~/components/site-header";
import { SiteMain } from "~/components/site-main";
import { ThemeProvider } from "~/components/theme-provider";
import { Toaster } from "~/components/ui/sonner";
import { appUrl } from "~/server/env";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "~/styles/global.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return {
    // Links in shared previews, such as a payment link's picture, are made absolute against this.
    metadataBase: appUrl(),
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  const initialState = cookieToInitialState(createWagmiConfig(), (await headers()).get("cookie"));

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <NextIntlClientProvider>
            <ChainProviders initialState={initialState}>
              <SiteHeader />
              <SiteMain>{children}</SiteMain>
              <Toaster position="bottom-right" />
            </ChainProviders>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
