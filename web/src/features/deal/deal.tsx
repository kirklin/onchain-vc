"use client";

import type { FormEvent } from "react";
import type { Address } from "viem";
import type { MilestoneDocument, Note, PitchDocument } from "~/chain/committee";
import type { Deal, Meeting } from "~/chain/deals";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useChainId, useConfig, useConnection, useReadContract } from "wagmi";
import { writeContract } from "wagmi/actions";
import { DEAL_EVENTS, ROLES } from "~/chain/committee";
import { networkOf } from "~/chain/config";
import { useDeployment } from "~/chain/contracts";
import { storeDocument, useBallots, useDeal, useDocument, useEvents, useMeetings, useNotes } from "~/chain/deals";
import { shortAddress } from "~/chain/format";
import { useChainNow } from "~/chain/live";
import { useRelay } from "~/chain/relay";
import { findRevert, useTransact } from "~/chain/transact";
import { EventText, Money, PartnerPanel, PhaseLine, StageBadge, TransactionLink, VoteDots } from "~/components/committee";
import { Countdown } from "~/components/countdown";
import { AccountAvatar, AccountName } from "~/components/identity";
import { Field, FormError, NotDeployed, Section } from "~/components/page";
import { LoadFailed, StateNotice } from "~/components/states";
import { Button } from "~/components/ui/button";

export function DealPage({ id }: { id: number }) {
  const t = useTranslations("deal");
  const tStates = useTranslations("states");
  const committee = useDeployment("Committee");
  const { deal, error, loading, refetch } = useDeal(id);

  if (committee === undefined) {
    return <NotDeployed name="Committee" />;
  }
  if (deal === undefined) {
    // The committee reverts for a deal it does not have. Any other failure is worth another try.
    if (error !== null && findRevert(error) === undefined) {
      return <LoadFailed title={tStates("loadFailed")} retry={tStates("retry")} onRetry={() => void refetch()} />;
    }
    return <StateNotice className="mx-auto mt-10 max-w-md" title={loading ? t("loading") : t("notFound")} hint={loading ? undefined : t("notFoundHint")} />;
  }
  return <DealView deal={deal} />;
}

function mergeNotes(stored: Note[] | undefined, live: Meeting | undefined): Note[] {
  const notes = new Map<string, Note>();
  for (const note of [...(stored ?? []), ...(live?.notes ?? [])]) {
    notes.set(`${note.round}:${note.phase}:${note.role}`, note);
  }
  return [...notes.values()];
}

function DealView({ deal }: { deal: Deal }) {
  const t = useTranslations("deal");
  const { address } = useConnection();
  const { meetings } = useMeetings(deal.id);
  const { data: stored } = useNotes(deal.id);
  const { data: pitch } = useDocument<PitchDocument>(deal.pitchUri);
  const live = meetings.get(deal.id);
  const notes = mergeNotes(stored, live);
  const isFounder = address !== undefined && address === deal.founder;
  const rounds = Array.from({ length: deal.round }, (_, index) => deal.round - index);

  return (
    <div className="flex flex-col gap-10" data-testid="deal" data-stage={deal.stage}>
      <header className="mt-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{t("number", { id: deal.id })}</span>
          <StageBadge stage={deal.stage} />
          {live?.phase !== null && live?.phase !== undefined && <PhaseLine phase={live.phase} />}
        </div>
        <h1 className="text-title break-all">{deal.name}</h1>
        {pitch !== undefined && <p className="max-w-2xl text-lg text-muted-foreground">{pitch.summary}</p>}
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 border-y py-5 sm:grid-cols-4">
          <Fact label={t("founder")}>
            <span className="flex items-center gap-2">
              <AccountAvatar address={deal.founder} className="size-5" />
              <AccountName address={deal.founder} />
            </span>
          </Fact>
          <Fact label={t("project")}><AddressLink address={deal.project} /></Fact>
          <Fact label={t("ask")}><Money value={deal.ask} /></Fact>
          <Fact label={t("paid")}><Money value={deal.paid} /></Fact>
        </dl>
        {pitch !== undefined && (pitch.description !== "" || pitch.links.length > 0) && (
          <div className="flex max-w-3xl flex-col gap-2">
            {pitch.description !== "" && <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{pitch.description}</p>}
            {pitch.links.map(link => <a key={link} href={link} target="_blank" rel="noreferrer nofollow" className="w-fit text-sm break-all text-link underline-offset-4 hover:underline">{link}</a>)}
          </div>
        )}
      </header>

      {isFounder && <FounderActions deal={deal} notes={notes} />}

      {rounds.map(round => <MilestoneRound key={round} deal={deal} round={round} notes={notes} live={live} />)}

      <Round deal={deal} round={0} title={t("decision")} meeting={{ dealId: deal.id, round: live?.round ?? 0, phase: live?.phase ?? null, notes, live: live?.live ?? [] }} />

      <Terms deal={deal} notes={notes} live={live} />
      <Timeline deal={deal} />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="truncate text-[17px] font-semibold">{children}</dd>
    </div>
  );
}

