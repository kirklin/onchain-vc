import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Join } from "~/features/join/join";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("join");
  return { title: t("title") };
}

export default function JoinPage() {
  return <Join />;
}
