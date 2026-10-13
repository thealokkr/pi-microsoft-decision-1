# pi-microsoft-decision-1

A Pi package and reusable `pi-ai` provider for Microsoft's Decision-1 classifier. The package name and provider ID are both `pi-microsoft-decision-1`. The model ID remains Microsoft's upstream `Microsoft-Decision-1` identifier.

The package supports two integrations:

- Pi loads its extension entry point and registers the provider automatically.
- Other coding agents can register the exported provider with a `pi-ai` `Models` collection.

Install `pi-microsoft-decision-1` from the [Pi package gallery](https://pi.dev/packages) or add its npm package name through Pi's package manager. The package manifest declares `./index.ts` as the Pi extension entry point and exports a reusable provider factory from the package root.

Verified with Pi 1.1.0 and Node 26.4.0.

## Pi setup

### Update `models.json`

**Configuration change:** this package registers the provider as `pi-microsoft-decision-1`. If your existing `models.json` entry is named `azure-decision`, rename that key and use the settings below:

```json
{
  "providers": {
    "pi-microsoft-decision-1": {
      "baseUrl": "https://<resource-name>.services.ai.azure.com",
      "apiKey": "$AZURE_DECISION_API_KEY",
      "deploymentName": "Decision-1"
    }
  }
}
```

The provider key is `pi-microsoft-decision-1`; the model ID remains Microsoft's `Microsoft-Decision-1`. `baseUrl` must be the HTTPS resource origin, without a project or API path. `deploymentName` is the Azure deployment name sent in the request. Do not add a custom `models` list for this provider.

The agent directory defaults to `~/.pi/agent`. If `PI_CODING_AGENT_DIR` is set, the package reads `models.json` from that directory, not from its npm installation location. The provider reads only its own settings and does not change other providers or reuse their endpoint, deployment, or credentials.

### Set the API key environment variable

Pi must inherit `AZURE_DECISION_API_KEY` when it starts. For example, set it in the shell before launching Pi:

```sh
export AZURE_DECISION_API_KEY="<your Azure Decision API key>"
```

To make it available in new terminal sessions, add the export to your shell profile, then restart Pi from that shell. Do not put the key directly in `models.json`, source code, or prompts. The `$AZURE_DECISION_API_KEY` value in `models.json` is an environment-variable reference, not the secret itself.

## Use from codemode

To call the classifier from scripts, enable Pi's `codemode` tool by adding `+codemode` to `defaultTools` in `settings.json`. If `defaultTools` already contains tools, append this entry rather than replacing them.

```js
const model = models.getModelOfType(
  "classifier",
  "pi-microsoft-decision-1",
  "Microsoft-Decision-1"
);

const result = await models.classify(model, {
  state: { message: "Checkout is down and customers cannot pay." },
  questions: {
    urgent: {
      type: "bool",
      instructions: "Does this need immediate attention?",
      criteria: { true: "Immediate attention required", false: "Can wait" }
    },
    owner: {
      type: "choice",
      instructions: "Which team should own this incident?",
      criteria: {
        billing: "Payment platform",
        engineering: "Core engineering",
        support: "Customer support"
      }
    },
    severity: {
      type: "score",
      instructions: "Rate the severity.",
      criteria: ["cosmetic", "minor", "major", "critical"]
    }
  }
});

return result.stopReason === "stop"
  ? { answers: result.answers, usage: result.usage }
  : { error: result.errorMessage };
```

Pi's public classifier type is `bool`; the adapter maps it to Microsoft's wire type `noul` and maps the response back. Choice and score probabilities, confidence, fractional scores, and raw Decision answers are preserved.

## Use from a `pi-ai` coding agent

The package root exports `createPiMicrosoftDecision1Provider`. Register the returned provider with `createModels()` and configure the resource endpoint and deployment explicitly:

```js
import { createModels } from "@earendil-works/pi-ai";
import { createPiMicrosoftDecision1Provider } from "pi-microsoft-decision-1";

const models = createModels();
const provider = createPiMicrosoftDecision1Provider({
  baseUrl: process.env.AZURE_DECISION_ENDPOINT,
  deploymentName: process.env.AZURE_DECISION_DEPLOYMENT
});
models.setProvider(provider);

const model = models.getModelOfType(
  "classifier",
  provider.id,
  "Microsoft-Decision-1"
);
const result = await models.classify(model, {
  state: { message: "Checkout is down and customers cannot pay." },
  questions: {
    urgent: {
      type: "bool",
      instructions: "Does this need immediate attention?",
      criteria: { true: "Immediate attention required", false: "Can wait" }
    }
  }
});
```

For this direct `pi-ai` integration, provide `AZURE_DECISION_ENDPOINT`, `AZURE_DECISION_DEPLOYMENT`, and `AZURE_DECISION_API_KEY` through the coding agent's environment (or provide the key through its `pi-ai` auth context). Set them before starting the agent:

```sh
export AZURE_DECISION_ENDPOINT="https://<resource-name>.services.ai.azure.com"
export AZURE_DECISION_DEPLOYMENT="Decision-1"
export AZURE_DECISION_API_KEY="<your Azure Decision API key>"
```

This integration does not require `@earendil-works/pi-coding-agent`; that package is used only by Pi's extension entry point.

## Request behavior

The package sends one non-streaming request to:

```text
POST <baseUrl>/providers/microsoft/v1/systemone
api-key: <AZURE_DECISION_API_KEY>
Content-Type: application/json
```

It validates configuration and response shapes, honors cancellation and request/response hooks, enforces a 60-second default timeout, rejects redirects, and does not retry requests. Errors expose the HTTP status and safe Azure error code without echoing provider payloads or credentials. The configuration checker reports settings and key presence but does not verify credentials or deployment existence.

## Validation

Tests use mocked HTTP responses and a temporary Pi agent directory. They cover request construction, bool/choice/score answers, probabilities, usage, configuration precedence, malformed responses, API and network failures, cancellation, timeout, hooks, the Pi extension loader, and the `pi-ai` classifier bridge.

```sh
npm run check
npm test
npm pack --dry-run
```

The integration test requires a Pi installation. `PI_CODING_AGENT_PACKAGE` can point to its coding-agent package directory when it is not beside the current Node installation.

## Security

Extensions run with the permissions of the Pi process. Review the source before installing. This package sends classifier requests to the configured Microsoft Foundry resource and makes no telemetry or package-time network calls.

## References

- [Pi packages](https://pi.dev/docs/latest/packages)
- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Microsoft Decision quickstart](https://github.com/MicrosoftDocs/azure-ai-docs/blob/main/articles/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision.md)
- [Microsoft Foundry Decision-1 announcement](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-microsoft-decision-1-in-microsoft-foundry-for-decision-and-classific/4562742)
