import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyDecision, decisionConfig, decisionRequest, resolveDecisionAuth,
  DECISION_API, DECISION_ENV, DECISION_MODEL, DECISION_PROVIDER,
} from "../decision-api.mjs";

const env = {
  AZURE_DECISION_ENDPOINT: "https://decision-resource.services.ai.azure.com/",
  AZURE_DECISION_API_KEY: "mock-decision-key",
  AZURE_DECISION_DEPLOYMENT: "my-decision-deployment",
};
const model = {
  type: "classifier", id: DECISION_MODEL, provider: DECISION_PROVIDER,
  api: DECISION_API, baseUrl: env.AZURE_DECISION_ENDPOINT,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = {
  state: { message: "Checkout is down again", contact_count: 3 },
  questions: {
    urgent: { type: "bool", instructions: "Is it urgent?", criteria: { true: "Urgent", false: "Not urgent" } },
    team: { type: "choice", instructions: "Who should handle it?", criteria: { billing: "Payments", engineering: "Outages" } },
    severity: { type: "score", instructions: "How severe?", criteria: ["Minor", "Major", "Critical"] },
  },
};
const responseBody = {
  model: "microsoft-decision-1",
  answers: {
    urgent: { type: "noul", noul: 0.9 },
    team: { type: "choice", choice: "engineering", confidence: 0.8, probabilities: { billing: 0.1, engineering: 0.9 } },
    severity: { type: "score", score: 1.7, confidence: 0.7, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 }, legend: { "0": "Minor", "1": "Major", "2": "Critical" } },
  },
  usage: { input_tokens: 115, output_tokens: 3 },
};
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const options = (fetch, extra = {}) => ({ apiKey: env.AZURE_DECISION_API_KEY, env, fetch, ...extra });

// All resource settings are independent of the Azure OpenAI chat configuration.
test("validates independent configuration and refuses project/API URLs", async () => {
  assert.deepEqual(decisionConfig(env), { endpoint: "https://decision-resource.services.ai.azure.com", apiKey: env.AZURE_DECISION_API_KEY, deployment: env.AZURE_DECISION_DEPLOYMENT });
  for (const name of DECISION_ENV) assert.throws(() => decisionConfig({ ...env, [name]: "" }), new RegExp(name));
  for (const endpoint of ["http://example.com", "not a URL", "https://example.com/api/projects/test/openai/v1", "https://example.com/providers/microsoft/v1/systemone", "https://user:password@example.com", "https://example.com/?key=secret", "https://example.com/#fragment"]) {
    assert.throws(() => decisionConfig({ ...env, AZURE_DECISION_ENDPOINT: endpoint }), /HTTPS resource/);
  }
  assert.throws(() => decisionConfig({ ...env, AZURE_DECISION_DEPLOYMENT: "https://example.com" }), /deployment name/);
  const ambient = { ...env, AZURE_FOUNDRY_API_KEY: "different-chat-key" };
  const auth = await resolveDecisionAuth({ ctx: { env: async (name) => ambient[name] } });
  assert.equal(auth.auth.apiKey, env.AZURE_DECISION_API_KEY);
  assert.equal(auth.env.AZURE_DECISION_DEPLOYMENT, env.AZURE_DECISION_DEPLOYMENT);
  assert.equal(await resolveDecisionAuth({ ctx: { env: async () => undefined } }), undefined);
  assert.equal(await resolveDecisionAuth({ ctx: { env: async (name) => name === "AZURE_DECISION_API_KEY" ? undefined : ambient[name] } }), undefined);
});

test("constructs Microsoft's systemone request with deployment and all three primitives", async () => {
  let request;
  const result = await classifyDecision(model, context, options(async (url, init) => {
    request = { url, init };
    return jsonResponse(responseBody);
  }));
  assert.equal(result.stopReason, "stop");
  assert.equal(request.url, "https://decision-resource.services.ai.azure.com/providers/microsoft/v1/systemone");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.get("api-key"), env.AZURE_DECISION_API_KEY);
  assert.equal(request.init.headers.has("authorization"), false);
  assert.equal(request.init.headers.get("content-type"), "application/json");
  assert.equal(request.init.redirect, "error");
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "my-decision-deployment");
  assert.deepEqual(body.state, context.state);
  assert.equal(body.questions.urgent.type, "noul");
  assert.deepEqual(body.questions.team, context.questions.team);
  assert.deepEqual(body.questions.severity, context.questions.severity);
  assert.equal("max_tokens" in body, false);
  assert.equal(context.questions.urgent.type, "bool");
  assert.equal(decisionRequest({ state: "text", questions: { q: { type: "noul", instructions: "True?" } } }, "deployment").questions.q.type, "noul");
});

