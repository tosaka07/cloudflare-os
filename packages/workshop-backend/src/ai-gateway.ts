import { AiChatAuthorInfo, AiModelConfig, DeploymentCustomModel, GatewayCustomApi,
  isValidGatewayCustomPathPrefix, isValidGatewayCustomSlug, SUGGESTED_MODELS }
  from "@gadgets/workshop-shared/api";
import { UserAiModelRecord } from "./user.js";

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Providers whose pi API adapter refuses a custom fetch, so their inference cannot ride the
 * Workers AI binding and needs CF_AI_GATEWAY_API_TOKEN over HTTPS. pi's Google adapter throws
 * "Custom fetch is not supported by the Google Generative AI adapter" whenever the fetch it is
 * given is not globalThis.fetch, and the client it builds on offers no hook to route around that:
 * @google/genai's `GoogleGenAI` takes only `httpOptions`, whose knobs are
 * baseUrl/apiVersion/headers/timeout/extraBody/retryOptions.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-generative-ai.ts#L80
 *
 * pi's Vertex adapter throws the same way, so a google-vertex provider would belong here too; it
 * is absent only because this deployment has no such provider.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-vertex.ts#L98
 */
const HTTPS_ONLY_PROVIDERS = new Set(["google"]);

const GATEWAY_CUSTOM_APIS: GatewayCustomApi[] =
    ["openai-responses", "openai-completions", "anthropic-messages"];

/**
 * Parse CF_AI_GATEWAY_CUSTOM_MODELS: the models this deployment offers to everyone through its
 * Custom Providers, as a JSON array of {@link DeploymentCustomModel}. Declared in env rather than
 * in SUGGESTED_MODELS because a slug and a path are deployment facts, not product ones -- and
 * because keeping them out of that table leaves it exactly as upstream ships it.
 *
 * Every failure throws: a typo here would otherwise surface as a model that quietly never
 * appears, or one that 404s at the vendor once somebody tries to chat with it.
 */
function parseCustomModels(raw: string | undefined): Map<string, DeploymentCustomModel> {
  const result = new Map<string, DeploymentCustomModel>();
  if (!raw?.trim()) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("CF_AI_GATEWAY_CUSTOM_MODELS is not valid JSON.", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("CF_AI_GATEWAY_CUSTOM_MODELS must be a JSON array of models.");
  }

  for (const entry of parsed as Partial<DeploymentCustomModel>[]) {
    const where = entry?.id ? `model "${entry.id}"` : "a model";
    const fail = (why: string) => {
      throw new Error(`CF_AI_GATEWAY_CUSTOM_MODELS: ${where} ${why}.`);
    };
    if (!entry?.id || !entry.name) fail("needs both an id and a name");
    if (!entry.slug || !isValidGatewayCustomSlug(entry.slug)) {
      fail("needs a slug of letters, digits and hyphens, starting with a letter or digit");
    }
    if (typeof entry.pathPrefix !== "string" || !isValidGatewayCustomPathPrefix(entry.pathPrefix)) {
      fail("needs a pathPrefix whose every segment starts with a letter or digit");
    }
    if (!entry.api || !GATEWAY_CUSTOM_APIS.includes(entry.api)) {
      fail(`needs an api of ${GATEWAY_CUSTOM_APIS.join(", ")}`);
    }
    if (!Number.isInteger(entry.contextWindow) || entry.contextWindow! <= 0) {
      fail("needs a positive integer contextWindow");
    }
    if (result.has(entry.id!)) fail("is declared twice");
    result.set(entry.id!, entry as DeploymentCustomModel);
  }
  return result;
}

