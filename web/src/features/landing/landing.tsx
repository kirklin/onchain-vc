"use client";

import type { ReactNode, RefObject } from "react";
import type { OrbitHandle } from "./committee-orbit";
import type { Pointer } from "./motion";
import type { RoleKey } from "~/chain/committee";
import type { Deal, IndexedEvent, Seat } from "~/chain/deals";
import { cn } from "cn";
import { ArrowRightIcon, ArrowUpRightIcon, BlocksIcon, LandmarkIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useBlockNumber, useChainId } from "wagmi";
import { DEAL_EVENTS, QUORUM, ROLES } from "~/chain/committee";
import { networkOf } from "~/chain/config";
import { addressOn } from "~/chain/contracts";
import { useBallots, useDeals, useEvents, useFund, useMeetings, useSeats, useStats } from "~/chain/deals";
import { formatAmount, shortAddress } from "~/chain/format";
import { isPushed, useChainNow } from "~/chain/live";
import { EventText, Money, TransactionLink, VoteDots } from "~/components/committee";
import { NAV_LINKS } from "~/components/nav";
import { ROLE_ICONS } from "~/components/role-icons";
import { SettingsMenu } from "~/components/settings-menu";
import { Logo } from "~/components/site-header";
import { CommitteeOrbit } from "./committee-orbit";
import { LightField } from "./light-field";
import { AGAINST_LIGHT, rgb, SEAT_LIGHT, useCountUp } from "./motion";
import { Streaks } from "./streaks";

const CONTAINER = "mx-auto w-full max-w-[1320px] px-5 sm:px-8";
const SECTION = cn(CONTAINER, "py-16 lg:py-24");
const WHITE_LIGHT = [235, 240, 255] as const;

/** The front page: what the committee is, what it has done so far, and the way in. */
export function Landing() {
  return (
    <div className="dark min-h-dvh bg-black text-foreground [color-scheme:dark]">
      <LandingHeader />
      <Hero />
      <Streaks className="h-40 sm:h-56" />
      <Numbers />
      <Steps />
      <Partners />
      <Activity />
      <Rules />
      <Closing />
      <Footer />
    </div>
  );
}

function LandingHeader() {
  const t = useTranslations();
  const links = NAV_LINKS.map(link => (
    <Link key={link.href} href={link.href} className="rounded-full px-3.5 py-2 text-[15px] font-medium whitespace-nowrap text-white/60 transition-colors hover:text-white">
      {t(`nav.${link.key}`)}
    </Link>
  ));
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-black/60 backdrop-blur-xl">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-8")}>
        <Link href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight whitespace-nowrap">
          <Logo />
          {t("app.name")}
        </Link>
        <nav className="hidden items-center gap-1 lg:flex">{links}</nav>
        <div className="ml-auto flex items-center gap-2">
          <SettingsMenu />
          <PillLink href="/room" size="small" className="hidden sm:inline-flex">{t("landing.watch")}</PillLink>
        </div>
      </div>
      <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none] lg:hidden">{links}</nav>
    </header>
  );
}

function PillLink({ href, tone = "solid", size = "large", className, children }: {
  href: string;
  tone?: "solid" | "glass";
  size?: "large" | "small";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group items-center gap-3 rounded-full font-semibold whitespace-nowrap transition-colors",
        className ?? "inline-flex",
        size === "large" ? "h-12 text-[15px]" : "h-9 text-sm",
        tone === "solid" && "bg-white text-black hover:bg-white/90",
        tone === "solid" && (size === "large" ? "pr-1.5 pl-5" : "pr-1 pl-4"),
        tone === "glass" && "border border-white/20 bg-white/5 px-5 text-white backdrop-blur-md hover:bg-white/10",
      )}
    >
      {children}
      {tone === "solid" && (
        <span className={cn("flex items-center justify-center rounded-full bg-black text-white transition-transform group-hover:translate-x-0.5", size === "large" ? "size-9" : "size-7")}>
          <ArrowRightIcon className="size-4" />
        </span>
      )}
    </Link>
  );
}

