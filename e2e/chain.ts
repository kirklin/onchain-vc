import type { Abi, Address, Hex } from "viem";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestClient, createWalletClient, http, parseEther, publicActions } from "viem";
import { generatePrivateKey, nonceManager, privateKeyToAccount } from "viem/accounts";
import { LOCAL_INVESTOR_KEY, LOCAL_PARTNER_KEYS, networks } from "../web/src/chain/networks.ts";
import { committeeAbi, committeeAddress, fundAbi, fundAddress, tokenAbi, tokenAddress } from "../web/src/contracts/abis.ts";

/**
 * The local chain the preview runs on, and the accounts these tests act through: the four
 * partners, whose keys the server would hold if its partners were on, and the investor who
 * received the fund's first shares.
 */
const chain = networks.local.chain;
const transport = http(chain.rpcUrls.default.http[0]);

export const committee = committeeAddress[31337] as Address;
export const fund = fundAddress[31337] as Address;
export const token = tokenAddress[31337] as Address;
export const investorKey = LOCAL_INVESTOR_KEY;

const reader = createTestClient({ chain, mode: "anvil", transport }).extend(publicActions);

function wallet(key: Hex) {
  return createWalletClient({ account: privateKeyToAccount(key, { nonceManager }), chain, transport, pollingInterval: 100 }).extend(publicActions);
}

const partners = LOCAL_PARTNER_KEYS.map(wallet);
const investor = wallet(LOCAL_INVESTOR_KEY);

async function send(client: ReturnType<typeof wallet>, call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) {
  const hash = await client.writeContract(call as Parameters<typeof client.writeContract>[0]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${call.functionName} reverted in ${hash}.`);
  }
  return receipt;
}

/** An account of its own for each caller, funded for gas, so parallel tests never share a nonce. */
async function freshWallet() {
  const created = wallet(generatePrivateKey());
  await reader.setBalance({ address: created.account.address, value: parseEther("1") });
  return created;
}

/** Deploys a contract for a founder to pitch: a fresh copy of the Faucet. */
export async function deployProject(): Promise<Address> {
  const artifact = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "contracts", "out", "Faucet.sol", "Faucet.json"), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  const deployer = await freshWallet();
  const hash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object });
  return (await deployer.waitForTransactionReceipt({ hash })).contractAddress!;
}

/** Puts the partners' bonds back up to the minimum, from the investor's money, after a veto took part of them. */
export async function restoreBonds() {
  const minBond = await reader.readContract({ address: committee, abi: committeeAbi, functionName: "minBond" });
  for (const partner of partners) {
    const { bond } = await reader.readContract({ address: committee, abi: committeeAbi, functionName: "getPartner", args: [partner.account.address] });
    if (bond >= minBond) {
      continue;
    }
    const missing = minBond - bond;
    await send(investor, { address: fund, abi: fundAbi, functionName: "withdraw", args: [missing, investor.account.address, investor.account.address] });
    await send(investor, { address: token, abi: tokenAbi, functionName: "approve", args: [committee, missing] });
    await send(investor, { address: committee, abi: committeeAbi, functionName: "postBond", args: [partner.account.address, missing] });
  }
}

/** Casts a seat's vote on the deal's current round, as the server's partner would. */
export async function vote(dealId: bigint, seat: number, inFavour: boolean) {
  await send(partners[seat]!, { address: committee, abi: committeeAbi, functionName: "vote", args: [dealId, inFavour, inFavour ? 82 : 18, "bafkreiendtoendopinion"] });
}

/** Three partners in favour: the pitch is approved, or the milestone accepted. */
export async function approve(dealId: bigint) {
  for (const seat of [0, 1, 2]) {
    await vote(dealId, seat, true);
  }
}

/** The risk partner sets the terms: 400 invested, 40% up front, the milestone due in 30 days. */
export async function offer(dealId: bigint) {
  await send(partners[3]!, { address: committee, abi: committeeAbi, functionName: "offer", args: [dealId, parseEther("400"), 4000, 30, "bafkreiendtoendterms"] });
}

/**
 * Pitches a fresh project from a fresh founder who pays their own gas, with the pitch stored
 * through `site`'s documents endpoint the way the pitch page stores it, and returns the deal.
 */
export async function pitchDirectly(site: string, name: string): Promise<{ dealId: bigint; founder: ReturnType<typeof wallet> }> {
  const founder = await freshWallet();
  const project = await deployProject();
  const response = await fetch(new URL("/api/documents", site), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "pitch", project, name, summary: `${name}, pitched from a test`, description: "", links: [], ask: 500 }),
  });
  const { cid } = await response.json() as { cid: string };
  await send(founder, { address: committee, abi: committeeAbi, functionName: "pitch", args: [project, parseEther("500"), name, cid] });
  const dealId = await reader.readContract({ address: committee, abi: committeeAbi, functionName: "openDealOf", args: [founder.account.address] });
  return { dealId, founder };
}

export async function accept(founder: ReturnType<typeof wallet>, dealId: bigint) {
  await send(founder, { address: committee, abi: committeeAbi, functionName: "accept", args: [dealId] });
}

export async function dealOf(dealId: bigint) {
  return reader.readContract({ address: committee, abi: committeeAbi, functionName: "getDeal", args: [dealId] });
}

/** How many pitches the committee has received, which is also the id of the newest. */
export async function dealCount(): Promise<bigint> {
  return reader.readContract({ address: committee, abi: committeeAbi, functionName: "dealCount" });
}

export async function bondOf(seat: number) {
  return (await reader.readContract({ address: committee, abi: committeeAbi, functionName: "getPartner", args: [partners[seat]!.account.address] })).bond;
}

/** Publishes each seat's profile with the hash the server computes, as the server does when its partners start. */
export async function publishProfiles(profiles: { name: string; profileHash: Hex }[]) {
  for (const [seat, profile] of profiles.entries()) {
    const current = await reader.readContract({ address: committee, abi: committeeAbi, functionName: "getPartner", args: [partners[seat]!.account.address] });
    if (current.profileHash !== profile.profileHash) {
      await send(partners[seat]!, { address: committee, abi: committeeAbi, functionName: "setProfile", args: [profile.name, profile.profileHash] });
    }
  }
}
