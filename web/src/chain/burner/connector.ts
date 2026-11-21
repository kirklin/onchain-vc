import type { Address, Chain, EIP1193RequestFn, Hex, PrivateKeyAccount } from "viem";
import type { BurnerClient } from "./client";
import { http, numberToHex } from "viem";
import { sendTransaction, signMessage, signTypedData } from "viem/actions";
import { ChainNotConfiguredError, createConnector } from "wagmi";
import { createBurnerClient } from "./client";
import { createLocalNonceManager } from "./nonce";
import { ensureBurnerKey, rememberBurnerConnected, wasBurnerConnected } from "./storage";

export const BURNER_CONNECTOR_ID = "burner";

interface BurnerProvider {
  request: EIP1193RequestFn;
}

/**
 * A wallet that lives in the browser: the key is generated on first visit and kept in
 * localStorage, and every signature happens locally without a prompt.
 *
 * wagmi uses the client returned by `getClient` for all wallet actions, so `useWriteContract`,
 * `useSendTransaction` and `useSignMessage` work as they do with any other wallet.
 *
 * `executorOn` gives the BatchExecutor's address on a chain, where there is one, and
 * `gasMarginPercentOn` how far to raise gas estimates there. See `createBurnerClient`.
 */
export function burner(options: {
  executorOn: (chainId: number) => Address | undefined;
  gasMarginPercentOn: (chainId: number) => number;
}) {
  const nonceManagers = new Map<number, ReturnType<typeof createLocalNonceManager>>();
  const clients = new Map<number, BurnerClient>();
  let account: PrivateKeyAccount | undefined;
  let currentChainId: number | undefined;

  return createConnector<BurnerProvider>((config) => {
    function chainOf(chainId: number): Chain {
      const chain = config.chains.find(candidate => candidate.id === chainId);
      if (chain === undefined) {
        throw new ChainNotConfiguredError();
      }
      return chain;
    }

    function clientOf(chainId: number): BurnerClient {
      let client = clients.get(chainId);
      if (client === undefined) {
        const chain = chainOf(chainId);
        let nonceManager = nonceManagers.get(chainId);
        if (nonceManager === undefined) {
          // After a failed send, wait a few blocks before reading the transaction count
          // again, so transactions already on their way are included in it.
          nonceManager = createLocalNonceManager({ settleMs: (chain.blockTime ?? 1000) * 3 });
          nonceManagers.set(chainId, nonceManager);
        }
        client = createBurnerClient({
          key: ensureBurnerKey(),
          chain,
          transport: config.transports?.[chainId] ?? http(),
          nonceManager,
          executor: options.executorOn(chainId),
          gasMarginPercent: options.gasMarginPercentOn(chainId),
        });
        clients.set(chainId, client);
      }
      return client;
    }

    return {
      id: BURNER_CONNECTOR_ID,
      name: "Burner Wallet",
      type: "burner",

      async connect({ chainId } = {}) {
        currentChainId = chainOf(chainId ?? config.chains[0].id).id;
        account = clientOf(currentChainId).account;
        rememberBurnerConnected(true);
        return { accounts: [account.address] as never, chainId: currentChainId };
      },

      async disconnect() {
        account = undefined;
        rememberBurnerConnected(false);
      },

      async getAccounts(): Promise<readonly Address[]> {
        return account === undefined ? [] : [account.address];
      },

      async getChainId() {
        return currentChainId ?? config.chains[0].id;
      },

      // wagmi reconnects every authorized connector on page load, so this must stay false
      // until the visitor has picked the burner wallet themselves.
      async isAuthorized() {
        return wasBurnerConnected();
      },

      async getClient({ chainId } = {}) {
        return clientOf(chainId ?? (await this.getChainId()));
      },

      async getProvider({ chainId } = {}) {
        const client = clientOf(chainId ?? (await this.getChainId()));

        const request = (async ({ method, params }: { method: string; params?: unknown }) => {
          const args = (params ?? []) as unknown[];
          switch (method) {
            case "eth_accounts":
            case "eth_requestAccounts":
              return [client.account.address];
            case "eth_chainId":
              return numberToHex(client.chain.id);
            case "personal_sign":
              return signMessage(client, { message: { raw: args[0] as Hex } });
            case "eth_signTypedData_v4":
              return signTypedData(client, JSON.parse(args[1] as string));
            case "eth_sendTransaction": {
              const { from: _from, gas, value, maxFeePerGas, maxPriorityFeePerGas, ...rest } = args[0] as Record<string, Hex | undefined>;
              return sendTransaction(client, {
                ...rest,
                gas: gas === undefined ? undefined : BigInt(gas),
                value: value === undefined ? undefined : BigInt(value),
                maxFeePerGas: maxFeePerGas === undefined ? undefined : BigInt(maxFeePerGas),
                maxPriorityFeePerGas: maxPriorityFeePerGas === undefined ? undefined : BigInt(maxPriorityFeePerGas),
              } as Parameters<typeof sendTransaction>[1]);
            }
            default:
              return client.request({ method, params } as Parameters<typeof client.request>[0]);
          }
        }) as EIP1193RequestFn;

        return { request };
      },

      async switchChain({ chainId }) {
        const chain = chainOf(chainId);
        currentChainId = chainId;
        account = clientOf(chainId).account;
        config.emitter.emit("change", { chainId });
        return chain;
      },

      onAccountsChanged() {},
      onChainChanged() {},
      onDisconnect() {
        account = undefined;
        config.emitter.emit("disconnect");
      },
    };
  });
}
