import type { Address, Hex, PrivateKeyAccount } from "viem";
import type { FundSystem } from "./helpers";
import type { ForwardRequest, SignedForwardRequest } from "~/chain/forward";
import type { RelayOptions } from "~/server/relay";
import { encodeFunctionData, parseEther, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { forwardRequestTypedData } from "~/chain/forward";
import { committeeAbi, forwarderAbi } from "~/contracts/abis";
import { Operator } from "~/server/operator";
import { RelayService } from "~/server/relay";
import { RpcGateway } from "~/server/rpc-gateway";
import { ANVIL_KEYS, ANVIL_URL, deadlineOnChain, deployContract, deployFundSystem, testChain, testClient } from "./helpers";

const key = ANVIL_KEYS[5];
const client = testClient(key);
const PITCH_GAS = 300_000n;

let system: FundSystem;
let untrusting: Address;

beforeAll(async () => {
  system = await deployFundSystem(key, client.account.address);
  // The same committee code, wired to a forwarder that is not this one.
  untrusting = await deployContract("Committee", key, [system.token, "0x00000000000000000000000000000000000000f0", client.account.address, {
    minBond: parseEther("1000"),
    maxAsk: parseEther("1000"),
    reviewPeriod: 86_400,
    acceptPeriod: 259_200,
    unbondingPeriod: 2_592_000,
    slashBps: 2000,
  }, system.partnerKeys.map(partner => privateKeyToAccount(partner).address)]);
});

function setup(overrides: Partial<RelayOptions> = {}) {
  const gateway = new RpcGateway({ upstreams: [ANVIL_URL], batchIntervalMs: 0, blockTtlMs: 50 });
  const operator = new Operator({ key, chain: testChain, gateway });
  const selectors = new Set<Hex>([toFunctionSelector("pitch(address,uint128,string,string)"), toFunctionSelector("accept(uint256)")]);
  const relay = new RelayService({
    operator,
    forwarder: system.forwarder,
    targets: new Map([[system.committee.toLowerCase(), selectors], [untrusting.toLowerCase(), selectors]]),
    perSender: 5,
    windowMs: 60_000,
    maxGas: 400_000n,
    budget: parseEther("1"),
    ...overrides,
  });
  return { operator, relay };
}

async function project(): Promise<Address> {
  return deployContract("Faucet", key);
}

function pitch(projectAddress: Address, name = "Demo Project"): Hex {
  return encodeFunctionData({ abi: committeeAbi, functionName: "pitch", args: [projectAddress, parseEther("100"), name, "bafkreidemo"] });
}

async function sign(signer: PrivateKeyAccount, fields: Partial<ForwardRequest> & { data: Hex }): Promise<SignedForwardRequest> {
  const request: ForwardRequest = { from: signer.address, to: system.committee, value: 0n, gas: PITCH_GAS, deadline: Number(await deadlineOnChain(600)), ...fields };
  const nonce = await client.readContract({ address: system.forwarder, abi: forwarderAbi, functionName: "nonces", args: [request.from] });
  const signature = await signer.signTypedData(forwardRequestTypedData({ chainId: testChain.id, forwarder: system.forwarder, nonce, request }));
  return { ...request, signature };
}

async function openDealOf(founder: Address) {
  return client.readContract({ address: system.committee, abi: committeeAbi, functionName: "openDealOf", args: [founder] });
}

describe("relay", () => {
  it("submits a pitch for a founder who holds no native tokens", async () => {
    const { operator, relay } = setup();
    const founder = privateKeyToAccount(generatePrivateKey());

    const result = await relay.relay(await sign(founder, { data: pitch(await project(), "Gasless") }));

    expect(result.status).toBe("relayed");
    const dealId = await openDealOf(founder.address);
    expect(dealId).toBeGreaterThan(0n);
    const deal = await client.readContract({ address: system.committee, abi: committeeAbi, functionName: "getDeal", args: [dealId] });
    expect(deal).toMatchObject({ founder: founder.address, name: "Gasless" });
    expect(await operator.client.getBalance({ address: founder.address })).toBe(0n);
    expect(relay.spent).toBeGreaterThan(0n);
  });

  it("refuses a target or function that is not listed, and any request carrying value", async () => {
    const { relay } = setup();
    const founder = privateKeyToAccount(generatePrivateKey());
    const unlisted = encodeFunctionData({ abi: committeeAbi, functionName: "close", args: [1n] });

    expect(await relay.relay(await sign(founder, { data: pitch(await project()), to: system.forwarder }))).toEqual({ status: "refused", reason: "target" });
    expect(await relay.relay(await sign(founder, { data: unlisted }))).toEqual({ status: "refused", reason: "target" });
    expect(await relay.relay(await sign(founder, { data: pitch(await project()), value: 1n }))).toEqual({ status: "refused", reason: "target" });
  });

  it("refuses a request for more gas than the limit", async () => {
    const { relay } = setup();
    const founder = privateKeyToAccount(generatePrivateKey());

    expect(await relay.relay(await sign(founder, { data: pitch(await project()), gas: 400_001n }))).toEqual({ status: "refused", reason: "gas" });
  });

  it("refuses a request that was altered, has expired, was already used, or targets a contract that does not trust the forwarder", async () => {
    const { relay } = setup();
    const founder = privateKeyToAccount(generatePrivateKey());
    const first = await project();

    const signed = await sign(founder, { data: pitch(first, "Original") });
    expect(await relay.relay({ ...signed, data: pitch(first, "Altered") })).toEqual({ status: "refused", reason: "signature" });

    const expired = await sign(founder, { data: pitch(first), deadline: Number(await deadlineOnChain(-60)) });
    expect(await relay.relay(expired)).toEqual({ status: "refused", reason: "signature" });

    expect((await relay.relay(signed)).status).toBe("relayed");
    expect(await relay.relay(signed)).toEqual({ status: "refused", reason: "signature" });

    const elsewhere = await sign(privateKeyToAccount(generatePrivateKey()), { data: pitch(await project()), to: untrusting });
    expect(await relay.relay(elsewhere)).toEqual({ status: "refused", reason: "signature" });
  });

  it("refuses a call that would revert, without spending anything", async () => {
    const { relay } = setup();
    const founder = privateKeyToAccount(generatePrivateKey());

    // A founder's own account is not a project.
    expect(await relay.relay(await sign(founder, { data: pitch(founder.address) }))).toEqual({ status: "refused", reason: "reverted" });
    expect(relay.spent).toBe(0n);
  });

  it("stops relaying for a signer that has used its allowance, and resumes after the window", async () => {
    const { relay } = setup({ perSender: 2, windowMs: 1500 });
    const founder = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());

    expect((await relay.relay(await sign(founder, { data: pitch(await project()) }))).status).toBe("relayed");
    // A second pitch while the first runs is refused by the committee, and still counts.
    expect(await relay.relay(await sign(founder, { data: pitch(await project()) }))).toEqual({ status: "refused", reason: "reverted" });
    expect(await relay.relay(await sign(founder, { data: pitch(await project()) }))).toEqual({ status: "refused", reason: "limit" });
    expect((await relay.relay(await sign(other, { data: pitch(await project()) }))).status).toBe("relayed");

    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(await relay.relay(await sign(founder, { data: pitch(await project()) }))).toEqual({ status: "refused", reason: "reverted" });
  });

  it("stops relaying once the budget is spent", async () => {
    const { relay } = setup({ budget: 1n });

    expect((await relay.relay(await sign(privateKeyToAccount(generatePrivateKey()), { data: pitch(await project()) }))).status).toBe("relayed");
    expect(await relay.relay(await sign(privateKeyToAccount(generatePrivateKey()), { data: pitch(await project()) }))).toEqual({ status: "refused", reason: "exhausted" });
  });
});
