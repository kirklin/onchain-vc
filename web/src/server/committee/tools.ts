import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AbiFunction, Address, Chain, Hex, PublicClient, Transport } from "viem";
import type { Database } from "../db";
import type { RoleKey, StageKey } from "~/chain/committee";
import type { Network } from "~/chain/networks";
import { Buffer } from "node:buffer";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { and, asc, eq } from "drizzle-orm";
import { formatEther, formatUnits, getAddress, isAddress, keccak256, parseAbi, parseAbiItem, toFunctionSelector } from "viem";
import { STAGES } from "~/chain/committee";
import { networks } from "~/chain/networks";
import { committeeAbi, fundAbi } from "~/contracts/abis";
import { chainEvents } from "../db/schema";
import { searchMonadDocs } from "./docs";

/** What the partners' tools read from: the chain, the contracts and the indexed history. */
export interface ToolContext {
  client: PublicClient<Transport, Chain>;
  database: Database;
  committee: Address;
  fund: Address;
  asset: { address: Address; symbol: string; decimals: number };
  /** The project contract of the deal under discussion. */
  project: Address;
  founder: Address;
  dealId: number;
}

const LOCAL_CHAIN_ID = 31_337;

/** How the partners speak of each stage of a deal. */
export const STAGE_NAMES: Record<StageKey, string> = {
  review: "审议中",
  approved: "已通过",
  rejected: "被否决",
  offered: "已出条款",
  funded: "已投资",
  milestone: "里程碑验收中",
  completed: "已完成",
  vetoed: "被出资人否决",
  expired: "已过期",
};
const EIP1967_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
const MAX_SOURCE_CHARS = 6000;
const MAX_CHECKED_FUNCTIONS = 12;

/** Functions worth noticing in someone's contract, by the 4-byte selector they compile to. */
const KNOWN_FUNCTIONS = [
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "balanceOf(address)",
  "totalSupply()",
  "mint(address,uint256)",
  "mint(uint256)",
  "mint()",
  "safeMint(address,uint256)",
  "burn(uint256)",
  "burnFrom(address,uint256)",
  "owner()",
  "transferOwnership(address)",
  "renounceOwnership()",
  "grantRole(bytes32,address)",
  "pause()",
  "unpause()",
  "blacklist(address)",
  "addToBlacklist(address)",
  "setFee(uint256)",
  "setTax(uint256)",
  "withdraw()",
  "withdraw(uint256)",
  "deposit()",
  "deposit(uint256)",
  "stake(uint256)",
  "claim()",
  "swap(uint256,uint256,address,bytes)",
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
  "ownerOf(uint256)",
  "tokenURI(uint256)",
  "safeTransferFrom(address,address,uint256)",
  "setApprovalForAll(address,bool)",
  "multicall(bytes[])",
  "execute(address,uint256,bytes)",
  "vote(uint256,bool)",
  "propose(address[],uint256[],bytes[],string)",
];
const SELECTORS = new Map<string, string>(KNOWN_FUNCTIONS.map(signature => [toFunctionSelector(signature), signature]));

const erc20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);

/** The 4-byte values pushed by PUSH4, which is how a contract's dispatcher names its functions. */
export function pushedSelectors(code: Hex): Set<string> {
  const bytes = Buffer.from(code.slice(2), "hex");
  const found = new Set<string>();
  for (let index = 0; index < bytes.length; index += 1) {
    const opcode = bytes[index]!;
    if (opcode === 0x63) {
      found.add(`0x${bytes.subarray(index + 1, index + 5).toString("hex")}`);
    }
    // PUSH1 to PUSH32 carry 1 to 32 bytes of data, which are not opcodes.
    if (opcode >= 0x60 && opcode <= 0x7F) {
      index += opcode - 0x5F;
    }
  }
  return found;
}

function text(lines: (string | undefined)[]) {
  return { content: [{ type: "text" as const, text: lines.filter(line => line !== undefined).join("\n") }] };
}

function checkedAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`${value} 不是合法的地址。`);
  }
  return getAddress(value);
}

