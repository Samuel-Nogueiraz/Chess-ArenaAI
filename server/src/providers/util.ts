import type { AdapterDecision, CostNature, ProviderAttempt } from "@arena/core";

export function failedDecision(
  prompt: string,
  failureReason: string,
  durationMs: number | null = null,
  rawResponse: unknown = null,
  preludes: ProviderAttempt[] = [],
): AdapterDecision {
  return {
    choiceId: null,
    modelReturned: null,
    rawResponse,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs: null,
    durationMs,
    failureReason,
    confidence: null,
    distribution: null,
    prompt,
    preludes,
  };
}

/** Custo estimado pela tarifa em US$ por milhão de tokens. Sem tarifa ou sem tokens, indisponível. */
export function estimateCost(
  inputTokens: number | null,
  outputTokens: number | null,
  inputUsdPerMillion?: number,
  outputUsdPerMillion?: number,
): { costUsd: number | null; costNature: CostNature } {
  if (inputUsdPerMillion == null || outputUsdPerMillion == null || inputTokens == null || outputTokens == null) {
    return { costUsd: null, costNature: "unavailable" };
  }
  return {
    costUsd: (inputTokens / 1_000_000) * inputUsdPerMillion + (outputTokens / 1_000_000) * outputUsdPerMillion,
    costNature: "estimated",
  };
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
