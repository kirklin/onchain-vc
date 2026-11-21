import type { Address, Hex } from "viem";
import type { FundSystem } from "./helpers";
import type { MeetingContext } from "~/server/committee/meeting";
import type { Database } from "~/server/db";
import type { ChainServices } from "~/server/services";
import { createTestClient, getAddress, http, parseEther, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { networks } from "~/chain/networks";
import { committeeAbi, fundAbi } from "~/contracts/abis";
import { MeetingBus } from "~/server/committee/bus";
import { chunkDocs, indexDocs, searchIndex } from "~/server/committee/docs";
import { models } from "~/server/committee/models";
import { profileHash, PROFILES } from "~/server/committee/profiles";
import { CommitteeRunner } from "~/server/committee/runner";
import { founderRecordTool, fundStatusTool, pushedSelectors, readContractTool, similarPitchesTool } from "~/server/committee/tools";
import { openDatabase } from "~/server/db";
import { DiskFileStore } from "~/server/files";
import { Indexer } from "~/server/indexer";
import { eventSource } from "~/server/indexing";
import { Operator } from "~/server/operator";
import { RpcGateway } from "~/server/rpc-gateway";
import { ANVIL_KEYS, ANVIL_URL, deployContract, deployFundSystem, testChain, testClient } from "./helpers";

const key = ANVIL_KEYS[0];
const client = testClient(key);
const tester = createTestClient({ chain: testChain, mode: "anvil", transport: http(ANVIL_URL) });
const MODEL = "deepseek/deepseek-flash";

let system: FundSystem;
let database: Database;

beforeAll(async () => {
  system = await deployFundSystem(key, client.account.address);
  database = await openDatabase({});
});

function services(): ChainServices {
  const gateway = new RpcGateway({ upstreams: [ANVIL_URL], batchIntervalMs: 0, blockTtlMs: 50 });
  const network = { ...networks.local, chain: testChain };
  return {
    name: "local",
    network,
    gateway,
    client: client as unknown as ChainServices["client"],
    operator: new Operator({ key, chain: testChain, gateway }),
    faucet: undefined,
    relay: undefined,
    join: undefined,
  };
}

function context(fund: FundSystem): MeetingContext {
  return {
    chainId: testChain.id,
    client: client as unknown as MeetingContext["client"],
    database,
    files: new DiskFileStore(`.data/test-files-${Date.now()}`),
    bus: new MeetingBus(),
    model: models().getModel("deepseek", "deepseek-flash")!,
    modelName: MODEL,
    committee: fund.committee,
    fund: fund.fund,
    asset: { address: fund.token, symbol: "tUSD", decimals: 18 },
    gasMarginPercent: 20,
  };
}

/** Pitches `project` from a fresh founder account through the forwarder-free path: the founder pays its own gas. */
async function pitch(fund: FundSystem, project: Address, name: string): Promise<{ dealId: bigint; founder: Address }> {
  const founderKey = generatePrivateKey();
  const founder = privateKeyToAccount(founderKey).address;
  await tester.setBalance({ address: founder, value: parseEther("1") });
  const wallet = testClient(founderKey);
  const hash = await wallet.writeContract({ address: fund.committee, abi: committeeAbi, functionName: "pitch", args: [project, parseEther("200"), name, "bafkreidemo"] });
  await wallet.waitForTransactionReceipt({ hash });
  const dealId = await client.readContract({ address: fund.committee, abi: committeeAbi, functionName: "openDealOf", args: [founder] });
  return { dealId, founder };
}

async function index(fund: FundSystem) {
  await new Indexer({
    database,
    client,
    sources: [eventSource(testChain.id, "committee", fund.committee, committeeAbi, 0n)],
    confirmations: 0,
    logRange: 1000n,
    pollMs: 50,
  }).sync();
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map(part => part.text ?? "").join("\n");
}

function toolContext(fund: FundSystem, deal: { project: Address; founder: Address; dealId: number }) {
  return { client: client as unknown as MeetingContext["client"], database, committee: fund.committee, fund: fund.fund, asset: { address: fund.token, symbol: "tUSD", decimals: 18 }, ...deal };
}

describe("partners' tools", () => {
  it("finds a contract's functions in its bytecode", async () => {
    const token = await deployContract("Token", key, ["Pizza Coin", "PIZZA", client.account.address]);
    const code = (await client.getCode({ address: token }))!;
    const selectors = pushedSelectors(code);
    expect(selectors).toContain(toFunctionSelector("transfer(address,uint256)"));
    expect(selectors).toContain(toFunctionSelector("mint(address,uint256)"));
    expect(selectors).not.toContain(toFunctionSelector("upgradeTo(address)"));
  });

  it("reads a token contract the way a reviewer would", async () => {
    const token = await deployContract("Token", key, ["Pizza Coin", "PIZZA", client.account.address]);
    const tool = readContractTool(toolContext(system, { project: token, founder: client.account.address, dealId: 1 }));

    const text = textOf(await tool.execute("call", { address: token }));

    expect(text).toContain(`地址 ${getAddress(token)}`);
    expect(text).toContain("作为代币：Pizza Coin（PIZZA），精度 18，发行量 0。");
    expect(text).toContain("mint(address,uint256)");
    expect(text).toContain(`所有者 ${client.account.address} 持有 0% 的发行量。`);
    expect(text).toContain("本地链没有源码验证服务");
  });

  it("checks the functions a pitch names against the contract, and calls the ones that take nothing", async () => {
    const token = await deployContract("Token", key, ["Pizza Coin", "PIZZA", client.account.address]);
    const tool = readContractTool(toolContext(system, { project: token, founder: client.account.address, dealId: 1 }));

    const unchecked = textOf(await tool.execute("call", { address: token }));
    expect(unchecked).toContain("项目自己写的函数没有核对");

    const text = textOf(await tool.execute("call", { address: token, functions: ["claim()", "symbol() returns (string)", "totalSupply() returns (uint256)", "function sign(string)"] }));
    expect(text).toContain("claim()：字节码里有这个函数。");
    expect(text).toContain("symbol() returns (string)：字节码里有这个函数，现在返回 PIZZA。");
    expect(text).toContain("totalSupply() returns (uint256)：字节码里有这个函数，现在返回 0。");
    expect(text).toContain("function sign(string)：字节码里没有这个函数。");
    await expect(tool.execute("call", { address: token, functions: ["not a signature"] })).rejects.toThrow();
  });

  it("says when an address holds no code", async () => {
    const someone = privateKeyToAccount(generatePrivateKey()).address;
    const tool = readContractTool(toolContext(system, { project: someone, founder: someone, dealId: 1 }));
    expect(textOf(await tool.execute("call", { address: someone }))).toBe(`${someone} 上没有合约代码，是普通账户。`);
    await expect(tool.execute("call", { address: "not an address" })).rejects.toThrow("不是合法的地址");
  });

  it("reports the fund's money and the committee's limits", async () => {
    const tool = fundStatusTool(toolContext(system, { project: system.token, founder: client.account.address, dealId: 1 }));
    const text = textOf(await tool.execute("call", {}));
    const available = await client.readContract({ address: system.fund, abi: fundAbi, functionName: "totalAssets" });
    expect(text).toContain(`基金可投资金 ${Number(available / 10n ** 18n)} tUSD，单笔上限 1000 tUSD`);
  });

  it("finds a founder's earlier pitches and pitches of identical contracts", async () => {
    const first = await deployContract("Faucet", key);
    const copy = await deployContract("Faucet", key);
    const earlier = await pitch(system, first, "Faucet One");
    const later = await pitch(system, copy, "Faucet One");
    await index(system);

    const similar = similarPitchesTool(toolContext(system, { project: copy, founder: later.founder, dealId: Number(later.dealId) }));
    const similarText = textOf(await similar.execute("call", {}));
    expect(similarText).toContain(`字节码完全相同的路演：第 ${earlier.dealId} 号「Faucet One」`);
    expect(similarText).toContain(`同名的路演：第 ${earlier.dealId} 号「Faucet One」`);

    const record = founderRecordTool(toolContext(system, { project: copy, founder: later.founder, dealId: Number(later.dealId) }));
    const recordText = textOf(await record.execute("call", {}));
    expect(recordText).toContain(`申请人 ${later.founder} 自己发出过 1 笔交易`);
    expect(recordText).toContain("之前没有在本基金路演过。");
  });
});

describe("committee runner", () => {
  it("publishes each seat's profile once, with the model it runs on", async () => {
    const fund = await deployFundSystem(key, client.account.address);
    const runner = new CommitteeRunner(context(fund), services(), fund.partnerKeys);

    await runner.prepare();

    expect(runner.seats.map(seat => seat.role)).toEqual(["product", "technology", "tokenomics", "risk"]);
    for (const [index, partnerKey] of fund.partnerKeys.entries()) {
      const partner = await client.readContract({ address: fund.committee, abi: committeeAbi, functionName: "getPartner", args: [privateKeyToAccount(partnerKey).address] });
      expect(partner.name).toBe(PROFILES[index]!.name);
      expect(partner.profileHash).toBe(profileHash(PROFILES[index]!, MODEL));
    }

    const nonces = await Promise.all(fund.partnerKeys.map(partnerKey => client.getTransactionCount({ address: privateKeyToAccount(partnerKey).address })));
    await new CommitteeRunner(context(fund), services(), fund.partnerKeys).prepare();
    expect(await Promise.all(fund.partnerKeys.map(partnerKey => client.getTransactionCount({ address: privateKeyToAccount(partnerKey).address })))).toEqual(nonces);
  });

  it("speaks only for the seats whose keys it holds", async () => {
    const fund = await deployFundSystem(key, client.account.address);
    const runner = new CommitteeRunner(context(fund), services(), [fund.partnerKeys[3]! as Hex, generatePrivateKey()]);
    await runner.prepare();
    expect(runner.seats.map(seat => seat.role)).toEqual(["risk"]);
  });

  it("posts the bonds again after a veto has cost the approving seats part of them", async () => {
    const fund = await deployFundSystem(key, client.account.address);
    const runner = new CommitteeRunner(context(fund), services(), fund.partnerKeys);
    await runner.prepare();
    const minBond = await client.readContract({ address: fund.committee, abi: committeeAbi, functionName: "minBond" });
    const bonds = () => Promise.all(fund.partnerKeys.map(async partnerKey =>
      (await client.readContract({ address: fund.committee, abi: committeeAbi, functionName: "getPartner", args: [privateKeyToAccount(partnerKey).address] })).bond));

    const { dealId } = await pitch(fund, await deployContract("Faucet", key), "Vetoed");
    for (const partnerKey of fund.partnerKeys.slice(0, 3)) {
      const partner = testClient(partnerKey as Hex);
      await partner.waitForTransactionReceipt({ hash: await partner.writeContract({ address: fund.committee, abi: committeeAbi, functionName: "vote", args: [dealId, true, 80, "bafkreidemo"] }) });
    }
    // The fund weighs the veto by the shares held at the approval, which it reads once a later block exists.
    const approved = await client.getBlockNumber();
    await expect.poll(() => client.getBlockNumber({ cacheTime: 0 })).toBeGreaterThan(approved);
    await client.waitForTransactionReceipt({ hash: await client.writeContract({ address: fund.fund, abi: fundAbi, functionName: "proposeVeto", args: [dealId] }) });
    expect(await bonds()).toEqual([minBond * 8n / 10n, minBond * 8n / 10n, minBond * 8n / 10n, minBond]);

    await runner.tick();

    expect(await bonds()).toEqual([minBond, minBond, minBond, minBond]);
  });

  it("closes a deal whose review ran out and tells every page", async () => {
    // A two-second review, so the chain's clock need not be moved for the other test files.
    const fund = await deployFundSystem(key, client.account.address, { reviewPeriod: 2 });
    const meeting = context(fund);
    const events: unknown[] = [];
    meeting.bus.subscribe(event => events.push(event));
    const { dealId } = await pitch(fund, await deployContract("Faucet", key), "Too Late");
    await expect.poll(async () => (await client.getBlock()).timestamp, { timeout: 10_000 })
      .toBeGreaterThan((await client.readContract({ address: fund.committee, abi: committeeAbi, functionName: "getDeal", args: [dealId] })).deadline);

    // No seats are held here, so nothing but the closing happens.
    await new CommitteeRunner(meeting, services(), []).tick();

    const deal = await client.readContract({ address: fund.committee, abi: committeeAbi, functionName: "getDeal", args: [dealId] });
    expect(deal.stage).toBe(8);
    expect(events).toContainEqual({ chainId: testChain.id, type: "stage", dealId: Number(dealId), stage: "review" });
  });
});

describe("monad docs search", () => {
  const full = [
    "# Monad Documentation",
    "",
    "# Execution",
    "Source: https://docs.example.com/execution",
    "Transactions are executed optimistically in parallel and merged in order.",
    "## Block time",
    "Blocks are produced every few hundred milliseconds.",
    "# Gas",
    "Source: https://docs.example.com/gas",
    "The sender pays for the gas limit, not for the gas used.",
  ].join("\n");

  it("splits the file into pages and sections, each with its source", () => {
    const chunks = chunkDocs(full);
    expect(chunks).toEqual([
      { title: "Execution", url: "https://docs.example.com/execution", text: "Transactions are executed optimistically in parallel and merged in order." },
      { title: "Execution", url: "https://docs.example.com/execution", text: "## Block time\nBlocks are produced every few hundred milliseconds." },
      { title: "Gas", url: "https://docs.example.com/gas", text: "The sender pays for the gas limit, not for the gas used." },
    ]);
  });

  it("ranks the sections that share the query's words first", () => {
    const index = indexDocs(chunkDocs(full));
    expect(searchIndex(index, "gas limit", 1)[0]!.url).toBe("https://docs.example.com/gas");
    expect(searchIndex(index, "parallel execution", 1)[0]!.url).toBe("https://docs.example.com/execution");
    expect(searchIndex(index, "bridge", 3)).toEqual([]);
  });
});
