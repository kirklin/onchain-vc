import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Partners } from "~/features/partners/partners";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("partners") };
}

export default function PartnersPage() {
  return <Partners />;
}