async function verifiedSource(chainId: number, address: Address): Promise<string> {
  if (chainId === LOCAL_CHAIN_ID) {
    return "源码验证：本地链没有源码验证服务。";
  }
  // A chain whose explorer runs its own Sourcify keeps what was verified there, which the
  // public one does not have. Both answer the same lookup, so the chain's own is asked first.
  const own = Object.values<Network>(networks).find(network => network.chain.id === chainId)?.verifierUrl;
  const lookups = [
    ...(own === undefined ? [] : [new URL(`v2/contract/${chainId}/${address}?fields=sources`, own)]),
    new URL(`https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=sources`),
  ];
  let body: { sources?: Record<string, { content: string }> } | undefined;
  for (const lookup of lookups) {
    const response = await fetch(lookup, { headers: { "user-agent": "onchain-vc" } });
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`${lookup.host} 返回 HTTP ${response.status}。`);
    }
    body = await response.json() as { sources?: Record<string, { content: string }> };
    break;
  }
  if (body === undefined) {
    return "源码验证：没有在 Sourcify 验证过源码。";
  }
  const files = Object.entries(body.sources ?? {}).filter(([file]) => !file.includes("node_modules") && !file.startsWith("lib/"));
  const joined = files.map(([file, source]) => `// ${file}\n${source.content}`).join("\n\n");
  return `源码验证：已在 Sourcify 验证，共 ${files.length} 个项目文件。源码${joined.length > MAX_SOURCE_CHARS ? `前 ${MAX_SOURCE_CHARS} 个字符` : ""}如下：\n${joined.slice(0, MAX_SOURCE_CHARS)}`;
}

function shown(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(shown).join("，")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, (_key, field: unknown) => (typeof field === "bigint" ? field.toString() : field));
  }
  return String(value);
}

/**
 * Looks in a contract's dispatcher for the functions a pitch names, and calls the ones that
 * take nothing and say what they return. A project's own functions appear in no list of
 * well-known ones, so this is how a partner checks that the contract does what the pitch says.
 */
async function checkFunctions(client: ToolContext["client"], address: Address, selectors: Set<string>, signatures: string[]): Promise<string[]> {
  const named = signatures.map((signature) => {
    const item = parseAbiItem(`function ${signature.trim().replace(/^function\s+/, "")}`) as AbiFunction;
    return { signature, item, present: selectors.has(toFunctionSelector(item)) };
  });
  const callable = named.filter(({ item, present }) => present && item.inputs.length === 0 && item.outputs.length > 0);
  const results = await client.multicall({
    allowFailure: true,
    contracts: callable.map(({ item }) => ({ address, abi: [item], functionName: item.name })),
  });
  return named.map((entry) => {
    if (!entry.present) {
      return `${entry.signature}：字节码里没有这个函数。`;
    }
    const index = callable.indexOf(entry);
    if (index === -1) {
      return `${entry.signature}：字节码里有这个函数。`;
    }
    const result = results[index]!;
    return result.status === "success"
      ? `${entry.signature}：字节码里有这个函数，现在返回 ${shown(result.result)}。`
      : `${entry.signature}：字节码里有这个函数，这次调用没有成功。`;
  });
}

