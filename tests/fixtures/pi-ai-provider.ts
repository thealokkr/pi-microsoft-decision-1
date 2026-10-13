import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiMicrosoftDecision1Provider } from "pi-microsoft-decision-1";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(createPiMicrosoftDecision1Provider({
    baseUrl: "https://integration-decision.services.ai.azure.com",
    deploymentName: "Decision-1",
  }));
}
