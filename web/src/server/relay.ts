import type { Address, Hash, Hex } from "viem";
import type { Operator } from "./operator";
import type { RelayRefusal, SignedForwardRequest } from "~/chain/forward";
import type { RelayLimits } from "~/chain/networks";
import { BaseError, concat, encodeFunctionData, ExecutionRevertedError, size, slice } from "viem";
import { forwarderAbi } from "~/contracts/abis";

export type RelayResult
  = | { status: "relayed"; hash: Hash }
    | { status: "refused"; reason: RelayRefusal };

export interface RelayOptions extends RelayLimits {
  operator: Operator;
  forwarder: Address;
  /** The 4-byte selectors that may be relayed, for each target contract in lower case. */
  targets: ReadonlyMap<string, ReadonlySet<Hex>>;
}

// What `Forwarder.execute` uses around the call it forwards: checking the signature, asking
// the target whether it trusts the forwarder, and storing the next nonce. Measured on Anvil
// at 35k for a signer's first request, the costliest one. The rest is margin for chains that
// charge more for reading an account or a storage slot the first time.
const FORWARD_OVERHEAD_GAS = 55_000n;
const BASE_TRANSACTION_GAS = 21_000n;
const GAS_PER_CALLDATA_BYTE = 16n;

/**
 * Pays the gas of calls that users sign for the Forwarder (ERC-2771).
 *
 * A request is only sent when the target and function are on the list, the signer is within
 * its allowance, the signature holds, and the call succeeds in simulation, so the budget is
 * never spent on a transaction that was bound to fail. Requests are handled one at a time,
 * which also means two requests signed with the same nonce cannot both get through.
 */
export class RelayService {
  readonly #options: RelayOptions;
  readonly #recent = new Map<Address, number[]>();
  #tail: Promise<unknown> = Promise.resolve();
  #spent = 0n;
  #sweptAt = Date.now();

  constructor(options: RelayOptions) {
    this.#options = options;
  }

  get spent(): bigint {
    return this.#spent;
  }

  relay(request: SignedForwardRequest): Promise<RelayResult> {
    const run = this.#tail.then(() => this.#relay(request));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #relay(request: SignedForwardRequest): Promise<RelayResult> {
    const { operator, forwarder, targets, maxGas, budget } = this.#options;

    const selectors = targets.get(request.to.toLowerCase());
    if (request.value !== 0n || selectors === undefined || size(request.data) < 4 || !selectors.has(slice(request.data, 0, 4))) {
      return { status: "refused", reason: "target" };
    }
    if (request.gas > maxGas) {
      return { status: "refused", reason: "gas" };
    }
    if (this.#spent >= budget) {
      return { status: "refused", reason: "exhausted" };
    }
    if (this.#recentCount(request.from) >= this.#options.perSender) {
      return { status: "refused", reason: "limit" };
    }

    const valid = await operator.client.readContract({ address: forwarder, abi: forwarderAbi, functionName: "verify", args: [request] });
    if (!valid) {
      return { status: "refused", reason: "signature" };
    }
    // Counted from here on: only the signer itself can use up its allowance.
    this.#recent.set(request.from, [...(this.#recent.get(request.from) ?? []), Date.now()]);

    if (!(await this.#succeeds(request))) {
      return { status: "refused", reason: "reverted" };
    }

    const data = encodeFunctionData({ abi: forwarderAbi, functionName: "execute", args: [request] });
    // The Forwarder insists on having a 63rd of the forwarded gas left after the call.
    const gas = BASE_TRANSACTION_GAS + GAS_PER_CALLDATA_BYTE * BigInt(size(data)) + FORWARD_OVERHEAD_GAS + request.gas + request.gas / 63n + 1n;
    const receipt = await operator.send({ to: forwarder, data, gas });
    this.#spent += gas * receipt.effectiveGasPrice;
    return { status: "relayed", hash: receipt.transactionHash };
  }

  #recentCount(sender: Address): number {
    const now = Date.now();
    const cutoff = now - this.#options.windowMs;
    if (now - this.#sweptAt > this.#options.windowMs) {
      this.#sweptAt = now;
      for (const [address, times] of this.#recent) {
        if (times.every(at => at <= cutoff)) {
          this.#recent.delete(address);
        }
      }
    }
    return (this.#recent.get(sender) ?? []).filter(at => at > cutoff).length;
  }

  /** Runs the call exactly as the target will see it: from the Forwarder, with the signer appended. */
  async #succeeds(request: SignedForwardRequest): Promise<boolean> {
    try {
      await this.#options.operator.client.call({
        account: this.#options.forwarder,
        to: request.to,
        data: concat([request.data, request.from]),
        gas: request.gas,
      });
      return true;
    } catch (error) {
      if (error instanceof BaseError && error.walk(cause => cause instanceof ExecutionRevertedError) !== null) {
        return false;
      }
      throw error;
    }
  }
}