/** A heading set large and tight. A second line, when there is one, continues it in a lighter weight. */
function Heading({ lead, rest, level = 2, className }: { lead: string; rest?: string; level?: 1 | 2; className?: string }) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <Tag
      className={cn(
        "leading-[1.04] tracking-[-0.035em] text-balance",
        level === 1 ? "text-[clamp(2.25rem,5vw,4.75rem)]" : "text-[clamp(2rem,4.2vw,3.75rem)]",
        className,
      )}
    >
      <span className="block font-medium">{lead}</span>
      {rest !== undefined && (
        <>
          {" "}
          <span className="block font-light text-white/75">{rest}</span>
        </>
      )}
    </Tag>
  );
}

function Hero() {
  const t = useTranslations("landing");
  const pointerRef = useRef<Pointer>({ x: 0, y: 0 });
  const orbitRef = useRef<OrbitHandle>(null);
  useVotesOnTheTable(orbitRef);

  return (
    <section
      className="relative isolate overflow-hidden"
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        pointerRef.current = { x: ((event.clientX - box.left) / box.width) * 2 - 1, y: ((event.clientY - box.top) / box.height) * 2 - 1 };
      }}
      onPointerLeave={() => {
        pointerRef.current = { x: 0, y: 0 };
      }}
    >
      <LightField pointer={pointerRef} className="absolute inset-0 -z-20 size-full" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(to_bottom,black_0%,rgb(0_0_0/0.75)_35%,transparent_75%)]" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[repeating-linear-gradient(to_bottom,rgb(0_0_0/0.4)_0_1px,transparent_1px_4px)]" />

      <div className={cn(CONTAINER, "grid items-center gap-6 pt-14 pb-16 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-10 lg:pt-8")}>
        <div className="relative z-10 flex flex-col items-start gap-7">
          <Heading level={1} lead={t("titleLead")} rest={t("titleRest")} />
          <p className="max-w-[34rem] text-[17px] leading-relaxed text-white/65 sm:text-lg">{t("lead")}</p>
          <div className="flex flex-wrap gap-3">
            <PillLink href="/pitch">{t("pitch")}</PillLink>
            <PillLink href="/join" tone="glass">{t("join")}</PillLink>
            <PillLink href="/room" tone="glass">{t("watch")}</PillLink>
          </div>
          <LatestDeal />
        </div>
        <CommitteeOrbit
          ref={orbitRef}
          pointer={pointerRef}
          labels={{ product: t("seats.product"), technology: t("seats.technology"), tokenomics: t("seats.tokenomics"), risk: t("seats.risk") }}
          className="pointer-events-none h-[320px] w-full sm:h-[440px] lg:-ml-32 lg:h-[620px] lg:w-[calc(100%+8rem)]"
        />
      </div>
    </section>
  );
}

/**
 * Plays the committee's votes on the table: the last few when the page opens, then each new
 * one as the index picks it up.
 */
function useVotesOnTheTable(orbitRef: RefObject<OrbitHandle | null>) {
  const { data: votes } = useEvents({ names: ["Voted"], limit: 8 });
  const seenRef = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const orbit = orbitRef.current;
    if (votes === undefined || orbit === null) {
      return;
    }
    const key = (vote: IndexedEvent) => `${vote.transactionHash}:${String(vote.args.role)}`;
    const seen = seenRef.current;
    const oldestFirst = [...votes].reverse();
    const fresh = seen === undefined ? oldestFirst.slice(-4) : oldestFirst.filter(vote => !seen.has(key(vote)));
    seenRef.current = new Set([...(seen ?? []), ...votes.map(key)]);
    for (const vote of fresh) {
      orbit.vote(Number(vote.args.role), vote.args.inFavour === true);
    }
  }, [votes, orbitRef]);
}

function LatestDeal() {
  const { deals } = useDeals();
  const deal = deals?.[0];
  return deal === undefined ? null : <LatestDealCard deal={deal} />;
}

