import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { serverEnv } from "../env";

// One collection per process. Stored on globalThis so dev-server reloads keep it.
const holder = globalThis as typeof globalThis & { onchainVcModels?: MutableModels };

/** The provider and the model id in a `<provider>/<model>` name. */
function parse(name: string): { provider: string; id: string } {
  const [provider, ...rest] = name.split("/");
  return { provider: provider!, id: rest.join("/") };
}

/**
 * Every provider pi-ai knows, each reading its key from its usual variable, DEEPSEEK_API_KEY
 * for DeepSeek. With PARTNER_BASE_URL set, the provider PARTNER_MODEL names is that endpoint,
 * reached over Anthropic's Messages API with PARTNER_API_KEY.
 */
export function models(): MutableModels {
  if (holder.onchainVcModels !== undefined) {
    return holder.onchainVcModels;
  }
  const collection = builtinModels({ identity: { attribution: null } });
  const { partnerModel: name, partnerBaseUrl: baseUrl } = serverEnv();
  if (baseUrl !== undefined) {
    const { provider, id } = parse(name);
    const model: Model<"anthropic-messages"> = {
      id,
      name: id,
      api: "anthropic-messages",
      provider,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    };
    collection.setProvider(createProvider({
      id: provider,
      baseUrl,
      auth: { apiKey: envApiKeyAuth("Partner model endpoint", ["PARTNER_API_KEY"]) },
      models: [model],
      api: anthropicMessagesApi(),
    }));
  }
  holder.onchainVcModels = collection;
  return collection;
}

/**
 * The model named by PARTNER_MODEL. Fails at once when the catalog does not have it or its
 * provider has no key, so a misconfigured server never starts a meeting it cannot finish.
 */
export async function partnerModel(): Promise<Model<Api>> {
  const name = serverEnv().partnerModel;
  const { provider, id } = parse(name);
  const model = models().getModel(provider, id);
  if (model === undefined) {
    throw new Error(`PARTNER_MODEL names ${name}, which the model catalog does not have.`);
  }
  if (await models().getAuth(model) === undefined) {
    throw new Error(`PARTNER_MODEL is ${name}, but its provider has no key. For DeepSeek set DEEPSEEK_API_KEY, for an endpoint named by PARTNER_BASE_URL set PARTNER_API_KEY, or set COMMITTEE=off to serve the app without the partners.`);
  }
  return model;
}
