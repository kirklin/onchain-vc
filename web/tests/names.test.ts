import process from "node:process";
import { describe, expect, it } from "vitest";
import { ensClient, NameService } from "~/server/names";

// ENS lives on Ethereum mainnet, so this runs only when TEST_MAINNET_RPC_URL names an endpoint:
//   TEST_MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com pnpm test:web
const url = process.env.TEST_MAINNET_RPC_URL;

// The best-known name there is, and the address it has pointed to since 2017.
const NAME = "vitalik.eth";
const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// Burn address: holds funds, has no name.
const NAMELESS = "0x000000000000000000000000000000000000dEaD";

describe.skipIf(url === undefined)("name service on mainnet", () => {
  const names = new NameService(ensClient([url!]));

  it("finds an address's primary name and the avatar that name states", async () => {
    const profile = await names.profile(ADDRESS);

    expect(profile.name).toBe(NAME);
    expect(profile.avatar).toMatch(/^(?:https|ipfs):\/\//);
  });

  it("has nothing for an address without a name", async () => {
    expect(await names.profile(NAMELESS)).toEqual({ name: null, avatar: null });
  });

  it("resolves a name to its address, whatever its letter case", async () => {
    expect(await names.resolve(NAME)).toBe(ADDRESS);
    expect(await names.resolve("Vitalik.ETH")).toBe(ADDRESS);
  });

  it("resolves nothing for a name nobody registered, or text that is not a name", async () => {
    expect(await names.resolve("this-name-is-not-registered-onchain-vc.eth")).toBeNull();
    expect(await names.resolve("not a name")).toBeNull();
    expect(await names.resolve("")).toBeNull();
  });

  it("answers a repeated question from memory", async () => {
    await names.profile(ADDRESS);
    const started = Date.now();
    await names.profile(ADDRESS);
    await names.resolve(NAME);

    expect(Date.now() - started).toBeLessThan(20);
  });
});
