import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DECISION_PROVIDER = "pi-microsoft-decision-1";
export const DECISION_API = "microsoft-decision-system-one";
export const DECISION_MODEL = "Microsoft-Decision-1";
export const DECISION_ENV = ["AZURE_DECISION_ENDPOINT", "AZURE_DECISION_API_KEY", "AZURE_DECISION_DEPLOYMENT"];

const LABEL = "Microsoft Decision API";
const getPiAgentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Accept only a resource origin; a project/OpenAI URL is never silently rewritten. */
export function decisionResourceEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Azure Decision endpoint (models.json baseUrl or AZURE_DECISION_ENDPOINT) must be an HTTPS resource endpoint");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Azure Decision endpoint (models.json baseUrl or AZURE_DECISION_ENDPOINT) must be an HTTPS resource origin, without a project or API path");
  }
  return url.origin;
}

/** Read only this extension\'s non-secret provider settings, never resolve API keys here. */
export async function readDecisionProviderSettings(agentDir = getPiAgentDir()) {
  let content;
  try { content = await readFile(join(agentDir, "models.json"), "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Cannot read valid Pi models.json");
  }
  let provider;
  try { provider = JSON.parse(content).providers?.[DECISION_PROVIDER]; }
  catch { throw new Error("Cannot read valid Pi models.json"); }
  if (provider === undefined) return {};
  if (!isRecord(provider)) throw new Error("Invalid pi-microsoft-decision-1 provider settings in models.json");
  return { baseUrl: provider.baseUrl, deploymentName: provider.deploymentName };
}

