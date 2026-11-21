"use client";

import type { Address, Hash } from "viem";
import type { Activity, MeetingEvent, MeetingSnapshot, MilestoneDocument, Note, Phase, PitchDocument, RoleKey, StageKey } from "./committee";
import { useQuery } from "@tanstack/react-query";
import { CID } from "multiformats/cid";
import { useEffect, useMemo, useState } from "react";
import { useChainId, useReadContract, useReadContracts } from "wagmi";
import { ROLES, STAGES } from "./committee";
import { useDeployment } from "./contracts";
import { useOnBlock } from "./live";
import { findRevert } from "./transact";

export interface Deal {
  id: number;
  founder: Address;
  project: Address;
  name: string;
  stage: StageKey;
  round: number;
  inFavour: number;
  against: number;
  ask: bigint;
  amount: bigint;
  paid: bigint;
  firstTrancheBps: number;
  milestoneDays: number;
  pitchedAt: Date;
  deadline: Date;
  milestoneDue: Date | undefined;
  approvedAt: bigint;
  pitchUri: string;
  termsUri: string;
  proofUri: string;
}

interface RawDeal {
  founder: Address;
  deadline: number;
  stage: number;
  round: number;
  inFavour: number;
  against: number;
  firstTrancheBps: number;
  project: Address;
  pitchedAt: number;
  approvedAt: number;
  ask: bigint;
  amount: bigint;
  paid: bigint;
  milestoneDue: number;
  milestoneDays: number;
  name: string;
  pitchUri: string;
  termsUri: string;
  proofUri: string;
}

function toDeal(id: number, raw: RawDeal): Deal {
  return {
    id,
    founder: raw.founder,
    project: raw.project,
    name: raw.name,
    stage: STAGES[raw.stage]!,
    round: raw.round,
    inFavour: raw.inFavour,
    against: raw.against,
    ask: raw.ask,
    amount: raw.amount,
    paid: raw.paid,
    firstTrancheBps: raw.firstTrancheBps,
    milestoneDays: raw.milestoneDays,
    pitchedAt: new Date(raw.pitchedAt * 1000),
    deadline: new Date(raw.deadline * 1000),
    milestoneDue: raw.milestoneDue === 0 ? undefined : new Date(raw.milestoneDue * 1000),
    approvedAt: BigInt(raw.approvedAt),
    pitchUri: raw.pitchUri,
    termsUri: raw.termsUri,
    proofUri: raw.proofUri,
  };
}

/** Every deal, newest first, read again whenever the chain moves. */
export function useDeals() {
  const committee = useDeployment("Committee");
  const { data: count, refetch: refetchCount } = useReadContract(committee === undefined ? undefined : { ...committee, functionName: "dealCount" });
  const ids = useMemo(() => Array.from({ length: Number(count ?? 0n) }, (_, index) => Number(count!) - index), [count]);
  const { data, refetch, isPending } = useReadContracts({
    allowFailure: false,
    contracts: committee === undefined ? [] : ids.map(id => ({ ...committee, functionName: "getDeal" as const, args: [BigInt(id)] as const })),
  });
  useOnBlock(() => {
    void refetchCount();
    void refetch();
  });
  const deals = useMemo(() => (data as RawDeal[] | undefined)?.map((raw, index) => toDeal(ids[index]!, raw)), [data, ids]);
  return { deals, loading: committee !== undefined && (count === undefined || isPending) };
}

/** A read that reverted has its answer, there being no such deal. Only other failures are tried again. */
function retryUnlessReverted(failures: number, error: unknown): boolean {
  return failures < 3 && findRevert(error) === undefined;
}

export function useDeal(id: number) {
  const committee = useDeployment("Committee");
  const { data, refetch, error, isPending } = useReadContract(committee === undefined
    ? undefined
    : { ...committee, functionName: "getDeal", args: [BigInt(id)], query: { retry: retryUnlessReverted } });
  useOnBlock(() => void refetch());
  return { deal: data === undefined ? undefined : toDeal(id, data as RawDeal), error, loading: isPending, refetch };
}

