import type { Address, Chain, Hex, TransactionReceipt } from "viem";
import type { RpcGateway } from "./rpc-gateway";
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
  #tail: Promise<unknown> = Promise.resolve();
  #nextNonce = 0;

  constructor(options: { key: Hex; chain: Chain; gateway: RpcGateway }) {
    this.client = createWalletClient({
      account: privateKeyToAccount(options.key),
      chain: options.chain,
      transport: gatewayTransport(options.gateway),
    }).extend(publicActions);
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

    const receipt = await this.client.sendTransactionSync({ ...call, nonce });
    // A reverted transaction is still included and still uses up its nonce.
    this.#nextNonce = nonce + 1;
    if (receipt.status !== "success") {
      throw new Error(`Transaction ${receipt.transactionHash} to ${call.to} reverted.`);
    }
    return receipt;
  }
}
