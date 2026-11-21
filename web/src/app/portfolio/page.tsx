import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Portfolio } from "~/features/portfolio/portfolio";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("portfolio") };
}

export default function PortfolioPage() {
  return <Portfolio />;
}
