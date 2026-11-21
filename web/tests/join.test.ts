import type { Address, Hex } from "viem";
import type { FundSystem } from "./helpers";
import type { JoinOptions } from "~/server/join";
import { createTestClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { fundAbi } from "~/contracts/abis";
import { JoinService } from "~/server/join";
import { Operator } from "~/server/operator";
import { RpcGateway } from "~/server/rpc-gateway";
import { ANVIL_URL, deployContract, deployFundSystem, testChain } from "./helpers";

// An account of its own, so its nonces never meet another test file's.
const key: Hex = generatePrivateKey();
const shares = parseEther("1000");
const gasMoney = parseEther("0.1");

let system: FundSystem;
let reception: Address;

beforeAll(async () => {
  const host = privateKeyToAccount(key).address;
  const tester = createTestClient({ chain: testChain, mode: "anvil", transport: http(ANVIL_URL) });
  await tester.setBalance({ address: host, value: parseEther("100") });
  system = await deployFundSystem(key, privateKeyToAccount(generatePrivateKey()).address);
  reception = await deployContract("Reception", key, [system.fund, host]);
});

function freshAddress(): Address {
  return privateKeyToAccount(generatePrivateKey()).address;
}

function setup(overrides: Partial<JoinOptions> = {}) {
  const gateway = new RpcGateway({ upstreams: [ANVIL_URL], batchIntervalMs: 0, blockTtlMs: 50 });
  const operator = new Operator({ key, chain: testChain, gateway });
  const join = new JoinService({ operator, fund: system.fund, token: system.token, reception, gasMoney, gasMarginPercent: 20, shares, members: 100, ...overrides });
  return { operator, join };
}

function sharesOf(operator: Operator, address: Address) {
  return operator.client.readContract({ address: system.fund, abi: fundAbi, functionName: "balanceOf", args: [address] });
}

describe("joining the fund", () => {
  it("gives a visitor shares that count in votes, and the gas money to cast them", async () => {
    const { operator, join } = setup();
    const visitor = freshAddress();

    const result = await join.join(visitor);

    expect(result.status).toBe("joined");
    expect(await sharesOf(operator, visitor)).toBe(shares);
    expect(await operator.client.readContract({ address: system.fund, abi: fundAbi, functionName: "getVotes", args: [visitor] })).toBe(shares);
    expect(await operator.client.getBalance({ address: visitor })).toBe(gasMoney);
    expect(join.members).toBe(1);
  });

  it("takes visitors who arrive together in with one transaction, each with the same shares", async () => {
    const { operator, join } = setup();
    const visitors = Array.from({ length: 12 }, freshAddress);
    // The first request finds the service idle and goes alone. The rest ride together.
    await join.join(freshAddress());
    const nonce = await operator.client.getTransactionCount({ address: operator.address });

    const results = await Promise.all(visitors.map(visitor => join.join(visitor)));

    expect(await Promise.all(visitors.map(visitor => sharesOf(operator, visitor)))).toEqual(visitors.map(() => shares));
    expect(new Set(results.map(result => result.status === "joined" && result.transactionHash)).size).toBeLessThanOrEqual(2);
    expect(await operator.client.getTransactionCount({ address: operator.address }) - nonce).toBeLessThanOrEqual(2);
  });

  it("takes each address in once", async () => {
    const { operator, join } = setup();
    const visitor = freshAddress();
    const [first, again] = await Promise.all([join.join(visitor), join.join(visitor)]);
    expect(first).toBe(again);

    const nonce = await operator.client.getTransactionCount({ address: operator.address });
    expect(await join.join(visitor)).toEqual({ status: "member", shares });
    expect(await operator.client.getTransactionCount({ address: operator.address })).toBe(nonce);
    expect(await sharesOf(operator, visitor)).toBe(shares);
  });

  it("stops taking visitors in at its limit", async () => {
    const { operator, join } = setup({ members: 1 });
    const late = freshAddress();
    await join.join(freshAddress());

    expect(await join.join(late)).toEqual({ status: "full" });
    expect(await sharesOf(operator, late)).toBe(0n);
  });
});
