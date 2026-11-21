import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Address, Chain, Hash, PublicClient, Transport } from "viem";
import type { z } from "zod";
import type { Database } from "../db";
import type { FileStore } from "../files";
import type { Operator } from "../operator";
import type { MeetingBus } from "./bus";
import type { Profile } from "./profiles";
import type { ToolContext } from "./tools";
import type { MilestoneDocument, Note, Phase, PitchDocument, RoleKey, TermsDraft, ToolUse } from "~/chain/committee";
import { Agent } from "@earendil-works/pi-agent-core";
import { bool, int, obj, oneOf, str } from "@earendil-works/pi-schema";
import { and, eq } from "drizzle-orm";
import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { milestoneDocument, pitchDocument, ROLES, STAGES } from "~/chain/committee";
import { committeeAbi, fundAbi } from "~/contracts/abis";
import { meetingNotes } from "../db/schema";
import { models } from "./models";
import { profileHash } from "./profiles";
import { fundStatusTool, readContractTool, researchTools } from "./tools";

/** A seat this server speaks for: the partner's account, its wallet and its profile. */
export interface Seat {
  role: RoleKey;
  account: Address;
  wallet: Operator;
  profile: Profile;
}

export interface MeetingContext {
  chainId: number;
  client: PublicClient<Transport, Chain>;
  database: Database;
  files: FileStore;
  bus: MeetingBus;
  model: Model<Api>;
  /** The model as `<provider>/<model>`, as it is written into profiles and opinions. */
  modelName: string;
  committee: Address;
  fund: Address;
  asset: { address: Address; symbol: string; decimals: number };
  gasMarginPercent: number;
}

type Deal = Awaited<ReturnType<typeof loadDeal>>;

/** How long one partner may take for one phase before the meeting is given up and tried again. */
const PHASE_TIMEOUT_MS = 120_000;
/** How often a partner is reminded to answer through its tool before the phase counts as failed. */
const REMINDERS = 2;

function roleIndex(role: RoleKey): number {
  return ROLES.indexOf(role);
}

export async function loadDeal(context: MeetingContext, dealId: number) {
  return context.client.readContract({ address: context.committee, abi: committeeAbi, functionName: "getDeal", args: [BigInt(dealId)] });
}

