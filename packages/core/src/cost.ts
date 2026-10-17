import type { CostNature, CostTotal, HistoryEntry } from "./types.js";

export const JEV_INPUT_USD_PER_MILLION = 0.042;

export function jevCost(inputTokens: number | null): { costUsd: number | null; costNature: CostNature } {
  if (inputTokens == null) return { costUsd: null, costNature: "unavailable" };
  return {
    costUsd: (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MILLION,
    costNature: "estimated",
  };
}

export function cursorCost(
  cost: { chargedCents?: number } | null | undefined,
): { costUsd: number | null; costNature: CostNature } {
  if (cost == null || typeof cost.chargedCents !== "number" || !Number.isFinite(cost.chargedCents)) {
    return { costUsd: null, costNature: "unavailable" };
  }
  if (cost.chargedCents === 0) return { costUsd: null, costNature: "included" };
  if (cost.chargedCents > 0) return { costUsd: cost.chargedCents / 100, costNature: "reported" };
  return { costUsd: null, costNature: "unavailable" };
}

export function sumCosts(parts: Array<{ costUsd: number | null; costNature: CostNature }>): CostTotal {
  let known = 0;
  let knownCount = 0;
  let unavailableCount = 0;
  let includedCount = 0;
  for (const part of parts) {
    if (part.costNature === "included") {
      includedCount += 1;
      continue;
    }
    if (part.costUsd == null || part.costNature === "unavailable") {
      unavailableCount += 1;
      continue;
    }
    known += part.costUsd;
    knownCount += 1;
  }
  if (knownCount === 0) {
    return {
      costUsd: null,
      availability: includedCount > 0 && unavailableCount === 0 ? "included" : "unavailable",
      unavailableCount,
      includedCount,
    };
  }
  return {
    costUsd: known,
    availability: unavailableCount > 0 ? "partial" : "known",
    unavailableCount,
    includedCount,
  };
}

/** Entrada que conta no custo JEV: o provedor jev, ou o JEV simulado do provedor demo. */
export function isJevEntry(entry: Pick<HistoryEntry, "provider" | "modelRequested">): boolean {
  return entry.provider === "jev" || (entry.provider === "demo" && entry.modelRequested === "jev-demo");
}

export function totalsFor(history: HistoryEntry[], createdAt: number, now = Date.now()) {
  const durationSumMs = history.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
  return {
    durationSumMs,
    sessionClockMs: Math.max(0, now - createdAt),
    jev: sumCosts(history.filter(isJevEntry)),
    all: sumCosts(history),
  };
}