function LatestDealCard({ deal }: { deal: Deal }) {
  const t = useTranslations("landing");
  const tStages = useTranslations("stages");
  const ballots = useBallots(deal.id, deal.round);
  const { meetings } = useMeetings(deal.id);
  const inSession = meetings.get(deal.id)?.live.some(item => item.activity !== "done" && item.activity !== "failed") === true;
  return (
    <Link
      href={`/deals/${deal.id}`}
      className="group mt-3 flex w-full max-w-md items-center gap-4 rounded-2xl border border-white/12 bg-white/[0.04] px-5 py-4 backdrop-blur-xl transition-colors hover:bg-white/[0.08]"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 text-[13px] text-white/50">
          {inSession && <span className="size-1.5 animate-pulse rounded-full bg-success motion-reduce:animate-none" />}
          {inSession ? t("inSession") : `${t("latest")} · ${tStages(deal.stage)}`}
        </span>
        <span className="truncate text-[17px] font-semibold">{deal.name}</span>
      </span>
      <VoteDots ballots={ballots} />
      <ArrowUpRightIcon className="size-5 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </Link>
  );
}

function Numbers() {
  const t = useTranslations("landing");
  const format = useFormatter();
  const chainId = useChainId();
  const { data: block } = useBlockNumber({ watch: { poll: !isPushed(chainId) } });
  const fund = useFund();
  const { deals } = useDeals();
  const { data: stats } = useStats();
  const network = networkOf(chainId);
  const backed = deals?.filter(deal => deal.paid > 0n);
  const amount = (value: bigint | undefined) => fund === undefined || value === undefined ? undefined : Number(formatUnits(value, fund.decimals));

  return (
    <section className={SECTION}>
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
        <div className="flex flex-col gap-6">
          <Heading lead={t("numbersLead")} rest={t("numbersRest")} />
          <p className="max-w-md text-[17px] leading-relaxed text-white/60">{t("numbersHint")}</p>
        </div>
        <dl className="flex flex-col justify-center border-white/15 lg:border-l lg:pl-12">
          <BigFigure icon={<BlocksIcon />} label={t("block")} value={block === undefined ? "—" : format.number(Number(block))} />
          <div className="my-6 h-px bg-white/10" />
          <BigFigure icon={<LandmarkIcon />} label={t("available")} value={<CountedAmount value={amount(fund?.available)} />} unit={fund?.symbol} />
        </dl>
      </div>
      <dl className="mt-16 grid grid-cols-2 gap-y-10 lg:grid-cols-4">
        <SmallFigure label={t("pitches")} value={<Counted value={deals?.length} />} />
        <SmallFigure label={t("backed")} value={<Counted value={backed?.length} />} />
        <SmallFigure label={t("paidOut")} value={<CountedAmount value={amount(backed?.reduce((sum, deal) => sum + deal.paid, 0n))} />} unit={fund?.symbol} />
        <SmallFigure label={t("bonds")} value={<CountedAmount value={amount(fund?.bonds)} />} unit={fund?.symbol} />
        <SmallFigure label={t("transactions")} value={<Counted value={stats?.transactions} />} />
        <SmallFigure label={t("blocks")} value={<Counted value={stats?.blocks} />} />
        <SmallFigure label={t("busiest")} value={<Counted value={stats?.busiestBlock} />} unit={t("busiestUnit")} />
        <SmallFigure label={t("fees")} value={stats === undefined ? "—" : formatAmount(stats.fees, 18, 4)} unit={network?.chain.nativeCurrency.symbol} />
      </dl>
    </section>
  );
}

function Counted({ value }: { value: number | undefined }) {
  const format = useFormatter();
  const shown = useCountUp(value);
  return <>{shown === undefined ? "—" : format.number(Math.round(shown))}</>;
}

function CountedAmount({ value }: { value: number | undefined }) {
  const format = useFormatter();
  const shown = useCountUp(value);
  return <>{shown === undefined ? "—" : format.number(shown, { maximumFractionDigits: shown < 100 ? 2 : 0 })}</>;
}

function BigFigure({ icon, label, value, unit }: { icon: ReactNode; label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="flex items-start gap-5">
      <span className="mt-2 text-white/50 [&_svg]:size-6" aria-hidden>{icon}</span>
      <div className="flex min-w-0 flex-col gap-2">
        <dd className="text-[clamp(2.25rem,4.5vw,3.5rem)] leading-none font-light tracking-[-0.03em] tabular-nums">
          {value}
          {unit !== undefined && <span className="ml-2 text-lg font-normal tracking-normal text-white/45">{unit}</span>}
        </dd>
        <dt className="text-[15px] text-white/55">{label}</dt>
      </div>
    </div>
  );
}