/** Validate the independently configured endpoint, key and deployment before HTTP. */
export function decisionConfig(env) {
  const missing = DECISION_ENV.filter((name) => typeof env[name] !== "string" || !env[name].trim());
  if (missing.length) throw new Error(`Missing Decision configuration: ${missing.join(", ")}`);
  const deployment = env.AZURE_DECISION_DEPLOYMENT.trim();
  if (/[\s/\\?#]/u.test(deployment)) throw new Error("Azure Decision deployment (models.json deploymentName or AZURE_DECISION_DEPLOYMENT) must be a deployment name, not a URL or path");
  return {
    endpoint: decisionResourceEndpoint(env.AZURE_DECISION_ENDPOINT.trim()),
    apiKey: env.AZURE_DECISION_API_KEY.trim(),
    deployment,
  };
}

/** Native Pi auth resolves only the separate key; deployment validation belongs to the request. */
export async function resolveDecisionAuth({ ctx, credential }) {
  const values = await Promise.all(DECISION_ENV.map((name) => ctx.env(name)));
  const env = Object.fromEntries(DECISION_ENV.map((name, index) => [name, credential?.env?.[name] ?? values[index]]));
  env.AZURE_DECISION_API_KEY = credential?.key ?? env.AZURE_DECISION_API_KEY;
  if (typeof env.AZURE_DECISION_API_KEY !== "string" || !env.AZURE_DECISION_API_KEY.trim()) return undefined;
  return {
    // Do not override model.baseUrl: Pi composes models.json above the catalog.
    auth: { apiKey: env.AZURE_DECISION_API_KEY.trim() },
    env: { AZURE_DECISION_ENDPOINT: env.AZURE_DECISION_ENDPOINT, AZURE_DECISION_DEPLOYMENT: env.AZURE_DECISION_DEPLOYMENT },
    source: "AZURE_DECISION_API_KEY",
  };
}

/** Pi calls its binary question `bool`; Microsoft calls the same primitive `noul`. */
export function decisionRequest(context, deployment) {
  if (context.images?.length) throw new Error(`${LABEL} does not support image input`);
  if (typeof context.state !== "string" && !isRecord(context.state) && !Array.isArray(context.state)) {
    throw new Error(`${LABEL} state must be text or JSON object/array`);
  }
  if (!isRecord(context.questions) || !Object.keys(context.questions).length) {
    throw new Error(`${LABEL} requires at least one question`);
  }
  const questions = Object.fromEntries(Object.entries(context.questions).map(([id, question]) => {
    if (!isRecord(question) || typeof question.instructions !== "string" || !question.instructions.trim()) {
      throw new Error(`${LABEL} requires instructions for question ${id}`);
    }
    const type = question.type === "bool" ? "noul" : question.type;
    if (type === "choice") {
      if (!isRecord(question.criteria) || !Object.keys(question.criteria).length || !Object.values(question.criteria).every((value) => typeof value === "string")) {
        throw new Error(`${LABEL} choice criteria must map labels to descriptions for ${id}`);
      }
    } else if (type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || !question.criteria.every((value) => typeof value === "string")) {
        throw new Error(`${LABEL} score criteria must list at least two levels for ${id}`);
      }
    } else if (type === "noul") {
      if (question.criteria !== undefined && (!isRecord(question.criteria) || typeof question.criteria.true !== "string" || typeof question.criteria.false !== "string")) {
        throw new Error(`${LABEL} noul criteria must describe true and false for ${id}`);
      }
    } else {
      throw new Error(`${LABEL} unsupported question type for ${id}`);
    }
    return [id, { ...question, type }];
  }));
  return { model: deployment, state: context.state, questions };
}

/** Reject malformed numbers rather than coercing or discarding probability data. */
function probability(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${LABEL} returned invalid ${field}`);
  }
  return value;
}

/** Preserve the full distribution, including score probabilities and legends. */
function decisionProbabilities(value, labels, id) {
  if (!isRecord(value) || Object.keys(value).length !== labels.length || labels.some((label) => !Object.hasOwn(value, label))) {
    throw new Error(`${LABEL} returned invalid probabilities for ${id}`);
  }
  for (const [label, valueProbability] of Object.entries(value)) probability(valueProbability, `probability for ${id}.${label}`);
  return { ...value };
}

/** Normalize only Pi's binary discriminant; retain all other wire answer fields. */
export function decisionAnswers(value, questions) {
  if (!isRecord(value)) throw new Error(`${LABEL} returned no answers object`);
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = value[id];
    if (!isRecord(answer)) throw new Error(`${LABEL} did not return an answer for ${id}`);
    if (question.type === "bool" || question.type === "noul") {
      if (answer.type !== "noul") throw new Error(`${LABEL} did not return a noul answer for ${id}`);
      return [id, { ...answer, type: "bool", probability: probability(answer.noul, `noul for ${id}`) }];
    }
    if (answer.type !== question.type) throw new Error(`${LABEL} returned the wrong answer type for ${id}`);
    probability(answer.confidence, `confidence for ${id}`);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new Error(`${LABEL} returned an unknown choice for ${id}`);
      }
      return [id, { ...answer, probabilities: decisionProbabilities(answer.probabilities, Object.keys(question.criteria), id) }];
    }
    // Scores are expected level indexes, not integers and not a 0..1 probability.
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) {
      throw new Error(`${LABEL} returned invalid score for ${id}`);
    }
    const labels = question.criteria.map((_, index) => String(index));
    return [id, { ...answer, probabilities: decisionProbabilities(answer.probabilities, labels, id) }];
  }));
}

/** Account only for token counts actually reported by the service. */
function decisionUsage(value, model) {
  if (!isRecord(value) || value.input_tokens === undefined) return undefined;
  const input = value.input_tokens;
  const output = value.output_tokens ?? 0;
  if (![input, output].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error(`${LABEL} returned invalid token usage`);
  }
  const inputCost = input * model.cost.input / 1_000_000;
  const outputCost = output * model.cost.output / 1_000_000;
  return {
    input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0, total: inputCost + outputCost },
  };
}

/** Surface status and safe Azure error codes, never entire provider payloads. */
async function decisionHttpError(response) {
  let code;
  try {
    const body = await response.json();
    const value = body?.error?.code;
    if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/u.test(value)) code = value;
  } catch { /* Azure gateways can return HTML or empty error bodies. */ }
  return new Error(`${LABEL} HTTP ${response.status}${code ? ` (${code})` : ""}`);
}

/** One non-streaming Decision request; errors use Pi's classifier result contract. */
export async function classifyDecision(model, context, options = {}, loadProviderSettings) {
  const result = {
    api: model.api, provider: model.provider, model: model.id,
    answers: {}, stopReason: "stop", timestamp: Date.now(),
  };
  let signal = options.signal;
  let apiKey;
  try {
    if (model.api !== DECISION_API) throw new Error(`${LABEL} unsupported classifier API`);
    // deploymentName is extension-owned metadata, not a built-in Pi model definition.
    // Read on each request so a configuration edit cannot leave a stale deployment cached.
    const providerSettings = await loadProviderSettings?.() ?? {};
    const config = decisionConfig({
      AZURE_DECISION_ENDPOINT: model.baseUrl || providerSettings.baseUrl || options.env?.AZURE_DECISION_ENDPOINT,
      AZURE_DECISION_API_KEY: options.apiKey,
      AZURE_DECISION_DEPLOYMENT: providerSettings.deploymentName !== undefined ? providerSettings.deploymentName : options.env?.AZURE_DECISION_DEPLOYMENT,
    });
    apiKey = config.apiKey;
    let payload = decisionRequest(context, config.deployment);
    const replacement = await options.onPayload?.(payload, model);
    if (replacement !== undefined) payload = replacement;
    const headers = new Headers({ "content-type": "application/json", accept: "application/json", "api-key": apiKey });
    for (const [name, value] of Object.entries({ ...model.headers, ...options.headers })) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await (options.fetch ?? globalThis.fetch)(`${config.endpoint}/providers/microsoft/v1/systemone`, {
      method: "POST", headers, body: JSON.stringify(payload), signal,
      redirect: "error", // Never forward a resource API key to a redirect target.
    });
    await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    if (!response.ok) throw await decisionHttpError(response);
    let body;
    try { body = await response.json(); }
    catch { throw new Error(`${LABEL} returned invalid JSON`); }
    if (!isRecord(body)) throw new Error(`${LABEL} returned an invalid response`);
    const usage = decisionUsage(body.usage, model);
    if (usage) result.usage = usage;
    result.answers = decisionAnswers(body.answers, context.questions);
    // Pi's score type omits the distribution; keep the untouched wire answers too.
    result.decisionAnswers = body.answers;
    result.decisionModel = body.model;
  } catch (error) {
    result.stopReason = options.signal?.aborted ? "aborted" : "error";
    const message = error instanceof Error ? error.message : "Request failed";
    result.errorMessage = apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
  }
  return result;
}
