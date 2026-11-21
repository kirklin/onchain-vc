import type { RecordingUpstream } from "./helpers";
import { setTimeout as sleep } from "node:timers/promises";
import { keccak256, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcGateway } from "~/server/rpc-gateway";
import { ANVIL_KEYS, startRecordingUpstream, testChain, testClient } from "./helpers";

const account = privateKeyToAccount(ANVIL_KEYS[1]);
const stranger = "0x00000000000000000000000000000000000000b1";

let first: RecordingUpstream;
let second: RecordingUpstream;

beforeEach(async () => {
  first = await startRecordingUpstream();
  second = await startRecordingUpstream();
});

afterEach(async () => {
  await first.close();
  await second.close();
});

function gateway(overrides: Partial<ConstructorParameters<typeof RpcGateway>[0]> = {}) {
  return new RpcGateway({ upstreams: [first.url], batchIntervalMs: 0, blockTtlMs: 200, ...overrides });
}

function balanceOf(index: number) {
  return ["eth_getBalance", [`0x${index.toString(16).padStart(40, "0")}`, "latest"]] as const;
}

describe("batching", () => {
  it("sends requests that arrive together as one upstream batch", async () => {
    const subject = gateway();
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, index) => subject.request(...balanceOf(index + 1))));

    expect(outcomes.every(outcome => "result" in outcome)).toBe(true);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]!.size).toBe(20);
  });

  it("splits a queue longer than the batch limit", async () => {
    const subject = gateway({ maxBatchSize: 8 });
    await Promise.all(Array.from({ length: 20 }, (_, index) => subject.request(...balanceOf(index + 1))));

    expect(first.calls.map(call => call.size)).toEqual([8, 8, 4]);
  });

  it("spaces batches to one upstream by the configured interval", async () => {
    const subject = gateway({ maxBatchSize: 5, batchIntervalMs: 150 });
    await Promise.all(Array.from({ length: 15 }, (_, index) => subject.request(...balanceOf(index + 1))));

    expect(first.calls).toHaveLength(3);
    expect(first.calls[1]!.at - first.calls[0]!.at).toBeGreaterThanOrEqual(140);
    expect(first.calls[2]!.at - first.calls[1]!.at).toBeGreaterThanOrEqual(140);
  });

  it("alternates between upstreams so each keeps its own pace", async () => {
    const subject = gateway({ upstreams: [first.url, second.url], maxBatchSize: 5, batchIntervalMs: 150 });
    const started = Date.now();
    await Promise.all(Array.from({ length: 20 }, (_, index) => subject.request(...balanceOf(index + 1))));

    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe("caching", () => {
  it("answers identical concurrent reads from one upstream request", async () => {
    const subject = gateway();
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => subject.request("eth_getBalance", [account.address, "latest"])));

    expect(new Set(outcomes.map(outcome => JSON.stringify(outcome))).size).toBe(1);
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]!.size).toBe(1);
    expect(subject.stats().shared).toBe(49);
  });

  it("serves a read from cache until a block has passed", async () => {
    const subject = gateway({ blockTtlMs: 200 });
    await subject.request("eth_blockNumber");
    await subject.request("eth_blockNumber");
    expect(first.calls).toHaveLength(1);
    expect(subject.stats().cacheHits).toBe(1);

    await sleep(220);
    await subject.request("eth_blockNumber");
    expect(first.calls).toHaveLength(2);
  });

  it("keeps the chain id for good", async () => {
    const subject = gateway({ blockTtlMs: 10 });
    const outcome = await subject.request("eth_chainId");
    await sleep(30);
    await subject.request("eth_chainId");

    expect(outcome).toEqual({ result: `0x${testChain.id.toString(16)}` });
    expect(first.calls).toHaveLength(1);
  });

  it("asks again for a receipt that does not exist yet", async () => {
    const subject = gateway({ blockTtlMs: 10 });
    const missing = `0x${"11".repeat(32)}`;
    expect(await subject.request("eth_getTransactionReceipt", [missing])).toEqual({ result: null });
    await sleep(30);
    await subject.request("eth_getTransactionReceipt", [missing]);

    expect(first.calls).toHaveLength(2);
  });

  it("drops cached reads once a synchronous send confirms", async () => {
    const subject = gateway({ blockTtlMs: 5000 });
    const client = testClient(ANVIL_KEYS[1]);
    const read = ["eth_getBalance", [stranger, "latest"]] as const;
    const before = await subject.request(...read);

    const request = await client.prepareTransactionRequest({ to: stranger, value: parseEther("0.01"), gas: 21_000n });
    await subject.request("eth_sendRawTransactionSync", [await client.signTransaction(request)]);

    expect(await subject.request(...read)).not.toEqual(before);
  });

  it("drops cached reads once a receipt first appears", async () => {
    const subject = gateway({ blockTtlMs: 5000 });
    const client = testClient(ANVIL_KEYS[1]);
    const read = ["eth_getBalance", [stranger, "latest"]] as const;
    const before = await subject.request(...read);

    const request = await client.prepareTransactionRequest({ to: stranger, value: parseEther("0.01"), gas: 21_000n });
    const raw = await client.signTransaction(request);
    await subject.request("eth_sendRawTransaction", [raw]);
    await client.waitForTransactionReceipt({ hash: keccak256(raw) });
    expect(await subject.request(...read)).toEqual(before);

    expect(await subject.request("eth_getTransactionReceipt", [keccak256(raw)])).toMatchObject({ result: { status: "0x1" } });
    expect(await subject.request(...read)).not.toEqual(before);
  });

  it("does not cache errors", async () => {
    const subject = gateway();
    const bad = ["eth_getBalance", ["not-an-address", "latest"]] as const;
    expect(await subject.request(...bad)).toHaveProperty("error");
    expect(await subject.request(...bad)).toHaveProperty("error");

    expect(first.calls).toHaveLength(2);
  });
});