function SmallFigure({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="flex flex-col gap-2 border-l border-white/12 pl-5 sm:pl-7">
      <dd className="text-[clamp(1.75rem,3vw,2.5rem)] leading-none font-light tracking-[-0.03em] tabular-nums">
        {value}
        {unit !== undefined && <span className="ml-1.5 text-sm font-normal tracking-normal text-white/45">{unit}</span>}
      </dd>
      <dt className="text-sm text-white/55">{label}</dt>
    </div>
  );
}

const STEPS = ["pitch", "review", "terms", "accept", "milestone", "veto"] as const;

function Steps() {
  const t = useTranslations("landing");
  return (
    <section className={SECTION}>
      <Heading lead={t("stepsTitle")} className="mb-14" />
      <div aria-hidden className="relative h-px overflow-hidden bg-white/10">
        <span className="absolute inset-y-0 w-40 animate-[rail_7s_linear_infinite] bg-gradient-to-r from-transparent via-white to-transparent motion-reduce:hidden" />
      </div>
      <ol className="grid border-l border-white/10 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex flex-col gap-3 border-r border-b border-white/10 p-7 transition-colors hover:bg-white/[0.03]">
            <span className="mb-6 font-mono text-sm text-white/35 tabular-nums">{String(index + 1).padStart(2, "0")}</span>
            <h3 className="text-xl font-semibold tracking-tight">{t(`steps.${step}.title`)}</h3>
            <p className="text-[15px] leading-relaxed text-white/60">{t(`steps.${step}.body`)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Partners() {
  const t = useTranslations("landing");
  const seats = useSeats();
  return (
    <section className={SECTION}>
      <div className="mb-14 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-6">
          <Heading lead={t("partnersLead")} rest={t("partnersRest")} />
          <p className="max-w-xl text-[17px] leading-relaxed text-white/60">{t("partnersHint")}</p>
        </div>
        <PillLink href="/partners" tone="glass">{t("allPartners")}</PillLink>
      </div>
      <div className="grid border-t border-l border-white/10 sm:grid-cols-2 lg:grid-cols-4">
        {ROLES.map((role, index) => <PartnerCell key={role} role={role} seat={seats?.[index]} />)}
      </div>
    </section>
  );
}

function PartnerCell({ role, seat }: { role: RoleKey; seat: Seat | undefined }) {
  const t = useTranslations("landing");
  const tRoles = useTranslations("roles");
  const Icon = ROLE_ICONS[role];
  const light = SEAT_LIGHT[role];

  return (
    <article data-role={role} className="flex flex-col gap-5 border-r border-b border-white/10 p-7">
      <span className="flex size-11 items-center justify-center rounded-full border" style={{ borderColor: rgb(light, 0.45), color: rgb(light), boxShadow: `0 0 20px ${rgb(light, 0.3)}` }}>
        <Icon className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1.5">
        <h3 className="text-xl font-semibold tracking-tight">{tRoles(role)}</h3>
        <p className="text-[15px] text-white/60">{tRoles(`${role}Brief`)}</p>
      </div>
      <p className="mt-auto flex items-baseline justify-between gap-3 border-t border-white/10 pt-4 text-sm">
        <span className="text-white/45">{t("bond")}</span>
        <span className="font-semibold">{seat === undefined ? "—" : seat.account === undefined ? t("vacant") : <Money value={seat.bond} />}</span>
      </p>
    </article>
  );
}

const FILTERS = {
  all: DEAL_EVENTS.filter(name => name !== "StageChanged"),
  founder: ["Pitched", "MilestoneSubmitted"],
  vote: ["Opined", "Voted"],
  money: ["Offered", "Paid", "Returned"],
  veto: ["MotionOpened", "MotionSupported", "Slashed"],
} as const satisfies Record<string, readonly (typeof DEAL_EVENTS)[number][]>;
type Filter = keyof typeof FILTERS;

/** Which filter an event falls under, which sets its tag. */
function filterOf(name: string): Exclude<Filter, "all"> {
  const found = (Object.keys(FILTERS) as Filter[]).find(key => key !== "all" && (FILTERS[key] as readonly string[]).includes(name));
  return found as Exclude<Filter, "all">;
}

function tagLight(event: IndexedEvent): readonly [number, number, number] {
  switch (filterOf(event.name)) {
    case "vote":
      return event.args.inFavour === true ? SEAT_LIGHT[ROLES[Number(event.args.role)]!] : AGAINST_LIGHT;
    case "money":
      return SEAT_LIGHT.risk;
    case "veto":
      return AGAINST_LIGHT;
    case "founder":
      return WHITE_LIGHT;
  }
}

function Activity() {
  const t = useTranslations("landing");
  const [filter, setFilter] = useState<Filter>("all");
  const { data: events } = useEvents({ names: FILTERS[filter], limit: 10 });

  return (
    <section className={SECTION}>
      <Heading lead={t("activityTitle")} className="mb-14" />
      <div className="grid border-t border-l border-white/10 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="flex gap-1 overflow-x-auto border-r border-b border-white/10 p-2 [scrollbar-width:none] lg:flex-col lg:p-3" role="group" aria-label={t("activityTitle")}>
          {(Object.keys(FILTERS) as Filter[]).map(key => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-lg px-3.5 py-2.5 text-left text-[15px] font-medium whitespace-nowrap transition-colors",
                filter === key ? "bg-white text-black" : "text-white/60 hover:bg-white/[0.06] hover:text-white",
              )}
            >
              {t(`filters.${key}`)}
            </button>
          ))}
        </div>
        <ol data-testid="activity" className="flex min-w-0 flex-col">
          {events === undefined && <li className="border-r border-b border-white/10 px-5 py-6 text-white/50">…</li>}
          {events?.length === 0 && <li className="border-r border-b border-white/10 px-5 py-6 text-white/50">{t("activityEmpty")}</li>}
          {events?.map((event, index) => <ActivityRow key={`${event.transactionHash}:${event.name}:${JSON.stringify(event.args)}`} event={event} index={index} />)}
        </ol>
      </div>
    </section>
  );
}

