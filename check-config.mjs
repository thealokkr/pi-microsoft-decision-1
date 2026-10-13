import { decisionConfig, DECISION_PROVIDER, readDecisionProviderSettings } from "./decision-api.mjs";

try {
  const settings = await readDecisionProviderSettings();
  const { endpoint, deployment } = decisionConfig({
    ...process.env,
    AZURE_DECISION_ENDPOINT: settings.baseUrl ?? process.env.AZURE_DECISION_ENDPOINT,
    AZURE_DECISION_DEPLOYMENT: settings.deploymentName !== undefined ? settings.deploymentName : process.env.AZURE_DECISION_DEPLOYMENT,
  });
  console.log(JSON.stringify({ provider: DECISION_PROVIDER, endpoint, deployment, apiKeyConfigured: true }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
