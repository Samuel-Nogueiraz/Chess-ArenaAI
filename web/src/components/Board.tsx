import { GLYPH, isDarkSquare, parsePlacement, pieceName, squareName } from "../fen";

interface BoardProps {
  fen: string | null;
  flipped: boolean;
  from: string | null;
  to: string | null;
}

export function Board({ fen, flipped, from, to }: BoardProps) {
  const placement = fen ? parsePlacement(fen) : null;
  const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const ranks = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const firstFile = files[0];
  const lastRank = ranks[ranks.length - 1];

  return (
    <div className={`board${placement ? "" : " empty"}`} role="grid" aria-label="Tabuleiro">
      {ranks.map((rank) =>
        files.map((fileIndex) => {
          const name = squareName(fileIndex, rank);
          const piece = placement?.[8 - rank]?.[fileIndex] ?? null;
          const marked = name === from || name === to;
          const dark = isDarkSquare(fileIndex, rank);
          const markClass = marked ? ` mark ${name === to ? "mark-to" : "mark-from"}` : "";
          return (
            <div
              key={name}
              role="gridcell"
              className={`sq ${dark ? "dark" : "light"}${markClass}`}
              aria-label={`${name}${piece ? `, ${pieceName(piece)}` : ""}${marked ? ", lance marcado" : ""}`}
            >
              {fileIndex === firstFile ? (
                <span className="coord coord-rank" aria-hidden="true">
                  {rank}
                </span>
              ) : null}
              {rank === lastRank ? (
                <span className="coord coord-file" aria-hidden="true">
                  {name[0]}
                </span>
              ) : null}
              {piece ? (
                <span className={`piece ${piece === piece.toUpperCase() ? "white" : "black"}`}>{GLYPH[piece]}</span>
              ) : null}
            </div>
          );
        }),
      )}
    </div>
  );
}