export class AiGatewayConfig {
  readonly gateway: string;
  /**
   * The gateway name for Workers-AI-binding calls (webFetch's toMarkdown): binding calls only
   * reach gateways in the Worker's own account, so this is the platform gateway whenever the
   * binding transport is active, and unset when it isn't (see {@link binding}).
   */
  readonly sameAccountGateway?: string;
  readonly accountId: string;
  readonly apiToken?: string;
  /**
   * Workers AI binding, used as the gateway transport whenever present unless
   * CF_AI_GATEWAY_USE_BINDING=false opts out: binding requests are pre-authenticated in-account,
   * so inference and cost-log reads need no API token. Binding requests only reach gateways in
   * the Worker's own account, and the Worker can't verify that itself (it can't discover its own
   * account ID), so deployments whose gateway lives in a DIFFERENT account must set the opt-out
   * and use CF_AI_GATEWAY_API_TOKEN over HTTPS. Absent in local dev unless run-dev-server is
   * started with --use-workers-ai-binding.
   *
   * Such a deployment opts out with the flag rather than by unbinding WORKERS_AI, because the
   * binding is not only the gateway transport: webFetch's document-to-Markdown conversion calls
   * `env.ai.toMarkdown()` through it (see web-fetch.ts), so unbinding would break that too.
   */
  readonly binding?: Ai;
  readonly providers: Set<string>;
  /**
   * Models this deployment offers to everyone, keyed by id. Empty unless the gateway-custom
   * provider is enabled, since each is reached through a Custom Provider on this gateway.
   */
  readonly customModels: Map<string, DeploymentCustomModel>;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID) {
      throw new Error("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN || undefined;
    // Normalized once, so a stray " False " opts out rather than reading as unset and silently
    // picking the other transport.
    const useBinding = env.CF_AI_GATEWAY_USE_BINDING?.trim().toLowerCase();
    this.binding = useBinding === "false"
        ? undefined
        : (env as { WORKERS_AI?: Ai }).WORKERS_AI;
    if (useBinding === "true" && !this.binding) {
      throw new Error(
          "CF_AI_GATEWAY_USE_BINDING requires the WORKERS_AI binding; without it the config " +
          "would silently fall back to the HTTPS transport.");
    }
    if (!this.apiToken && !this.binding) {
      throw new Error(
          "AI Gateway mode needs a transport: bind Workers AI (WORKERS_AI; in local dev start " +
          "with --use-workers-ai-binding) or set CF_AI_GATEWAY_API_TOKEN (a Run + Read token).");
    }
    this.sameAccountGateway = this.binding ? this.gateway : undefined;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
    // Gated on the provider being enabled, so one switch turns the whole feature off and a
    // stale declaration cannot keep offering models the deployment no longer serves.
    this.customModels = this.providers.has("gateway-custom")
        ? parseCustomModels(env.CF_AI_GATEWAY_CUSTOM_MODELS)
        : new Map();
    const httpsOnly = [...this.providers].filter(p => HTTPS_ONLY_PROVIDERS.has(p));
    if (httpsOnly.length > 0 && !this.apiToken) {
      const names = httpsOnly.join(", ");
      throw new Error(
          `${names} inference cannot ride the Workers AI binding transport, so enabling the ` +
          `${names} provider${httpsOnly.length > 1 ? "s" : ""} requires ` +
          "CF_AI_GATEWAY_API_TOKEN.");
    }
  }

  /**
   * Transport for a provider's gateway inference: the Workers AI binding when present, except for
   * the providers in {@link HTTPS_ONLY_PROVIDERS}, which ride HTTPS with the token (the
   * constructor guarantees a token whenever one of them is an enabled provider).
   */
  bindingFor(provider: string): Ai | undefined {
    return HTTPS_ONLY_PROVIDERS.has(provider) ? undefined : this.binding;
  }

  /**
   * Get the list of models available through AI Gateway, as AiChatAuthorInfo entries.
   */
  getModelList(): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = [];
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider)) {
        for (let [id, model] of Object.entries(models)) {
          result.push({ type: "agent", id, name: model.name });
        }
      }
    }
    for (let model of this.customModels.values()) {
      result.push({ type: "agent", id: model.id, name: model.name });
    }
    return result;
  }

  /**
   * Look up an AI Gateway model by ID. Returns a UserAiModelRecord if the model is a
   * SUGGESTED_MODEL for an enabled gateway provider, or undefined otherwise.
   */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    let custom = this.customModels.get(modelId);
    if (custom) {
      const { id, name, model, ...route } = custom;
      return {
        profile: { type: "agent", id, name },
        // apiToken is ignored in AI Gateway mode -- getModel() authenticates with the gateway
        // token and lets the gateway supply the vendor's own key.
        config: {
          provider: "gateway-custom", model: model ?? id, apiToken: "", gatewayCustom: route,
        },
      };
    }
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider) && modelId in models) {
        return {
          profile: { type: "agent", id: modelId, name: models[modelId].name },
          config: {
            provider: provider as AiModelConfig["provider"],
            model: modelId,
            // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
            // reads the real values from env. We set them to empty strings here to satisfy
            // the type.
            apiToken: "",
          },
        };
      }
    }
    return undefined;
  }

  /**
   * Get the AiModelConfig for the quick model (used for title generation).
   */
  getQuickModelConfig(): AiModelConfig | undefined {
    // Always use Workers AI here.
    return {
      provider: "cloudflare",
      model: QUICK_MODEL_ID,
      apiToken: "",
    };
  }
}

/**
 * Parse AI Gateway configuration from environment variables. Returns null if AI Gateway
 * mode is not enabled (i.e. CF_AI_GATEWAY is not set).
 */
export function getAiGatewayConfig(env: Cloudflare.Env): AiGatewayConfig | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new AiGatewayConfig(env);
}

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return validateLogCost(log.cost);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  let cost = "cost" in body.result ? body.result.cost : undefined;
  return validateLogCost(cost);
}
