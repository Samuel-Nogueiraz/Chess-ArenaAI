import { Chess, DEFAULT_POSITION } from "chess.js";
import type { HistoryEntry, Outcome, Participant, ProviderId, Side, Slot } from "./types.js";

export interface EngineScore {
  cp: number | null;
  mate: number | null;
  bestMove: string | null;
}

export interface Engine {
  name: string;
  depth: number;
  evaluate(fen: string): Promise<EngineScore>;
}

export type MoveLabel = "melhor" | "bom" | "imprecisão" | "erro" | "erro grave";

export interface MoveAnalysis {
  ply: number;
  slot: Slot;
  uci: string;
  san: string;
  fenBefore: string;
  fenAfter: string;
  bestMove: string | null;
  bestSan: string | null;
  whiteCp: number;
  whiteMate: number | null;
  cpLoss: number;
  winDrop: number;
  accuracy: number;
  label: MoveLabel;
  durationMs: number | null;
  clockAfterMs: number | null;
}

export interface PlayerAnalysis {
  slot: Slot;
  provider: ProviderId;
  modelId: string;
  moves: number;
  accuracy: number | null;
  acpl: number | null;
  best: number;
  good: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  invalid: number;
  avgMoveMs: number | null;
  totalMs: number;
}

export interface GameAnalysis {
  sessionId: string;
  engine: string;
  depth: number;
  startFen: string;
  moves: MoveAnalysis[];
  players: [PlayerAnalysis, PlayerAnalysis];
  pgn: string;
}

export interface AnalysisInput {
  sessionId: string;
  fen: string;
  participants: Participant[];
  history: HistoryEntry[];
  outcome: Outcome | null;
  clock: { limitMs: number } | null;
  createdAt?: number;
}

const CP_CAP = 1000;

export function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function moveAccuracy(winDrop: number): number {
  return clamp(103.1668 * Math.exp(-0.04354 * winDrop) - 3.1669, 0, 100);
}

export function labelFor(winDrop: number, best: boolean): MoveLabel {
  if (best) return "melhor";
  if (winDrop >= 15) return "erro grave";
  if (winDrop >= 10) return "erro";
  if (winDrop >= 5) return "imprecisão";
  return "bom";
}

export function parseUciScore(line: string): { cp: number | null; mate: number | null } | null {
  if (!line.startsWith("info ") || / (lower|upper)bound/.test(line)) return null;
  const multipv = line.match(/ multipv (\d+)/);
  if (multipv && multipv[1] !== "1") return null;
  const score = line.match(/ score (cp|mate) (-?\d+)/);
  if (!score) return null;
  const value = Number(score[2]);
  return score[1] === "cp" ? { cp: value, mate: null } : { cp: null, mate: value };
}

export async function analyzeGame(input: AnalysisInput, engine: Engine): Promise<GameAnalysis> {
  const scores = new Map<string, Promise<EngineScore>>();
  const scoreOf = (fen: string) => {
    let score = scores.get(fen);
    if (!score) {
      score = terminalScore(fen) ?? engine.evaluate(fen);
      scores.set(fen, score);
    }
    return score;
  };

  const startFen = input.history[0]?.fen ?? input.fen;
  const used: [number, number] = [0, 0];
  const moves: MoveAnalysis[] = [];
  for (const entry of input.history) {
    used[entry.slot] += entry.durationMs ?? 0;
    if (!entry.logical || !entry.applied || !entry.choiceId) continue;
    const before = await scoreOf(entry.fen);
    const after = await scoreOf(entry.fenAfter);
    const moverBefore = capped(before);
    const moverAfter = -capped(after);
    const winDrop = Math.max(0, winPercent(moverBefore) - winPercent(moverAfter));
    const afterTurn = turnOf(entry.fenAfter);
    const whiteSign = afterTurn === "w" ? 1 : -1;
    moves.push({
      ply: moves.length + 1,
      slot: entry.slot,
      uci: entry.choiceId,
      san: entry.san ?? entry.choiceId,
      fenBefore: entry.fen,
      fenAfter: entry.fenAfter,
      bestMove: before.bestMove,
      bestSan: before.bestMove ? sanOf(entry.fen, before.bestMove) : null,
      whiteCp: whiteSign * capped(after),
      whiteMate: after.mate == null ? null : whiteSign * after.mate,
      cpLoss: Math.round(Math.max(0, moverBefore - moverAfter)),
      winDrop: round1(winDrop),
      accuracy: round1(moveAccuracy(winDrop)),
      label: labelFor(winDrop, before.bestMove === entry.choiceId),
      durationMs: entry.durationMs,
      clockAfterMs: input.clock ? Math.max(0, input.clock.limitMs - used[entry.slot]) : null,
    });
  }

  const players = ([0, 1] as const).map((slot) => summarize(slot, input, moves, used[slot])) as [PlayerAnalysis, PlayerAnalysis];
  return {
    sessionId: input.sessionId,
    engine: engine.name,
    depth: engine.depth,
    startFen,
    moves,
    players,
    pgn: buildPgn(input, startFen, moves),
  };
}

