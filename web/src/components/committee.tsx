"use client";

import type { Address, Hash } from "viem";
import type { Note, Phase, RoleKey, StageKey } from "~/chain/committee";
import type { Ballot, IndexedEvent, LiveSpeech, Meeting } from "~/chain/deals";
import { cn } from "cn";
import { CheckIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useChainId } from "wagmi";
import { ROLES, STAGES } from "~/chain/committee";
import { networkOf } from "~/chain/config";
import { useFund } from "~/chain/deals";
import { formatAmount, shortAddress } from "~/chain/format";
import { ROLE_ICONS } from "./role-icons";

export function RoleIcon({ role, className }: { role: RoleKey; className?: string }) {
  const Icon = ROLE_ICONS[role];
  return (
    <span aria-hidden className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground", className)}>
      <Icon className="size-[45%]" strokeWidth={1.75} />
    </span>
  );
}

/** An amount of the fund's asset, with its symbol. */
export function Money({ value, className }: { value: bigint; className?: string }) {
  const fund = useFund();
  return (
    <span className={cn("tabular-nums", className)}>
      {fund === undefined ? "…" : `${formatAmount(value, fund.decimals, 2)} ${fund.symbol}`}
    </span>
  );
}

const STAGE_TONES: Record<StageKey, string> = {
  review: "bg-fill text-foreground",
  approved: "bg-success-fill text-success",
  rejected: "bg-fill text-muted-foreground",
  offered: "bg-success-fill text-success",
  funded: "bg-primary text-primary-foreground",
  milestone: "bg-fill text-foreground",
  completed: "bg-primary text-primary-foreground",
  vetoed: "bg-destructive-fill text-destructive",
  expired: "bg-fill text-muted-foreground",
};

export function StageBadge({ stage, className }: { stage: StageKey; className?: string }) {
  const t = useTranslations("stages");
  return (
    <span data-stage={stage} className={cn("inline-flex h-7 shrink-0 items-center rounded-full px-3 text-[13px] font-semibold whitespace-nowrap", STAGE_TONES[stage], className)}>
      {t(stage)}
    </span>
  );
}

/** One dot per seat: filled for a vote in favour, crossed for one against, hollow for none yet. */
export function VoteDots({ ballots, className }: { ballots: readonly Ballot[] | undefined; className?: string }) {
  const t = useTranslations("meeting");
  const tRoles = useTranslations("roles");
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {ROLES.map((role, index) => {
        const ballot = ballots?.[index];
        const label = t("ballot", { role: tRoles(role), vote: ballot?.cast !== true ? t("notVoted") : ballot.inFavour ? t("inFavour") : t("against") });
        return (
          <span
            key={role}
            role="img"
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex size-5 items-center justify-center rounded-full",
              ballot?.cast !== true && "bg-fill",
              ballot?.cast === true && ballot.inFavour && "bg-success text-background",
              ballot?.cast === true && !ballot.inFavour && "bg-destructive text-background",
            )}
          >
            {ballot?.cast === true && (ballot.inFavour ? <CheckIcon className="size-3" strokeWidth={3} /> : <XIcon className="size-3" strokeWidth={3} />)}
          </span>
        );
      })}
    </span>
  );
}

/** What an indexed event of a deal means, in a sentence. */
export function EventText({ event }: { event: IndexedEvent }) {
  const t = useTranslations("events");
  const tRoles = useTranslations("roles");
  const tStages = useTranslations("stages");
  const args = event.args;
  switch (event.name) {
    case "Pitched":
      return <>{t("pitched")}</>;
    case "Voted":
      return <>{t("voted", { role: tRoles(ROLES[Number(args.role)]!), vote: args.inFavour === true ? t("for") : t("against"), score: Number(args.score) })}</>;
    case "StageChanged":
      return <>{t("stage", { stage: tStages(STAGES[Number(args.stage)]!) })}</>;
    case "Offered":
      return <>{t("offered")}</>;
    case "Paid":
      return (
        <>
          {t("paid", { tranche: Number(args.tranche) })}
          {" "}
          <Money value={BigInt(String(args.amount))} />
        </>
      );
    case "MilestoneSubmitted":
      return <>{t("milestone", { round: Number(args.round) })}</>;
    case "Returned":
      return (
        <>
          {t("returned")}
          {" "}
          <Money value={BigInt(String(args.amount))} />
        </>
      );
    case "Slashed":
      return (
        <>
          {t("slashed", { partner: shortAddress(String(args.partner) as Address) })}
          {" "}
          <Money value={BigInt(String(args.amount))} />
        </>
      );
    case "MotionOpened":
      return <>{t("motionOpened", { investor: shortAddress(String(args.proposer) as Address) })}</>;
    default:
      return <>{event.name}</>;
  }
}

/** A transaction, linked to the explorer on chains that have one. */
export function TransactionLink({ hash, className }: { hash: Hash; className?: string }) {
  const explorer = networkOf(useChainId())?.chain.blockExplorers?.default.url;
  if (explorer === undefined) {
    return <span className={cn("font-mono", className)} title={hash}>{shortAddress(hash)}</span>;
  }
  return (
    <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" title={hash} className={cn("inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline", className)}>
      {shortAddress(hash)}
      <ExternalLinkIcon className="size-3" />
    </a>
  );
}

/**
 * How a seat voted. With the partner's note it says how long the vote took to go on chain;
 * a vote known only from the chain, cast by a partner this server does not run, says just that.
 */
