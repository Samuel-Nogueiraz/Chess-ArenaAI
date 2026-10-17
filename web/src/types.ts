import type { GameAnalysis, ProviderId } from "@arena/core";

export type { GameAnalysis, ProviderId };
export type ScenarioId = "game" | "opening" | "mate" | "check" | "defense";
export type ArenaMode = "compare" | "battle";
export type Slot = 0 | 1;
export type Side = "w" | "b";
export type Validation = "aceita" | "recusada" | "falha";
export type CostNature = "reported" | "estimated" | "unavailable" | "included";
export type OutcomeKind = "checkmate" | "timeout" | "draw" | "stopped";

export interface ModelRef {
  id: string;
  label: string;
}

export type ProviderKind = "demo" | "api" | "sdk" | "cli";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  available: boolean;
  reason: string | null;
  models: ModelRef[];
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
}

export interface ParticipantConfig {
  slot: Slot;
  provider: ProviderId;
  modelId: string;
}

export interface Candidate {
  id: string;
  san: string;
}

export interface Outcome {
  kind: OutcomeKind;
  label: string;
  winnerSlot: Slot | null;
  san: string | null;
  reason: string | null;
}

export interface HistoryEntry {
  sessionId: string;
  slot: Slot;
  choiceId: string | null;
  san: string | null;
  validation: Validation | null;
  failureReason: string | null;
  modelRequested: string;
  modelReturned: string | null;
  provider: ProviderId | null;
  durationMs: number | null;
  sdkDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNature: CostNature | null;
  mode: "real" | "demo" | null;
  confidence: number | null;
  distribution: Record<string, number> | null;
  fen: string | null;
  candidateIds: string[] | null;
  applied: boolean | null;
  logical: boolean | null;
}

export interface CostTotal {
  costUsd: number | null;
  availability: "known" | "partial" | "unavailable" | "included";
  unavailableCount: number | null;
  includedCount: number | null;
}

export interface SessionTotals {
  durationSumMs: number | null;
  sessionClockMs: number | null;
  jev: CostTotal | null;
  all: CostTotal | null;
}

export interface ClockState {
  limitMs: number;
  remainingMs: [number, number];
}

export interface SessionSnapshot {
  sessionId: string;
  mode: ArenaMode;
  scenarioId: ScenarioId;
  fen: string;
  sideToMove: Side;
  objective: string;
  candidates: Candidate[];
  outcome: Outcome | null;
  status: string | null;
  history: HistoryEntry[];
  sessionClockMs: number | null;
  inCheck: boolean | null;
  totals: SessionTotals | null;
  clock: ClockState | null;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: ProviderId;
}
