import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { classifyDecision, readDecisionProviderSettings, resolveDecisionAuth, DECISION_API, DECISION_MODEL, DECISION_PROVIDER } from "../decision-api.mjs";

const endpoint = "https://configured-decision.services.ai.azure.com";
const env = { AZURE_DECISION_API_KEY: "mock-config-key", AZURE_DECISION_DEPLOYMENT: "configured-deployment" };
const model = { type: "classifier", id: DECISION_MODEL, provider: DECISION_PROVIDER, api: DECISION_API, baseUrl: endpoint, cost: { input: 0.042, output: 0 } };
const context = { state: { message: "Outage" }, questions: { gate: { type: "bool", instructions: "Urgent?", criteria: { true: "Urgent", false: "Not urgent" } } } };

// Credentials must resolve without knowing the endpoint that Pi overlays from models.json.
test("native auth needs only the separate key and does not override model.baseUrl", async () => {
  const auth = await resolveDecisionAuth({ ctx: { env: async (name) => name === "AZURE_DECISION_DEPLOYMENT" ? undefined : env[name] } });
  assert.equal(auth.auth.apiKey, env.AZURE_DECISION_API_KEY);
  assert.equal(auth.auth.baseUrl, undefined);
  assert.equal(auth.env.AZURE_DECISION_ENDPOINT, undefined);
  assert.equal(auth.env.AZURE_DECISION_DEPLOYMENT, undefined);
  const stored = await resolveDecisionAuth({ ctx: { env: async (name) => env[name] }, credential: { key: "stored-decision-key" } });
  assert.equal(stored.auth.apiKey, "stored-decision-key");
});

test("models.json endpoint wins over a stale env endpoint; explicit env-only fallback still works", async () => {
  const fetch = async (url, init) => {
    assert.equal(url, `${endpoint}/providers/microsoft/v1/systemone`);
    assert.equal(JSON.parse(init.body).model, env.AZURE_DECISION_DEPLOYMENT);
    return new Response(JSON.stringify({ answers: { gate: { type: "noul", noul: 0.9 } } }));
  };
  const result = await classifyDecision(model, context, { apiKey: env.AZURE_DECISION_API_KEY, env: { ...env, AZURE_DECISION_ENDPOINT: "https://stale.example.com/openai/v1" }, fetch });
  assert.equal(result.stopReason, "stop");
  const fallback = await classifyDecision({ ...model, baseUrl: "" }, context, { apiKey: env.AZURE_DECISION_API_KEY, env: { ...env, AZURE_DECISION_ENDPOINT: endpoint }, fetch });
  assert.equal(fallback.stopReason, "stop");
});

test("invalid configured endpoint never falls back to another resource or sends HTTP", async () => {
  const result = await classifyDecision({ ...model, baseUrl: `${endpoint}/api/projects/project/openai/v1` }, context, {
    apiKey: env.AZURE_DECISION_API_KEY, env: { ...env, AZURE_DECISION_ENDPOINT: endpoint },
    fetch: () => assert.fail("invalid configured endpoint must not fetch"),
  });
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /HTTPS resource origin/);
});

// The checker must read the new non-secret setting without needing AZURE_DECISION_ENDPOINT.
test("config checker reads models.json, reports only missing credentials and never prints secrets", (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-decision-config-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { "pi-microsoft-decision-1": { baseUrl: endpoint, apiKey: "$AZURE_DECISION_API_KEY", deploymentName: "Decision-1" } } }));
  const checker = fileURLToPath(new URL("../check-config.mjs", import.meta.url));
  const check = (extra) => spawnSync(process.execPath, [checker], {
    encoding: "utf8", env: { ...process.env, ...env, PI_CODING_AGENT_DIR: agentDir, AZURE_DECISION_ENDPOINT: "", ...extra },
  });
  const ready = check({ AZURE_DECISION_DEPLOYMENT: "" });
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(JSON.parse(ready.stdout).endpoint, endpoint);
  assert.equal(JSON.parse(ready.stdout).deployment, "Decision-1");
  assert.equal(ready.stdout.includes(env.AZURE_DECISION_API_KEY), false);
  const missing = check({ AZURE_DECISION_API_KEY: "", AZURE_DECISION_DEPLOYMENT: "" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "Missing Decision configuration: AZURE_DECISION_API_KEY");
  writeFileSync(modelsPath, JSON.stringify({ providers: { "pi-microsoft-decision-1": { baseUrl: endpoint } } }));
  const missingDeployment = check({ AZURE_DECISION_DEPLOYMENT: "" });
  assert.equal(missingDeployment.status, 1);
  assert.match(missingDeployment.stderr, /AZURE_DECISION_DEPLOYMENT/);
  writeFileSync(modelsPath, JSON.stringify({ providers: { "pi-microsoft-decision-1": { baseUrl: `${endpoint}/openai/v1` } } }));
  const invalid = check({});
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /HTTPS resource origin/);
  writeFileSync(modelsPath, "{broken");
  const broken = check({});
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Cannot read valid Pi models.json/);
});

