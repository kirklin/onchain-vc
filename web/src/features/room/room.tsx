"use client";

import type { Note } from "~/chain/committee";
import type { Deal, Meeting } from "~/chain/deals";
import { cn } from "cn";
import { ArrowRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { ROLES } from "~/chain/committee";
import { useBallots, useDeals, useDocument, useFund, useMeetings, useNotes } from "~/chain/deals";
import { Money, PartnerPanel, PhaseLine, StageBadge, TransactionLink, VoteDots } from "~/components/committee";
import { AccountAvatar, AccountName } from "~/components/identity";
import { QrCode } from "~/components/qr-code";
import { StateNotice } from "~/components/states";
import { Button } from "~/components/ui/button";

type Variant = "page" | "screen";

const subscribeNothing = () => () => {};

/** This site's address as the visitor's browser sees it. Empty while rendering on the server. */
function useOrigin(): string {
  return useSyncExternalStore(subscribeNothing, () => window.location.origin, () => "");
}

/**
 * The committee's table. It follows whichever meeting is on, and otherwise shows the latest
 * pitch and how it was decided. `screen` is the version for a projector: larger, and with
 * the code that opens the pitch page always in view.
 */
export function Room({ variant = "page" }: { variant?: Variant }) {
  const t = useTranslations("room");
  const { deals, loading } = useDeals();
  const { meetings } = useMeetings();

  // The meeting under way the longest, or else the newest pitch.
  const focus = useMemo(() => {
    const active = [...meetings.values()].filter(meeting => meeting.phase !== null).map(meeting => meeting.dealId).sort((left, right) => left - right);
    const id = active[0] ?? deals?.[0]?.id;
    return deals?.find(deal => deal.id === id);
  }, [meetings, deals]);

  const screen = variant === "screen";

  return (
    <div className={cn("grid grid-cols-1 gap-6", screen ? "min-h-dvh p-8 lg:grid-cols-[1fr_380px] lg:gap-8" : "lg:grid-cols-[1fr_340px]")}>
      <section className="flex min-w-0 flex-col gap-6">
        <RoomTitle screen={screen} />
        {focus === undefined
          ? (
              <StateNotice
                title={loading ? t("loading") : t("empty")}
                hint={loading ? undefined : t("emptyHint")}
                className="py-24"
                action={loading || screen ? undefined : <Button asChild><Link href="/pitch">{t("pitchNow")}</Link></Button>}
              />
            )
          : <Table deal={focus} live={meetings.get(focus.id)} variant={variant} />}
      </section>
      <aside className="flex min-w-0 flex-col gap-6">
        <PitchCode variant={variant} />
        <FundFacts deals={deals} />
        <Queue deals={deals} focus={focus?.id} />
        <Recent deals={deals} focus={focus?.id} />
      </aside>
    </div>
  );
}

function RoomTitle({ screen }: { screen: boolean }) {
  const t = useTranslations();
  return (
    <header className={cn("flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1", !screen && "mt-4")}>
      <h1 className={screen ? "text-title" : "text-heading"}>{screen ? t("app.name") : t("nav.room")}</h1>
      <p className={cn("text-muted-foreground", screen ? "text-lg" : "text-[15px]")}>{t("app.tagline")}</p>
    </header>
  );
}

function mergeNotes(stored: Note[] | undefined, live: Meeting | undefined): Note[] {
  const notes = new Map<string, Note>();
  for (const note of [...(stored ?? []), ...(live?.notes ?? [])]) {
    notes.set(`${note.round}:${note.phase}:${note.role}`, note);
  }
  return [...notes.values()];
}

/** The deal at the table: who pitched what, what each partner says, and what came of it. */
function Table({ deal, live, variant }: { deal: Deal; live: Meeting | undefined; variant: Variant }) {
  const t = useTranslations("room");
  const { data: stored } = useNotes(deal.id);
  const { data: pitch } = useDocument<{ summary: string }>(deal.pitchUri);
  const notes = mergeNotes(stored, live);
  const round = live?.round ?? deal.round;
  const ballots = useBallots(deal.id, round);
  const meeting: Meeting = { dealId: deal.id, round, phase: live?.phase ?? null, notes, live: live?.live ?? [] };
  const terms = notes.find(note => note.phase === "terms");
  const drafting = live?.live.find(item => item.phase === "terms");
  const screen = variant === "screen";

  return (
    <div className="flex flex-col gap-6" data-testid="table" data-deal={deal.id}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{t("dealNumber", { id: deal.id })}</span>
          <StageBadge stage={deal.stage} />
          <VoteDots ballots={ballots} />
          {live?.phase !== null && live?.phase !== undefined && <PhaseLine phase={live.phase} />}
          {round > 0 && <span>{t("milestoneRound", { round })}</span>}
        </div>
        <Link href={`/deals/${deal.id}`} className="group flex items-center gap-2">
          <h2 className={cn("font-semibold tracking-tight break-all", screen ? "text-5xl" : "text-3xl")}>{deal.name}</h2>
          {!screen && <ArrowRightIcon className="size-6 text-muted-foreground transition-transform group-hover:translate-x-1" />}
        </Link>
        {pitch?.summary !== undefined && <p className={cn("max-w-3xl text-muted-foreground", screen ? "text-xl" : "text-lg")}>{pitch.summary}</p>}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[15px]">
          <span className="flex items-center gap-2">
            <AccountAvatar address={deal.founder} className="size-5" />
            <AccountName address={deal.founder} />
          </span>
          <span>
            {t("ask")}
            {" "}
            <Money value={deal.ask} className="font-semibold" />
          </span>
          {deal.amount > 0n && (
            <span>
              {t("invested")}
              {" "}
              <Money value={deal.amount} className="font-semibold" />
            </span>
          )}
        </div>
      </header>

      <div className={cn("grid grid-cols-1 gap-4", screen ? "xl:grid-cols-2" : "md:grid-cols-2")}>
        {ROLES.map((role, seat) => <PartnerPanel key={role} role={role} round={round} meeting={meeting} ballot={ballots?.[seat]} size={screen ? "screen" : "default"} />)}
      </div>

      {(terms !== undefined || drafting !== undefined) && round === 0 && (
        <TermsCard note={terms} drafting={drafting?.text} />
      )}
      <Outcome deal={deal} />
    </div>
  );
}

function TermsCard({ note, drafting }: { note: Note | undefined; drafting: string | undefined }) {
  const t = useTranslations("room");
  const fund = useFund();
  const terms = note?.terms ?? null;
  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-fill p-5" data-testid="terms">
      <h3 className="text-heading">{t("terms")}</h3>
      {terms === null
        ? <p className="text-[15px] leading-relaxed">{drafting}</p>
        : (
            <>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Fact label={t("termsAmount")}>{`${terms.amount} ${fund?.symbol ?? ""}`}</Fact>
                <Fact label={t("firstTranche")}>{`${terms.firstTranchePercent}%`}</Fact>
                <Fact label={t("secondTranche")}>{`${100 - terms.firstTranchePercent}%`}</Fact>
                <Fact label={t("deadline")}>{t("days", { days: terms.milestoneDays })}</Fact>
              </dl>
              <p className="text-[15px] leading-relaxed">
                <span className="font-semibold">{t("milestone")}</span>
                {terms.milestone}
              </p>
              <p className="text-[15px] leading-relaxed text-muted-foreground">{note!.text}</p>
              {note!.transactionHash !== null && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  {t("termsOnChain")}
                  <TransactionLink hash={note!.transactionHash} />
                </p>
              )}
            </>
          )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

/** What came of the deal, once something has. */
function Outcome({ deal }: { deal: Deal }) {
  const t = useTranslations("room");
  if (deal.stage === "review" || deal.stage === "milestone" || deal.stage === "approved") {
    return null;
  }
  return (
    <p
      data-testid="outcome"
      className={cn(
        "rounded-2xl px-5 py-4 text-lg font-semibold",
        deal.stage === "vetoed" || deal.stage === "rejected" ? "bg-destructive-fill text-destructive" : "bg-success-fill text-success",
        deal.stage === "expired" && "bg-fill text-muted-foreground",
      )}
    >
      {deal.stage === "offered" && t("outcome.offered")}
      {(deal.stage === "funded" || deal.stage === "completed") && (
        <>
          {t("outcome.paid")}
          {" "}
          <Money value={deal.paid} />
        </>
      )}
      {deal.stage === "rejected" && t("outcome.rejected")}
      {deal.stage === "vetoed" && t("outcome.vetoed")}
      {deal.stage === "expired" && t("outcome.expired")}
    </p>
  );
}

/** The code a phone scans to open the pitch page. */
function PitchCode({ variant }: { variant: Variant }) {
  const t = useTranslations("room");
  const origin = useOrigin();
  const url = `${origin}/pitch`;
  return (
    <section className={cn("flex flex-col items-center gap-4 surface p-6 text-center", variant === "page" && "hidden lg:flex")}>
      <h2 className="text-heading">{t("scanToPitch")}</h2>
      {origin === "" ? <div className="aspect-square w-full max-w-60 rounded-xl bg-fill" /> : <QrCode value={url} label={t("scanToPitch")} className="w-full max-w-60" />}
      <p className="font-mono text-sm break-all text-muted-foreground">{url}</p>
    </section>
  );
}

function FundFacts({ deals }: { deals: Deal[] | undefined }) {
  const t = useTranslations("room");
  const fund = useFund();
  const invested = deals?.reduce((sum, deal) => sum + deal.paid, 0n) ?? 0n;
  const backed = deals?.filter(deal => ["offered", "funded", "milestone", "completed"].includes(deal.stage)).length ?? 0;
  return (
    <section className="grid grid-cols-2 gap-5 surface p-5">
      <Fact label={t("available")}>{fund === undefined ? "…" : <Money value={fund.available} />}</Fact>
      <Fact label={t("paidOut")}><Money value={invested} /></Fact>
      <Fact label={t("pitches")}>{deals?.length ?? "…"}</Fact>
      <Fact label={t("backed")}>{backed}</Fact>
    </section>
  );
}

function Queue({ deals, focus }: { deals: Deal[] | undefined; focus: number | undefined }) {
  const t = useTranslations("room");
  const waiting = (deals ?? []).filter(deal => deal.id !== focus && (deal.stage === "review" || deal.stage === "milestone")).reverse();
  if (waiting.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">{t("queue", { count: waiting.length })}</h2>
      <ul className="flex flex-col divide-y border-y">
        {waiting.slice(0, 6).map(deal => <DealRow key={deal.id} deal={deal} />)}
      </ul>
    </section>
  );
}

function Recent({ deals, focus }: { deals: Deal[] | undefined; focus: number | undefined }) {
  const t = useTranslations("room");
  const decided = (deals ?? []).filter(deal => deal.id !== focus && deal.stage !== "review");
  if (decided.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground">{t("recent")}</h2>
      <ul className="flex flex-col divide-y border-y">
        {decided.slice(0, 6).map(deal => <DealRow key={deal.id} deal={deal} />)}
      </ul>
    </section>
  );
}

function DealRow({ deal }: { deal: Deal }) {
  return (
    <li>
      <Link href={`/deals/${deal.id}`} className="flex items-center justify-between gap-3 py-3 transition-colors hover:text-muted-foreground">
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-semibold">{deal.name}</span>
          <Money value={deal.amount > 0n ? deal.amount : deal.ask} className="text-sm text-muted-foreground" />
        </span>
        <StageBadge stage={deal.stage} />
      </Link>
    </li>
  );
}
