import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Room } from "~/features/room/room";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("room") };
}

export default function RoomPage() {
  return <Room />;
}
