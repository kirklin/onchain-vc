import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Room } from "~/features/room/room";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("screen") };
}

/** The meeting room for a projector: no site header, larger type, the pitch code always in view. */
export default function ScreenPage() {
  return <Room variant="screen" />;
}