function ActivityRow({ event, index }: { event: IndexedEvent; index: number }) {
  const t = useTranslations("landing");
  const format = useFormatter();
  const now = useChainNow();
  const light = tagLight(event);
  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 border-r border-b border-white/10 px-4 py-4 text-[15px] sm:grid-cols-[2.25rem_minmax(0,1fr)_auto_auto] sm:px-5">
      <span className="flex size-8 items-center justify-center rounded-md border border-white/12 font-mono text-xs text-white/50 tabular-nums">{index + 1}</span>
      <span className="min-w-0">
        {event.dealId !== null && (
          <Link href={`/deals/${event.dealId}`} className="mr-2 font-semibold underline-offset-4 hover:underline">{t("dealName", { id: event.dealId })}</Link>
        )}
        <span className="text-white/75"><EventText event={event} /></span>
      </span>
      <span className="col-start-2 flex items-center gap-2 text-xs text-white/60 sm:col-start-auto">
        <span className="size-1.5 rounded-full" style={{ background: rgb(light), boxShadow: `0 0 8px ${rgb(light)}` }} />
        {t(`filters.${filterOf(event.name)}`)}
      </span>
      <span className="col-start-2 flex items-center gap-3 text-sm text-white/45 sm:col-start-auto">
        {format.relativeTime(new Date(event.timestamp), now)}
        <TransactionLink hash={event.transactionHash} />
      </span>
    </li>
  );
}