/** Reads a contract the way a reviewer would: size, functions, proxies, token facts and source. */
export function readContractTool(context: ToolContext): AgentTool<any> {
  const parameters = obj({
    address: str({ description: "要读取的合约地址，0x 开头。通常是项目合约。" }),
    functions: opt(arr(
      str({ description: "一个函数的 Solidity 签名，例如 sign(string) 或 count() returns (uint256)。" }),
      { maxItems: MAX_CHECKED_FUNCTIONS, description: "路演材料里提到的函数，按签名逐个写。工具会核对字节码里有没有每个函数；不带参数并且写了 returns 的函数还会调用一次，给出现在的返回值。" },
    )),
  });
  const tool: AgentTool<typeof parameters> = {
    name: "read_contract",
    label: "读取合约",
    description: "读取链上一个合约：字节码大小和哈希、常见函数里能认出的、是否代理合约、作为代币的名称和发行量、所有者，以及在 Sourcify 验证过的源码。项目自己写的函数不在常见函数里，要核对它们，把签名放进 functions。",
    parameters,
    async execute(_id, params) {
      const address = checkedAddress(params.address);
      const { client } = context;
      const code = await client.getCode({ address });
      if (code === undefined || code === "0x") {
        return { ...text([`${address} 上没有合约代码，是普通账户。`]), details: { address, contract: false } };
      }

      const lines: string[] = [`地址 ${address}，字节码 ${(code.length - 2) / 2} 字节，哈希 ${keccak256(code)}。`];
      let logic = code;
      const minimal = MINIMAL_PROXY.exec(code);
      const slot = await client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION });
      const implementation = minimal === null
        ? (slot === undefined || BigInt(slot) === 0n ? undefined : getAddress(`0x${slot.slice(-40)}`))
        : getAddress(`0x${minimal[1]}`);
      if (implementation !== undefined) {
        lines.push(`这是代理合约，逻辑在 ${implementation}${minimal === null ? "，按 EIP-1967 可以升级" : "，是不可升级的最小代理"}。`);
        logic = (await client.getCode({ address: implementation })) ?? "0x";
      }

      const selectors = pushedSelectors(logic);
      const known = [...selectors].flatMap(selector => SELECTORS.get(selector) ?? []);
      lines.push(`字节码里约有 ${selectors.size} 个函数入口。常见的代币、权限和升级函数里，认出的有：${known.length === 0 ? "无" : known.join("、")}。`);
      if (params.functions !== undefined && params.functions.length > 0) {
        lines.push("按签名核对的结果：", ...await checkFunctions(client, address, selectors, params.functions));
      } else {
        lines.push("项目自己写的函数没有核对。要核对，带上 functions 再读一次。");
      }

      const reads = await client.multicall({
        allowFailure: true,
        contracts: [
          { address, abi: erc20, functionName: "name" },
          { address, abi: erc20, functionName: "symbol" },
          { address, abi: erc20, functionName: "decimals" },
          { address, abi: erc20, functionName: "totalSupply" },
          { address, abi: erc20, functionName: "owner" },
        ],
      });
      const [name, symbol, decimals, supply, owner] = reads.map(read => (read.status === "success" ? read.result : undefined));
      if (symbol !== undefined && supply !== undefined) {
        const digits = typeof decimals === "number" ? decimals : 0;
        lines.push(`作为代币：${String(name ?? "")}（${String(symbol)}），精度 ${digits}，发行量 ${formatUnits(supply as bigint, digits)}。`);
        if (owner !== undefined) {
          const held = await client.readContract({ address, abi: erc20, functionName: "balanceOf", args: [owner as Address] });
          const share = (supply as bigint) === 0n ? 0 : Number(held * 10_000n / (supply as bigint)) / 100;
          lines.push(`所有者 ${String(owner)} 持有 ${share}% 的发行量。`);
        }
      } else if (owner !== undefined) {
        lines.push(`所有者是 ${String(owner)}。`);
      }
      lines.push(`合约持有原生币 ${formatEther(await client.getBalance({ address }))}。`);
      lines.push(await verifiedSource(client.chain.id, implementation ?? address));
      return { ...text(lines), details: { address, contract: true, size: (code.length - 2) / 2, functions: known } };
    },
  };
  return tool;
}

export function searchDocsTool(): AgentTool<any> {
  const parameters = obj({ query: str({ description: "英文关键词，例如 parallel execution、block time、contract size limit。" }) });
  const tool: AgentTool<typeof parameters> = {
    name: "search_monad_docs",
    label: "查阅 Monad 文档",
    description: "在 Monad 官方开发者文档里按关键词检索，返回最相关的三段原文和出处。",
    parameters,
    async execute(_id, params) {
      const found = await searchMonadDocs(params.query);
      if (found.length === 0) {
        return { ...text([`文档里没有找到和「${params.query}」相关的内容。`]), details: { results: 0 } };
      }
      return {
        ...text(found.map(chunk => `【${chunk.title}】${chunk.url}\n${chunk.text}`)),
        details: { results: found.length },
      };
    },
  };
  return tool;
}

function amount(value: bigint, context: ToolContext) {
  return `${formatUnits(value, context.asset.decimals)} ${context.asset.symbol}`;
}

export function fundStatusTool(context: ToolContext): AgentTool<any> {
  return {
    name: "fund_status",
    label: "查看基金",
    description: "查看基金现在能投多少钱、单笔上限、已经为别的交易预留了多少，以及历次决定的统计。",
    parameters: obj({}),
    async execute() {
      const { client } = context;
      const [available, maxAsk, committed, dealCount] = await Promise.all([
        client.readContract({ address: context.fund, abi: fundAbi, functionName: "totalAssets" }),
        client.readContract({ address: context.committee, abi: committeeAbi, functionName: "maxAsk" }),
        client.readContract({ address: context.committee, abi: committeeAbi, functionName: "committed" }),
        client.readContract({ address: context.committee, abi: committeeAbi, functionName: "dealCount" }),
      ]);
      const decided = await context.database
        .select({ args: chainEvents.args })
        .from(chainEvents)
        .where(and(eq(chainEvents.chainId, client.chain.id), eq(chainEvents.name, "StageChanged")));
      const counts = new Map<string, number>();
      for (const { args } of decided) {
        const stage = STAGES[Number(args.stage)]!;
        counts.set(stage, (counts.get(stage) ?? 0) + 1);
      }
      return {
        ...text([
          `基金可投资金 ${amount(available, context)}，单笔上限 ${amount(maxAsk, context)}，已为其他交易预留 ${amount(committed, context)}。`,
          `至今收到 ${dealCount} 份路演，通过 ${counts.get("approved") ?? 0} 份，否决 ${counts.get("rejected") ?? 0} 份，被出资人否决 ${counts.get("vetoed") ?? 0} 份。`,
        ]),
        details: { available: available.toString(), maxAsk: maxAsk.toString() },
      };
    },
  };
}

