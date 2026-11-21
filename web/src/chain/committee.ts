import type { Hash } from "viem";
import { isAddress } from "viem";
import { z } from "zod";

/** The four seats, in the order of `Committee.Role`. */
export const ROLES = ["product", "technology", "tokenomics", "risk"] as const;
export type RoleKey = (typeof ROLES)[number];

/** The stages of a deal, in the order of `Committee.Stage`. */
export const STAGES = ["review", "approved", "rejected", "offered", "funded", "milestone", "completed", "vetoed", "expired"] as const;
export type StageKey = (typeof STAGES)[number];

export const QUORUM = 3;

/** The events that make up a deal's history, by the names the indexer stores them under. */
export const DEAL_EVENTS = ["Pitched", "Opined", "Voted", "StageChanged", "Offered", "Paid", "MilestoneSubmitted", "Returned", "Slashed", "MotionOpened", "MotionSupported"] as const;

/** Stages in which investors can still veto the deal. */
export const VETOABLE: readonly StageKey[] = ["approved", "offered", "funded", "milestone"];

/** Stages after which nothing more happens to the deal. */
export const SETTLED: readonly StageKey[] = ["rejected", "completed", "vetoed", "expired"];

/** Mirrors `Committee.MAX_NAME_BYTES` and the characters `Committee` refuses in names and URIs. */
export const MAX_NAME_BYTES = 32;
const REFUSED = new Set(["\"", "\\", "<", ">", "&"]);

export function isCommitteeText(text: string, maxBytes: number): boolean {
  const bytes = new TextEncoder().encode(text).length;
  return bytes > 0 && bytes <= maxBytes && [...text].every((char) => {
    const code = char.codePointAt(0)!;
    return code >= 0x20 && code !== 0x7F && !REFUSED.has(char);
  });
}

const link = z.url().max(200);
const address = z.string().refine(isAddress, "must be an address");

/** What a founder writes when pitching. It is stored in the file store and its CID goes on chain. */
export const pitchDocument = z.object({
  kind: z.literal("pitch"),
  project: address,
  name: z.string().trim().refine(text => isCommitteeText(text, MAX_NAME_BYTES), "must be 1 to 32 bytes without quotes, backslashes, <, > or &"),
  summary: z.string().trim().min(1).max(140),
  description: z.string().trim().max(2000),
  links: z.array(link).max(5),
  /** In whole tokens of the fund's asset. */
  ask: z.number().positive(),
});
export type PitchDocument = z.infer<typeof pitchDocument>;

/** What a founder writes when reporting a milestone as reached. */
export const milestoneDocument = z.object({
  kind: z.literal("milestone"),
  dealId: z.number().int().positive(),
  summary: z.string().trim().min(1).max(2000),
  links: z.array(link).max(5),
});
export type MilestoneDocument = z.infer<typeof milestoneDocument>;

/** A tool a partner used while forming a view, as shown beside what they said. */
export interface ToolUse {
  tool: string;
  /** The tool's arguments, as the partner gave them. */
  input: Record<string, unknown>;
  failed: boolean;
}

/** What a partner concluded in a phase of a meeting. */
export interface Note {
  dealId: number;
  round: number;
  phase: Phase;
  role: RoleKey;
  text: string;
  /** For an analysis, whether the partner leans towards investing. For a vote, how they voted. */
  inFavour: boolean | null;
  score: number | null;
  tools: ToolUse[];
  /** The terms the risk partner set, for the `terms` phase. */
  terms: TermsDraft | null;
  /** Where the written opinion or terms are kept. */
  cid: string | null;
  transactionHash: Hash | null;
  /** How long the transaction took from sending to its receipt. */
  confirmMs: number | null;
  createdAt: string;
}

export interface TermsDraft {
  /** In whole tokens of the fund's asset. */
  amount: number;
  firstTranchePercent: number;
  milestoneDays: number;
  milestone: string;
}

/**
 * The parts of a meeting. A pitch has an `analysis`, where each partner studies it alone, and
 * a `vote`, where each answers the others and votes; once approved, the risk partner sets
 * the `terms`. A milestone report gets a single `vote`.
 */
export type Phase = "analysis" | "vote" | "terms";

/** What a partner is doing right now. */
export type Activity = "reading" | "tool" | "speaking" | "done" | "failed";

/** Everything the server pushes about meetings, as it happens. */
export type MeetingEvent
  = | { type: "phase"; dealId: number; round: number; phase: Phase }
    | { type: "activity"; dealId: number; round: number; phase: Phase; role: RoleKey; activity: Activity; tool?: string }
    | { type: "text"; dealId: number; round: number; phase: Phase; role: RoleKey; text: string }
    | { type: "note"; note: Note }
    | { type: "stage"; dealId: number; stage: StageKey }
    | { type: "failed"; dealId: number; round: number; message: string };

/** A meeting as it stands: what is final, and what each partner is still saying. */
export interface MeetingSnapshot {
  dealId: number;
  round: number;
  phase: Phase | null;
  notes: Note[];
  live: { phase: Phase; role: RoleKey; activity: Activity; tool?: string; text: string }[];
}
