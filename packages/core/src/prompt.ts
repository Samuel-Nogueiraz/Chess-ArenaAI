import { endingLines, labeledMoves, positionBrief } from "./brief.js";
import type { Candidate, DecisionContext } from "./types.js";

/** Instrução fixa que todo provedor de LLM recebe antes da posição. */
export const MOVE_SYSTEM_PROMPT = [
  "You are a chess move picker. You are not a coding assistant.",
  "Do not read files, edit files, run commands, search, or use tools.",
  "Play to win. Be effective and fast: decide quickly, do not deliberate at length.",
  "Do not explain, plan, or think aloud.",
  "Reply with exactly one move id from legal_moves and nothing else.",
].join(" ");

export const ONLY_ID_PHRASE = "Reply with only one of these ids.";

const UCI_TOKEN = /\b[a-h][1-8][a-h][1-8][qrbn]?\b/gi;

type CandidateList = ReadonlyArray<Candidate | string>;

/** Pedido de lance (sem a instrução de sistema). */
export function buildMovePrompt(context: DecisionContext): string {
  const ids = context.candidates.map((candidate) => candidate.id);
  return [
    positionBrief(context),
    ...opponentLine(context),
    `FEN: ${context.fen}`,
    `Side to move: ${context.sideToMove === "w" ? "white" : "black"}`,
    `Objective: ${context.objective}`,
    `ids: ${ids.join(", ")}`,
    ONLY_ID_PHRASE,
  ].join("\n");
}

/** Pedido completo para provedores sem papel "system" (CLI via stdin). */
export function buildStandalonePrompt(context: DecisionContext): string {
  return `${MOVE_SYSTEM_PROMPT}\n\n${buildMovePrompt(context)}`;
}

/** Segunda chance quando a resposta não foi um id da lista. Autossuficiente. */
export function buildCorrection(context: DecisionContext, answer: string): string {
  const shown = answer.replace(/\s+/g, " ").trim().slice(0, 40);
  return [
    shown ? `"${shown}" is not in legal_moves. That move is illegal in this position.` : "Your reply was not a move id.",
    `You play ${context.sideToMove === "w" ? "white" : "black"}.`,
    ...endingLines(context),
    `FEN: ${context.fen}`,
    `legal_moves: ${labeledMoves(context)}`,
    ONLY_ID_PHRASE,
  ].join("\n");
}

/**
 * Lê o id do lance numa resposta de texto livre.
 * Aceita a resposta exata ou o primeiro token UCI que esteja na lista. Id fora da lista vira null.
 */
export function parseMoveId(text: string, candidates: CandidateList): string | null {
  const legal = new Set(candidates.map((candidate) => (typeof candidate === "string" ? candidate : candidate.id)));
  const cleaned = text.replace(/<\|[^|>]*\|?>/g, " ").trim();
  if (!cleaned) return null;
  const exact = cleaned.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").toLowerCase();
  if (legal.has(exact)) return exact;
  for (const match of cleaned.matchAll(UCI_TOKEN)) {
    const token = match[0].toLowerCase();
    if (legal.has(token)) return token;
  }
  return null;
}

/** Primeiro token com cara de UCI, legal ou não. Serve para registrar o que o modelo disse. */
export function looseMoveToken(text: string): string | null {
  const match = text.match(UCI_TOKEN);
  return match ? (match[0] as string).toLowerCase() : null;
}

function opponentLine(context: DecisionContext): string[] {
  const move = context.lastMove;
  if (!move) return [];
  return [`Opponent played ${move.id}${move.san ? ` (${move.san})` : ""}.`];
}
