export type Mode = "compare" | "battle";

export type ScenarioId = "game" | "opening" | "mate" | "check" | "defense";

export type ProviderId = "demo" | "jev" | "cursor" | "cli" | "openai";

export const PROVIDER_IDS: readonly ProviderId[] = ["demo", "jev", "cursor", "cli", "openai"];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** "real" = decisão de um provedor de verdade; "demo" = simulada, sem rede. */
export type DecisionMode = "real" | "demo";

export type Slot = 0 | 1;

export type Side = "w" | "b";

export type Validation = "aceita" | "recusada" | "falha";

export type CostNature = "reported" | "estimated" | "unavailable" | "included";

export type SessionStatus = "ready" | "running" | "paused" | "ended" | "stopped" | "failed";

export interface Candidate {
  id: string;
  san: string;
}

export interface Participant {
  slot: Slot;
  provider: ProviderId;
  modelId: string;
}

export interface DecisionContext {
  sessionId: string;
  fen: string;
  sideToMove: Side;
  objective: string;
  candidates: Candidate[];
  lastMove?: Candidate | null;
}

export interface NormalizedDecision {
  sessionId: string;
  slot: Slot;
  choiceId: string | null;
  validation: Validation;
  failureReason: string | null;
  modelRequested: string;
  modelReturned: string | null;
  durationMs: number | null;
  sdkDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNature: CostNature;
  mode: DecisionMode;
  provider: ProviderId;
  confidence: number | null;
  distribution: Record<string, number> | null;
}

export interface ProviderAttempt {
  logical: false;
  choiceId?: string | null;
  durationMs: number | null;
  failureReason: string;
  modelReturned: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNature: CostNature;
  rawResponse: unknown;
}

export interface AdapterDecision {
  choiceId: string | null;
  modelReturned: string | null;
  rawResponse: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNature: CostNature;
  sdkDurationMs: number | null;
  durationMs: number | null;
  failureReason: string | null;
  confidence: number | null;
  distribution: Record<string, number> | null;
  prompt: string;
  preludes: ProviderAttempt[];
}

export interface AdapterRequest {
  sessionId: string;
  slot: Slot;
  participant: Participant;
  context: DecisionContext;
  budgetMs?: number | null;
}

export interface DecisionAdapter {
  decide(input: AdapterRequest): Promise<AdapterDecision>;
}

export interface Outcome {
  kind: "checkmate" | "timeout" | "draw" | "stopped";
  label: string;
  san?: string;
  winnerSlot?: Slot;
  reason?: string;
}

export interface HistoryEntry {
  logical: boolean;
  sessionId: string;
  slot: Slot;
  provider: ProviderId;
  modelRequested: string;
  modelReturned: string | null;
  choiceId: string | null;
  san: string | null;
  validation: Validation;
  failureReason: string | null;
  durationMs: number | null;
  sdkDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNature: CostNature;
  mode: DecisionMode;
  fen: string;
  fenAfter: string;
  applied: boolean;
  mate: boolean;
  candidateIds: string[];
  objective: string;
  prompt: string;
  rawResponse: unknown;
  confidence: number | null;
  distribution: Record<string, number> | null;
}

export interface CostTotal {
  costUsd: number | null;
  availability: "known" | "partial" | "unavailable" | "included";
  unavailableCount: number;
  includedCount: number;
}

export interface ClockState {
  limitMs: number;
  remainingMs: [number, number];
}

export interface SessionSnapshot {
  sessionId: string;
  mode: Mode;
  scenarioId: ScenarioId;
  fen: string;
  sideToMove: Side;
  objective: string;
  candidates: Candidate[];
  inCheck: boolean;
  outcome: Outcome | null;
  status: SessionStatus;
  history: HistoryEntry[];
  participants: Participant[];
  clock: ClockState | null;
  totals: {
    durationSumMs: number;
    sessionClockMs: number;
    jev: CostTotal;
    all: CostTotal;
  };
}
