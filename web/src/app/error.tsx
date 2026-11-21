"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { StateNotice } from "~/components/states";
import { Button } from "~/components/ui/button";

/** Shown in place of a page that threw while rendering. `reset` renders it again. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("states");
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StateNotice
      className="mx-auto mt-10 max-w-md"
      title={t("error")}
      hint={t("errorHint")}
      action={<Button onClick={reset}>{t("retry")}</Button>}
    />
  );
}
