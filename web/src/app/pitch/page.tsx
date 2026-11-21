import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Pitch } from "~/features/pitch/pitch";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("pitch") };
}

export default function PitchPage() {
  return <Pitch />;
}