export interface Ballot {
  voter: Address;
  cast: boolean;
  inFavour: boolean;
  score: number;
}

/** How each seat voted in a round, in seat order. */
export function useBallots(id: number, round: number) {
  const committee = useDeployment("Committee");
  const { data, refetch } = useReadContract(committee === undefined ? undefined : { ...committee, functionName: "getBallots", args: [BigInt(id), BigInt(round)] });
  useOnBlock(() => void refetch());
  return data as readonly Ballot[] | undefined;
}

export interface Seat {
  role: RoleKey;
  account: Address | undefined;
  name: string;
  profileHash: Hash;
  bond: bigint;
}

/** Who holds each seat, with what they published and the bond they put up. */
export function useSeats() {
  const committee = useDeployment("Committee");
  const { data: seats, refetch: refetchSeats } = useReadContract(committee === undefined ? undefined : { ...committee, functionName: "getSeats" });
  const { data: partners, refetch } = useReadContracts({
    allowFailure: false,
    contracts: committee === undefined || seats === undefined ? [] : seats.map(account => ({ ...committee, functionName: "getPartner" as const, args: [account] as const })),
  });
  useOnBlock(() => {
    void refetchSeats();
    void refetch();
  });
  return useMemo(() => seats?.map((account, index): Seat => {
    const partner = (partners as { name: string; profileHash: Hash; bond: bigint }[] | undefined)?.[index];
    const vacant = BigInt(account) === 0n;
    return {
      role: ROLES[index]!,
      account: vacant ? undefined : account,
      name: partner?.name ?? "",
      profileHash: partner?.profileHash ?? "0x",
      bond: partner?.bond ?? 0n,
    };
  }), [seats, partners]);
}

/** The fund's money, the committee's rules and the asset they are in. */
export function useFund() {
  const fund = useDeployment("Fund");
  const committee = useDeployment("Committee");
  const token = useDeployment("Token");
  const ready = fund !== undefined && committee !== undefined && token !== undefined;
  const { data, refetch } = useReadContracts({
    allowFailure: false,
    contracts: ready
      ? [
          { ...fund, functionName: "totalAssets" },
          { ...fund, functionName: "totalSupply" },
          { ...committee, functionName: "committed" },
          { ...committee, functionName: "maxAsk" },
          { ...committee, functionName: "minBond" },
          { ...committee, functionName: "totalBonds" },
          { ...token, functionName: "symbol" },
          { ...token, functionName: "decimals" },
          { ...fund, functionName: "quorumBps" },
          { ...committee, functionName: "slashBps" },
        ]
      : [],
  });
  useOnBlock(() => void refetch());
  if (data === undefined || !ready) {
    return undefined;
  }
  const [available, shares, committed, maxAsk, minBond, bonds, symbol, decimals, quorumBps, slashBps] = data as [bigint, bigint, bigint, bigint, bigint, bigint, string, number, number, number];
  return { available, shares, committed, maxAsk, minBond, bonds, symbol, decimals, quorumBps, slashBps };
}

export interface IndexedEvent {
  contract: "committee" | "fund";
  name: string;
  dealId: number | null;
  account: Address | null;
  args: Record<string, unknown>;
  blockNumber: string;
  transactionHash: Hash;
  timestamp: string;
}

/** Events from the server's index, newest first. The index follows the chain from a little behind. */
export function useEvents(parameters: { dealId?: number; names?: readonly string[]; limit?: number }) {
  const chainId = useChainId();
  const query = new URLSearchParams({ chainId: String(chainId), limit: String(parameters.limit ?? 50) });
  if (parameters.dealId !== undefined) {
    query.set("dealId", String(parameters.dealId));
  }
  if (parameters.names !== undefined) {
    query.set("names", parameters.names.join(","));
  }
  return useQuery({
    queryKey: ["events", query.toString()],
    queryFn: async () => {
      const response = await fetch(`/api/events?${query}`);
      if (!response.ok) {
        throw new Error(`/api/events failed with HTTP ${response.status}.`);
      }
      return (await response.json() as { events: IndexedEvent[] }).events;
    },
    refetchInterval: 2000,
  });
}

