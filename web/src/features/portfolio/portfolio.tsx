"use client";

import type { StageKey } from "~/chain/committee";
import type { Deal } from "~/chain/deals";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { useDeployment } from "~/chain/contracts";
import { useBallots, useDeals } from "~/chain/deals";
import { useChainNow } from "~/chain/live";
import { Money, StageBadge, VoteDots } from "~/components/committee";
import { AccountAvatar, AccountName } from "~/components/identity";
import { NotDeployed, PageHeader, Stat } from "~/components/page";
import { StateNotice } from "~/components/states";
import { Segmented } from "~/components/ui/segmented";

const FILTERS = {
  all: undefined,
  reviewing: ["review", "approved", "offered", "milestone"],
  backed: ["funded", "milestone", "completed"],
  declined: ["rejected", "vetoed", "expired"],
} as const satisfies Record<string, readonly StageKey[] | undefined>;
type Filter = keyof typeof FILTERS;

export function Portfolio() {
  const t = useTranslations("portfolio");
  const committee = useDeployment("Committee");
  const { deals, loading } = useDeals();
  const [filter, setFilter] = useState<Filter>("all");

  if (committee === undefined) {
    return <NotDeployed name="Committee" />;
  }

  const stages = FILTERS[filter] as readonly StageKey[] | undefined;
  const shown = (deals ?? []).filter(deal => stages === undefined || stages.includes(deal.stage));
  const backed = (deals ?? []).filter(deal => deal.paid > 0n);
  const decided = (deals ?? []).filter(deal => deal.stage !== "review" && deal.stage !== "expired");
  const approved = decided.filter(deal => deal.stage !== "rejected");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("title")} description={t("description")} />
      <section className="grid grid-cols-2 gap-6 border-y py-6 sm:grid-cols-4">
        <Stat label={t("pitches")} value={deals?.length ?? "…"} />
        <Stat label={t("backed")} value={backed.length} />
        <Stat label={t("approvalRate")} value={decided.length === 0 ? "—" : `${Math.round(approved.length / decided.length * 100)}%`} />
        <Stat label={t("paidOut")} value={<Money value={backed.reduce((sum, deal) => sum + deal.paid, 0n)} />} />
      </section>
      <Segmented
        value={filter}
        onValueChange={value => setFilter(value as Filter)}
        options={(Object.keys(FILTERS) as Filter[]).map(key => ({ value: key, label: t(`filters.${key}`) }))}
        aria-label={t("filter")}
      />
      {shown.length === 0
        ? <StateNotice title={loading ? t("loading") : t("empty")} />
        : (
            <ul className="flex flex-col divide-y border-y" data-testid="deals">
              {shown.map(deal => <DealRow key={deal.id} deal={deal} />)}
            </ul>
          )}
    </div>
  );
}

function DealRow({ deal }: { deal: Deal }) {
  const t = useTranslations("portfolio");
  const format = useFormatter();
  // Deals are stamped with the chain's time, so that is what their age is measured against.
  const now = useChainNow();
  const ballots = useBallots(deal.id, 0);
  const progress = deal.amount === 0n ? 0 : Number(deal.paid * 100n / deal.amount);
  return (
    <li>
      <Link href={`/deals/${deal.id}`} className="grid grid-cols-1 gap-3 py-5 transition-colors hover:bg-fill/50 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground tabular-nums">{`#${deal.id}`}</span>
            <span className="truncate text-[17px] font-semibold">{deal.name}</span>
            <StageBadge stage={deal.stage} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <AccountAvatar address={deal.founder} className="size-4" />
              <AccountName address={deal.founder} />
            </span>
            <span>{format.relativeTime(deal.pitchedAt, now)}</span>
            <VoteDots ballots={ballots} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5 sm:items-end">
          <span className="text-[15px]">
            {deal.amount > 0n ? t("invested") : t("asked")}
            {" "}
            <Money value={deal.amount > 0n ? deal.amount : deal.ask} className="font-semibold" />
          </span>
          {deal.amount > 0n && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="h-1.5 w-28 overflow-hidden rounded-full bg-fill">
                <span className="block h-full rounded-full bg-foreground" style={{ width: `${progress}%` }} />
              </span>
              {t("paidShare", { percent: progress })}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}