function Rules() {
  const t = useTranslations("landing");
  const fund = useFund();
  const percent = (bps: number | undefined) => bps === undefined ? "—" : String(bps / 100);
  const veto = percent(fund?.quorumBps);
  const slash = percent(fund?.slashBps);
  const cells = [
    { figure: `${QUORUM}/${ROLES.length}`, text: t("rules.quorum") },
    { figure: "2", unit: t("rules.tranchesUnit"), text: t("rules.tranches") },
    { figure: `${veto}%`, text: t("rules.veto", { percent: veto }) },
    { figure: `${slash}%`, text: t("rules.slash", { percent: slash }) },
  ];
  return (
    <section className={SECTION}>
      <div className="mb-14 flex flex-col gap-6">
        <Heading lead={t("rulesTitle")} />
        <p className="max-w-xl text-[17px] leading-relaxed text-white/60">{t("rulesHint")}</p>
      </div>
      <div className="grid border-t border-l border-white/10 sm:grid-cols-2 lg:grid-cols-4">
        {cells.map(cell => (
          <div key={cell.text} className="flex flex-col gap-8 border-r border-b border-white/10 p-7">
            <span className="text-[clamp(2.75rem,5vw,4rem)] leading-none font-light tracking-[-0.03em] tabular-nums">
              {cell.figure}
              {cell.unit !== undefined && <span className="ml-2 text-lg font-normal tracking-normal text-white/45">{cell.unit}</span>}
            </span>
            <p className="text-[15px] leading-relaxed text-white/60">{cell.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Closing() {
  const t = useTranslations("landing");
  return (
    <section className="relative isolate overflow-hidden py-28 lg:py-36">
      <Streaks around className="absolute inset-0 -z-10 h-full" />
      <div className={cn(CONTAINER, "flex flex-col items-center gap-8 text-center")}>
        <Heading lead={t("closingTitle")} />
        <p className="max-w-xl text-[17px] leading-relaxed text-white/65">{t("closingHint")}</p>
        <div className="flex flex-wrap justify-center gap-3">
          <PillLink href="/pitch">{t("pitch")}</PillLink>
          <PillLink href="/join" tone="glass">{t("join")}</PillLink>
          <PillLink href="/room" tone="glass">{t("watch")}</PillLink>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const t = useTranslations();
  const chainId = useChainId();
  const explorer = networkOf(chainId)?.chain.blockExplorers?.default.url;
  const columns = [
    { title: t("landing.product"), links: [{ href: "/room", label: t("nav.room") }, { href: "/screen", label: t("nav.screen") }, { href: "/pitch", label: t("nav.pitch") }, { href: "/portfolio", label: t("nav.portfolio") }] },
    { title: t("landing.public"), links: [{ href: "/partners", label: t("nav.partners") }, { href: "/investors", label: t("nav.investors") }] },
  ];

  return (
    <footer className="border-t border-white/10">
      <div className={cn(CONTAINER, "grid gap-12 py-16 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.4fr]")}>
        <div className="flex flex-col gap-4">
          <Link href="/" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-tight">
            <Logo />
            {t("app.name")}
          </Link>
          <p className="max-w-xs text-sm leading-relaxed text-white/55">{t("app.tagline")}</p>
        </div>
        {columns.map(column => (
          <div key={column.title} className="flex flex-col gap-4">
            <h2 className="text-xs tracking-widest text-white/40 uppercase">{column.title}</h2>
            <ul className="flex flex-col gap-2.5">
              {column.links.map(link => <li key={link.href}><Link href={link.href} className="text-[15px] text-white/70 transition-colors hover:text-white">{link.label}</Link></li>)}
            </ul>
          </div>
        ))}
        <div className="flex flex-col gap-4">
          <h2 className="text-xs tracking-widest text-white/40 uppercase">{t("landing.contracts")}</h2>
          <ul className="flex flex-col gap-2.5">
            {(["Committee", "Fund", "PortfolioBadge", "Token"] as const).map((name) => {
              const address = addressOn(name, chainId);
              return (
                <li key={name} className="flex items-center justify-between gap-4 text-[15px]">
                  <span className="text-white/70">{name}</span>
                  {address === undefined
                    ? <span className="text-sm text-white/40">{t("landing.notDeployed")}</span>
                    : explorer === undefined
                      ? <span className="font-mono text-sm text-white/50" title={address}>{shortAddress(address)}</span>
                      : <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer" title={address} className="font-mono text-sm text-white/50 underline-offset-4 hover:text-white hover:underline">{shortAddress(address)}</a>}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </footer>
  );
}
