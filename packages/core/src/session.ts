import { totalsFor } from "./cost.js";
import { applyUci, hasMatingMaterial, inspect } from "./engine.js";
import { objectiveFor, SCENARIOS } from "./scenarios.js";
import { sanitize } from "./sanitize.js";
import type {
  AdapterDecision,
  ClockState,
  DecisionAdapter,
  DecisionContext,
  HistoryEntry,
  Mode,
  Outcome,
  Participant,
  ProviderAttempt,
  ScenarioId,
  SessionSnapshot,
  SessionStatus,
  Side,
  Slot,
  Validation,
} from "./types.js";

export const CLOCK_LIMIT_MS = 5 * 60_000;

export class SessionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface CreateSessionInput {
  mode: Mode;
  scenarioId: ScenarioId;
  participants: Participant[];
  fen?: string;
}

export interface PublicSession extends SessionSnapshot {
  sessionClockMs: number;
}

export interface DecideResult {
  decision: HistoryEntry | null;
  applied: boolean;
  mate: boolean;
  fen: string;
  session: PublicSession;
  ignored: boolean;
  blocked: boolean;
  reason: string | null;
}

interface LiveSession {
  sessionId: string;
  mode: Mode;
  scenarioId: ScenarioId;
  fen: string;
  objective: string;
  participants: Participant[];
  status: SessionStatus;
  history: HistoryEntry[];
  outcome: Outcome | null;
  createdAt: number;
  callOpen: boolean;
  auto: boolean;
  clockUsedMs: [number, number];
}

export interface SessionStore {
  create(input: CreateSessionInput): PublicSession;
  decide(sessionId: string, slot: Slot, injectedChoiceId?: string): Promise<DecideResult>;
  start(sessionId: string): Promise<DecideResult | PublicSession>;
  step(sessionId: string): Promise<DecideResult>;
  pause(sessionId: string): PublicSession;
  resume(sessionId: string): PublicSession;
  stop(sessionId: string): PublicSession;
  restart(sessionId: string): PublicSession;
  get(sessionId: string): PublicSession;
  exportSession(sessionId: string): unknown;
  activeId(): string | null;
}

