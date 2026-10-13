import type { Provider } from "@earendil-works/pi-ai";

export interface PiMicrosoftDecision1Settings {
  baseUrl?: string;
  deploymentName?: string;
}

export interface PiMicrosoftDecision1ProviderOptions {
  /** Azure resource origin; required when registering outside Pi's extension runtime. */
  baseUrl?: string;
  /** Azure deployment name; defaults to AZURE_DECISION_DEPLOYMENT when omitted. */
  deploymentName?: string;
  /** Optional per-request settings source, used by the Pi extension adapter. */
  loadProviderSettings?: () => PiMicrosoftDecision1Settings | Promise<PiMicrosoftDecision1Settings>;
}

export declare function createPiMicrosoftDecision1Provider(
  options?: PiMicrosoftDecision1ProviderOptions,
): Provider;
