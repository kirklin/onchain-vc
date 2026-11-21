import type { Address } from "viem";
import { PERMIT2_ADDRESS } from "./contracts";

/**
 * The message a token holder signs to grant an allowance without sending a transaction
 * (ERC-2612). Whoever holds the signature passes it to the token's `permit`, usually inside
 * the same call that then spends the allowance.
 */
export function permitTypedData(parameters: {
  chainId: number;
  token: Address;
  /** The token's EIP-712 domain name, which for most tokens is its `name()`. */
  name: string;
  version?: string;
  owner: Address;
  spender: Address;
  value: bigint;
  /** The token's `nonces(owner)` at the time of signing. */
  nonce: bigint;
  deadline: bigint;
}) {
  const { chainId, token, name, version = "1", owner, spender, value, nonce, deadline } = parameters;
  return {
    domain: { name, version, chainId, verifyingContract: token },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner, spender, value, nonce, deadline },
  } as const;
}

/**
 * The message a token holder signs to let `spender` pull one transfer through Permit2.
 * It works for any ERC-20 the holder has approved to Permit2 once, with or without ERC-2612.
 */
export function permit2TransferTypedData(parameters: {
  chainId: number;
  token: Address;
  amount: bigint;
  spender: Address;
  /** Any number not used before by this owner. See `randomPermit2Nonce`. */
  nonce: bigint;
  deadline: bigint;
}) {
  const { chainId, token, amount, spender, nonce, deadline } = parameters;
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    message: { permitted: { token, amount }, spender, nonce, deadline },
  } as const;
}

/**
 * Permit2 tracks signature-transfer nonces as a bitmap, so they need not be sequential and a
 * random one never has to be looked up first.
 */
export function randomPermit2Nonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

/** A deadline `seconds` from now, in the unit contracts compare against `block.timestamp`. */
export function deadlineIn(seconds: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}
