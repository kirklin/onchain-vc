import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { DealPage } from "~/features/deal/deal";

const DEAL_ID = /^[1-9]\d{0,9}$/;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const t = await getTranslations("deal");
  return { title: t("number", { id: (await params).id }) };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!DEAL_ID.test(id)) {
    notFound();
  }
  return <DealPage id={Number(id)} />;
}
