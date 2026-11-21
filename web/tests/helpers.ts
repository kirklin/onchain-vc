import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Abi, Address, Hex } from "viem";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createTestClient, createWalletClient, defineChain, http, parseEther, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PERMIT2_ADDRESS } from "~/chain/contracts";
import { networks } from "~/chain/networks";
import { committeeAbi, fundAbi, tokenAbi } from "~/contracts/abis";

export const ANVIL_PORT = 8646;
export const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

export const testChain = defineChain({
  ...networks.local.chain,
  rpcUrls: { default: { http: [ANVIL_URL] } },
});

/** Accounts Anvil funds at genesis. Each test file takes its own so nonces never collide. */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
] as const satisfies readonly Hex[];

export function testClient(key: Hex) {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: testChain,
    transport: http(ANVIL_URL),
    pollingInterval: 50,
  }).extend(publicActions);
}

/** Deploys a contract from the Foundry build output. */
export async function deployContract(name: string, key: Hex, args: readonly unknown[] = []): Promise<Address> {
  const artifactPath = path.join(import.meta.dirname, "..", "..", "contracts", "out", `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: Abi; bytecode: { object: Hex } };

  const client = testClient(key);
  const hash = await client.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.contractAddress == null) {
    throw new Error(`Deploying ${name} produced no contract address.`);
  }
  return receipt.contractAddress;
}

export interface FundSystem {
  token: Address;
  forwarder: Address;
  committee: Address;
  badge: Address;
  fund: Address;
  /** The four partners' keys, in seat order, each funded with native tokens for gas. */
  partnerKeys: Hex[];
}

export interface Rules {
  minBond: bigint;
  maxAsk: bigint;
  reviewPeriod: number;
  acceptPeriod: number;
  unbondingPeriod: number;
  slashBps: number;
}

/** The rules script/Deploy.s.sol deploys with. */
export const RULES: Rules = {
  minBond: parseEther("1000"),
  maxAsk: parseEther("1000"),
  reviewPeriod: 86_400,
  acceptPeriod: 259_200,
  unbondingPeriod: 2_592_000,
  slashBps: 2000,
};
export const SEED = parseEther("100000");

/**
 * Deploys and wires the committee, its fund and badge the way script/Deploy.s.sol does,
 * with four fresh partners whose bonds are posted, and `investor` holding every share.
 */
export async function deployFundSystem(key: Hex, investor: Address, rules: Partial<Rules> = {}): Promise<FundSystem> {
  const deployer = testClient(key);
  const operator = deployer.account.address;
  const partnerKeys = Array.from({ length: 4 }, () => generatePrivateKey());
  const partners = partnerKeys.map(partner => privateKeyToAccount(partner).address);
  const tester = createTestClient({ chain: testChain, mode: "anvil", transport: http(ANVIL_URL) });
  for (const partner of partners) {
    await tester.setBalance({ address: partner, value: parseEther("10") });
  }

  const token = await deployContract("Token", key, ["Test USD", "tUSD", operator]);
  const forwarder = await deployContract("Forwarder", key);
  const committee = await deployContract("Committee", key, [token, forwarder, operator, { ...RULES, ...rules }, partners]);
  const badge = await deployContract("PortfolioBadge", key, [committee]);
  const fund = await deployContract("Fund", key, [token, "Onchain VC Fund", "OVC", PERMIT2_ADDRESS, committee, 5000, 259_200]);

  const send = async (hash: Promise<Hex>) => deployer.waitForTransactionReceipt({ hash: await hash });
  await send(deployer.writeContract({ address: committee, abi: committeeAbi, functionName: "bind", args: [fund, badge] }));
  await send(deployer.writeContract({ address: token, abi: tokenAbi, functionName: "mint", args: [operator, SEED + RULES.minBond * 4n] }));
  await send(deployer.writeContract({ address: token, abi: tokenAbi, functionName: "approve", args: [fund, SEED] }));
  await send(deployer.writeContract({ address: fund, abi: fundAbi, functionName: "deposit", args: [SEED, investor] }));
  await send(deployer.writeContract({ address: token, abi: tokenAbi, functionName: "approve", args: [committee, RULES.minBond * 4n] }));
  for (const partner of partners) {
    await send(deployer.writeContract({ address: committee, abi: committeeAbi, functionName: "postBond", args: [partner, RULES.minBond] }));
  }
  return { token, forwarder, committee, badge, fund, partnerKeys };
}

export interface RecordedCall {
  at: number;
  /** Number of JSON-RPC requests in the HTTP body. */
  size: number;
  methods: string[];
}

export interface RecordingUpstream {
  url: string;
  calls: RecordedCall[];
  /** Answers the next `count` HTTP requests with `status` instead of forwarding them. */
  failNext: (count: number, status: number) => void;
  close: () => Promise<void>;
}

/** A real HTTP server that forwards to Anvil and keeps a log of what passed through. */
export async function startRecordingUpstream(): Promise<RecordingUpstream> {
  const calls: RecordedCall[] = [];
  let failures = { count: 0, status: 0 };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(body) as { method: string }[] | { method: string };
      const items = Array.isArray(parsed) ? parsed : [parsed];
      calls.push({ at: Date.now(), size: items.length, methods: items.map(item => item.method) });

      if (failures.count > 0) {
        failures.count -= 1;
        response.writeHead(failures.status, { "content-type": "text/plain" });
        response.end("Rate limit exceeded");
        return;
      }

      const forwarded = await fetch(ANVIL_URL, { method: "POST", headers: { "content-type": "application/json" }, body });
      response.writeHead(forwarded.status, { "content-type": "application/json" });
      response.end(await forwarded.text());
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    failNext: (count, status) => {
      failures = { count, status };
    },
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}