/** Whether the text is a CID in its canonical form. The committee stores whatever text a caller gives it. */
function isCid(text: string): boolean {
  try {
    return CID.parse(text).toString() === text;
  } catch {
    return false;
  }
}

/**
 * A document stored by its CID: a pitch, a milestone report, an opinion or terms. Nothing is
 * fetched for text that is not a CID, which someone calling the contract directly may have left.
 */
export function useDocument<T>(cid: string | undefined) {
  return useQuery({
    queryKey: ["document", cid],
    queryFn: async () => {
      const response = await fetch(`/api/ipfs/${cid}`);
      if (!response.ok) {
        throw new Error(`Reading ${cid} failed with HTTP ${response.status}.`);
      }
      return await response.json() as T;
    },
    enabled: cid !== undefined && isCid(cid),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export type { MilestoneDocument, PitchDocument };

/** Stores what the founder wrote and resolves with the CID to put on chain. */
export async function storeDocument(document: PitchDocument | MilestoneDocument): Promise<string> {
  const response = await fetch("/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(document),
  });
  const result = await response.json() as { cid: string } | { error: string };
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result.cid;
}

export interface PartnerProfile {
  role: RoleKey;
  name: string;
  instructions: string;
  model: string;
  profileHash: Hash;
}

/** The partners' profiles as the server runs them. */
export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const response = await fetch("/api/partners");
      if (!response.ok) {
        throw new Error(`/api/partners failed with HTTP ${response.status}.`);
      }
      return await response.json() as { model: string; profiles: PartnerProfile[] };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** What one partner is doing in one phase, while the meeting is on. */
export interface LiveSpeech {
  phase: Phase;
  role: RoleKey;
  activity: Activity;
  tool?: string;
  text: string;
}

export interface Meeting {
  dealId: number;
  round: number;
  phase: Phase | null;
  notes: Note[];
  live: LiveSpeech[];
}

type Stream = { type: "snapshot"; meetings: MeetingSnapshot[] } | (MeetingEvent & { chainId: number });

function noteKey(note: { round: number; phase: Phase; role: RoleKey }) {
  return `${note.round}:${note.phase}:${note.role}`;
}

function apply(meetings: Map<number, Meeting>, event: Stream): Map<number, Meeting> {
  if (event.type === "snapshot") {
    return new Map(event.meetings.map(meeting => [meeting.dealId, { ...meeting, live: meeting.live }]));
  }
  const next = new Map(meetings);
  const dealId = event.type === "note" ? event.note.dealId : event.dealId;
  const meeting: Meeting = next.get(dealId) ?? { dealId, round: 0, phase: null, notes: [], live: [] };
  switch (event.type) {
    case "phase":
      next.set(dealId, { ...meeting, round: event.round, phase: event.phase });
      break;
    case "activity":
    case "text": {
      const others = meeting.live.filter(item => !(item.phase === event.phase && item.role === event.role));
      const current = meeting.live.find(item => item.phase === event.phase && item.role === event.role) ?? { phase: event.phase, role: event.role, activity: "reading" as Activity, text: "" };
      const updated = event.type === "activity"
        ? { ...current, activity: event.activity, tool: event.tool }
        : { ...current, activity: "speaking" as Activity, text: event.text };
      next.set(dealId, { ...meeting, round: event.round, live: [...others, updated] });
      break;
    }
    case "note": {
      const notes = [...meeting.notes.filter(note => noteKey(note) !== noteKey(event.note)), event.note];
      const live = meeting.live.filter(item => !(item.phase === event.note.phase && item.role === event.note.role));
      next.set(dealId, { ...meeting, notes, live });
      break;
    }
    case "stage":
    case "failed":
      next.set(dealId, { ...meeting, live: event.type === "failed" ? [] : meeting.live });
  }
  return next;
}

/**
 * Follows meetings as the server holds them: the meetings in progress, or the one about
 * `dealId` from its start. Every note and what each partner is saying right now, kept up
 * to date over a stream of server-sent events that reconnects on its own.
 */
export function useMeetings(dealId?: number) {
  const chainId = useChainId();
  const [meetings, setMeetings] = useState(() => new Map<number, Meeting>());
  const [stages, setStages] = useState<{ dealId: number; stage: StageKey }[]>([]);

  useEffect(() => {
    const query = new URLSearchParams({ chainId: String(chainId) });
    if (dealId !== undefined) {
      query.set("dealId", String(dealId));
    }
    const source = new EventSource(`/api/meetings/stream?${query}`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as Stream;
      setMeetings(current => apply(current, event));
      if (event.type === "stage") {
        setStages(current => [{ dealId: event.dealId, stage: event.stage }, ...current].slice(0, 20));
      }
    };
    return () => source.close();
  }, [chainId, dealId]);

  return { meetings, stages };
}

/** Everything the partners concluded about a deal, for deals whose meetings are over. */
export function useNotes(dealId: number | undefined) {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["notes", chainId, dealId],
    queryFn: async () => {
      const response = await fetch(`/api/meetings/${dealId}?chainId=${chainId}`);
      if (!response.ok) {
        throw new Error(`Reading the notes of deal ${dealId} failed with HTTP ${response.status}.`);
      }
      return (await response.json() as { notes: Note[] }).notes;
    },
    enabled: dealId !== undefined,
    refetchInterval: 3000,
  });
}

