import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { serverEnv } from "../env";

// One collection per process. Stored on globalThis so dev-server reloads keep it.
const holder = globalThis as typeof globalThis & { onchainVcModels?: Models };

/** Every provider pi-ai knows. Each reads its key from its usual variable, DEEPSEEK_API_KEY for DeepSeek. */
export function models(): Models {
  holder.onchainVcModels ??= builtinModels({ identity: { attribution: null } });
  return holder.onchainVcModels;
}

/**
 * The model named by PARTNER_MODEL. Fails at once when the catalog does not have it or its
 * provider has no key, so a misconfigured server never starts a meeting it cannot finish.
 */
export async function partnerModel(): Promise<Model<Api>> {
  const name = serverEnv().partnerModel;
  const [provider, ...rest] = name.split("/");
  const model = models().getModel(provider!, rest.join("/"));
  if (model === undefined) {
    throw new Error(`PARTNER_MODEL names ${name}, which the model catalog does not have.`);
  }
  if (await models().getAuth(model) === undefined) {
    throw new Error(`PARTNER_MODEL is ${name}, but its provider has no key. For DeepSeek set DEEPSEEK_API_KEY, or set COMMITTEE=off to serve the app without the partners.`);
  }
  return model;
}