export function createSessionStore(adapter: DecisionAdapter, options: { clockLimitMs?: number } = {}): SessionStore {
  const sessions = new Map<string, LiveSession>();
  const clockLimitMs = options.clockLimitMs ?? CLOCK_LIMIT_MS;
  let active: string | null = null;

  function clockOf(session: LiveSession): ClockState | null {
    if (session.mode !== "battle") return null;
    return {
      limitMs: clockLimitMs,
      remainingMs: [
        Math.max(0, clockLimitMs - session.clockUsedMs[0]),
        Math.max(0, clockLimitMs - session.clockUsedMs[1]),
      ],
    };
  }

  function live(sessionId: string): LiveSession {
    const session = sessions.get(sessionId);
    if (!session) throw new SessionError("Sessão não encontrada.", 404);
    return session;
  }

  function snapshot(session: LiveSession): PublicSession {
    const view = inspect(session.fen);
    const totals = totalsFor(session.history, session.createdAt);
    return {
      sessionId: session.sessionId,
      mode: session.mode,
      scenarioId: session.scenarioId,
      fen: session.fen,
      sideToMove: view.sideToMove,
      objective: session.objective,
      candidates: view.candidates,
      inCheck: view.inCheck,
      outcome: session.outcome,
      status: session.status,
      history: session.history.map((entry) => ({ ...entry })),
      participants: session.participants.map((participant) => ({ ...participant })),
      clock: clockOf(session),
      totals,
      sessionClockMs: totals.sessionClockMs,
    };
  }

  function blankResult(session: LiveSession, patch: Partial<DecideResult>): DecideResult {
    return {
      decision: null,
      applied: false,
      mate: false,
      fen: session.fen,
      session: snapshot(session),
      ignored: false,
      blocked: false,
      reason: null,
      ...patch,
    };
  }

  function open(input: CreateSessionInput): LiveSession {
    if (input.participants.length !== 2) throw new SessionError("São necessários dois participantes.");
    const slots = new Set(input.participants.map((participant) => participant.slot));
    if (!slots.has(0) || !slots.has(1)) throw new SessionError("Os participantes ocupam os slots 0 e 1.");
    const scenario = SCENARIOS[input.scenarioId];
    if (!scenario) throw new SessionError("Cenário desconhecido.");
    const fen = input.fen ?? scenario.fen;
    const view = inspect(fen);
    const session: LiveSession = {
      sessionId: newSessionId(),
      mode: input.mode,
      scenarioId: input.scenarioId,
      fen: view.fen,
      objective: objectiveFor(input.scenarioId, view.candidates.length),
      participants: input.participants.map((participant) => ({ ...participant })),
      status: "ready",
      history: [],
      outcome: null,
      createdAt: Date.now(),
      callOpen: false,
      auto: false,
      clockUsedMs: [0, 0],
    };
    if (input.mode === "battle" && view.terminal) {
      session.outcome = outcomeFromTerminal(view.terminal);
      session.status = "ended";
    }
    sessions.set(session.sessionId, session);
    active = session.sessionId;
    return session;
  }

  async function decide(sessionId: string, slot: Slot, injectedChoiceId?: string): Promise<DecideResult> {
    const session = live(sessionId);
    if (active !== sessionId) return blankResult(session, { ignored: true });
    if (session.outcome || session.status === "ended" || session.status === "stopped") {
      return blankResult(session, { blocked: true, reason: "posição encerrada" });
    }
    if (session.status === "failed") return blankResult(session, { blocked: true, reason: "falha anterior" });
    if (session.status === "paused") return blankResult(session, { blocked: true, reason: "pausada" });

    const view = inspect(session.fen);
    if (session.mode === "battle" && view.terminal) {
      session.outcome = outcomeFromTerminal(view.terminal);
      session.status = "ended";
      return blankResult(session, { blocked: true, reason: "posição encerrada" });
    }
    const participant = session.participants.find((item) => item.slot === slot);
    if (!participant) return blankResult(session, { blocked: true, reason: "participante ausente" });
    if (session.mode === "battle" && slotFor(view.sideToMove) !== slot) {
      return blankResult(session, { blocked: true, reason: "não é a vez deste participante" });
    }

    const fenAtStart = session.fen;
    const previous = session.history.slice().reverse().find((entry) => entry.applied && entry.choiceId);
    const context: DecisionContext = {
      sessionId,
      fen: view.fen,
      sideToMove: view.sideToMove,
      objective: session.objective,
      candidates: view.candidates,
      lastMove: previous?.choiceId ? { id: previous.choiceId, san: previous.san ?? "" } : null,
    };
    const budgetMs = session.mode === "battle" ? Math.max(0, clockLimitMs - session.clockUsedMs[slot]) : null;
    session.callOpen = true;
    if (statusNow(session) !== "paused") session.status = "running";
    try {
      const started = performance.now();
      const call = injectedChoiceId != null
        ? Promise.resolve(injected(injectedChoiceId, context))
        : adapter.decide({ sessionId, slot, participant, context, budgetMs });
      const answered = budgetMs == null ? await call : await withinClock(call, budgetMs);
      const measured = Math.round(performance.now() - started);
      if (active !== sessionId || session.fen !== fenAtStart) return blankResult(session, { ignored: true });
      const flagged = budgetMs != null && (!answered || measured >= budgetMs);
      if (budgetMs != null) session.clockUsedMs[slot] += flagged ? budgetMs : measured;
      const raw = flagged || !answered ? clockFailure(answered, context, measured) : answered;
      const validation: Validation = raw.failureReason ? "falha" : validChoice(raw.choiceId, context) ? "aceita" : "recusada";
      const stopped = outcomeNow(session)?.kind === "stopped";
      let applied = false;
      let mate = false;
      let fenAfter = fenAtStart;
      let san: string | null = null;
      if (!stopped && validation === "aceita" && session.mode === "battle" && raw.choiceId) {
        const move = applyUci(fenAtStart, raw.choiceId);
        if (move.ok) {
          applied = true;
          mate = move.checkmate;
          fenAfter = move.fen;
          san = move.san;
          session.fen = move.fen;
          if (move.checkmate) {
            session.outcome = {
              kind: "checkmate",
              label: `Vitória. ${move.san ?? raw.choiceId}`,
              san: move.san ?? undefined,
              winnerSlot: slot,
            };
            session.status = "ended";
          } else if (move.draw) {
            session.outcome = {
              kind: "draw",
              label: `Empate · ${move.drawReason ?? "empate"}`,
              reason: move.drawReason ?? "empate",
            };
            session.status = "ended";
          }
        }
      } else if (validation === "aceita" && raw.choiceId) {
        san = context.candidates.find((candidate) => candidate.id === raw.choiceId)?.san ?? null;
      }
      if (flagged && !session.outcome) {
        session.outcome = timeoutOutcome(fenAtStart, slot, clockLimitMs);
        session.status = "ended";
      }
      const decision = record(session, participant, context, raw, measured, validation, applied, fenAfter, mate, san);
      if (session.mode === "battle" && validation !== "aceita" && !session.outcome) session.status = "failed";
      return {
        decision,
        applied,
        mate,
        fen: fenAtStart,
        session: snapshot(session),
        ignored: false,
        blocked: false,
        reason: null,
      };
    } finally {
      session.callOpen = false;
      if (session.status === "running") session.status = "ready";
    }
  }

  return {
    create(input) {
      return snapshot(open(input));
    },
    decide,
    async start(sessionId) {
      const session = live(sessionId);
      if (session.outcome || session.status === "ended" || session.status === "stopped" || session.status === "failed") {
        return snapshot(session);
      }
      session.auto = true;
      if (session.status === "paused") session.status = "ready";
      let last: DecideResult = blankResult(session, {});
      while (session.auto && active === sessionId && !session.outcome && statusNow(session) !== "paused" && statusNow(session) !== "failed" && statusNow(session) !== "stopped") {
        const view = inspect(session.fen);
        if (view.terminal) break;
        last = await decide(sessionId, slotFor(view.sideToMove));
        if (last.ignored || last.blocked || last.decision?.validation !== "aceita" || statusNow(session) === "paused") break;
      }
      session.auto = false;
      return last.decision ? { ...last, session: snapshot(session) } : snapshot(session);
    },
    async step(sessionId) {
      const session = live(sessionId);
      const wasPaused = session.status === "paused";
      if (wasPaused) session.status = "ready";
      const slot = slotFor(inspect(session.fen).sideToMove);
      const result = await decide(sessionId, slot);
      if (wasPaused && !session.outcome && session.status !== "failed" && session.status !== "stopped") session.status = "paused";
      return { ...result, session: snapshot(session) };
    },
    pause(sessionId) {
      const session = live(sessionId);
      session.auto = false;
      if (!session.outcome && session.status !== "stopped" && session.status !== "failed" && session.status !== "ended") {
        session.status = "paused";
      }
      return snapshot(session);
    },
    resume(sessionId) {
      const session = live(sessionId);
      if (session.status === "paused") session.status = "ready";
      return snapshot(session);
    },
    stop(sessionId) {
      const session = live(sessionId);
      session.auto = false;
      if (!session.outcome) {
        session.outcome = { kind: "stopped", label: "Interrompida · sem vencedor" };
        session.status = "stopped";
      }
      return snapshot(session);
    },
    restart(sessionId) {
      const session = live(sessionId);
      session.auto = false;
      return snapshot(open({
        mode: session.mode,
        scenarioId: session.scenarioId,
        participants: session.participants,
      }));
    },
    get(sessionId) {
      return snapshot(live(sessionId));
    },
    exportSession(sessionId) {
      return sanitize(snapshot(live(sessionId)));
    },
    activeId() {
      return active;
    },
  };
}

