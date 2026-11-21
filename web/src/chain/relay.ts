import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, ContractFunctionParameters, Hash, LocalAccount } from "viem";
import type { ForwardRequest, RelayRefusal } from "./forward";
import { useCallback } from "react";
import { encodeFunctionData } from "viem";
import { estimateContractGas } from "viem/actions";
import { useChainId, useConfig } from "wagmi";
import { getPublicClient, readContract, signTypedData } from "wagmi/actions";
import { forwarderAbi } from "~/contracts/abis";
import { networkOf } from "./config";
import { addressOn } from "./contracts";
import { forwardRequestTypedData } from "./forward";
import { DEFAULT_GAS_MARGIN_PERCENT } from "./networks";
import { deadlineIn } from "./permit";

type Mutability = "nonpayable" | "payable";

/** How long the relayer has to submit a signed request before the Forwarder refuses it. */
const REQUEST_LIFETIME_SECONDS = 10 * 60;

/** Thrown when the relayer declines a request. `reason` says why. */
export class RelayRefusedError extends Error {
  override name = "RelayRefusedError";
  readonly reason: RelayRefusal;

  constructor(reason: RelayRefusal) {
    super(`The relayer refused the request: ${reason}.`);
    this.reason = reason;
  }
}

/**
 * Sends contract calls through the server's relayer, so the user signs and the server pays
 * the gas. `available` is false on chains without a relayer, where calls must be sent the
 * usual way. The target contract has to trust the Forwarder and be listed in `relayed`.
 *
 * By default the connected wallet signs as `from`. Pass `signer` to sign with a key held in
 * the page instead, such as a session key, in which case nothing prompts the user.
 */
export function useRelay() {
  const config = useConfig();
  const chainId = useChainId();
  const forwarder = addressOn("Forwarder", chainId);
  const available = forwarder !== undefined && networkOf(chainId)?.relay !== undefined;

  const relay = useCallback(async <
    const abi extends Abi,
    functionName extends ContractFunctionName<abi, Mutability>,
    const args extends ContractFunctionArgs<abi, Mutability, functionName>,
  >(
    call: ContractFunctionParameters<abi, Mutability, functionName, args>,
    options: { from: Address; signer?: LocalAccount },
  ): Promise<Hash> => {
    if (forwarder === undefined) {
      throw new Error(`No Forwarder is deployed on chain ${chainId}.`);
    }
    const from = options.signer?.address ?? options.from;
    const { address: to, ...rest } = call as unknown as ContractFunctionParameters<Abi, Mutability, string>;

    // Estimated the way the target will see the call: from the Forwarder, with the signer
    // appended. A call that would revert fails here, with the contract's own error.
    const estimate = await estimateContractGas(getPublicClient(config, { chainId })!, { ...rest, address: to, account: forwarder, dataSuffix: from });
    // The relayer is billed for this limit on chains that charge the limit, so the margin is the chain's own.
    const margin = BigInt(networkOf(chainId)?.gasMarginPercent ?? DEFAULT_GAS_MARGIN_PERCENT);
    const request: ForwardRequest = {
      from,
      to,
      value: 0n,
      gas: estimate + estimate * margin / 100n,
      deadline: Number(deadlineIn(REQUEST_LIFETIME_SECONDS)),
      data: encodeFunctionData(rest),
    };

    const nonce = await readContract(config, { address: forwarder, abi: forwarderAbi, functionName: "nonces", args: [from], chainId });
    const typedData = forwardRequestTypedData({ chainId, forwarder, nonce, request });
    const signature = options.signer === undefined
      ? await signTypedData(config, typedData)
      : await options.signer.signTypedData(typedData);

    const response = await fetch("/api/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chainId,
        request: { ...request, value: request.value.toString(), gas: request.gas.toString(), signature },
      }),
    });
    const result = await response.json() as { status: "relayed"; hash: Hash } | { status: "refused"; reason: RelayRefusal } | { error: string };
    if ("error" in result) {
      throw new Error(`Relay request failed with HTTP ${response.status}: ${result.error}`);
    }
    if (result.status === "refused") {
      throw new RelayRefusedError(result.reason);
    }
    return result.hash;
  }, [config, chainId, forwarder]);

  return { available, relay };
}