function AddressLink({ address }: { address: Address }) {
  const explorer = networkOf(useChainId())?.chain.blockExplorers?.default.url;
  return explorer === undefined
    ? <span className="font-mono" title={address}>{shortAddress(address)}</span>
    : <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" className="font-mono underline-offset-4 hover:underline" title={address}>{shortAddress(address)}</a>;
}

/** One round of votes: on the pitch, or on a milestone report, with what came before the panels. */
function Round({ deal, round, title, meeting, children }: { deal: Deal; round: number; title: string; meeting: Meeting; children?: React.ReactNode }) {
  const ballots = useBallots(deal.id, round);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-heading">{title}</h2>
        <VoteDots ballots={ballots} />
      </div>
      {children}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {ROLES.map((role, seat) => <PartnerPanel key={role} role={role} round={round} meeting={meeting} ballot={ballots?.[seat]} />)}
      </div>
    </section>
  );
}

function Terms({ deal, notes, live }: { deal: Deal; notes: Note[]; live: Meeting | undefined }) {
  const t = useTranslations("deal");
  const note = notes.find(item => item.phase === "terms");
  const drafting = live?.live.find(item => item.phase === "terms");
  if (note === undefined && drafting === undefined) {
    return null;
  }
  const terms = note?.terms ?? null;
  return (
    <Section title={t("terms")} description={terms === null ? t("drafting") : undefined}>
      {terms === null
        ? <p className="text-[15px] leading-relaxed">{drafting?.text}</p>
        : (
            <div className="flex flex-col gap-4" data-testid="terms">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Fact label={t("amount")}><Money value={deal.amount} /></Fact>
                <Fact label={t("firstTranche")}>{`${terms.firstTranchePercent}%`}</Fact>
                <Fact label={t("secondTranche")}>{`${100 - terms.firstTranchePercent}%`}</Fact>
                <Fact label={t("milestoneDays")}>{t("days", { days: terms.milestoneDays })}</Fact>
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
            </div>
          )}
    </Section>
  );
}

