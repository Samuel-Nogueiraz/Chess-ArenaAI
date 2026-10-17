import { isProviderId } from "@arena/core";
import type {
  ArenaMode,
  Candidate,
  ClockState,
  CostNature,
  CostTotal,
  GameAnalysis,
  HistoryEntry,
  Outcome,
  OutcomeKind,
  ProviderId,
  ProviderInfo,
  ProviderKind,
  ProvidersResponse,
  ScenarioId,
  SessionSnapshot,
  SessionTotals,
  Side,
  Slot,
  Validation,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function slotOf(value: unknown): Slot | null {
  return value === 0 || value === 1 ? value : null;
}

function providerOf(value: unknown): ProviderId | null {
  return isProviderId(value) ? value : null;
}

function validationOf(value: unknown): Validation | null {
  return value === "aceita" || value === "recusada" || value === "falha" ? value : null;
}

function natureOf(value: unknown): CostNature | null {
  return value === "reported" ||
    value === "estimated" ||
    value === "unavailable" ||
    value === "included"
    ? value
    : null;
}

function scenarioOf(value: unknown): ScenarioId | null {
  return value === "game" || value === "opening" || value === "mate" || value === "check" || value === "defense"
    ? value
    : null;
}

function modeOf(value: unknown): ArenaMode | null {
  return value === "compare" || value === "battle" ? value : null;
}

function sideOf(value: unknown): Side | null {
  if (value === "w" || value === "white") return "w";
  if (value === "b" || value === "black") return "b";
  return null;
}

export class ContractError extends Error {
  constructor(message = "Resposta incompleta do servidor.") {
    super(message);
    this.name = "ContractError";
  }
}

function kindOf(value: unknown): ProviderKind {
  return value === "demo" || value === "api" || value === "sdk" || value === "cli" ? value : "api";
}

export function parseProviders(raw: unknown): ProvidersResponse {
  if (!isRecord(raw) || !Array.isArray(raw.providers)) throw new ContractError("Resposta de provedores inválida.");
  const providers = raw.providers.flatMap((item): ProviderInfo[] => {
    if (!isRecord(item)) return [];
    const id = providerOf(item.id);
    if (!id) return [];
    const models = Array.isArray(item.models)
      ? item.models.flatMap((model) => {
          if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim()) return [];
          return [{ id: model.id.trim(), label: text(model.label) ?? model.id.trim() }];
        })
      : [];
    const available = item.available === true;
    return [
      {
        id,
        label: text(item.label) ?? id,
        kind: kindOf(item.kind),
        available,
        reason: available ? null : (text(item.reason) ?? "indisponível"),
        models,
      },
    ];
  });
  return { providers };
}

export function parseAnalysis(raw: unknown): GameAnalysis {
  if (
    !isRecord(raw) ||
    typeof raw.engine !== "string" ||
    !Array.isArray(raw.moves) ||
    !Array.isArray(raw.players) ||
    raw.players.length !== 2 ||
    !raw.players.every(isRecord) ||
    !raw.moves.every(isRecord)
  ) {
    throw new ContractError("Análise incompleta.");
  }
  return raw as unknown as GameAnalysis;
}

function parseCandidate(raw: unknown): Candidate | null {
  if (typeof raw === "string" && raw.trim()) return { id: raw.trim(), san: raw.trim() };
  if (!isRecord(raw)) return null;
  const id = text(raw.id) ?? text(raw.uci);
  if (!id) return null;
  return { id, san: text(raw.san) ?? id };
}

function parseOutcome(raw: unknown): Outcome | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    return { kind: "stopped", label: raw, winnerSlot: null, san: null, reason: null };
  }
  if (!isRecord(raw)) return null;
  const marker = `${text(raw.kind) ?? ""} ${text(raw.type) ?? ""} ${text(raw.result) ?? ""}`.toLowerCase();
  let kind: OutcomeKind = "stopped";
  if (marker.includes("stalemate") || marker.includes("draw") || marker.includes("empate")) {
    kind = "draw";
  } else if (marker.includes("timeout")) {
    kind = "timeout";
  } else if (marker.includes("checkmate") || /\bmate\b/.test(marker) || marker.includes("vitoria") || marker.includes("vitória")) {
    kind = "checkmate";
  } else if (marker.includes("stop") || marker.includes("interrupt")) {
    kind = "stopped";
  }
  const winnerSlot = slotOf(raw.winnerSlot);
  const san = text(raw.san);
  const reason = text(raw.reason);
  const label = text(raw.label) ?? defaultOutcomeLabel(kind, winnerSlot, san, reason);
  return { kind, label, winnerSlot, san, reason };
}

function defaultOutcomeLabel(
  kind: OutcomeKind,
  winnerSlot: Slot | null,
  san: string | null,
  reason: string | null,
): string {
  if (kind === "stopped") return "Interrompida · sem vencedor";
  if (kind === "draw") return reason ? `Empate. ${reason}` : "Empate.";
  const who = winnerSlot === 0 ? "Participante 1" : winnerSlot === 1 ? "Participante 2" : "Quem aplicou o lance";
  if (kind === "timeout") return `Vitória por tempo de ${who}.`;
  return san ? `Vitória de ${who}. ${san}` : `Vitória de ${who}.`;
}

function parseDistribution(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
  return entries.length ? Object.fromEntries(entries) : null;
}

function parseCostTotal(raw: unknown): CostTotal | null {
  if (!isRecord(raw)) return null;
  const availability = raw.availability;
  if (
    availability !== "known" &&
    availability !== "partial" &&
    availability !== "unavailable" &&
    availability !== "included"
  ) {
    return null;
  }
  return {
    costUsd: num(raw.costUsd),
    availability,
    unavailableCount: num(raw.unavailableCount),
    includedCount: num(raw.includedCount),
  };
}