const INVALID_ANSWERS = new Set(["id fora da lista", "resposta inválida"]);

function summarize(slot: Slot, input: AnalysisInput, moves: MoveAnalysis[], totalMs: number): PlayerAnalysis {
  const participant = input.participants.find((item) => item.slot === slot);
  const own = moves.filter((move) => move.slot === slot);
  const timed = own.filter((move) => move.durationMs != null);
  const count = (label: MoveLabel) => own.filter((move) => move.label === label).length;
  return {
    slot,
    provider: participant?.provider ?? "cursor",
    modelId: participant?.modelId ?? "",
    moves: own.length,
    accuracy: own.length ? round1(mean(own.map((move) => move.accuracy))) : null,
    acpl: own.length ? Math.round(mean(own.map((move) => move.cpLoss))) : null,
    best: count("melhor"),
    good: count("bom"),
    inaccuracies: count("imprecisão"),
    mistakes: count("erro"),
    blunders: count("erro grave"),
    invalid: input.history.filter((entry) => entry.slot === slot && INVALID_ANSWERS.has(entry.failureReason ?? "")).length,
    avgMoveMs: timed.length ? Math.round(mean(timed.map((move) => move.durationMs ?? 0))) : null,
    totalMs,
  };
}

export function buildPgn(input: AnalysisInput, startFen: string, moves: MoveAnalysis[]): string {
  const chess = new Chess(startFen);
  const date = new Date(input.createdAt ?? Date.now());
  chess.setHeader("Event", "JEV Chess Arena");
  chess.setHeader("Site", "JEV Chess Arena");
  chess.setHeader("Date", `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`);
  chess.setHeader("White", playerName(input.participants, 0));
  chess.setHeader("Black", playerName(input.participants, 1));
  chess.setHeader("Result", resultOf(input.outcome));
  if (startFen !== DEFAULT_POSITION) {
    chess.setHeader("SetUp", "1");
    chess.setHeader("FEN", startFen);
  }
  if (input.clock) chess.setHeader("TimeControl", String(Math.round(input.clock.limitMs / 1000)));
  if (input.outcome?.kind === "timeout") chess.setHeader("Termination", "time forfeit");
  for (const move of moves) {
    chess.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), ...(move.uci[4] ? { promotion: move.uci[4] } : {}) });
    const tags = [
      move.whiteMate === 0 ? null : `[%eval ${evalTag(move)}]`,
      move.clockAfterMs == null ? null : `[%clk ${clockTag(move.clockAfterMs)}]`,
    ].filter(Boolean);
    if (tags.length) chess.setComment(tags.join(" "));
  }
  return chess.pgn();
}

function terminalScore(fen: string): Promise<EngineScore> | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return Promise.resolve({ cp: null, mate: 0, bestMove: null });
  if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.moves().length === 0) {
    return Promise.resolve({ cp: 0, mate: null, bestMove: null });
  }
  return null;
}

function capped(score: EngineScore): number {
  if (score.mate != null) return score.mate > 0 ? CP_CAP : -CP_CAP;
  return clamp(score.cp ?? 0, -CP_CAP, CP_CAP);
}

function evalTag(move: MoveAnalysis): string {
  if (move.whiteMate != null) return `#${move.whiteMate}`;
  return (move.whiteCp / 100).toFixed(2);
}

function clockTag(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function resultOf(outcome: Outcome | null): string {
  if (!outcome) return "*";
  if (outcome.kind === "draw") return "1/2-1/2";
  if (outcome.winnerSlot === 0) return "1-0";
  if (outcome.winnerSlot === 1) return "0-1";
  return "*";
}

function playerName(participants: Participant[], slot: Slot): string {
  const participant = participants.find((item) => item.slot === slot);
  if (!participant) return "?";
  return participant.provider === "jev" ? "Jev" : participant.modelId;
}

function sanOf(fen: string, uci: string): string | null {
  try {
    const moved = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
    return moved?.san ?? null;
  } catch {
    return null;
  }
}

function turnOf(fen: string): Side {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