/** A document a founder stored, or undefined when it is missing or not what it should be. */
async function readDocument<T>(context: MeetingContext, cid: string, schema: z.ZodType<T>): Promise<T | undefined> {
  if (cid === "") {
    return undefined;
  }
  const bytes = await context.files.get(cid);
  if (bytes === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export async function notesOf(database: Database, chainId: number, dealId: number): Promise<Note[]> {
  const rows = await database.select().from(meetingNotes).where(and(eq(meetingNotes.chainId, chainId), eq(meetingNotes.dealId, dealId)));
  return rows.map(row => ({
    dealId: row.dealId,
    round: row.round,
    phase: row.phase as Phase,
    role: row.role as RoleKey,
    text: row.text,
    inFavour: row.inFavour,
    score: row.score,
    tools: row.tools,
    terms: row.terms,
    cid: row.cid,
    transactionHash: row.transactionHash as Hash | null,
    confirmMs: row.confirmMs,
    createdAt: row.createdAt.toISOString(),
  }));
}

async function saveNote(context: MeetingContext, note: Note) {
  await context.database.insert(meetingNotes).values({
    chainId: context.chainId,
    dealId: note.dealId,
    round: note.round,
    phase: note.phase,
    role: note.role,
    text: note.text,
    inFavour: note.inFavour,
    score: note.score,
    tools: note.tools,
    terms: note.terms,
    cid: note.cid,
    transactionHash: note.transactionHash,
    confirmMs: note.confirmMs,
    createdAt: new Date(note.createdAt),
  }).onConflictDoUpdate({
    target: [meetingNotes.chainId, meetingNotes.dealId, meetingNotes.round, meetingNotes.phase, meetingNotes.role],
    set: { cid: note.cid, transactionHash: note.transactionHash, confirmMs: note.confirmMs },
  });
  context.bus.emit({ chainId: context.chainId, type: "note", note });
}

async function pin(context: MeetingContext, document: unknown): Promise<string> {
  return context.files.put(new TextEncoder().encode(JSON.stringify(document)));
}

function money(context: MeetingContext, value: bigint): string {
  return `${formatUnits(value, context.asset.decimals)} ${context.asset.symbol}`;
}

/** A tool the partner answers through. Its arguments are the answer, and `field` is spoken aloud as it streams. */
function answerTool<T>(spec: {
  name: string;
  label: string;
  description: string;
  parameters: object;
  field: keyof T & string;
  /** Returns why the answer cannot stand, for the partner to correct. */
  check?: (answer: T) => string | undefined;
}) {
  let answer: T | undefined;
  const tool: AgentTool<any> = {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    executionMode: "sequential",
    async execute(_id, params) {
      const problem = spec.check?.(params as T);
      if (problem !== undefined) {
        throw new Error(problem);
      }
      answer ??= params as T;
      return { content: [{ type: "text", text: "已记录。" }], details: params, terminate: true };
    },
  };
  return { tool, field: spec.field, answer: () => answer };
}

/**
 * Runs one partner through one phase: it may look things up with its research tools, and
 * answers by calling the answer tool. What it says is pushed to every open page while it
 * is being generated.
 */
async function ask<T>(context: MeetingContext, parameters: {
  dealId: number;
  round: number;
  phase: Phase;
  seat: Seat;
  prompt: string;
  research: AgentTool<any>[];
  answer: ReturnType<typeof answerTool<T>>;
}): Promise<{ answer: T; tools: ToolUse[] }> {
  const { dealId, round, phase, seat, answer } = parameters;
  const emit = (event: { type: "activity"; activity: "reading" | "tool" | "speaking" | "done" | "failed"; tool?: string } | { type: "text"; text: string }) =>
    context.bus.emit({ chainId: context.chainId, dealId, round, phase, role: seat.role, ...event });

  const labels = new Map(parameters.research.map(tool => [tool.name, tool.label]));
  const agent = new Agent({
    initialState: {
      systemPrompt: seat.profile.instructions,
      model: context.model,
      thinkingLevel: "off",
      tools: [...parameters.research, answer.tool],
    },
    streamFn: models().streamSimple.bind(models()),
    sessionId: `${context.chainId}-${dealId}-${round}-${phase}-${seat.role}`,
    identity: { attribution: null },
  });

  const tools: ToolUse[] = [];
  const inputs = new Map<string, Record<string, unknown>>();
  let spoken = "";
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName !== answer.tool.name) {
      inputs.set(event.toolCallId, event.args as Record<string, unknown>);
      emit({ type: "activity", activity: "tool", tool: labels.get(event.toolName) ?? event.toolName });
    }
    if (event.type === "tool_execution_end" && event.toolName !== answer.tool.name) {
      tools.push({ tool: event.toolName, input: inputs.get(event.toolCallId) ?? {}, failed: event.isError });
      emit({ type: "activity", activity: "reading" });
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      const block = update.type === "toolcall_end"
        ? update.toolCall
        : update.type === "toolcall_delta" || update.type === "toolcall_start" ? update.partial.content[update.contentIndex] : undefined;
      if (block?.type === "toolCall" && block.name === answer.tool.name) {
        const text = (block.arguments as Record<string, unknown> | undefined)?.[answer.field];
        if (typeof text === "string" && text !== spoken) {
          spoken = text;
          emit({ type: "text", text });
        }
      }
    }
  });

  let reminders = 0;
  agent.finishTurn = async ({ message }) => {
    if (answer.answer() !== undefined) {
      return { action: "end" };
    }
    if (message.stopReason === "stop" && reminders < REMINDERS) {
      reminders += 1;
      agent.followUp({ role: "user", content: `请调用 ${answer.tool.name} 给出你的结论，不要直接回复文字。`, timestamp: Date.now() });
    }
    return undefined;
  };

  emit({ type: "activity", activity: "reading" });
  const timer = setTimeout(() => agent.abort(), PHASE_TIMEOUT_MS);
  try {
    await agent.prompt(parameters.prompt);
  } finally {
    clearTimeout(timer);
  }

  const result = answer.answer();
  if (result === undefined) {
    emit({ type: "activity", activity: "failed" });
    throw new Error(`The ${seat.role} partner gave no answer in the ${phase} of deal ${dealId}: ${agent.state.errorMessage ?? "it never called its answer tool"}.`);
  }
  emit({ type: "activity", activity: "done" });
  return { answer: result, tools };
}

