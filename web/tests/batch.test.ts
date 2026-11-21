import type { Address, Hex } from "viem";
import type { BatchCall } from "~/chain/batch";
import { createClient, erc20Abi, http, parseEther, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { estimateContractGas, sendTransaction } from "viem/actions";
import { beforeAll, describe, expect, it } from "vitest";
import { sendBatch, supportsAtomicBatch } from "~/chain/batch";
import { createBurnerClient } from "~/chain/burner/client";
import { createLocalNonceManager } from "~/chain/burner/nonce";
import { tokenAbi, vaultAbi } from "~/contracts/abis";
import { ANVIL_KEYS, ANVIL_URL, deployContract, testChain, testClient } from "./helpers";

const funder = testClient(ANVIL_KEYS[7]);
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

let executor: Address;
let token: Address;
let vault: Address;

beforeAll(async () => {
  executor = await deployContract("BatchExecutor", ANVIL_KEYS[7]);
  token = await deployContract("Token", ANVIL_KEYS[7], ["Test USD", "tUSD", funder.account.address]);
  vault = await deployContract("Vault", ANVIL_KEYS[7], [token, "Test Vault", "vtUSD", PERMIT2]);
});

const reader = createClient({ chain: testChain, transport: http(ANVIL_URL), pollingInterval: 50 }).extend(publicActions);

/** A new account holding 1 native token and 100 tUSD. */
async function fundedKey(): Promise<Hex> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  await funder.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: address, value: parseEther("1") }) });
  await funder.waitForTransactionReceipt({ hash: await funder.writeContract({ address: token, abi: tokenAbi, functionName: "mint", args: [address, parseEther("100")] }) });
  return key;
}

function burnerClient(key: Hex, options: { executor: Address | undefined }) {
  return createBurnerClient({
    key,
    chain: testChain,
    transport: http(ANVIL_URL),
    nonceManager: createLocalNonceManager({ settleMs: 300 }),
    executor: options.executor,
    gasMarginPercent: 20,
  });
}

function approveAndDeposit(owner: Address, approved: bigint, deposited: bigint): BatchCall[] {
  return [
    { to: token, abi: erc20Abi, functionName: "approve", args: [vault, approved] },
    { to: vault, abi: vaultAbi, functionName: "deposit", args: [deposited, owner] },
  ];
}

function shares(owner: Address) {
  return reader.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
}

function allowance(owner: Address) {
  return reader.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, vault] });
}

describe("sendBatch with a wallet that batches", () => {
  it("executes every call in one transaction, delegating the account on first use", async () => {
    const wallet = burnerClient(await fundedKey(), { executor });
    const owner = wallet.account.address;
    expect(await supportsAtomicBatch(wallet)).toBe(true);
    expect(await reader.getCode({ address: owner })).toBeUndefined();

    const hashes: Hex[] = [];
    const receipts = await sendBatch({ wallet, reader, calls: approveAndDeposit(owner, parseEther("40"), parseEther("40")), onHash: hash => hashes.push(hash) });

    expect(receipts).toHaveLength(1);
    expect(hashes).toEqual([receipts[0]!.transactionHash]);
    expect(await shares(owner)).toBe(parseEther("40"));
    expect((await reader.getCode({ address: owner }))?.toLowerCase()).toBe(`0xef0100${executor.slice(2).toLowerCase()}`);

    // The delegation used up a nonce of its own, next to the transaction's.
    expect(await reader.getTransactionCount({ address: owner })).toBe(2);

    // The second batch reuses the delegation already in place.
    await sendBatch({ wallet, reader, calls: approveAndDeposit(owner, parseEther("10"), parseEther("10")) });
    expect(await shares(owner)).toBe(parseEther("50"));
    expect(await reader.getTransactionCount({ address: owner })).toBe(3);
  });

  it("applies none of the calls when one of them fails", async () => {
    const wallet = burnerClient(await fundedKey(), { executor });
    const owner = wallet.account.address;

    await expect(sendBatch({ wallet, reader, calls: approveAndDeposit(owner, parseEther("10"), parseEther("40")) })).rejects.toThrow();

    expect(await allowance(owner)).toBe(0n);
    expect(await shares(owner)).toBe(0n);
  });

  it("keeps sending ordinary transactions between batches with the right nonces", async () => {
    const wallet = burnerClient(await fundedKey(), { executor });
    const owner = wallet.account.address;

    await sendBatch({ wallet, reader, calls: approveAndDeposit(owner, parseEther("5"), parseEther("5")) });
    const hash = await sendTransaction(wallet, { to: funder.account.address, value: 1n });
    expect((await reader.waitForTransactionReceipt({ hash })).status).toBe("success");
    await sendBatch({ wallet, reader, calls: approveAndDeposit(owner, parseEther("5"), parseEther("5")) });

    expect(await shares(owner)).toBe(parseEther("10"));
    expect(await reader.getTransactionCount({ address: owner })).toBe(4);
  });

  it("raises gas estimates by the configured margin", async () => {
    const key = await fundedKey();
    const plain = createClient({ account: privateKeyToAccount(key), chain: testChain, transport: http(ANVIL_URL) });
    const padded = burnerClient(key, { executor });
    const approve = { address: token, abi: erc20Abi, functionName: "approve", args: [vault, 1n] } as const;

    const estimate = await estimateContractGas(plain, approve);
    expect(await estimateContractGas(padded, approve)).toBe(estimate + estimate / 5n);
  });
});

describe("sendBatch with a wallet that does not batch", () => {
  it("sends the calls one after another, each once the one before is confirmed", async () => {
    const wallet = burnerClient(await fundedKey(), { executor: undefined });
    const owner = wallet.account.address;
    expect(await supportsAtomicBatch(wallet)).toBe(false);

    const hashes: Hex[] = [];
    const receipts = await sendBatch({ wallet, reader, calls: approveAndDeposit(owner, parseEther("40"), parseEther("40")), onHash: hash => hashes.push(hash) });

    expect(receipts).toHaveLength(2);
    expect(hashes).toEqual(receipts.map(receipt => receipt.transactionHash));
    expect(await shares(owner)).toBe(parseEther("40"));
    expect(await reader.getCode({ address: owner })).toBeUndefined();
  });

  it("answers the same for a wallet that has never heard of batches", async () => {
    const wallet = createClient({ account: privateKeyToAccount(await fundedKey()), chain: testChain, transport: http(ANVIL_URL) });
    expect(await supportsAtomicBatch(wallet)).toBe(false);

    await sendBatch({ wallet, reader, calls: approveAndDeposit(wallet.account.address, parseEther("15"), parseEther("15")) });
    expect(await shares(wallet.account.address)).toBe(parseEther("15"));
  });

  it("stops at the call that fails and leaves the earlier ones in place", async () => {
    const wallet = createClient({ account: privateKeyToAccount(await fundedKey()), chain: testChain, transport: http(ANVIL_URL) });
    const owner = wallet.account.address;

    await expect(sendBatch({ wallet, reader, calls: approveAndDeposit(owner, parseEther("10"), parseEther("40")) })).rejects.toThrow();

    expect(await allowance(owner)).toBe(parseEther("10"));
    expect(await shares(owner)).toBe(0n);
  });
});