function VoteLine({ inFavour, score, note }: { inFavour: boolean; score: number; note: Note | undefined }) {
  const t = useTranslations("meeting");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span
        data-vote={inFavour ? "for" : "against"}
        className={cn("inline-flex h-7 items-center gap-1 rounded-full px-3 font-semibold", inFavour ? "bg-success-fill text-success" : "bg-destructive-fill text-destructive")}
      >
        {inFavour ? <CheckIcon className="size-3.5" strokeWidth={3} /> : <XIcon className="size-3.5" strokeWidth={3} />}
        {inFavour ? t("inFavour") : t("against")}
      </span>
      <span className="font-semibold tabular-nums">{t("score", { score })}</span>
      {note === undefined && <span className="text-muted-foreground">{t("onChainOnly")}</span>}
      {note !== undefined && note.transactionHash === null && <span className="text-muted-foreground">{t("sending")}</span>}
      {note?.transactionHash !== null && note !== undefined && (
        <span className="flex items-center gap-2 text-muted-foreground">
          {t("onChain", { seconds: ((note.confirmMs ?? 0) / 1000).toFixed(1) })}
          <TransactionLink hash={note.transactionHash} />
        </span>
      )}
    </div>
  );
}

/**
 * One partner at the table: what they are doing, what they are saying as they say it, and
 * how they voted. `round` picks the decision on the pitch (0) or a milestone report, and
 * `ballot` is the seat's vote in that round as the chain has it.
 */
export function PartnerPanel({ role, round, meeting, ballot, size = "default" }: {
  role: RoleKey;
  round: number;
  meeting: Meeting | undefined;
  ballot: Ballot | undefined;
  size?: "default" | "screen";
}) {
  const t = useTranslations("meeting");
  const tRoles = useTranslations("roles");
  const notes = meeting?.notes.filter(note => note.role === role && note.round === round) ?? [];
  const analysis = notes.find(note => note.phase === "analysis");
  const vote = notes.find(note => note.phase === "vote");
  const live = meeting?.round === round ? meeting.live.filter(item => item.role === role && item.phase !== "terms") : [];
  const speaking = live.find(item => item.phase === "vote") ?? live.find(item => item.phase === "analysis");

  return (
    <article data-role={role} className={cn("flex min-w-0 flex-col gap-4 surface p-5", size === "screen" && "gap-5 p-6")}>
      <header className="flex items-center gap-3">
        <RoleIcon role={role} className={size === "screen" ? "size-12" : undefined} />
        <div className="flex min-w-0 flex-col">
          <h3 className={cn("font-semibold", size === "screen" ? "text-xl" : "text-[17px]")}>{tRoles(role)}</h3>
          <Activity speech={speaking} voted={vote !== undefined || ballot?.cast === true} spoke={analysis !== undefined} />
        </div>
      </header>

      {analysis !== undefined && (
        <section className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-muted-foreground">
            {t("analysis")}
            {" · "}
            {analysis.inFavour === true ? t("leanInvest") : t("leanPass")}
            {" · "}
            {t("score", { score: analysis.score ?? 0 })}
          </p>
          <p className={cn("leading-relaxed text-pretty", size === "screen" ? "text-lg" : "text-[15px]")}>{analysis.text}</p>
        </section>
      )}
      {speaking !== undefined && speaking.text !== "" && (
        <section className="flex flex-col gap-1.5" aria-live="polite">
          <p className="text-xs font-semibold text-muted-foreground">{speaking.phase === "vote" ? t("statement") : t("analysis")}</p>
          <p className={cn("leading-relaxed text-pretty", size === "screen" ? "text-lg" : "text-[15px]")}>
            {speaking.text}
            <span aria-hidden className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-foreground" />
          </p>
        </section>
      )}
      {vote !== undefined && (
        <section className="mt-auto flex flex-col gap-2 border-t pt-4">
          <p className={cn("leading-relaxed text-pretty", size === "screen" ? "text-lg" : "text-[15px]")}>{vote.text}</p>
          <VoteLine inFavour={vote.inFavour === true} score={vote.score ?? 0} note={vote} />
          {vote.cid !== null && (
            <a href={`/api/ipfs/${vote.cid}`} target="_blank" rel="noreferrer" className="w-fit text-xs text-muted-foreground underline-offset-4 hover:underline">
              {t("fullOpinion")}
            </a>
          )}
        </section>
      )}
      {vote === undefined && ballot?.cast === true && (
        <section className="mt-auto border-t pt-4">
          <VoteLine inFavour={ballot.inFavour} score={ballot.score} note={undefined} />
        </section>
      )}
    </article>
  );
}

function Activity({ speech, voted, spoke }: { speech: LiveSpeech | undefined; voted: boolean; spoke: boolean }) {
  const t = useTranslations("meeting");
  let label: string;
  if (speech !== undefined) {
    label = speech.activity === "tool" && speech.tool !== undefined ? t("usingTool", { tool: speech.tool }) : t(`activity.${speech.activity}`);
  } else if (voted) {
    label = t("voted");
  } else if (spoke) {
    label = t("waitingVote");
  } else {
    label = t("waiting");
  }
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      {speech !== undefined && speech.activity !== "done" && speech.activity !== "failed" && <span aria-hidden className="inline-block size-1.5 animate-pulse rounded-full bg-foreground" />}
      {label}
    </span>
  );
}

/** The phase a meeting is in, as a line of text. */
export function PhaseLine({ phase }: { phase: Phase | null }) {
  const t = useTranslations("meeting");
  return <span>{phase === null ? t("phase.none") : t(`phase.${phase}`)}</span>;
}