// O estado muda durante os await; estas leituras evitam que o TypeScript trate o valor como fixo.
function statusNow(session: LiveSession): SessionStatus {
  return session.status;
}

function outcomeNow(session: LiveSession): Outcome | null {
  return session.outcome;
}

/** randomUUID só existe em contexto seguro (https ou localhost); fora dele monta o UUID v4 com getRandomValues. */
function newSessionId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function slotFor(side: Side): Slot {
  return side === "w" ? 0 : 1;
}

function outcomeFromTerminal(terminal: NonNullable<ReturnType<typeof inspect>["terminal"]>): Outcome {
  if (terminal.kind === "checkmate") {
    return { kind: "checkmate", label: "Vitória.", winnerSlot: slotFor(terminal.winner) };
  }
  return { kind: "draw", label: `Empate · ${terminal.reason}`, reason: terminal.reason };
}

async function withinClock(call: Promise<AdapterDecision>, budgetMs: number): Promise<AdapterDecision | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flag = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  void call.catch(() => undefined);
  try {
    return await Promise.race([call, flag]);
  } finally {
    clearTimeout(timer);
  }
}

function timeoutOutcome(fen: string, loser: Slot, limitMs: number): Outcome {
  const winner: Slot = loser === 0 ? 1 : 0;
  const loserName = loser === 0 ? "As brancas" : "As pretas";
  const minutes = `${limitMs / 60_000} ${limitMs === 60_000 ? "minuto" : "minutos"}`;
  if (!hasMatingMaterial(fen, winner === 0 ? "w" : "b")) {
    return {
      kind: "draw",
      label: `Empate · ${loserName.toLowerCase()} esgotaram ${minutes}, mas o adversário não tem material para mate`,
      reason: "tempo esgotado sem material para mate",
    };
  }
  return { kind: "timeout", label: `Vitória por tempo. ${loserName} esgotaram ${minutes}.`, winnerSlot: winner };
}

