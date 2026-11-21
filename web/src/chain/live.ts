import type { UseWatchBlockNumberParameters, UseWatchContractEventParameters } from "wagmi";
import { useNow } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { useBlock, useChainId, useWatchBlockNumber, useWatchContractEvent } from "wagmi";
import { networkOf, webSocketUrlOf } from "./config";

/**
 * Whether new blocks and events on a chain are pushed to the page over a WebSocket. Where
 * they are not, the page asks for them once per block instead.
 */
export function isPushed(chainId: number): boolean {
  const network = networkOf(chainId);
  return network !== undefined && webSocketUrlOf(network.chain) !== undefined;
}

/**
 * Calls `onLogs` when the contract emits the event, pushed where the chain allows and
 * polled where it does not. Keep `onLogs` the same function between renders, with
 * `useCallback`, or the subscription is set up again each time.
 */
export const useContractEvent = ((parameters: UseWatchContractEventParameters) => {
  const chainId = useChainId();
  // wagmi types `poll` from the kind of transport, and this one is decided at run time.
  useWatchContractEvent({ ...parameters, poll: !isPushed(parameters.chainId ?? chainId) } as UseWatchContractEventParameters);
}) as typeof useWatchContractEvent;

/**
 * Calls `callback` when the chain has a new block, which is when anything read from it may
 * have changed, a payment from someone else included. On a fast chain blocks come several
 * a second, so calls are spaced at least `minIntervalMs` apart, the last one never dropped.
 */
export function useOnBlock(callback: () => void, minIntervalMs = 2000) {
  const chainId = useChainId();
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const stateRef = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | undefined }>({ last: 0, timer: undefined });
  const onBlockNumber = useCallback(() => {
    const state = stateRef.current;
    if (state.timer !== undefined) {
      return;
    }
    const wait = Math.max(0, state.last + minIntervalMs - Date.now());
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.last = Date.now();
      callbackRef.current();
    }, wait);
  }, [minIntervalMs]);
  useEffect(() => {
    const state = stateRef.current;
    return () => clearTimeout(state.timer);
  }, []);

  useWatchBlockNumber({ onBlockNumber, poll: !isPushed(chainId) } as UseWatchBlockNumberParameters);
}

/**
 * The time on the chain, which is what contracts compare deadlines against. It follows the
 * newest block and moves forward with the clock between blocks.
 *
 * A chain can run ahead of the clock, as a local one does when it produces several blocks
 * a second. The time then holds at the newest block's until the clock catches up, since
 * the next block will not be stamped any earlier.
 */
export function useChainNow(): Date {
  const chainId = useChainId();
  const now = useNow({ updateInterval: 1000 });
  const { data: block } = useBlock({ watch: { poll: !isPushed(chainId) } });
  const blockTime = block === undefined ? 0 : Number(block.timestamp) * 1000;
  return blockTime > now.getTime() ? new Date(blockTime) : now;
}

/** The time left until `until`: whole days, and the rest as `HH:MM:SS`. All zero once it is reached. */
export function countdown(until: Date, now: Date): { days: number; clock: string } {
  const seconds = Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1000));
  const clock = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, "0"))
    .join(":");
  return { days: Math.floor(seconds / 86_400), clock };
}