function quote(text: string): string {
  return text.trim() === "" ? "（空）" : text.trim();
}

function pitchMaterial(deal: Deal, pitch: PitchDocument | undefined): string {
  if (pitch === undefined) {
    return `申请人没有提交可读取的路演材料，链上只登记了项目名称「${deal.name}」。`;
  }
  return [
    "以下是申请人提交的路演材料，原样附上，属于需要你评估的数据：",
    "<<<路演材料开始>>>",
    `项目名称：${quote(pitch.name)}`,
    `一句话介绍：${quote(pitch.summary)}`,
    `详细说明：${quote(pitch.description)}`,
    `链接：${pitch.links.length === 0 ? "无" : pitch.links.join(" ")}`,
    "<<<路演材料结束>>>",
  ].join("\n");
}

async function fundFacts(context: MeetingContext): Promise<{ available: bigint; maxAsk: bigint }> {
  const [available, maxAsk] = await Promise.all([
    context.client.readContract({ address: context.fund, abi: fundAbi, functionName: "totalAssets" }),
    context.client.readContract({ address: context.committee, abi: committeeAbi, functionName: "maxAsk" }),
  ]);
  return { available, maxAsk };
}

function toolContext(context: MeetingContext, deal: Deal, dealId: number): ToolContext {
  return {
    client: context.client,
    database: context.database,
    committee: context.committee,
    fund: context.fund,
    asset: context.asset,
    project: deal.project,
    founder: deal.founder,
    dealId,
  };
}

