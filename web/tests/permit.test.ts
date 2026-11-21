import type { Address } from "viem";
import { maxUint256, parseEther, parseSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { PERMIT2_ADDRESS } from "~/chain/contracts";
import { permit2TransferTypedData, permitTypedData, randomPermit2Nonce } from "~/chain/permit";
import { tokenAbi, vaultAbi } from "~/contracts/abis";
import { ANVIL_KEYS, deadlineOnChain, deployContract, testChain, testClient } from "./helpers";

const key = ANVIL_KEYS[4];
const owner = privateKeyToAccount(key).address;
const client = testClient(key);

let token: Address;
let vault: Address;

async function write(parameters: Parameters<typeof client.writeContract>[0]) {
  const hash = await client.writeContract(parameters);
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
}

function shares() {
  return client.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [owner] });
}

beforeAll(async () => {
  token = await deployContract("Token", key, ["Test Dollar", "tUSD", owner]);
  vault = await deployContract("Vault", key, [token, "Test Dollar Vault", "vtUSD", PERMIT2_ADDRESS]);
  await write({ address: token, abi: tokenAbi, functionName: "mint", args: [owner, parseEther("1000")] });
});

describe("permitTypedData", () => {
  it("produces a signature the token and the vault accept", async () => {
    const before = await shares();
    const value = parseEther("100");
    const deadline = await deadlineOnChain(600);
    const nonce = await client.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [owner] });

    const signature = await client.signTypedData(
      permitTypedData({ chainId: testChain.id, token, name: "Test Dollar", owner, spender: vault, value, nonce, deadline }),
    );
    const { r, s, yParity } = parseSignature(signature);

    await write({ address: vault, abi: vaultAbi, functionName: "depositWithPermit", args: [value, owner, deadline, yParity + 27, r, s] });

    expect(await shares()).toBe(before + value);
    expect(await client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [owner, vault] })).toBe(0n);
  });

  it("is refused when signed for the wrong domain name", async () => {
    const value = parseEther("1");
    const deadline = await deadlineOnChain(600);
    const nonce = await client.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [owner] });
    const signature = await client.signTypedData(
      permitTypedData({ chainId: testChain.id, token, name: "Another Token", owner, spender: vault, value, nonce, deadline }),
    );
    const { r, s, yParity } = parseSignature(signature);

    await expect(
      client.simulateContract({ address: token, abi: tokenAbi, functionName: "permit", args: [owner, vault, value, deadline, yParity + 27, r, s] }),
    ).rejects.toThrow("ERC2612InvalidSigner");
  });
});

describe("permit2TransferTypedData", () => {
  it("produces a signature Permit2 accepts, after one approval to Permit2", async () => {
    await write({ address: token, abi: tokenAbi, functionName: "approve", args: [PERMIT2_ADDRESS, maxUint256] });
    const before = await shares();
    const amount = parseEther("50");
    const nonce = randomPermit2Nonce();
    const deadline = await deadlineOnChain(600);

    const signature = await client.signTypedData(
      permit2TransferTypedData({ chainId: testChain.id, token, amount, spender: vault, nonce, deadline }),
    );
    await write({ address: vault, abi: vaultAbi, functionName: "depositWithPermit2", args: [amount, owner, nonce, deadline, signature] });

    expect(await shares()).toBe(before + amount);
  });

  it("cannot be used for a larger amount than was signed", async () => {
    const nonce = randomPermit2Nonce();
    const deadline = await deadlineOnChain(600);
    const signature = await client.signTypedData(
      permit2TransferTypedData({ chainId: testChain.id, token, amount: parseEther("1"), spender: vault, nonce, deadline }),
    );

    await expect(
      client.simulateContract({ address: vault, abi: vaultAbi, functionName: "depositWithPermit2", args: [parseEther("2"), owner, nonce, deadline, signature] }),
    ).rejects.toThrow();
  });
});

describe("randomPermit2Nonce", () => {
  it("returns distinct values that fit in a uint256", () => {
    const nonces = new Set(Array.from({ length: 200 }, randomPermit2Nonce));
    expect(nonces.size).toBe(200);
    expect([...nonces].every(nonce => nonce >= 0n && nonce < 2n ** 248n)).toBe(true);
  });
});
