import type { NonceManager } from "viem";
import { getTransactionCount } from "viem/actions";

interface State {
  next: number | undefined;
  syncing: Promise<void> | undefined;
  /** Set after a failed send, when transactions still in flight could skew the on-chain count. */
  unsettled: boolean;
  /** Incremented by every reset. */
  generation: number;
}

/**
 * Hands out nonces from memory so a burst of transactions costs no extra round trips.
 *
 * The count is read from the chain once. After a failed send it is read again, but only
 * after `settleMs`, giving transactions that were already on their way time to land.
 */
export function createLocalNonceManager({ settleMs }: { settleMs: number }): NonceManager {
  const states = new Map<string, State>();

  function stateOf(address: string, chainId: number): State {
    const key = `${chainId}:${address.toLowerCase()}`;
    let state = states.get(key);
    if (state === undefined) {
      state = { next: undefined, syncing: undefined, unsettled: false, generation: 0 };
      states.set(key, state);
    }
    return state;
  }

  async function sync(state: State, parameters: Parameters<NonceManager["get"]>[0]): Promise<number> {
    while (state.next === undefined) {
      state.syncing ??= (async () => {
        const generation = state.generation;
        if (state.unsettled) {
          await new Promise(resolve => setTimeout(resolve, settleMs));
        }
        const count = await getTransactionCount(parameters.client, { address: parameters.address, blockTag: "pending" });
        // A send that failed in the meantime makes this count stale. The loop reads it again.
        if (generation === state.generation) {
          state.next = count;
          state.unsettled = false;
        }
      })().finally(() => {
        state.syncing = undefined;
      });
      await state.syncing;
    }
    return state.next;
  }

  return {
    async consume(parameters) {
      const state = stateOf(parameters.address, parameters.chainId);
      const nonce = await sync(state, parameters);
      state.next = nonce + 1;
      return nonce;
    },
    async get(parameters) {
      return sync(stateOf(parameters.address, parameters.chainId), parameters);
    },
    increment({ address, chainId }) {
      const state = stateOf(address, chainId);
      if (state.next !== undefined) {
        state.next += 1;
      }
    },
    reset({ address, chainId }) {
      const state = stateOf(address, chainId);
      state.next = undefined;
      state.unsettled = true;
      state.generation += 1;
    },
  };
}