test("preserves structured answers, score distributions, legends and underlying model identity", async () => {
  const result = await classifyDecision(model, context, options(async () => jsonResponse(responseBody)));
  assert.equal(result.model, DECISION_MODEL);
  assert.equal(result.decisionModel, "microsoft-decision-1");
  assert.deepEqual(result.decisionAnswers, responseBody.answers);
  assert.deepEqual(result.answers.urgent, { type: "bool", noul: 0.9, probability: 0.9 });
  assert.deepEqual(result.answers.team, responseBody.answers.team);
  assert.deepEqual(result.answers.severity, responseBody.answers.severity);
  assert.equal(result.usage.input, 115);
  assert.equal(result.usage.output, 3);
  assert.equal(result.usage.totalTokens, 118);
  assert.equal(result.usage.cost.total, 115 * 0.042 / 1_000_000);
  const body = structuredClone(responseBody);
  delete body.usage;
  const withoutUsage = await classifyDecision(model, context, options(async () => jsonResponse(body)));
  assert.equal(withoutUsage.usage, undefined);
});

test("rejects malformed responses without returning partial answers", async () => {
  const mutations = [
    (body) => { delete body.answers.urgent; },
    (body) => { body.answers.urgent.noul = 1.1; },
    (body) => { body.answers.team.choice = "unknown"; },
    (body) => { body.answers.team.probabilities.billing = "0.1"; },
    (body) => { delete body.answers.team.probabilities.billing; },
    (body) => { body.answers.severity.score = 3; },
    (body) => { delete body.answers.severity.probabilities; },
    (body) => { body.answers.severity.type = "choice"; },
  ];
  for (const mutate of mutations) {
    const body = structuredClone(responseBody);
    mutate(body);
    const result = await classifyDecision(model, context, options(async () => jsonResponse(body)));
    assert.equal(result.stopReason, "error");
    assert.deepEqual(result.answers, {});
    assert.equal(result.usage.input, 115); // Malformed answers can still be billed.
  }
  const invalidJson = await classifyDecision(model, context, options(async () => new Response("{broken")));
  assert.equal(invalidJson.stopReason, "error");
  assert.match(invalidJson.errorMessage, /invalid JSON/);
});

test("returns HTTP status and Azure error code without echoing secrets or payloads", async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 500]) {
    const result = await classifyDecision(model, context, options(async () => jsonResponse({ error: { code: "DeploymentNotFound", message: env.AZURE_DECISION_API_KEY } }, status)));
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, new RegExp(`HTTP ${status} \\(DeploymentNotFound\\)`));
    assert.equal(result.errorMessage.includes(env.AZURE_DECISION_API_KEY), false);
  }
  const html = await classifyDecision(model, context, options(async () => new Response("<html>gateway</html>", { status: 502 })));
  assert.equal(html.errorMessage, "Microsoft Decision API HTTP 502");
  const network = await classifyDecision(model, context, options(async () => { throw new Error(`network failure: ${env.AZURE_DECISION_API_KEY}`); }));
  assert.equal(network.errorMessage, "network failure: [redacted]");
});

test("honors request hooks, custom headers, cancellation and timeout", async () => {
  let responseHook = false;
  await classifyDecision(model, context, options(async (_, init) => {
    assert.equal(JSON.parse(init.body).state.message, "hooked state");
    assert.equal(init.headers.get("x-client"), "test");
    return jsonResponse(responseBody);
  }, {
    headers: { "x-client": "test" },
    onPayload: (body) => ({ ...body, state: { message: "hooked state" } }),
    onResponse: ({ status }) => { assert.equal(status, 200); responseHook = true; },
  }));
  assert.equal(responseHook, true);
  const signal = AbortSignal.abort();
  const aborted = await classifyDecision(model, context, options(() => assert.fail("aborted call must not fetch"), { signal }));
  assert.equal(aborted.stopReason, "aborted");
  const timedOut = await classifyDecision(model, context, options(async (_, init) => {
    await new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("mock did not receive timeout")), 100);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      }, { once: true });
    });
  }, { timeoutMs: 1 }));
  assert.equal(timedOut.stopReason, "error");
  assert.match(timedOut.errorMessage, /timeout|timed out/i);
});

test("fails before HTTP on missing config, image input and invalid questions", async () => {
  const noFetch = () => assert.fail("invalid input must not fetch");
  const missing = await classifyDecision(model, context, { fetch: noFetch });
  assert.equal(missing.stopReason, "error");
  assert.match(missing.errorMessage, /AZURE_DECISION_API_KEY/);
  for (const input of [
    { ...context, images: [{ type: "image", data: "", mimeType: "image/png" }] },
    { ...context, state: null },
    { ...context, questions: {} },
    { ...context, questions: { q: { type: "chat", instructions: "Say something" } } },
    { ...context, questions: { q: { type: "choice", instructions: "Pick", criteria: [] } } },
    { ...context, questions: { q: { type: "score", instructions: "Rate", criteria: ["Only level"] } } },
  ]) {
    const result = await classifyDecision(model, input, options(noFetch));
    assert.equal(result.stopReason, "error");
  }
});
