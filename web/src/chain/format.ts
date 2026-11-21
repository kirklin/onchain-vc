import type { Address } from "viem";
import { formatUnits } from "viem";

const DECIMAL = /^\d+(?:\.\d+)?$/;
const TRAILING_ZEROS = /0+$/;

/** Whether the text is a plain non-negative decimal number, the form parseUnits accepts. */
export function isDecimal(text: string): boolean {
  return DECIMAL.test(text);
}

export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A token amount trimmed to at most `maxFraction` decimals, without trailing zeros. */
export function formatAmount(value: bigint, decimals = 18, maxFraction = 4): string {
  const [whole = "0", fraction = ""] = formatUnits(value, decimals).split(".");
  const trimmed = fraction.slice(0, maxFraction).replace(TRAILING_ZEROS, "");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return trimmed === "" ? grouped : `${grouped}.${trimmed}`;
}
