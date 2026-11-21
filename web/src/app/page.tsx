import { getTranslations } from "next-intl/server";
import { PageHeader } from "~/components/page";

export default async function HomePage() {
  const t = await getTranslations("app");
  return <PageHeader title={t("name")} description={t("tagline")} />;
}
