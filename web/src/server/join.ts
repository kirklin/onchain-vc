import type { Address, Hash } from "viem";
import type { Operator } from "./operator";
import type { JoinLimits } from "~/chain/networks";
import { encodeFunctionData } from "viem";
import { fundAbi, receptionAbi, tokenAbi } from "~/contracts/abis";

export type JoinResult
  = | { status: "joined"; shares: bigint; transactionHash: Hash; blockNumber: bigint }
    /** The address holds shares already. */
    | { status: "member"; shares: bigint }
    /** The app has taken in as many visitors as it is set to. */
    | { status: "full" };

export interface JoinOptions extends JoinLimits {
  operator: Operator;
  fund: Address;
  token: Address;
  /** The Reception contract, which takes many visitors in with one transaction. */
  reception: Address;
  /** The native tokens each visitor is left with, for the gas of their own vetoes. */
  gasMoney: bigint;
  /** How far above the node's estimate to set gas limits, in percent. */
  gasMarginPercent: number;
  maxBatchSize?: number;
}

interface Waiter {
  address: Address;
  resolve: (result: JoinResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Makes visitors investors: each gets the same number of shares, so a room of people can
 * hold the fund together and each counts alike when they vote on a veto. The shares are
 * bought with a test token the operator mints.
 *
 * Requests that arrive while a transaction is in flight ride together in the next one, so a
 * room that scans the code at the same moment is taken in by a few transactions.
 */
export class JoinService {
  readonly #options: Required<JoinOptions>;
  readonly #inFlight = new Map<Address, Promise<JoinResult>>();
  #queue: Waiter[] = [];
  #draining = false;
  /** Visitors accepted whose transaction has not settled yet. */
  #waiting = 0;
  #members = 0;

  constructor(options: JoinOptions) {
    // Each visitor costs about 200k gas, and a transaction may use 30M.
    this.#options = { maxBatchSize: 50, ...options };
  }

  get members(): number {
    return this.#members;
  }

  join(address: Address): Promise<JoinResult> {
    const running = this.#inFlight.get(address);
    if (running !== undefined) {
      return running;
    }
    const started = this.#join(address).finally(() => this.#inFlight.delete(address));
    this.#inFlight.set(address, started);
    return started;
  }

  async #join(address: Address): Promise<JoinResult> {
    const { operator, fund, members } = this.#options;
    const held = await operator.client.readContract({ address: fund, abi: fundAbi, functionName: "balanceOf", args: [address] });
    if (held > 0n) {
      return { status: "member", shares: held };
    }
    if (this.#members + this.#waiting >= members) {
      return { status: "full" };
    }
    this.#waiting += 1;
    return new Promise<JoinResult>((resolve, reject) => {
      this.#queue.push({ address, resolve, reject });
      void this.#drain();
    }).finally(() => {
      this.#waiting -= 1;
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
        const receipt = await this.#admit(waiters.map(waiter => waiter.address));
        this.#members += waiters.length;
        for (const waiter of waiters) {
          waiter.resolve({ status: "joined", shares: this.#options.shares, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber });
        }
      } catch (error) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
    }
    this.#draining = false;
  }

  async #admit(visitors: Address[]) {
    const { operator, reception, shares, gasMoney, gasMarginPercent } = this.#options;
    await this.#stock(visitors.length);
    const call = { address: reception, abi: receptionAbi, functionName: "admit", args: [visitors, shares, gasMoney] } as const;
    const value = gasMoney * BigInt(visitors.length);
    const gas = await operator.client.estimateContractGas({ ...call, value, account: operator.address });
    return operator.send({ to: reception, data: encodeFunctionData(call), value, gas: gas + gas * BigInt(gasMarginPercent) / 100n });
  }

  /** Keeps the Reception holding what the next visitors' shares cost, minting well ahead when it runs low. */
  async #stock(visitors: number) {
    const { operator, fund, token, reception, shares, members, gasMarginPercent } = this.#options;
    const [price, held] = await Promise.all([
      operator.client.readContract({ address: fund, abi: fundAbi, functionName: "previewMint", args: [shares] }),
      operator.client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [reception] }),
    ]);
    if (held >= price * BigInt(visitors)) {
      return;
    }
    const data = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [reception, price * BigInt(members)] });
    const gas = await operator.client.estimateGas({ account: operator.address, to: token, data });
    await operator.send({ to: token, data, gas: gas + gas * BigInt(gasMarginPercent) / 100n });
  }
}