/** What the founder can do next: accept the terms, report the milestone, and see the badge. */
function FounderActions({ deal, notes }: { deal: Deal; notes: Note[] }) {
  const t = useTranslations("deal");
  const now = useChainNow();
  const badge = useDeployment("PortfolioBadge");
  const { data: tokenUri } = useReadContract(badge === undefined || deal.paid === 0n ? undefined : { ...badge, functionName: "tokenURI", args: [BigInt(deal.id)] });
  const terms = notes.find(note => note.phase === "terms")?.terms ?? null;

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-fill p-5 sm:p-6" data-testid="founder">
      {deal.stage === "review" && <p className="text-[17px] font-medium">{t("founderReview")}</p>}
      {deal.stage === "approved" && <p className="text-[17px] font-medium">{t("founderApproved")}</p>}
      {deal.stage === "rejected" && <p className="text-[17px] font-medium">{t("founderRejected")}</p>}
      {deal.stage === "offered" && (
        <AcceptTerms deal={deal} terms={terms} expired={deal.deadline < now} />
      )}
      {(deal.stage === "funded" || deal.stage === "milestone" || deal.stage === "completed") && (
        <p className="text-[17px] font-medium">
          {t("received")}
          {" "}
          <Money value={deal.paid} />
        </p>
      )}
      {deal.stage === "funded" && deal.milestoneDue !== undefined && deal.milestoneDue > now && <ReportMilestone deal={deal} />}
      {deal.stage === "milestone" && <p className="text-[15px] text-muted-foreground">{t("founderMilestone")}</p>}
      {deal.stage === "vetoed" && <p className="text-[17px] font-medium text-destructive">{t("founderVetoed")}</p>}
      {deal.stage === "expired" && <p className="text-[17px] font-medium">{t("founderExpired")}</p>}
      {tokenUri !== undefined && <BadgeImage uri={tokenUri} />}
    </section>
  );
}

