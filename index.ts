import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readDecisionProviderSettings } from "./decision-api.mjs";
import { createPiMicrosoftDecision1Provider } from "./provider.mjs";

/** Register the provider as a Pi package extension using Pi's agent settings. */
export default function (pi: ExtensionAPI) {
  pi.registerProvider(createPiMicrosoftDecision1Provider({
    loadProviderSettings: readDecisionProviderSettings,
  }));
}
