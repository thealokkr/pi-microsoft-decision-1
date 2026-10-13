import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// Resolve the installed host, not a second copy of Pi's provider registry.
const hostRoot = process.env.PI_CODING_AGENT_PACKAGE ?? resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
const piAiRoot = [
  resolve(hostRoot, "node_modules/@earendil-works/pi-ai"),
  resolve(dirname(hostRoot), "pi-ai"),
].find((candidate) => existsSync(join(candidate, "dist/index.js")));
if (!piAiRoot) throw new Error("Could not find the host's pi-ai package beside its coding-agent package");
const { ModelRegistry, ModelRuntime } = await import(pathToFileURL(join(hostRoot, "dist/index.js")));
const { createModels, InMemoryCredentialStore, InMemoryModelsStore } = await import(pathToFileURL(join(piAiRoot, "dist/index.js")));
const { loadExtensions } = await import(pathToFileURL(join(hostRoot, "dist/core/extensions/loader.js")));
const { executeCodemode } = await import(pathToFileURL(join(hostRoot, "dist/extensions/codemode/execute.js")));
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const piAiProviderExtensionPath = fileURLToPath(new URL("./fixtures/pi-ai-provider.ts", import.meta.url));

// Exercise the host's real loader, classifier registry, auth resolution and QuickJS models.classify bridge.
test("host loads a separate classifier and models.classify retains probabilities without changing chat", async (t) => {
  const env = { AZURE_DECISION_API_KEY: "integration-mock-key" };
  const oldEnv = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", ...Object.keys(env), "AZURE_DECISION_ENDPOINT", "AZURE_DECISION_DEPLOYMENT"].map((name) => [name, process.env[name]]));
  const homeDir = mkdtempSync(join(tmpdir(), "pi-decision-integration-home-"));
  const agentDir = join(homeDir, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  const endpoint = "https://integration-decision.services.ai.azure.com";
  const originalConfig = JSON.stringify({ providers: {
    "azure-foundry": { models: [{ id: "existing-chat-model", name: "Existing chat model", api: "openai-completions", baseUrl: endpoint, contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    "pi-microsoft-decision-1": { baseUrl: endpoint, apiKey: "$AZURE_DECISION_API_KEY", deploymentName: "Decision-1" },
  } });
  writeFileSync(modelsPath, originalConfig);
  process.env.HOME = homeDir;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.AZURE_DECISION_ENDPOINT;
  delete process.env.AZURE_DECISION_DEPLOYMENT;
  Object.assign(process.env, env);
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const decisionProvider = JSON.parse(originalConfig).providers["pi-microsoft-decision-1"];
  assert.equal(decisionProvider.apiKey, "$AZURE_DECISION_API_KEY");
  const runtime = await ModelRuntime.create({
    modelsPath, credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false,
  });
  const registry = new ModelRegistry(runtime);
  assert.equal(registry.getError(), undefined, "Pi must accept the extension-specific deploymentName field");
  const chatBefore = structuredClone(registry.getModelsOfType("chat", "azure-foundry"));
  assert.ok(chatBefore.length, "existing Azure Foundry chat models must be present");
  const loaded = await loadExtensions([extensionPath], homedir());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 1);
  registry.registerProvider(loaded.runtime.pendingNativeProviderRegistrations[0].provider);
  assert.deepEqual(registry.getModelsOfType("chat", "azure-foundry"), chatBefore);
  assert.deepEqual(registry.getModelsOfType("chat", "pi-microsoft-decision-1"), []);
  const classifiers = registry.getModelsOfType("classifier", "pi-microsoft-decision-1");
  assert.equal(classifiers.length, 1);
  assert.equal(classifiers[0].id, "Microsoft-Decision-1");
  assert.equal(classifiers[0].baseUrl, endpoint);
  assert.equal("maxTokens" in classifiers[0], false);
  assert.equal("reasoning" in classifiers[0], false);
  assert.equal((await registry.getAvailableOfType("classifier", "pi-microsoft-decision-1")).length, 1);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests++;
    assert.equal(String(url), `${endpoint}/providers/microsoft/v1/systemone`);
    assert.equal(init.headers.get("api-key"), env.AZURE_DECISION_API_KEY);
    const request = JSON.parse(init.body);
    assert.equal(request.model, decisionProvider.deploymentName);
    assert.equal(request.questions.gate.type, "noul");
    return new Response(JSON.stringify({
      model: "microsoft-decision-1",
      answers: {
        gate: { type: "noul", noul: 0.9 },
        severity: { type: "score", score: 0.8, confidence: 0.6, probabilities: { "0": 0.2, "1": 0.8 } },
      },
      usage: { input_tokens: 20, output_tokens: 2 },
    }), { headers: { "content-type": "application/json" } });
  });
  const genericProviderExtension = await loadExtensions([piAiProviderExtensionPath], homedir());
  assert.deepEqual(genericProviderExtension.errors, []);
  const piAiModels = createModels();
  piAiModels.setProvider(genericProviderExtension.runtime.pendingNativeProviderRegistrations[0].provider);
  const piAiModel = piAiModels.getModelOfType("classifier", "pi-microsoft-decision-1", "Microsoft-Decision-1");
  assert.ok(piAiModel);
  const piAiResult = await piAiModels.classify(piAiModel, {
    state: { message: "Checkout is down" },
    questions: { gate: { type: "bool", instructions: "Urgent?", criteria: { true: "Urgent", false: "Not urgent" } } },
  });
  assert.equal(piAiResult.stopReason, "stop", piAiResult.errorMessage);
  assert.equal(piAiResult.answers.gate.probability, 0.9);

  const output = await executeCodemode("decision-integration", { code: `
    const model = await models.getModelOfType("classifier", "pi-microsoft-decision-1", "Microsoft-Decision-1");
    return await models.classify(model, {
      state: { message: "Checkout is down" },
      questions: {
        gate: { type: "bool", instructions: "Urgent?", criteria: { true: "Urgent", false: "Not urgent" } },
        severity: { type: "score", instructions: "How severe?", criteria: ["Minor", "Major"] }
      }
    });
  ` }, undefined, undefined, {
    tools: [], modelRegistry: registry, sessionManager: { getBranch: () => [] },
  }, { models: true });
  assert.equal(output.isError, undefined, JSON.stringify(output.content));
  assert.equal(requests, 2);
  const text = output.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.match(text, /"stopReason":"stop"/);
  assert.match(text, /"probabilities":\{"0":0.2,"1":0.8\}/);
  assert.match(text, /"decisionAnswers"/);
  assert.equal(output.usage.input, 20);
  assert.equal(readFileSync(modelsPath, "utf8"), originalConfig);
});
