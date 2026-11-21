import type { Address, Chain, Hex, TransactionReceipt } from "viem";
import type { RpcGateway } from "./rpc-gateway";
import { setTimeout as sleep } from "node:timers/promises";
import { createWalletClient, custom, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** A viem transport that hands every call to the gateway in this process. */
export function gatewayTransport(gateway: RpcGateway) {
  return custom(
    {
      async request({ method, params }: { method: string; params?: readonly unknown[] }) {
        const outcome = await gateway.request(method, params ?? []);
        if ("error" in outcome) {
          throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code, data: outcome.error.data });
        }
        return outcome.result;
      },
    },
    { retryCount: 0 },
  );
}

/**
 * A chain's rule that an account's balance stays above a reserve. On Monad a transfer that
 * would take the sender below 10 MON reverts, unless the sender has sent nothing else in the
 * blocks consensus has not yet seen executed.
 */
export interface ReserveRule {
  balance: bigint;
  /** How many blocks must have passed since the account's previous transaction. */
  blocks: number;
}

export interface OperatorCall {
  to: Address;
  data: Hex;
  /** Some chains bill the whole limit, Monad among them, so pass the tightest value that always suffices. */
  gas: bigint;
  value?: bigint;
}

/**
 * The server's own account, used for transactions the app sends on its own behalf.
 * Sends go out one at a time and each waits for its receipt, which keeps nonces in order
 * without any coordination between callers.
 */
export class Operator {
  readonly client;
  readonly #reserve: ReserveRule | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #nextNonce = 0;
  /** The block of this account's latest transaction. */
  #lastBlock: bigint | undefined;

  constructor(options: { key: Hex; chain: Chain; gateway: RpcGateway; reserve?: ReserveRule }) {
    this.client = createWalletClient({
      account: privateKeyToAccount(options.key),
      chain: options.chain,
      transport: gatewayTransport(options.gateway),
    }).extend(publicActions);
    this.#reserve = options.reserve;
  }

  get address(): Address {
    return this.client.account.address;
  }

  send(call: OperatorCall): Promise<TransactionReceipt> {
    const run = this.#tail.then(() => this.#send(call));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #send(call: OperatorCall): Promise<TransactionReceipt> {
    // Upstream nodes can trail each other by a block, so never go below what was already used.
    const onChain = await this.client.getTransactionCount({ address: this.address, blockTag: "latest" });
    const nonce = Math.max(onChain, this.#nextNonce);
    await this.#clearReserve(call.value ?? 0n);

    const receipt = await this.client.sendTransactionSync({ ...call, nonce });
    // A reverted transaction is still included and still uses up its nonce.
    this.#nextNonce = nonce + 1;
    this.#lastBlock = receipt.blockNumber;
    if (receipt.status !== "success") {
      throw new Error(`Transaction ${receipt.transactionHash} to ${call.to} reverted.`);
    }
    return receipt;
  }

  /**
   * Holds back a transfer of native tokens that would take the balance below the chain's
   * reserve until the account's previous transaction is old enough for the chain to let it
   * through. Sent sooner, the transfer would be included and reverted.
   */
  async #clearReserve(value: bigint) {
    const reserve = this.#reserve;
    if (reserve === undefined || value === 0n || this.#lastBlock === undefined) {
      return;
    }
    const balance = await this.client.getBalance({ address: this.address });
    if (balance - value >= reserve.balance) {
      return;
    }
    const clear = this.#lastBlock + BigInt(reserve.blocks);
    while (await this.client.getBlockNumber({ cacheTime: 0 }) < clear) {
      await sleep(this.client.chain.blockTime ?? 1000);
    }
  }
}
