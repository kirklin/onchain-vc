import type { Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import { getAddress, isAddress } from "viem";
import { resolveUri } from "./metadata";

/**
 * Whether addresses are shown by their ENS name. Set NEXT_PUBLIC_ENS=on to turn it on: the
 * server then looks names up on Ethereum mainnet, through RPC_URLS_MAINNET when that is set.
 */
export const ensEnabled = process.env.NEXT_PUBLIC_ENS === "on";

interface Profile {
  name: string | null;
  avatar: string | null;
}

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * The ENS name and avatar of an address, when it has them and lookups are on. `avatar` is
 * ready for an `<img>`.
 */
export function useProfile(address: Address | undefined): { name: string | undefined; avatar: string | undefined } {
  const { data } = useQuery({
    queryKey: ["profile", address],
    queryFn: async () => {
      const response = await fetch(`/api/names?address=${address!}`);
      if (!response.ok) {
        throw new Error(`Looking up ${address!} failed with HTTP ${response.status}.`);
      }
      return response.json() as Promise<Profile>;
    },
    enabled: ensEnabled && address !== undefined,
    staleTime: FIVE_MINUTES,
  });
  return {
    name: data?.name ?? undefined,
    avatar: data?.avatar == null ? undefined : resolveUri(data.avatar),
  };
}

/**
 * Turns what someone typed as a recipient into an address: an address as it is, and an ENS
 * name by looking it up when lookups are on. Undefined when it is neither, or the name
 * points nowhere.
 */
export async function resolveRecipient(text: string): Promise<Address | undefined> {
  const input = text.trim();
  if (isAddress(input)) {
    return getAddress(input);
  }
  if (!ensEnabled || !input.includes(".")) {
    return undefined;
  }
  const response = await fetch(`/api/names?name=${encodeURIComponent(input)}`);
  if (!response.ok) {
    throw new Error(`Resolving ${input} failed with HTTP ${response.status}.`);
  }
  return (await response.json() as { address: Address | null }).address ?? undefined;
}