test("default settings path is the Pi agent directory, not the npm package directory", async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), "pi-decision-home-"));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  const agentDir = join(homeDir, ".pi", "agent");
  const packageDir = join(agentDir, "npm", "node_modules", "pi-microsoft-decision-1");
  mkdirSync(packageDir, { recursive: true });
  const modulePath = join(packageDir, "decision-api.mjs");
  copyFileSync(fileURLToPath(new URL("../decision-api.mjs", import.meta.url)), modulePath);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "pi-microsoft-decision-1": { baseUrl: endpoint, deploymentName: "Decision-1" } } }));
  const overrideDir = join(homeDir, "custom-agent");
  mkdirSync(overrideDir);
  writeFileSync(join(overrideDir, "models.json"), JSON.stringify({ providers: { "pi-microsoft-decision-1": { baseUrl: endpoint, deploymentName: "Custom-Decision" } } }));

  const oldHome = process.env.HOME;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = homeDir;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    const { readDecisionProviderSettings: readInstalledSettings } = await import(`${pathToFileURL(modulePath).href}?package-install`);
    assert.deepEqual(await readInstalledSettings(), { baseUrl: endpoint, deploymentName: "Decision-1" });
    process.env.PI_CODING_AGENT_DIR = overrideDir;
    assert.deepEqual(await readInstalledSettings(), { baseUrl: endpoint, deploymentName: "Custom-Decision" });
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

// Pi owns endpoint/key composition; this extension owns the extra deploymentName field.
test("deploymentName wins over env, reloads per request, and does not replace the classifier ID", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-decision-deployment-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const path = join(agentDir, "models.json");
  const save = (deploymentName) => writeFileSync(path, JSON.stringify({ providers: { "pi-microsoft-decision-1": { baseUrl: endpoint, deploymentName } } }));
  const loadSettings = () => readDecisionProviderSettings(agentDir);
  let expectedDeployment = "Decision-1";
  const options = {
    apiKey: env.AZURE_DECISION_API_KEY,
    env: { AZURE_DECISION_DEPLOYMENT: "stale-env-deployment" },
    fetch: async (url, init) => {
      assert.equal(url, `${endpoint}/providers/microsoft/v1/systemone`);
      assert.equal(JSON.parse(init.body).model, expectedDeployment);
      return new Response(JSON.stringify({ answers: { gate: { type: "noul", noul: 0.9 } } }));
    },
  };
  save(expectedDeployment);
  const first = await classifyDecision(model, context, options, loadSettings);
  assert.equal(first.stopReason, "stop");
  assert.equal(first.model, "Microsoft-Decision-1");
  expectedDeployment = "another-deployment";
  save(expectedDeployment);
  const second = await classifyDecision(model, context, { ...options, env: {} }, loadSettings);
  assert.equal(second.stopReason, "stop");
  assert.equal(second.model, "Microsoft-Decision-1");
});

test("invalid deployment metadata and unreadable settings return errors before HTTP", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-decision-invalid-deployment-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const path = join(agentDir, "models.json");
  const options = {
    apiKey: env.AZURE_DECISION_API_KEY,
    env, // A valid fallback must not hide an explicitly invalid configured value.
    fetch: () => assert.fail("invalid deployment metadata must not fetch"),
  };
  for (const deploymentName of ["", null, 123, "wrong/path", "name with spaces", "https://example.com"]) {
    writeFileSync(path, JSON.stringify({ providers: { "pi-microsoft-decision-1": { deploymentName } } }));
    const result = await classifyDecision(model, context, options, () => readDecisionProviderSettings(agentDir));
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /deployment|AZURE_DECISION_DEPLOYMENT/);
  }
  writeFileSync(path, "{broken");
  const broken = await classifyDecision(model, context, options, () => readDecisionProviderSettings(agentDir));
  assert.equal(broken.stopReason, "error");
  assert.equal(broken.errorMessage, "Cannot read valid Pi models.json");
  writeFileSync(path, JSON.stringify({ providers: { "pi-microsoft-decision-1": [] } }));
  const invalidProvider = await classifyDecision(model, context, options, () => readDecisionProviderSettings(agentDir));
  assert.equal(invalidProvider.stopReason, "error");
  assert.match(invalidProvider.errorMessage, /Invalid pi-microsoft-decision-1 provider settings/);
  rmSync(path);
  assert.deepEqual(await readDecisionProviderSettings(agentDir), {});
});
