import { Chess, type Move } from "chess.js";
import type { Candidate, Side } from "./types.js";

export interface PositionView {
  fen: string;
  sideToMove: Side;
  candidates: Candidate[];
  inCheck: boolean;
  terminal: { kind: "checkmate"; winner: Side } | { kind: "draw"; reason: string } | null;
}

export interface AppliedMove {
  ok: boolean;
  fen: string;
  san: string | null;
  checkmate: boolean;
  draw: boolean;
  drawReason: string | null;
  sideToMove: Side;
}

export function loadPosition(fen: string): Chess {
  return new Chess(fen);
}

export function uciOf(move: Pick<Move, "from" | "to" | "promotion">): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

export function inspect(fen: string): PositionView {
  const chess = new Chess(fen);
  const candidates = chess.moves({ verbose: true }).map((move) => ({
    id: uciOf(move),
    san: move.san,
  }));
  return {
    fen: chess.fen(),
    sideToMove: chess.turn(),
    candidates,
    inCheck: chess.inCheck(),
    terminal: terminalOf(chess),
  };
}

export function matingMoves(fen: string): Candidate[] {
  const chess = new Chess(fen);
  const mates: Candidate[] = [];
  for (const move of chess.moves({ verbose: true })) {
    const copy = new Chess(fen);
    const applied = copy.move(move);
    if (applied && copy.isCheckmate()) {
      mates.push({ id: uciOf(move), san: applied.san });
    }
  }
  return mates;
}

export function applyUci(fen: string, uci: string): AppliedMove {
  const chess = new Chess(fen);
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.slice(4);
  const moved = chess.move({
    from,
    to,
    ...(promotion ? { promotion: promotion as "q" | "r" | "b" | "n" } : {}),
  });
  if (!moved) {
    return {
      ok: false,
      fen,
      san: null,
      checkmate: false,
      draw: false,
      drawReason: null,
      sideToMove: chess.turn(),
    };
  }
  return {
    ok: true,
    fen: chess.fen(),
    san: moved.san,
    checkmate: chess.isCheckmate(),
    draw: chess.isDraw(),
    drawReason: drawReason(chess),
    sideToMove: chess.turn(),
  };
}

export function hasMatingMaterial(fen: string, side: Side): boolean {
  const pieces = new Chess(fen).board().flat().filter((piece) => piece && piece.color === side && piece.type !== "k");
  if (pieces.some((piece) => piece?.type === "p" || piece?.type === "r" || piece?.type === "q")) return true;
  return pieces.length >= 2;
}

export function drawReason(chess: Chess): string | null {
  if (!chess.isDraw() && chess.moves().length > 0) return null;
  if (chess.isStalemate()) return "afogamento";
  if (chess.isInsufficientMaterial()) return "material insuficiente";
  if (chess.isThreefoldRepetition()) return "repetição tripla";
  if (chess.isDrawByFiftyMoves()) return "regra dos cinquenta lances";
  if (chess.moves().length === 0) return "sem lances legais";
  if (chess.isDraw()) return "empate";
  return null;
}

function terminalOf(chess: Chess): PositionView["terminal"] {
  if (chess.isCheckmate()) {
    return { kind: "checkmate", winner: chess.turn() === "w" ? "b" : "w" };
  }
  if (chess.isDraw() || chess.moves().length === 0) {
    return { kind: "draw", reason: drawReason(chess) ?? "empate" };
  }
  return null;
}
