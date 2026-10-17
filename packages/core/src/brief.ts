import { Chess } from "chess.js";
import type { Candidate, DecisionContext } from "./types.js";

const GLYPH: Record<string, string> = {
  wp: "P",
  wn: "N",
  wb: "B",
  wr: "R",
  wq: "Q",
  wk: "K",
  bp: "p",
  bn: "n",
  bb: "b",
  br: "r",
  bq: "q",
  bk: "k",
};

type MoveKind = "checkmate" | "check" | "capture" | "draw" | "move";

interface PlayedMove {
  candidate: Candidate;
  kind: MoveKind;
  san: string;
  opponentMates: boolean;
}

export function positionBrief(context: DecisionContext): string {
  const chess = new Chess(context.fen);
  const side = context.sideToMove === "w" ? "white" : "black";
  const rows = chess.board().map((rank, index) => {
    const cells = rank.map((piece) => (piece ? GLYPH[`${piece.color}${piece.type}`] : ".")).join(" ");
    return `${8 - index} ${cells}`;
  });
  return [
    `You are ${side}. This is the current game only. Ignore any earlier game.`,
    "Choose the strongest legal move for your side.",
    ...endingLines(context),
    "Every listed move is legal. Anything outside the list is illegal.",
    chess.inCheck() ? `${side} is in check.` : `${side} is not in check.`,
    "Board, rank 8 at the top. Uppercase is white, lowercase is black.",
    "  a b c d e f g h",
    ...rows,
    `legal_moves: ${labeledMoves(context)}`,
  ].join("\n");
}

export function endingLines(context: DecisionContext): string[] {
  const played = playAll(context);
  const mates = played.filter((move) => move.kind === "checkmate");
  const losses = played.filter((move) => move.opponentMates);
  return [
    "The game ends by checkmate. You never capture the king. The king stays on the board.",
    "# on a move means checkmate: you win immediately. Prefer any checkmate over a capture.",
    "+ means check. x means you only capture a piece and the game continues.",
    "If a checkmate is listed and you play another id, the opponent moves next and can end the game.",
    mates.length
      ? `checkmates: ${mates.map((move) => `${move.candidate.id} ${move.san}`).join(", ")}`
      : "checkmates: none",
    losses.length
      ? `opponent_mates_after: ${losses.map((move) => move.candidate.id).join(", ")}`
      : "opponent_mates_after: none",
  ];
}

export function choiceLabel(context: DecisionContext, candidate: Candidate): string {
  const played = playOne(context.fen, candidate);
  if (!played) return candidate.san || candidate.id;
  if (played.kind === "checkmate") return `${played.san} checkmate, you win now`;
  const loss = played.opponentMates ? ", opponent can checkmate next" : "";
  if (played.kind === "check") return `${played.san} check${loss}`;
  if (played.kind === "capture") return `${played.san} capture, the game continues${loss}`;
  if (played.kind === "draw") return `${played.san} draw, the game ends without a winner${loss}`;
  return loss ? `${played.san}${loss}` : played.san;
}

export function labeledMoves(context: DecisionContext): string {
  return playAll(context)
    .map((move) => {
      const mark =
        move.kind === "checkmate" ? " checkmate"
        : move.kind === "check" ? " check"
        : move.kind === "capture" ? " capture"
        : move.kind === "draw" ? " draw"
        : "";
      const loss = move.opponentMates ? " opponent_mates_next" : "";
      return `${move.candidate.id} ${move.san}${mark}${loss}`;
    })
    .join(", ");
}

function playAll(context: DecisionContext): PlayedMove[] {
  return context.candidates.map((candidate) => playOne(context.fen, candidate)).filter((move): move is PlayedMove => move != null);
}

function playOne(fen: string, candidate: Candidate): PlayedMove | null {
  const chess = new Chess(fen);
  const from = candidate.id.slice(0, 2);
  const to = candidate.id.slice(2, 4);
  const promotion = candidate.id.slice(4);
  const moved = chess.move({
    from,
    to,
    ...(promotion ? { promotion: promotion as "q" | "r" | "b" | "n" } : {}),
  });
  if (!moved) return null;
  const kind: MoveKind =
    chess.isCheckmate() ? "checkmate"
    : chess.isDraw() ? "draw"
    : chess.inCheck() ? "check"
    : moved.san.includes("x") ? "capture"
    : "move";
  return {
    candidate,
    kind,
    san: moved.san,
    opponentMates: kind !== "checkmate" && chess.moves().some((san) => san.endsWith("#")),
  };
}
