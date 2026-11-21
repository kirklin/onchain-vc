import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { StateNotice } from "~/components/states";
import { Button } from "~/components/ui/button";

/** Shown for any address that is not a page of the app. */
export default async function NotFound() {
  const t = await getTranslations("states");
  return (
    <StateNotice
      className="mx-auto mt-10 max-w-md"
      title={t("notFound")}
      hint={t("notFoundHint")}
      action={<Button asChild><Link href="/">{t("home")}</Link></Button>}
    />
  );
}