describe("transactions", () => {
  it("forwards a signed transaction and returns its hash", async () => {
    const client = testClient(ANVIL_KEYS[1]);
    const request = await client.prepareTransactionRequest({ to: stranger, value: parseEther("0.01"), gas: 21_000n });
    const raw = await client.signTransaction(request);

    const outcome = await gateway().request("eth_sendRawTransaction", [raw]);

    expect(outcome).toEqual({ result: keccak256(raw) });
    const receipt = await client.waitForTransactionReceipt({ hash: keccak256(raw) });
    expect(receipt.status).toBe("success");
  });

  it("returns the receipt for a synchronous send", async () => {
    const client = testClient(ANVIL_KEYS[1]);
    const request = await client.prepareTransactionRequest({ to: stranger, value: parseEther("0.01"), gas: 21_000n });
    const raw = await client.signTransaction(request);

    const outcome = await gateway().request("eth_sendRawTransactionSync", [raw]);

    expect(outcome).toMatchObject({ result: { transactionHash: keccak256(raw), status: "0x1" } });
  });

  it("treats a retried send that already landed as delivered", async () => {
    const client = testClient(ANVIL_KEYS[1]);
    const request = await client.prepareTransactionRequest({ to: stranger, value: parseEther("0.01"), gas: 21_000n });
    const raw = await client.signTransaction(request);
    const hash = await client.request({ method: "eth_sendRawTransaction", params: [raw] });
    await client.waitForTransactionReceipt({ hash });

    first.failNext(1, 502);
    const outcome = await gateway({ cooldownMs: 10 }).request("eth_sendRawTransaction", [raw]);

    expect(outcome).toEqual({ result: keccak256(raw) });
  });

  it("passes on the error of a first-time send the node refuses", async () => {
    const client = testClient(ANVIL_KEYS[1]);
    const request = await client.prepareTransactionRequest({ to: stranger, value: parseEther("0.01"), gas: 21_000n });
    const raw = await client.signTransaction(request);
    const hash = await client.request({ method: "eth_sendRawTransaction", params: [raw] });
    await client.waitForTransactionReceipt({ hash });

    const outcome = await gateway().request("eth_sendRawTransaction", [raw]);

    expect(outcome).toHaveProperty("error");
  });
});

describe("failover", () => {
  it("moves a throttled batch to the next upstream", async () => {
    const subject = gateway({ upstreams: [first.url, second.url] });
    first.failNext(1, 429);

    const outcome = await subject.request("eth_chainId");

    expect(outcome).toEqual({ result: `0x${testChain.id.toString(16)}` });
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(subject.stats().upstreamFailures).toBe(1);
  });

  it("rests a failed upstream for the cooldown", async () => {
    const subject = gateway({ upstreams: [first.url, second.url], cooldownMs: 300 });
    first.failNext(1, 429);
    await subject.request(...balanceOf(1));

    for (const index of [2, 3, 4, 5]) {
      await subject.request(...balanceOf(index));
    }
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(5);

    await sleep(320);
    await subject.request(...balanceOf(6));
    expect(first.calls).toHaveLength(2);
  });

  it("reports an error once every attempt has failed", async () => {
    const subject = gateway({ maxAttempts: 2, cooldownMs: 10 });
    first.failNext(2, 503);

    const outcome = await subject.request("eth_blockNumber");

    expect(outcome).toMatchObject({ error: { code: -32603 } });
    expect(first.calls).toHaveLength(2);
  });
});

describe("serve", () => {
  it("refuses methods outside the allowlist without calling upstream", async () => {
    const reply = await gateway().serve({ jsonrpc: "2.0", id: 7, method: "debug_traceCall", params: [] });

    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32601 } });
    expect(first.calls).toHaveLength(0);
  });

  it("answers a single request with the caller's id", async () => {
    const reply = await gateway().serve({ jsonrpc: "2.0", id: "abc", method: "eth_chainId" });

    expect(reply).toEqual({ jsonrpc: "2.0", id: "abc", result: `0x${testChain.id.toString(16)}` });
  });

  it("answers a batch in order", async () => {
    const reply = await gateway().serve([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
      { jsonrpc: "2.0", id: 2, method: "admin_peers" },
      { jsonrpc: "2.0", id: 3, method: "eth_getBalance", params: [account.address, "latest"] },
    ]);

    expect(reply).toMatchObject([
      { id: 1, result: `0x${testChain.id.toString(16)}` },
      { id: 2, error: { code: -32601 } },
      { id: 3, result: expect.stringMatching(/^0x/) },
    ]);
  });

  it("rejects malformed requests", async () => {
    const subject = gateway();

    expect(await subject.serve("eth_chainId")).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await subject.serve({ id: 1, method: 5 })).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await subject.serve([])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await subject.serve(Array.from({ length: 101 }, (_, id) => ({ jsonrpc: "2.0", id, method: "eth_chainId" })))).toMatchObject({ id: null, error: { code: -32600 } });
  });
});