function AcceptTerms({ deal, terms, expired }: { deal: Deal; terms: { firstTranchePercent: number } | null; expired: boolean }) {
  const t = useTranslations("deal");
  const config = useConfig();
  const committee = useDeployment("Committee")!;
  const { address } = useConnection();
  const { transact, pending } = useTransact();
  const { available: relayed, relay } = useRelay();
  const first = deal.amount * BigInt(deal.firstTrancheBps) / 10_000n;

  async function accept() {
    const call = { ...committee, functionName: "accept", args: [BigInt(deal.id)] } as const;
    await transact(
      () => (relayed ? relay(call, { from: address! }) : writeContract(config, call)),
      { title: t("acceptTitle"), success: t("accepted"), errors: { DeadlinePassed: t("offerExpired") }, unprompted: relayed },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[17px] font-medium">
        {t("offer")}
        {" "}
        <Money value={deal.amount} className="font-semibold" />
        {terms !== null && t("offerFirst", { percent: terms.firstTranchePercent })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t.rich("acceptWithin", { countdown: () => <Countdown until={deal.deadline} /> })}
      </p>
      <Button size="lg" disabled={pending || expired} onClick={accept}>
        {t("accept")}
        {" · "}
        <Money value={first} />
      </Button>
    </div>
  );
}

function BadgeImage({ uri }: { uri: string }) {
  const t = useTranslations("deal");
  const json = JSON.parse(atob(uri.slice("data:application/json;base64,".length))) as { name: string; image: string };
  return (
    <figure className="flex items-center gap-4 border-t pt-4">
      {/* eslint-disable-next-line next/no-img-element -- an SVG the badge contract draws on chain */}
      <img src={json.image} alt={json.name} className="size-28 rounded-2xl" />
      <figcaption className="flex flex-col gap-1">
        <span className="font-semibold">{t("badge")}</span>
        <span className="text-sm text-muted-foreground">{t("badgeHint")}</span>
      </figcaption>
    </figure>
  );
}

function ReportMilestone({ deal }: { deal: Deal }) {
  const t = useTranslations("deal");
  const id = useId();
  const ids = { summary: `${id}summary`, links: `${id}links` };
  const config = useConfig();
  const committee = useDeployment("Committee")!;
  const { address } = useConnection();
  const { transact, pending } = useTransact();
  const { available: relayed, relay } = useRelay();
  const [summary, setSummary] = useState("");
  const [links, setLinks] = useState("");
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const linkList = links.split("\n").map(line => line.trim()).filter(line => line !== "");
    if (summary.trim() === "") {
      setError(t("reportRequired"));
      return;
    }
    if (linkList.length > 5 || linkList.some(link => !URL.canParse(link) || !/^https?:/.test(link))) {
      setError(t("invalidLinks"));
      return;
    }
    setError(undefined);
    const document: MilestoneDocument = { kind: "milestone", dealId: deal.id, summary: summary.trim(), links: linkList };
    let cid: string;
    try {
      cid = await storeDocument(document);
    } catch (cause) {
      console.error(cause);
      setError(t("storeFailed"));
      return;
    }
    const call = { ...committee, functionName: "submitMilestone", args: [BigInt(deal.id), cid] } as const;
    const receipt = await transact(
      () => (relayed ? relay(call, { from: address! }) : writeContract(config, call)),
      { title: t("reportTitle"), success: t("reported"), unprompted: relayed },
    );
    if (receipt !== undefined) {
      setSummary("");
      setLinks("");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border-t pt-4">
      <p className="text-[15px] font-medium">
        {t.rich("reportBy", { countdown: () => <Countdown until={deal.milestoneDue!} /> })}
      </p>
      <Field label={t("report")} htmlFor={ids.summary}>
        <textarea id={ids.summary} value={summary} rows={4} maxLength={2000} onChange={e => setSummary(e.target.value)} placeholder={t("reportPlaceholder")} className="w-full resize-none bg-transparent text-base outline-none placeholder:text-faint-foreground/70" />
      </Field>
      <Field label={t("links")} htmlFor={ids.links}>
        <textarea id={ids.links} value={links} rows={2} onChange={e => setLinks(e.target.value)} placeholder={t("linksPlaceholder")} className="w-full resize-none bg-transparent font-mono text-sm outline-none placeholder:text-faint-foreground/70" />
      </Field>
      {error !== undefined && <FormError>{error}</FormError>}
      <Button type="submit" disabled={pending}>{t("submitReport")}</Button>
    </form>
  );
}

function MilestoneRound({ deal, round, notes, live }: { deal: Deal; round: number; notes: Note[]; live: Meeting | undefined }) {
  const t = useTranslations("deal");
  const { data: events } = useEvents({ dealId: deal.id, names: ["MilestoneSubmitted"] });
  const submitted = events?.find(event => Number(event.args.round) === round);
  const { data: report } = useDocument<MilestoneDocument>(submitted === undefined ? undefined : String(submitted.args.uri));
  const meeting: Meeting = { dealId: deal.id, round: live?.round ?? deal.round, phase: live?.phase ?? null, notes, live: live?.live ?? [] };
  return (
    <Round deal={deal} round={round} title={t("milestoneRound", { round })} meeting={meeting}>
      {report !== undefined && (
        <div className="flex flex-col gap-2 rounded-2xl bg-fill p-5">
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{report.summary}</p>
          {report.links.map(link => <a key={link} href={link} target="_blank" rel="noreferrer nofollow" className="w-fit text-sm break-all text-link underline-offset-4 hover:underline">{link}</a>)}
        </div>
      )}
    </Round>
  );
}

/** Every on-chain event of the deal, oldest first, with its transaction. */
function Timeline({ deal }: { deal: Deal }) {
  const t = useTranslations("deal");
  const format = useFormatter();
  // Events are stamped with the chain's time, so that is what their age is measured against.
  const now = useChainNow();
  const { data: events } = useEvents({ dealId: deal.id, names: DEAL_EVENTS, limit: 200 });
  if (events === undefined || events.length === 0) {
    return null;
  }
  return (
    <Section title={t("timeline")}>
      <ol className="flex flex-col divide-y">
        {[...events].reverse().map(event => (
          <li key={`${event.transactionHash}:${event.name}:${JSON.stringify(event.args)}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-[15px]">
            <span><EventText event={event} /></span>
            <span className="flex items-center gap-3 text-sm text-muted-foreground">
              {format.relativeTime(new Date(event.timestamp), now)}
              <TransactionLink hash={event.transactionHash} />
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
