import type { ChildProcess } from "node:child_process";
import type { Address, Hex } from "viem";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient, createTestClient, defineChain, http, parseEther, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sendTransaction } from "viem/actions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBurnerClient } from "~/chain/burner/client";
import { createLocalNonceManager } from "~/chain/burner/nonce";
import { trackTransaction } from "~/chain/track";
import { gatewayTransport } from "~/server/operator";
import { RpcGateway } from "~/server/rpc-gateway";
import { testChain } from "./helpers";

// A chain of its own that only produces a block when told to, so transactions stay waiting.
const PORT = 8647;
const URL = `http://127.0.0.1:${PORT}`;
const chain = defineChain({ ...testChain, rpcUrls: { default: { http: [URL] } } });
const node = createTestClient({ chain, mode: "anvil", transport: http(URL), pollingInterval: 50 }).extend(publicActions);

let anvil: ChildProcess;

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--no-mining"], { stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await node.getChainId();
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await sleep(50);
    }
  }
});

afterAll(() => {
  anvil.kill();
});

/** A wallet that signs in memory, holding 1 native token. */
async function fundedWallet() {
  const key = generatePrivateKey();
  await node.setBalance({ address: privateKeyToAccount(key).address, value: parseEther("1") });
  return createBurnerClient({
    key,
    chain,
    transport: http(URL),
    nonceManager: createLocalNonceManager({ settleMs: 100 }),
    executor: undefined,
    gasMarginPercent: 20,
  });
}

function freshAddress(): Address {
  return privateKeyToAccount(generatePrivateKey()).address;
}

/** Follows a transaction this wallet sent, starting only now. */
function track(wallet: { account: { address: Address } }, hash: Hex, nonce: number) {
  return trackTransaction(node, { hash, from: wallet.account.address, nonce, settleMs: 200 });
}

describe("rpc gateway", () => {
  it("does not hold on to a transaction that is still waiting", async () => {
    const gateway = new RpcGateway({ upstreams: [URL], batchIntervalMs: 0, blockTtlMs: 50 });
    const wallet = await fundedWallet();
    const hash = await sendTransaction(wallet, { to: freshAddress(), value: 1n });

    expect(await gateway.request("eth_getTransactionByHash", [hash])).toMatchObject({ result: { blockHash: null } });

    await node.mine({ blocks: 1 });
    await sleep(100);
    const found = await gateway.request("eth_getTransactionByHash", [hash]);
    expect("result" in found && (found.result as { blockHash: string | null }).blockHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("drops what it read during a block as soon as it sees the next one", async () => {
    const gateway = new RpcGateway({ upstreams: [URL], batchIntervalMs: 0, blockTtlMs: 1500 });
    const wallet = await fundedWallet();
    const hash = await sendTransaction(wallet, { to: freshAddress(), value: 1n });
    const balance = ["eth_getBalance", [wallet.account.address, "latest"]] as const;

    await gateway.request("eth_blockNumber");
    await sleep(1200);
    // Both answers would normally be served from memory for another 1.5 seconds.
    expect(await gateway.request("eth_getTransactionReceipt", [hash])).toEqual({ result: null });
    const before = await gateway.request(...balance);

    await node.mine({ blocks: 1 });
    await sleep(400);
    expect(await gateway.request(...balance)).toEqual(before);

    await gateway.request("eth_blockNumber");
    expect(await gateway.request("eth_getTransactionReceipt", [hash])).toMatchObject({ result: { status: "0x1" } });
    expect(await gateway.request(...balance)).not.toEqual(before);
  });
});

describe("trackTransaction", () => {
  it("waits through blocks that do not include the transaction", async () => {
    const wallet = await fundedWallet();
    const hash = await sendTransaction(wallet, { to: freshAddress(), value: 1n });
    let settled = false;
    const tracking = track(wallet, hash, 0).finally(() => (settled = true));

    await sleep(300);
    expect(settled).toBe(false);

    await node.mine({ blocks: 1 });
    expect(await tracking).toMatchObject({ status: "confirmed", receipt: { transactionHash: hash } });
  });

  it("reports a transaction that was included but reverted", async () => {
    const wallet = await fundedWallet();
    // Creation code that reverts at once.
    const hash = await sendTransaction(wallet, { data: "0x60006000fd", gas: 100_000n });

    await node.mine({ blocks: 1 });
    expect(await track(wallet, hash, 0)).toMatchObject({ status: "reverted" });
  });

  it("reports a transaction whose nonce another transaction took", async () => {
    const wallet = await fundedWallet();
    const original = await sendTransaction(wallet, { to: freshAddress(), value: 1n, nonce: 0 });
    const block = await node.getBlock();
    // The same nonce again, paying more, as a wallet's own speed-up does.
    const replacement = await sendTransaction(wallet, {
      to: wallet.account.address,
      value: 0n,
      nonce: 0,
      maxFeePerGas: (block.baseFeePerGas ?? 1n) * 4n + parseEther("0.00000001"),
      maxPriorityFeePerGas: parseEther("0.00000001"),
    });

    await node.mine({ blocks: 1 });
    expect(await track(wallet, replacement, 0)).toMatchObject({ status: "confirmed" });
    expect(await track(wallet, original, 0)).toEqual({ status: "replaced" });
  });

  it("is not fooled by a cache that shows the used nonce before the receipt", async () => {
    // Through the gateway a missing receipt stays cached for a block, while the nonce is read afresh.
    const gateway = new RpcGateway({ upstreams: [URL], batchIntervalMs: 0, blockTtlMs: 600 });
    const reader = createClient({ chain, transport: gatewayTransport(gateway), pollingInterval: 50 });
    const wallet = await fundedWallet();
    const hash = await sendTransaction(wallet, { to: freshAddress(), value: 1n });
    const tracking = trackTransaction(reader, { hash, from: wallet.account.address, nonce: 0 });

    await sleep(200);
    await node.mine({ blocks: 1 });
    expect(await tracking).toMatchObject({ status: "confirmed" });
  });

  it("stops when told to", async () => {
    const wallet = await fundedWallet();
    const hash = await sendTransaction(wallet, { to: freshAddress(), value: 1n });
    const controller = new AbortController();
    const tracking = trackTransaction(node, { hash, from: wallet.account.address, nonce: 0, signal: controller.signal });

    controller.abort(new Error("no longer needed"));
    await expect(tracking).rejects.toThrow("no longer needed");
    await node.mine({ blocks: 1 });
  });
});