export function founderRecordTool(context: ToolContext): AgentTool<any> {
  return {
    name: "founder_record",
    label: "查看申请人",
    description: "查看申请人账户的来历：发过多少笔交易、余额，以及之前在本基金的路演和结果。",
    parameters: obj({}),
    async execute() {
      const { client, founder } = context;
      const [nonce, balance, pitches] = await Promise.all([
        client.getTransactionCount({ address: founder }),
        client.getBalance({ address: founder }),
        context.database
          .select({ dealId: chainEvents.dealId, args: chainEvents.args })
          .from(chainEvents)
          .where(and(eq(chainEvents.chainId, client.chain.id), eq(chainEvents.name, "Pitched"), eq(chainEvents.account, founder)))
          .orderBy(asc(chainEvents.blockNumber)),
      ]);
      const earlier = pitches.filter(pitch => Number(pitch.dealId) !== context.dealId);
      const stages = earlier.length === 0
        ? []
        : await Promise.all(earlier.map(async (pitch) => {
            const deal = await client.readContract({ address: context.committee, abi: committeeAbi, functionName: "getDeal", args: [pitch.dealId!] });
            return `第 ${pitch.dealId} 号「${String(pitch.args.name)}」：${STAGE_NAMES[STAGES[deal.stage]!]}`;
          }));
      return {
        ...text([
          `申请人 ${founder} 自己发出过 ${nonce} 笔交易，持有原生币 ${formatEther(balance)}。${nonce === 0 ? "这是一个新账户，路演是通过代付提交的。" : ""}`,
          earlier.length === 0 ? "之前没有在本基金路演过。" : `之前的路演：${stages.join("；")}。`,
        ]),
        details: { nonce, earlier: earlier.length },
      };
    },
  };
}

export function similarPitchesTool(context: ToolContext): AgentTool<any> {
  return {
    name: "similar_pitches",
    label: "比对其他路演",
    description: "把这个项目的合约字节码和名字，与本基金收到的所有其他路演比对，找出重复申请和一模一样的合约。",
    parameters: obj({}),
    async execute() {
      const { client } = context;
      const pitches = await context.database
        .select({ dealId: chainEvents.dealId, args: chainEvents.args })
        .from(chainEvents)
        .where(and(eq(chainEvents.chainId, client.chain.id), eq(chainEvents.name, "Pitched")))
        .orderBy(asc(chainEvents.blockNumber));
      const others = pitches.filter(pitch => Number(pitch.dealId) !== context.dealId);
      const ownCode = await client.getCode({ address: context.project });
      const ownHash = ownCode === undefined ? undefined : keccak256(ownCode);
      const codes = await Promise.all(others.map(pitch => client.getCode({ address: pitch.args.project as Address })));
      const sameCode = others.filter((_, index) => codes[index] !== undefined && keccak256(codes[index]!) === ownHash);
      const self = pitches.find(pitch => Number(pitch.dealId) === context.dealId);
      const ownName = String(self?.args.name ?? "").trim().toLowerCase();
      const sameName = others.filter(pitch => String(pitch.args.name).trim().toLowerCase() === ownName);
      const describe = (list: typeof others) => list.map(pitch => `第 ${pitch.dealId} 号「${String(pitch.args.name)}」（申请人 ${String(pitch.args.founder)}）`).join("；");
      return {
        ...text([
          `本基金共收到 ${pitches.length} 份路演。`,
          sameCode.length === 0 ? "没有其他路演的合约字节码与它相同。" : `字节码完全相同的路演：${describe(sameCode)}。`,
          sameName.length === 0 ? "没有同名的路演。" : `同名的路演：${describe(sameName)}。`,
        ]),
        details: { sameCode: sameCode.length, sameName: sameName.length },
      };
    },
  };
}

/** The research each seat does before speaking. */
export function researchTools(role: RoleKey, context: ToolContext): AgentTool<any>[] {
  switch (role) {
    case "product":
      return [readContractTool(context)];
    case "technology":
      return [readContractTool(context), searchDocsTool()];
    case "tokenomics":
      return [readContractTool(context), fundStatusTool(context)];
    case "risk":
      return [founderRecordTool(context), similarPitchesTool(context), fundStatusTool(context)];
  }
}
