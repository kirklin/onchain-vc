import type { Address, Hex } from "viem";

/** A call a user signed for the Forwarder to make on their behalf (ERC-2771). */
export interface ForwardRequest {
  from: Address;
  to: Address;
  value: bigint;
  /** Gas handed to the call itself. The relayer adds what the Forwarder needs on top. */
  gas: bigint;
  /** Unix seconds after which the Forwarder refuses the request. */
  deadline: number;
  data: Hex;
}

export interface SignedForwardRequest extends ForwardRequest {
  signature: Hex;
}

/** The message `from` signs. `nonce` is the Forwarder's `nonces(from)` at the time of signing. */
export function forwardRequestTypedData(parameters: { chainId: number; forwarder: Address; nonce: bigint; request: ForwardRequest }) {
  const { chainId, forwarder, nonce, request } = parameters;
  return {
    // The name is the one contracts/src/Forwarder.sol passes to its constructor.
    domain: { name: "Forwarder", version: "1", chainId, verifyingContract: forwarder },
    types: {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    },
    primaryType: "ForwardRequest",
    message: { ...request, nonce },
  } as const;
}

/**
 * Why the relayer declined a request:
 * - `target`: the contract or function is not listed in `relayed`, or the request carries value.
 * - `gas`: the call asks for more gas than the chain's relay limit allows.
 * - `signature`: the signature, nonce or deadline does not hold up.
 * - `reverted`: the call would revert.
 * - `limit`: this signer has used up its allowance for now.
 * - `exhausted`: the relayer has spent its whole budget.
 */
export type RelayRefusal = "target" | "gas" | "signature" | "reverted" | "limit" | "exhausted";
