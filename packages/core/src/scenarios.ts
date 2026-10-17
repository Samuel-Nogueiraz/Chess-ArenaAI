import type { ScenarioId } from "./types.js";

export interface Scenario {
  id: ScenarioId;
  name: string;
  fen: string;
  objective: string;
}

export const CHECK_OBJECTIVE_SINGLE = "Escolher a única saída legal de xeque.";

export const CHECK_OBJECTIVE_MANY = "Escolher uma saída legal de xeque.";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const GAME_OBJECTIVE =
  "Vencer a partida: dar xeque-mate no adversário e evitar empate. Cada lado tem 5 minutos para terminar o jogo; seja efetivo e rápido. Escolher o lance legal mais forte.";

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  game: {
    id: "game",
    name: "Partida",
    fen: START_FEN,
    objective: GAME_OBJECTIVE,
  },
  opening: {
    id: "opening",
    name: "Abertura de exemplo",
    fen: START_FEN,
    objective: "Escolher uma jogada para desenvolver a posição.",
  },
  mate: {
    id: "mate",
    name: "Mate em um lance",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
    objective: "Encontrar o mate em um lance.",
  },
  check: {
    id: "check",
    name: "Saída obrigatória de xeque",
    fen: "r7/8/8/8/8/2k5/8/K7 w - - 0 1",
    objective: CHECK_OBJECTIVE_SINGLE,
  },
  defense: {
    id: "defense",
    name: "Defesa do rei",
    fen: "6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1",
    objective: "Escolher uma continuação segura para o rei.",
  },
};

export const DRAW_KINGS_FEN = "8/8/8/8/8/4k3/8/4K3 w - - 0 1";

export function isScenarioId(value: string): value is ScenarioId {
  return value === "game" || value === "opening" || value === "mate" || value === "check" || value === "defense";
}

export function objectiveFor(scenarioId: ScenarioId, legalCount: number): string {
  if (scenarioId === "check" && legalCount > 1) return CHECK_OBJECTIVE_MANY;
  return SCENARIOS[scenarioId].objective;
}