function parseClock(raw: unknown): ClockState | null {
  if (!isRecord(raw) || !Array.isArray(raw.remainingMs)) return null;
  const limitMs = num(raw.limitMs);
  const white = num(raw.remainingMs[0]);
  const black = num(raw.remainingMs[1]);
  if (limitMs == null || white == null || black == null) return null;
  return { limitMs, remainingMs: [white, black] };
}

function parseTotals(raw: unknown): SessionTotals | null {
  if (!isRecord(raw)) return null;
  return {
    durationSumMs: num(raw.durationSumMs),
    sessionClockMs: num(raw.sessionClockMs),
    jev: parseCostTotal(raw.jev),
    all: parseCostTotal(raw.all),
  };
}

function parseIdList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (isRecord(item) && typeof item.id === "string" && item.id.trim()) return [item.id.trim()];
    return [];
  });
  return ids;
}

export function parseHistoryItem(raw: unknown, fallbackSessionId = ""): HistoryEntry | null {
  if (!isRecord(raw)) return null;
  const source = isRecord(raw.decision) ? { ...raw, ...raw.decision } : raw;
  const slot = slotOf(source.slot);
  if (slot === null) return null;
  const candidateIds = parseIdList(source.candidateIds ?? source.candidates);
  return {
    sessionId: text(source.sessionId) ?? fallbackSessionId,
    slot,
    choiceId: text(source.choiceId),
    san: text(source.san),
    validation: validationOf(source.validation),
    failureReason: text(source.failureReason),
    modelRequested: text(source.modelRequested) ?? "Indisponível",
    modelReturned: text(source.modelReturned),
    provider: providerOf(source.provider),
    durationMs: num(source.durationMs),
    sdkDurationMs: num(source.sdkDurationMs),
    inputTokens: num(source.inputTokens),
    outputTokens: num(source.outputTokens),
    costUsd: num(source.costUsd),
    costNature: natureOf(source.costNature),
    mode: source.mode === "real" || source.mode === "demo" ? source.mode : null,
    confidence: num(source.confidence),
    distribution: parseDistribution(source.distribution),
    fen: text(source.fen),
    candidateIds,
    applied: typeof source.applied === "boolean" ? source.applied : null,
    logical: typeof source.logical === "boolean" ? source.logical : null,
  };
}

function sameEntry(a: HistoryEntry, b: HistoryEntry): boolean {
  return (
    a.slot === b.slot &&
    a.choiceId === b.choiceId &&
    a.validation === b.validation &&
    a.failureReason === b.failureReason &&
    a.durationMs === b.durationMs &&
    a.modelRequested === b.modelRequested &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.costUsd === b.costUsd
  );
}

function unwrapSession(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new ContractError();
  if (!text(raw.sessionId) && !text(raw.id) && !text(raw.fen) && isRecord(raw.session)) return raw.session;
  return raw;
}

export function parseSession(raw: unknown): SessionSnapshot {
  const body = unwrapSession(raw);
  const sessionId = text(body.sessionId) ?? text(body.id);
  const mode = modeOf(body.mode);
  const scenarioId = scenarioOf(body.scenarioId);
  const fen = text(body.fen);
  const sideToMove = sideOf(body.sideToMove);
  if (!sessionId || !mode || !scenarioId || !fen || !sideToMove) throw new ContractError();
  const candidates = Array.isArray(body.candidates)
    ? body.candidates.flatMap((item) => {
        const candidate = parseCandidate(item);
        return candidate ? [candidate] : [];
      })
    : [];
  const history = Array.isArray(body.history)
    ? body.history.flatMap((item) => {
        const entry = parseHistoryItem(item, sessionId);
        return entry ? [entry] : [];
      })
    : [];
  const totals = parseTotals(body.totals);
  return {
    sessionId,
    mode,
    scenarioId,
    fen,
    sideToMove,
    objective: text(body.objective) ?? "",
    candidates,
    outcome: parseOutcome(body.outcome),
    status: text(body.status),
    history,
    sessionClockMs: totals?.sessionClockMs ?? num(body.sessionClockMs),
    inCheck: typeof body.inCheck === "boolean" ? body.inCheck : null,
    totals,
    clock: parseClock(body.clock),
  };
}

export type DecideParse =
  | { stale: true }
  | {
      stale: false;
      blocked: boolean;
      reason: string | null;
      session: SessionSnapshot;
      decision: HistoryEntry | null;
    };

export function parseDecide(raw: unknown, expectedSessionId: string): DecideParse {
  if (!isRecord(raw)) throw new ContractError();
  if (raw.ignored === true) return { stale: true };
  const sessionRaw = isRecord(raw.session) ? raw.session : raw;
  const session = parseSession(sessionRaw);
  if (session.sessionId !== expectedSessionId) return { stale: true };
  const decision = raw.decision == null ? null : parseHistoryItem(raw.decision, session.sessionId);
  if (decision && decision.sessionId && decision.sessionId !== expectedSessionId) return { stale: true };
  const history =
    !decision || session.history.some((item) => sameEntry(item, decision))
      ? session.history
      : [...session.history, { ...decision, sessionId: session.sessionId }];
  return {
    stale: false,
    blocked: raw.blocked === true || decision == null,
    reason: text(raw.reason),
    session: { ...session, history },
    decision: decision ? { ...decision, sessionId: session.sessionId } : null,
  };
}
