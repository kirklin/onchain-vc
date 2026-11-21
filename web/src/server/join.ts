import type { Address, Hash } from "viem";
import type { FaucetService } from "./faucet";
import type { Operator } from "./operator";
import type { JoinLimits } from "~/chain/networks";
import { encodeFunctionData, maxUint256 } from "viem";
import { fundAbi, tokenAbi } from "~/contracts/abis";

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
  /** Gives the visitor native tokens for the gas of their own vetoes, where there is a faucet. */
  faucet: FaucetService | undefined;
  /** How far above the node's estimate to set gas limits, in percent. */
  gasMarginPercent: number;
}

/**
 * Makes a visitor an investor: the operator mints the fund's asset and buys the same number
 * of shares for each of them, so a room of people can hold the fund together and each
 * counts alike when they vote on a veto. The asset is a test token the operator owns.
 */
export class JoinService {
  readonly #options: JoinOptions;
  readonly #inFlight = new Map<Address, Promise<JoinResult>>();
  #ready: Promise<void> | undefined;
  #members = 0;

  constructor(options: JoinOptions) {
    this.#options = options;
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
    const { operator, fund, faucet, shares, members, gasMarginPercent } = this.#options;

    const held = await operator.client.readContract({ address: fund, abi: fundAbi, functionName: "balanceOf", args: [address] });
    if (held > 0n) {
      return { status: "member", shares: held };
    }
    if (this.#members + this.#inFlight.size > members) {
      return { status: "full" };
    }

    this.#ready ??= this.#prepare();
    await this.#ready;
    // The gas money goes out first, so it has aged past the chain's spend delay by the time it is needed.
    await faucet?.fund(address);

    const call = { address: fund, abi: fundAbi, functionName: "mint", args: [shares, address] } as const;
    const gas = await operator.client.estimateContractGas({ ...call, account: operator.address });
    const receipt = await operator.send({
      to: fund,
      data: encodeFunctionData(call),
      gas: gas + gas * BigInt(gasMarginPercent) / 100n,
    });
    this.#members += 1;
    return { status: "joined", shares, transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
  }

  /** Mints what the visitors' shares can cost and lets the fund draw on it. */
  async #prepare() {
    const { operator, fund, token, shares, members } = this.#options;
    // A share is worth more than one token once the fund has gained, so the float is doubled.
    const float = shares * BigInt(members) * 2n;
    const [balance, allowance] = await Promise.all([
      operator.client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [operator.address] }),
      operator.client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [operator.address, fund] }),
    ]);
    if (balance < float) {
      await this.#send(token, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [operator.address, float - balance] }));
    }
    if (allowance < float) {
      await this.#send(token, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [fund, maxUint256] }));
    }
  }

  async #send(to: Address, data: `0x${string}`) {
    const { operator, gasMarginPercent } = this.#options;
    const gas = await operator.client.estimateGas({ account: operator.address, to, data });
    await operator.send({ to, data, gas: gas + gas * BigInt(gasMarginPercent) / 100n });
  }
}