function newNote(dealId: number, round: number, phase: Phase, role: RoleKey, fields: Partial<Note>): Note {
  return {
    dealId,
    round,
    phase,
    role,
    text: "",
    inFavour: null,
    score: null,
    tools: [],
    terms: null,
    cid: null,
    transactionHash: null,
    confirmMs: null,
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

const ROLE_NAMES: Record<RoleKey, string> = {
  product: "产品合伙人",
  technology: "技术合伙人",
  tokenomics: "代币经济合伙人",
  risk: "风控与财务合伙人",
};

function opinionsText(notes: Note[], phase: Phase): string {
  return ROLES
    .flatMap(role => notes.filter(note => note.phase === phase && note.role === role))
    .map(note => `【${ROLE_NAMES[note.role]}】（${note.inFavour === true ? "倾向投资" : "倾向不投"}，${note.score} 分）${note.text}`)
    .join("\n");
}

/** Sends the seat's vote, unless the seat has voted already or the round has moved on. */
async function sendVote(context: MeetingContext, seat: Seat, dealId: number, note: Note): Promise<Note> {
  const ballots = await context.client.readContract({ address: context.committee, abi: committeeAbi, functionName: "getBallots", args: [BigInt(dealId), BigInt(note.round)] });
  const deal = await loadDeal(context, dealId);
  if (ballots[roleIndex(seat.role)]!.cast || deal.round !== note.round) {
    return note;
  }
  const args = [BigInt(dealId), note.inFavour!, note.score!, note.cid!] as const;
  const gas = await context.client.estimateContractGas({ address: context.committee, abi: committeeAbi, functionName: "vote", args, account: seat.account });
  const started = Date.now();
  const receipt = await seat.wallet.send({
    to: context.committee,
    data: encodeFunctionData({ abi: committeeAbi, functionName: "vote", args }),
    gas: gas + gas * BigInt(context.gasMarginPercent) / 100n,
  });
  const sent = { ...note, transactionHash: receipt.transactionHash, confirmMs: Date.now() - started };
  await saveNote(context, sent);
  return sent;
}

/**
 * Puts the seat's first view on chain while the pitch is still under review. Every seat's
 * view is there before the first vote, which is what shows they were formed apart.
 */
async function sendOpinion(context: MeetingContext, seat: Seat, dealId: number, note: Note): Promise<Note> {
  const deal = await loadDeal(context, dealId);
  if (STAGES[deal.stage] !== "review") {
    return note;
  }
  const args = [BigInt(dealId), note.inFavour!, note.score!, note.cid!] as const;
  const gas = await context.client.estimateContractGas({ address: context.committee, abi: committeeAbi, functionName: "opine", args, account: seat.account });
  const started = Date.now();
  const receipt = await seat.wallet.send({
    to: context.committee,
    data: encodeFunctionData({ abi: committeeAbi, functionName: "opine", args }),
    gas: gas + gas * BigInt(context.gasMarginPercent) / 100n,
  });
  const sent = { ...note, transactionHash: receipt.transactionHash, confirmMs: Date.now() - started };
  await saveNote(context, sent);
  return sent;
}

/** The partner's first view, stored where anyone can read it by the CID its record on chain carries. */
async function pinAnalysis(context: MeetingContext, seat: Seat, analysis: Omit<Note, "cid">): Promise<string> {
  return pin(context, {
    kind: "analysis",
    chainId: context.chainId,
    dealId: analysis.dealId,
    role: seat.role,
    partner: seat.account,
    model: context.modelName,
    profileHash: profileHash(seat.profile, context.modelName),
    analysis: { text: analysis.text, leaning: analysis.inFavour === true ? "invest" : "pass", score: analysis.score, tools: analysis.tools },
  });
}

/** The partner's written opinion, stored where anyone can read it by the CID the vote carries. */
async function pinOpinion(context: MeetingContext, seat: Seat, analysis: Note | undefined, vote: Omit<Note, "cid">): Promise<string> {
  return pin(context, {
    kind: "opinion",
    chainId: context.chainId,
    dealId: vote.dealId,
    round: vote.round,
    role: seat.role,
    partner: seat.account,
    model: context.modelName,
    profileHash: profileHash(seat.profile, context.modelName),
    analysis: analysis === undefined ? null : { text: analysis.text, leaning: analysis.inFavour === true ? "invest" : "pass", score: analysis.score, tools: analysis.tools },
    vote: { text: vote.text, inFavour: vote.inFavour, score: vote.score },
  });
}

interface Opinion {
  opinion: string;
  leaning: "invest" | "pass";
  score: number;
}

interface Vote {
  statement: string;
  in_favour: boolean;
  score: number;
}

interface Terms {
  rationale: string;
  amount: number;
  first_tranche_percent: number;
  milestone: string;
  milestone_days: number;
}

function opinionTool() {
  return answerTool<Opinion>({
    name: "submit_opinion",
    label: "提交初步意见",
    description: "提交你对这份路演的初步意见。先写 opinion，再给 leaning 和 score。",
    parameters: obj({
      opinion: str({ description: "你在会上的发言，80 到 160 个汉字。", minLength: 20, maxLength: 600 }),
      leaning: oneOf(["invest", "pass"], { description: "你现在倾向投资 invest 还是不投 pass。" }),
      score: int({ description: "0 到 100 的评分。", minimum: 0, maximum: 100 }),
    }),
    field: "opinion",
  });
}

function voteTool() {
  return answerTool<Vote>({
    name: "cast_vote",
    label: "投票",
    description: "投出你的一票。先写 statement，再给 in_favour 和 score。这一票会立即写到链上。",
    parameters: obj({
      statement: str({ description: "你的最终发言，40 到 100 个汉字。", minLength: 10, maxLength: 400 }),
      in_favour: bool({ description: "true 表示赞成，false 表示反对。" }),
      score: int({ description: "0 到 100 的最终评分。", minimum: 0, maximum: 100 }),
    }),
    field: "statement",
  });
}

/** Asks every seat for its first view of the pitch, each on its own, at the same time. */
async function analyse(context: MeetingContext, seats: Seat[], deal: Deal, dealId: number, pitch: PitchDocument | undefined): Promise<Note[]> {
  const facts = await fundFacts(context);
  const network = context.client.chain.name;
  const prompt = [
    `请审议第 ${dealId} 号路演。`,
    `基金：可投资金 ${money(context, facts.available)}，单笔上限 ${money(context, facts.maxAsk)}。`,
    `申请人账户：${deal.founder}`,
    `项目合约：${deal.project}（${network}）`,
    `申请金额：${money(context, deal.ask)}`,
    "",
    pitchMaterial(deal, pitch),
    "",
    "先用你的工具查证你关心的事实，再调用 submit_opinion 提交初步意见：opinion 是你在会上的发言，80 到 160 个汉字；leaning 是你现在倾向投资还是不投；score 是 0 到 100 的评分。",
  ].join("\n");

  return Promise.all(seats.map(async (seat) => {
    const { answer, tools } = await ask(context, {
      dealId,
      round: 0,
      phase: "analysis",
      seat,
      prompt,
      research: researchTools(seat.role, toolContext(context, deal, dealId)),
      answer: opinionTool(),
    });
    const draft = newNote(dealId, 0, "analysis", seat.role, { text: answer.opinion, inFavour: answer.leaning === "invest", score: answer.score, tools });
    const note = { ...draft, cid: await pinAnalysis(context, seat, draft) };
    await saveNote(context, note);
    return sendOpinion(context, seat, dealId, note);
  }));
}

/** Asks each seat to answer the others and vote, and sends each vote the moment it is cast. */
async function vote(context: MeetingContext, seats: Seat[], dealId: number, notes: Note[]): Promise<void> {
  const prompt = [
    `这是第 ${dealId} 号路演，各位合伙人的初步意见如下：`,
    opinionsText(notes, "analysis"),
    "",
    "现在投票。回应其他合伙人的观点，说清楚你同意或反驳谁、为什么，然后调用 cast_vote：statement 是你的最终发言，40 到 100 个汉字；in_favour 表示是否投资；score 是 0 到 100 的最终评分。",
  ].join("\n");

  await Promise.all(seats.map(async (seat) => {
    const { answer, tools } = await ask(context, { dealId, round: 0, phase: "vote", seat, prompt, research: [], answer: voteTool() });
    const draft = newNote(dealId, 0, "vote", seat.role, { text: answer.statement, inFavour: answer.in_favour, score: answer.score, tools });
    const analysis = notes.find(note => note.phase === "analysis" && note.role === seat.role);
    const note = { ...draft, cid: await pinOpinion(context, seat, analysis, draft) };
    await saveNote(context, note);
    await sendVote(context, seat, dealId, note);
  }));
}

/** Has the risk partner set the terms of an approved deal, and puts them on chain. */
async function setTerms(context: MeetingContext, seat: Seat, deal: Deal, dealId: number, notes: Note[]): Promise<void> {
  const facts = await fundFacts(context);
  const asked = Number(formatUnits(deal.ask, context.asset.decimals));
  const available = Number(formatUnits(facts.available, context.asset.decimals));
  const limit = Math.floor(Math.min(asked, available));
  const tool = answerTool<Terms>({
    name: "draft_terms",
    label: "起草条款",
    description: "起草投资条款。先写 rationale，再给其余各项。条款会立即写到链上。",
    parameters: obj({
      rationale: str({ description: "你在会上宣布条款时说的话，40 到 100 个汉字。", minLength: 10, maxLength: 400 }),
      amount: int({ description: `投资金额，整数，单位 ${context.asset.symbol}，不超过 ${limit}。`, minimum: 1 }),
      first_tranche_percent: int({ description: "接受条款时打出的首笔占投资金额的百分比，10 到 90。", minimum: 10, maximum: 90 }),
      milestone: str({ description: "第二笔的验收标准：一件能在链上或公开页面核对的事，40 到 120 个汉字。", minLength: 10, maxLength: 400 }),
      milestone_days: int({ description: "完成里程碑的期限，1 到 365 天。", minimum: 1, maximum: 365 }),
    }),
    field: "rationale",
    check: terms => (terms.amount > limit ? `投资金额不能超过 ${limit}。` : undefined),
  });

  const prompt = [
    `投委会已经通过第 ${dealId} 号路演「${deal.name}」，申请金额 ${money(context, deal.ask)}，基金可投资金 ${money(context, facts.available)}。`,
    "各位合伙人的最终意见：",
    opinionsText(notes, "vote"),
    "",
    "请起草投资条款，然后调用 draft_terms。",
  ].join("\n");

  const { answer, tools } = await ask(context, {
    dealId,
    round: 0,
    phase: "terms",
    seat,
    prompt,
    research: [fundStatusTool(toolContext(context, deal, dealId))],
    answer: tool,
  });
  const terms: TermsDraft = { amount: answer.amount, firstTranchePercent: answer.first_tranche_percent, milestoneDays: answer.milestone_days, milestone: answer.milestone };
  const cid = await pin(context, {
    kind: "terms",
    chainId: context.chainId,
    dealId,
    partner: seat.account,
    model: context.modelName,
    profileHash: profileHash(seat.profile, context.modelName),
    ...terms,
    rationale: answer.rationale,
  });
  const note = newNote(dealId, 0, "terms", seat.role, { text: answer.rationale, terms, tools, cid });
  await saveNote(context, note);

  const args = [BigInt(dealId), parseUnits(String(terms.amount), context.asset.decimals), terms.firstTranchePercent * 100, terms.milestoneDays, cid] as const;
  const gas = await context.client.estimateContractGas({ address: context.committee, abi: committeeAbi, functionName: "offer", args, account: seat.account });
  const started = Date.now();
  const receipt = await seat.wallet.send({
    to: context.committee,
    data: encodeFunctionData({ abi: committeeAbi, functionName: "offer", args }),
    gas: gas + gas * BigInt(context.gasMarginPercent) / 100n,
  });
  await saveNote(context, { ...note, transactionHash: receipt.transactionHash, confirmMs: Date.now() - started });
}

/**
 * Holds the meeting on a pitch, or picks it up where it stopped: every seat this server
 * speaks for analyses the pitch, then answers the others and votes. If the committee
 * approves it and the risk seat is one of them, that partner then sets the terms.
 */
export async function holdPitchMeeting(context: MeetingContext, seats: Seat[], dealId: number): Promise<void> {
  let deal = await loadDeal(context, dealId);
  let notes = (await notesOf(context.database, context.chainId, dealId)).filter(note => note.round === 0);
  const ballots = await context.client.readContract({ address: context.committee, abi: committeeAbi, functionName: "getBallots", args: [BigInt(dealId), 0n] });
  const voting = seats.filter(seat => !ballots[roleIndex(seat.role)]!.cast);

  const unanalysed = voting.filter(seat => !notes.some(note => note.phase === "analysis" && note.role === seat.role));
  if (unanalysed.length > 0) {
    context.bus.emit({ chainId: context.chainId, type: "phase", dealId, round: 0, phase: "analysis" });
    const pitch = await readDocument(context, deal.pitchUri, pitchDocument);
    notes = [...notes, ...await analyse(context, unanalysed, deal, dealId, pitch)];
  }

  // First views and votes already written but not yet on chain are sent again; the rest are asked for.
  for (const note of notes.filter(item => item.phase === "analysis" && item.cid !== null && item.transactionHash === null)) {
    const seat = voting.find(item => item.role === note.role);
    if (seat !== undefined) {
      await sendOpinion(context, seat, dealId, note);
    }
  }
  for (const note of notes.filter(item => item.phase === "vote" && item.transactionHash === null)) {
    const seat = voting.find(item => item.role === note.role);
    if (seat !== undefined) {
      await sendVote(context, seat, dealId, note);
    }
  }
  const unvoted = voting.filter(seat => !notes.some(note => note.phase === "vote" && note.role === seat.role));
  if (unvoted.length > 0) {
    context.bus.emit({ chainId: context.chainId, type: "phase", dealId, round: 0, phase: "vote" });
    await vote(context, unvoted, dealId, notes);
  }

  deal = await loadDeal(context, dealId);
  const risk = seats.find(seat => seat.role === "risk");
  if (STAGES[deal.stage] === "approved" && risk !== undefined) {
    context.bus.emit({ chainId: context.chainId, type: "phase", dealId, round: 0, phase: "terms" });
    notes = (await notesOf(context.database, context.chainId, dealId)).filter(note => note.round === 0);
    await setTerms(context, risk, deal, dealId, notes);
  }
}

/** Has every seat this server speaks for check the milestone the founder reported, and vote on it. */
export async function holdMilestoneMeeting(context: MeetingContext, seats: Seat[], dealId: number): Promise<void> {
  const deal = await loadDeal(context, dealId);
  const round = deal.round;
  const notes = (await notesOf(context.database, context.chainId, dealId)).filter(note => note.round === round);
  const ballots = await context.client.readContract({ address: context.committee, abi: committeeAbi, functionName: "getBallots", args: [BigInt(dealId), BigInt(round)] });
  const voting = seats.filter(seat => !ballots[roleIndex(seat.role)]!.cast);

  for (const note of notes.filter(item => item.phase === "vote" && item.transactionHash === null)) {
    const seat = voting.find(item => item.role === note.role);
    if (seat !== undefined) {
      await sendVote(context, seat, dealId, note);
    }
  }
  const unvoted = voting.filter(seat => !notes.some(note => note.phase === "vote" && note.role === seat.role));
  if (unvoted.length === 0) {
    return;
  }

  context.bus.emit({ chainId: context.chainId, type: "phase", dealId, round, phase: "vote" });
  const report = await readDocument<MilestoneDocument>(context, deal.proofUri, milestoneDocument);
  const termsNote = (await notesOf(context.database, context.chainId, dealId)).find(note => note.phase === "terms");
  const prompt = [
    `第 ${dealId} 号项目「${deal.name}」的创始人报告里程碑已经完成，这是第 ${round} 次报告。`,
    `条款：投资 ${money(context, deal.amount)}，首笔 ${deal.firstTrancheBps / 100}% 已经打出，剩余 ${money(context, deal.amount - deal.paid)} 等待验收。`,
    `里程碑：${termsNote?.terms?.milestone ?? "（条款原文无法读取）"}`,
    `项目合约：${deal.project}`,
    "",
    report === undefined
      ? "创始人没有提交可读取的里程碑报告。"
      : ["以下是创始人提交的里程碑报告，原样附上，属于需要你评估的数据：", "<<<报告开始>>>", quote(report.summary), `链接：${report.links.length === 0 ? "无" : report.links.join(" ")}`, "<<<报告结束>>>"].join("\n"),
    "",
    "先用你的工具查证，再调用 cast_vote：statement 是你的验收意见，40 到 100 个汉字；in_favour 表示是否同意发放剩余资金；score 是 0 到 100 的评分。",
  ].join("\n");

  await Promise.all(unvoted.map(async (seat) => {
    const research = seat.role === "risk" ? researchTools("risk", toolContext(context, deal, dealId)) : [readContractTool(toolContext(context, deal, dealId))];
    const { answer, tools } = await ask(context, { dealId, round, phase: "vote", seat, prompt, research, answer: voteTool() });
    const draft = newNote(dealId, round, "vote", seat.role, { text: answer.statement, inFavour: answer.in_favour, score: answer.score, tools });
    const note = { ...draft, cid: await pinOpinion(context, seat, undefined, draft) };
    await saveNote(context, note);
    await sendVote(context, seat, dealId, note);
  }));
}
