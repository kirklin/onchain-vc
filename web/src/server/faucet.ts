import type { Address } from "viem";
import type { Operator } from "./operator";
import type { FaucetLimits } from "~/chain/networks";
import { encodeFunctionData, parseEventLogs } from "viem";
import { faucetAbi } from "~/contracts/abis";

export type FundResult
  = | { status: "funded"; amount: bigint }
    /** The balance is still above the low-water mark. */
    | { status: "sufficient" }
    /** This address has received everything one address may receive. */
    | { status: "limit" }
    /** The faucet has given out its whole budget. */
    | { status: "exhausted" };

export interface FaucetOptions extends FaucetLimits {
  operator: Operator;
  contract: Address;
  maxBatchSize?: number;
}

// Sized for Monad, the costliest of the supported chains and the one that bills the whole
// limit: about 22k for the call plus 44k for each account created, measured on Anvil.
const DRIP_BASE_GAS = 30_000n;
const DRIP_GAS_PER_RECIPIENT = 48_000n;

interface Waiter {
  address: Address;
  resolve: (result: FundResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Tops up accounts with native tokens through the Faucet contract.
 *
 * Requests that arrive while a transaction is in flight ride together in the next one, so a
 * burst of new visitors costs a few transactions instead of one each.
 */
export class FaucetService {
  readonly #options: Required<FaucetOptions>;
  readonly #granted = new Map<Address, bigint>();
  #queue: Waiter[] = [];
  #spent = 0n;
  #draining = false;

  constructor(options: FaucetOptions) {
    this.#options = { maxBatchSize: 100, ...options };
  }

  get spent(): bigint {
    return this.#spent;
  }

  get recipients(): number {
    return this.#granted.size;
  }

  async fund(address: Address): Promise<FundResult> {
    const { operator, target, lowWater, perAddress, budget } = this.#options;

    if ((this.#granted.get(address) ?? 0n) >= perAddress) {
      return { status: "limit" };
    }
    const reserved = target * BigInt(this.#queue.length + 1);
    if (this.#spent + reserved > budget) {
      return { status: "exhausted" };
    }
    const balance = await operator.client.getBalance({ address });
    if (balance > lowWater) {
      return { status: "sufficient" };
    }

    return new Promise((resolve, reject) => {
      this.#queue.push({ address, resolve, reject });
      void this.#drain();
    });
  }

  async #drain() {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    while (this.#queue.length > 0) {
      const waiters = this.#queue.splice(0, this.#options.maxBatchSize);
      try {
        const amounts = await this.#drip([...new Set(waiters.map(waiter => waiter.address))]);
        for (const waiter of waiters) {
          const amount = amounts.get(waiter.address);
          waiter.resolve(amount === undefined ? { status: "sufficient" } : { status: "funded", amount });
        }
      } catch (error) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
    }
    this.#draining = false;
  }

  async #drip(recipients: Address[]): Promise<Map<Address, bigint>> {
    const { operator, contract, target } = this.#options;
    const gas = DRIP_BASE_GAS + DRIP_GAS_PER_RECIPIENT * BigInt(recipients.length);

    const receipt = await operator.send({
      to: contract,
      data: encodeFunctionData({ abi: faucetAbi, functionName: "drip", args: [recipients, target] }),
      value: target * BigInt(recipients.length),
      gas,
    });
    this.#spent += gas * receipt.effectiveGasPrice;

    const amounts = new Map<Address, bigint>();
    for (const log of parseEventLogs({ abi: faucetAbi, eventName: "Dripped", logs: receipt.logs })) {
      const { to, amount } = log.args;
      amounts.set(to, amount);
      this.#granted.set(to, (this.#granted.get(to) ?? 0n) + amount);
      this.#spent += amount;
    }
    return amounts;
  }
}
