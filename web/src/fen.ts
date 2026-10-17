const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

const PIECES: Record<string, string> = {
  K: "rei branco",
  Q: "dama branca",
  R: "torre branca",
  B: "bispo branco",
  N: "cavalo branco",
  P: "peão branco",
  k: "rei preto",
  q: "dama preta",
  r: "torre preta",
  b: "bispo preto",
  n: "cavalo preto",
  p: "peão preto",
};

// Silhuetas cheias para as duas cores: a cor da peça vem do CSS (preenchimento + contorno).
// U+FE0E força a forma de texto e evita o peão virar emoji.
export const GLYPH: Record<string, string> = {
  K: "\u265A\uFE0E",
  Q: "\u265B\uFE0E",
  R: "\u265C\uFE0E",
  B: "\u265D\uFE0E",
  N: "\u265E\uFE0E",
  P: "\u265F\uFE0E",
  k: "\u265A\uFE0E",
  q: "\u265B\uFE0E",
  r: "\u265C\uFE0E",
  b: "\u265D\uFE0E",
  n: "\u265E\uFE0E",
  p: "\u265F\uFE0E",
};

export function pieceName(piece: string): string {
  return PIECES[piece] ?? "peça";
}

export function parsePlacement(fen: string): (string | null)[][] | null {
  const placement = fen.split(" ")[0] ?? "";
  const ranks = placement.split("/");
  if (ranks.length !== 8) return null;
  const rows = ranks.map((rank) => {
    const row: (string | null)[] = [];
    for (const char of rank) {
      if (char >= "1" && char <= "8") {
        for (let index = 0; index < Number(char); index += 1) row.push(null);
      } else if (PIECES[char]) {
        row.push(char);
      } else {
        return null;
      }
    }
    return row.length === 8 ? row : null;
  });
  if (rows.some((row) => row === null)) return null;
  return rows as (string | null)[][];
}

export function uciSquares(uci: string | null | undefined): { from: string; to: string } | null {
  if (!uci || uci.length < 4) return null;
  const from = uci.slice(0, 2).toLowerCase();
  const to = uci.slice(2, 4).toLowerCase();
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return null;
  return { from, to };
}

export function squareName(fileIndex: number, rank: number): string {
  return `${FILES[fileIndex]}${rank}`;
}

export function isDarkSquare(fileIndex: number, rank: number): boolean {
  return (fileIndex + rank) % 2 === 1;
}
