import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Investors } from "~/features/investors/investors";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("investors") };
}

export default function InvestorsPage() {
  return <Investors />;
}