export interface ChainStats {
  transactions: number;
  blocks: number;
  busiestBlock: number;
  /** In wei of the chain's native token. */
  fees: bigint;
  medianConfirmMs: number | null;
}

/** How much the app has put on the chain so far: transactions, the blocks they are in and their cost. */
export function useStats() {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["stats", chainId],
    queryFn: async (): Promise<ChainStats> => {
      const response = await fetch(`/api/stats?chainId=${chainId}`);
      if (!response.ok) {
        throw new Error(`/api/stats failed with HTTP ${response.status}.`);
      }
      const stats = await response.json() as Omit<ChainStats, "fees"> & { fees: string };
      return { ...stats, fees: BigInt(stats.fees) };
    },
    refetchInterval: 2000,
  });
}

export interface VetoMotion {
  id: bigint;
  carried: boolean;
  deadline: Date;
  /** The weight behind the motion and the weight it needs, in shares. */
  support: bigint;
  quorum: bigint;
  /** How far the support has come towards the quorum, from 0 to 100. */
  percent: number;
}

/** The latest motion to veto a deal, if investors have moved one. */
export function useVetoMotion(dealId: number): VetoMotion | undefined {
  const fund = useDeployment("Fund");
  const { data: id, refetch: refetchId } = useReadContract(fund === undefined ? undefined : { ...fund, functionName: "vetoMotionOf", args: [BigInt(dealId)] });
  const known = id !== undefined && id > 0n;
  const { data, refetch } = useReadContracts({
    allowFailure: false,
    contracts: fund === undefined || !known
      ? []
      : [
          { ...fund, functionName: "motion", args: [id] },
          { ...fund, functionName: "quorumOf", args: [id] },
        ],
  });
  useOnBlock(() => {
    void refetchId();
    void refetch();
  }, 1000);
  if (!known || data === undefined || data.length === 0) {
    return undefined;
  }
  const [motion, quorum] = data as [{ carried: boolean; deadline: number; support: bigint }, bigint];
  return {
    id,
    carried: motion.carried,
    deadline: new Date(motion.deadline * 1000),
    support: motion.support,
    quorum,
    percent: quorum === 0n ? 0 : Math.min(100, Number(motion.support * 100n / quorum)),
  };
}
