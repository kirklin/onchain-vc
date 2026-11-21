import type { Abi, Address } from "viem";
import { useChainId } from "wagmi";
import * as generated from "~/contracts/abis";

/** Contracts that sit at the same address on every chain, the local one included. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" satisfies Address;
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" satisfies Address;

/**
 * Every deployed contract the app knows, with the addresses recorded by `pnpm deploy:contracts`.
 * After adding a contract to contracts/src and to script/Deploy.s.sol, list it here.
 */
export const contracts = {
  Token: { abi: generated.tokenAbi, addresses: generated.tokenAddress },
  Forwarder: { abi: generated.forwarderAbi, addresses: generated.forwarderAddress },
  BatchExecutor: { abi: generated.batchExecutorAbi, addresses: generated.batchExecutorAddress },
  Faucet: { abi: generated.faucetAbi, addresses: generated.faucetAddress },
} as const satisfies Record<string, { abi: Abi; addresses: Record<number, Address> }>;

export type ContractName = keyof typeof contracts;

/**
 * Functions whose gas the server pays when a user signs the call instead of sending it.
 * Only list contracts that trust the Forwarder (ERC-2771), and only functions that are
 * cheap and safe to offer for free: the relayer's budget is spent on whatever is listed.
 */
export const relayed: Partial<Record<ContractName, readonly string[]>> = {};

export function addressOn(name: ContractName, chainId: number): Address | undefined {
  return (contracts[name].addresses as Partial<Record<number, Address>>)[chainId];
}

/** The contract on the given chain, or undefined when it is not deployed there. */
export function deploymentOn<Name extends ContractName>(name: Name, chainId: number) {
  const address = addressOn(name, chainId);
  return address === undefined ? undefined : { abi: contracts[name].abi as (typeof contracts)[Name]["abi"], address };
}

/** The contract on the chain the app is currently set to, or undefined when it is not deployed there. */
export function useDeployment<Name extends ContractName>(name: Name) {
  return deploymentOn(name, useChainId());
}
