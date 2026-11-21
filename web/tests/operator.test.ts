import type { Address } from "viem";
import { encodeFunctionData, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { tokenAbi } from "~/contracts/abis";
import { Operator } from "~/server/operator";
import { RpcGateway } from "~/server/rpc-gateway";
import { ANVIL_KEYS, ANVIL_URL, deployContract, testChain } from "./helpers";

const key = ANVIL_KEYS[2];
const stranger = "0x00000000000000000000000000000000000000c1";

let token: Address;

function operator() {
  const gateway = new RpcGateway({ upstreams: [ANVIL_URL], batchIntervalMs: 0, blockTtlMs: 100 });
  return new Operator({ key, chain: testChain, gateway });
}

beforeAll(async () => {
  token = await deployContract("Token", key, ["Test USD", "tUSD", privateKeyToAccount(key).address]);
});

describe("operator", () => {
  it("sends a transaction and returns its receipt", async () => {
    const subject = operator();
    const before = await subject.client.getBalance({ address: stranger });

    const receipt = await subject.send({ to: stranger, data: "0x", value: parseEther("0.25"), gas: 21_000n });

    expect(receipt.status).toBe("success");
    expect(await subject.client.getBalance({ address: stranger })).toBe(before + parseEther("0.25"));
  });

  it("gives concurrent sends consecutive nonces in call order", async () => {
    const subject = operator();
    const start = await subject.client.getTransactionCount({ address: subject.address });

    const receipts = await Promise.all(
      Array.from({ length: 6 }, () => subject.send({ to: stranger, data: "0x", value: 1n, gas: 21_000n })),
    );

    const transactions = await Promise.all(receipts.map(receipt => subject.client.getTransaction({ hash: receipt.transactionHash })));
    expect(transactions.map(transaction => transaction.nonce)).toEqual([0, 1, 2, 3, 4, 5].map(offset => start + offset));
  });

  it("spaces transfers that would take it below the chain's reserve, and only those", async () => {
    const gateway = new RpcGateway({ upstreams: [ANVIL_URL], batchIntervalMs: 0, blockTtlMs: 50 });
    const blocks = 12;
    const balance = await operator().client.getBalance({ address: privateKeyToAccount(key).address });
    const blockOf = async (subject: Operator, value: bigint) => (await subject.send({ to: stranger, data: "0x", value, gas: 21_000n })).blockNumber;

    // A reserve above what the account holds: every transfer of value dips below it.
    const low = new Operator({ key, chain: testChain, gateway, reserve: { balance: balance * 2n, blocks } });
    const first = await blockOf(low, 1n);
    expect(await blockOf(low, 1n) - first).toBeGreaterThan(BigInt(blocks));
    // A transaction that moves no value is not held back.
    const before = await blockOf(low, 1n);
    expect(await blockOf(low, 0n) - before).toBeLessThan(BigInt(blocks));

    // A reserve the account stays well above: nothing is held back.
    const high = new Operator({ key, chain: testChain, gateway, reserve: { balance: 1n, blocks } });
    const start = await blockOf(high, 1n);
    expect(await blockOf(high, 1n) - start).toBeLessThan(BigInt(blocks));
  });

  it("rejects when the transaction reverts and keeps working afterwards", async () => {
    const subject = operator();
    // The operator holds no tokens, so sending some reverts.
    const overdraw = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [stranger, 1n] });

    await expect(subject.send({ to: token, data: overdraw, gas: 60_000n })).rejects.toThrow("reverted");

    const mint = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [stranger, 1n] });
    const receipt = await subject.send({ to: token, data: mint, gas: 100_000n });
    expect(receipt.status).toBe("success");
  });
});
