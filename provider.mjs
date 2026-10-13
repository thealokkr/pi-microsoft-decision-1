import { createProvider } from "@earendil-works/pi-ai";
import {
  classifyDecision,
  DECISION_API,
  DECISION_MODEL,
  DECISION_PROVIDER,
  resolveDecisionAuth,
} from "./decision-api.mjs";

/** Build a provider for Pi or any application using pi-ai's Models collection. */
export function createPiMicrosoftDecision1Provider(options = {}) {
  const loadProviderSettings = options.loadProviderSettings ?? (() => ({
    baseUrl: options.baseUrl,
    deploymentName: options.deploymentName,
  }));

  return createProvider({
    id: DECISION_PROVIDER,
    name: DECISION_MODEL,
    auth: {
      apiKey: {
        name: "Microsoft Decision API key",
        resolve: resolveDecisionAuth,
      },
    },
    models: [{
      type: "classifier",
      provider: DECISION_PROVIDER,
      id: DECISION_MODEL,
      name: DECISION_MODEL,
      api: DECISION_API,
      baseUrl: options.baseUrl ?? "",
      input: ["text"],
      contextWindow: 32768,
      cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    classifiers: {
      [DECISION_API]: {
        classify: (model, context, requestOptions) =>
          classifyDecision(model, context, requestOptions, loadProviderSettings),
      },
    },
  });
}
