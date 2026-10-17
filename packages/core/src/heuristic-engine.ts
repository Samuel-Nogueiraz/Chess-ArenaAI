import { Chess, type Square } from "chess.js";
import type { Engine, EngineScore } from "./analysis.js";
import { uciOf } from "./engine.js";

export const HEURISTIC_ENGINE_NAME = "heurística (demo)";
export const HEURISTIC_DEFAULT_DEPTH = 2;

/** Valor em centipeões. O rei não entra: a partida acaba em mate, não em captura. */
export const PIECE_VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

const MATE = 100_000;
const MATE_WINDOW = 1_000;
const MOBILITY_CP = 2;

export interface RootMove {
  uci: string;
  score: number;
}

export interface RootSearch {
  /** Melhor nota para quem joga. Perto de ±100000 é mate. */
  score: number;
  /** Lances com a nota máxima (empates), na ordem de geração. */
  best: RootMove[];
  moves: RootMove[];
}

/** Material de quem joga menos o do adversário, em centipeões. */
export function materialBalance(chess: Chess): number {
  let balance = 0;
  for (const rank of chess.board()) {
    for (const piece of rank) {
      if (!piece) continue;
      const value = PIECE_VALUE[piece.type] ?? 0;
      balance += piece.color === chess.turn() ? value : -value;
    }
  }
  return balance;
}

/**
 * Busca alfa-beta de profundidade fixa (em meios-lances) no lugar, com make/undo.
 * Usa os lances em SAN (rápidos no chess.js) e só gera os objetos completos uma vez, na raiz.
 */
export function searchRoot(fen: string, depth: number): RootSearch {
  const chess = new Chess(fen);
  const uciBySan = new Map(chess.moves({ verbose: true }).map((move) => [move.san, uciOf(move)]));
  const material = materialBalance(chess);
  const scored: RootMove[] = [];
  let best = -Infinity;
  for (const move of ordered(chess)) {
    chess.move(move.san);
    // Janela (best - 1, +inf): lances que empatam com o melhor voltam com a nota exata.
    const score = -negamax(chess, Math.max(0, depth - 1), -Infinity, -(best - 1), -(material + move.gain), 1);
    chess.undo();
    scored.push({ uci: uciBySan.get(move.san) ?? move.san, score });
    if (score > best) best = score;
  }
  return { score: best, best: scored.filter((move) => move.score >= best), moves: scored };
}

function negamax(chess: Chess, depth: number, alpha: number, beta: number, material: number, ply: number): number {
  if (depth === 0) {
    const count = chess.moves().length;
    if (count === 0) return chess.inCheck() ? -(MATE - ply) : 0;
    return material + MOBILITY_CP * count;
  }
  const moves = ordered(chess);
  if (moves.length === 0) return chess.inCheck() ? -(MATE - ply) : 0;
  let best = -Infinity;
  for (const move of moves) {
    chess.move(move.san);
    const score = -negamax(chess, depth - 1, -beta, -alpha, -(material + move.gain), ply + 1);
    chess.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

interface OrderedMove {
  san: string;
  /** Material que o lance ganha para quem joga (captura e promoção). */
  gain: number;
}

const PIECE_BY_LETTER: Record<string, number> = { N: 320, B: 330, R: 500, Q: 900, K: 0 };

/** Lances legais em SAN, com o ganho de material, as melhores capturas primeiro. */
function ordered(chess: Chess): OrderedMove[] {
  const keyed = chess.moves().map((san) => {
    const core = san.replace(/[+#]$/, "");
    const promotion = core.match(/=([QRBN])$/);
    const target = core.replace(/=[QRBN]$/, "").slice(-2);
    let gain = 0;
    if (core.includes("x")) {
      const taken = chess.get(target as Square);
      gain += taken ? (PIECE_VALUE[taken.type] ?? 0) : PIECE_VALUE.p!;
    }
    if (promotion) gain += (PIECE_BY_LETTER[promotion[1]!] ?? 0) - PIECE_VALUE.p!;
    const mover = PIECE_BY_LETTER[core[0] ?? ""] ?? PIECE_VALUE.p!;
    return { san, gain, key: gain * 10 - mover };
  });
  keyed.sort((a, b) => b.key - a.key);
  return keyed;
}

export function isMateScore(score: number): boolean {
  return Math.abs(score) >= MATE - MATE_WINDOW;
}

/** Converte nota de mate em "mate em N lances" com o sinal de quem joga (como o Stockfish). */
export function mateIn(score: number): number {
  const plies = MATE - Math.abs(score);
  const moves = Math.ceil(plies / 2);
  return score > 0 ? moves : -moves;
}

/** Motor de brinquedo para o modo demo: material, mobilidade leve e mate, em busca rasa. */
export function createHeuristicEngine(options: { depth?: number } = {}): Engine {
  const depth = Math.max(1, Math.floor(options.depth ?? HEURISTIC_DEFAULT_DEPTH));
  return {
    name: HEURISTIC_ENGINE_NAME,
    depth,
    async evaluate(fen): Promise<EngineScore> {
      // Cede o turno ao navegador entre posições para a tela não travar durante a análise.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const chess = new Chess(fen);
      if (chess.moves().length === 0) {
        return chess.inCheck() ? { cp: null, mate: 0, bestMove: null } : { cp: 0, mate: null, bestMove: null };
      }
      const result = searchRoot(fen, depth);
      const bestMove = result.best[0]?.uci ?? null;
      if (isMateScore(result.score)) return { cp: null, mate: mateIn(result.score), bestMove };
      return { cp: result.score, mate: null, bestMove };
    },
  };
}
