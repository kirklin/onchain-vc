"use client";

import { useTranslations } from "next-intl";
import { countdown, useChainNow } from "~/chain/live";

/** The time left until a moment on the chain's clock, ticking every second. */
export function Countdown({ until }: { until: Date }) {
  const t = useTranslations("common");
  const { days, clock } = countdown(until, useChainNow());

  return (
    <time dateTime={until.toISOString()} className="font-medium text-foreground tabular-nums">
      {days > 0 && `${t("days", { count: days })} `}
      {clock}
    </time>
  );
}
