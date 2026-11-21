import type { Address } from "viem";
import type { FaucetOptions } from "~/server/faucet";
import { parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { FaucetService } from "~/server/faucet";
import { Operator } from "~/server/operator";
import { RpcGateway } from "~/server/rpc-gateway";
import { ANVIL_KEYS, ANVIL_URL, deployContract, testChain, testClient } from "./helpers";

const key = ANVIL_KEYS[3];
const target = parseEther("0.5");
const lowWater = parseEther("0.1");

let contract: Address;

beforeAll(async () => {
  contract = await deployContract("Faucet", key);
});

function freshAddress(): Address {
  return privateKeyToAccount(generatePrivateKey()).address;
}

function setup(overrides: Partial<FaucetOptions> = {}) {
  const gateway = new RpcGateway({ upstreams: [ANVIL_URL], batchIntervalMs: 0, blockTtlMs: 50 });
  const operator = new Operator({ key, chain: testChain, gateway });
  const faucet = new FaucetService({
    operator,
    contract,
    target,
    lowWater,
    perAddress: parseEther("2"),
    budget: parseEther("50"),
    ...overrides,
  });
  return { operator, faucet };
}

describe("faucet", () => {
  it("raises an empty account to the target", async () => {
    const { operator, faucet } = setup();
    const account = freshAddress();

    const result = await faucet.fund(account);

    expect(result).toEqual({ status: "funded", amount: target });
    expect(await operator.client.getBalance({ address: account })).toBe(target);
  });

  it("leaves an account above the low-water mark alone", async () => {
    const { operator, faucet } = setup();
    const account = freshAddress();
    await operator.send({ to: account, data: "0x", value: lowWater + 1n, gas: 21_000n });
    const nonce = await operator.client.getTransactionCount({ address: operator.address });

    expect(await faucet.fund(account)).toEqual({ status: "sufficient" });
    expect(await operator.client.getTransactionCount({ address: operator.address })).toBe(nonce);
  });

  it("tops up an account at the low-water mark by the difference", async () => {
    const { operator, faucet } = setup();
    const account = freshAddress();
    await operator.send({ to: account, data: "0x", value: lowWater, gas: 21_000n });

    expect(await faucet.fund(account)).toEqual({ status: "funded", amount: target - lowWater });
    expect(await operator.client.getBalance({ address: account })).toBe(target);
  });

  it("funds many accounts asking at once in a few transactions", async () => {
    const { operator, faucet } = setup();
    const accounts = Array.from({ length: 60 }, freshAddress);
    const nonce = await operator.client.getTransactionCount({ address: operator.address });

    const results = await Promise.all(accounts.map(account => faucet.fund(account)));

    expect(results.every(result => result.status === "funded")).toBe(true);
    const balances = await Promise.all(accounts.map(address => operator.client.getBalance({ address })));
    expect(balances.every(balance => balance === target)).toBe(true);
    const used = (await operator.client.getTransactionCount({ address: operator.address })) - nonce;
    expect(used).toBeGreaterThanOrEqual(1);
    expect(used).toBeLessThanOrEqual(3);
  });

  it("splits more requests than fit in one batch", async () => {
    const { operator, faucet } = setup({ maxBatchSize: 10 });
    const accounts = Array.from({ length: 25 }, freshAddress);

    const results = await Promise.all(accounts.map(account => faucet.fund(account)));

    expect(results.every(result => result.status === "funded")).toBe(true);
    const balances = await Promise.all(accounts.map(address => operator.client.getBalance({ address })));
    expect(balances.every(balance => balance === target)).toBe(true);
  });

  it("answers duplicate requests for one address from a single top-up", async () => {
    const { operator, faucet } = setup();
    const account = freshAddress();

    const results = await Promise.all([faucet.fund(account), faucet.fund(account), faucet.fund(account)]);

    expect(results.filter(result => result.status === "funded").length).toBeGreaterThanOrEqual(1);
    expect(await operator.client.getBalance({ address: account })).toBe(target);
  });

  it("stops funding an address that has received its allowance", async () => {
    const { faucet } = setup({ perAddress: target });
    const accountKey = generatePrivateKey();
    const account = privateKeyToAccount(accountKey).address;
    await faucet.fund(account);

    const client = testClient(accountKey);
    const hash = await client.sendTransaction({ to: privateKeyToAccount(key).address, value: parseEther("0.45"), gas: 21_000n });
    await client.waitForTransactionReceipt({ hash });
    expect(await client.getBalance({ address: account })).toBeLessThan(lowWater);

    expect(await faucet.fund(account)).toEqual({ status: "limit" });
  });

  it("stops once the budget is spent", async () => {
    const { faucet } = setup({ budget: parseEther("0.9") });

    expect((await faucet.fund(freshAddress())).status).toBe("funded");
    expect(await faucet.fund(freshAddress())).toEqual({ status: "exhausted" });
  });

  it("counts gas and grants towards the budget", async () => {
    const { faucet } = setup();
    await faucet.fund(freshAddress());

    expect(faucet.recipients).toBe(1);
    expect(faucet.spent).toBeGreaterThan(target);
    expect(faucet.spent).toBeLessThan(target + parseEther("0.01"));
  });
});