function clockFailure(late: AdapterDecision | null, context: DecisionContext, durationMs: number): AdapterDecision {
  return {
    choiceId: late?.choiceId ?? null,
    modelReturned: late?.modelReturned ?? null,
    rawResponse: late?.rawResponse ?? null,
    inputTokens: late?.inputTokens ?? null,
    outputTokens: late?.outputTokens ?? null,
    costUsd: late?.costUsd ?? null,
    costNature: late?.costNature ?? "unavailable",
    sdkDurationMs: late?.sdkDurationMs ?? null,
    durationMs,
    failureReason: "relógio esgotado",
    confidence: late?.confidence ?? null,
    distribution: late?.distribution ?? null,
    prompt: late?.prompt ?? context.objective,
    preludes: late?.preludes ?? [],
  };
}

function validChoice(choiceId: string | null, context: DecisionContext): choiceId is string {
  return Boolean(choiceId && context.candidates.some((candidate) => candidate.id === choiceId));
}

function injected(choiceId: string, context: DecisionContext): AdapterDecision {
  return {
    choiceId,
    modelReturned: "injetado",
    rawResponse: { injected: true },
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs: null,
    durationMs: null,
    failureReason: null,
    confidence: null,
    distribution: null,
    prompt: context.objective,
    preludes: [],
  };
}

function record(
  session: LiveSession,
  participant: Participant,
  context: DecisionContext,
  raw: AdapterDecision,
  measured: number,
  validation: Validation,
  applied: boolean,
  fenAfter: string,
  mate: boolean,
  san: string | null,
): HistoryEntry {
  for (const prelude of raw.preludes) session.history.push(preludeEntry(session, participant, context, prelude));
  const entry = blank(session, participant, context.fen, context.candidates.map((candidate) => candidate.id), {
    choiceId: raw.choiceId,
    san,
    validation,
    failureReason: raw.failureReason ?? (validation === "recusada" ? "id fora da lista" : null),
    modelReturned: raw.modelReturned,
    durationMs: raw.durationMs ?? measured,
    sdkDurationMs: raw.sdkDurationMs,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costUsd: raw.costUsd,
    costNature: raw.costNature,
    fenAfter,
    applied,
    mate,
    prompt: raw.prompt,
    rawResponse: sanitize(raw.rawResponse),
    confidence: raw.confidence,
    distribution: raw.distribution,
  });
  session.history.push(entry);
  return entry;
}

function preludeEntry(session: LiveSession, participant: Participant, context: DecisionContext, prelude: ProviderAttempt): HistoryEntry {
  return blank(session, participant, context.fen, context.candidates.map((candidate) => candidate.id), {
    logical: false,
    choiceId: prelude.choiceId ?? null,
    validation: "falha",
    failureReason: prelude.failureReason,
    modelReturned: prelude.modelReturned,
    durationMs: prelude.durationMs,
    inputTokens: prelude.inputTokens,
    outputTokens: prelude.outputTokens,
    costUsd: prelude.costUsd,
    costNature: prelude.costNature,
    prompt: context.objective,
    rawResponse: sanitize(prelude.rawResponse),
  });
}

function blank(session: LiveSession, participant: Participant, fen: string, candidateIds: string[], patch: Partial<HistoryEntry>): HistoryEntry {
  return {
    logical: true,
    sessionId: session.sessionId,
    slot: participant.slot,
    provider: participant.provider,
    modelRequested: participant.modelId,
    modelReturned: null,
    choiceId: null,
    san: null,
    validation: "falha",
    failureReason: null,
    durationMs: null,
    sdkDurationMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    mode: participant.provider === "demo" ? "demo" : "real",
    fen,
    fenAfter: fen,
    applied: false,
    mate: false,
    candidateIds,
    objective: session.objective,
    prompt: "",
    rawResponse: null,
    confidence: null,
    distribution: null,
    ...patch,
  };
}
