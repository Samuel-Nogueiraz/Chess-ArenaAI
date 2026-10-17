import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { analyzeGame, labelFor, moveAccuracy, parseUciScore, winPercent, type Engine, type EngineScore } from "../src/analysis.js";
import { createSessionStore } from "../src/session.js";
import type { DecisionAdapter, Participant } from "../src/types.js";

const participants: Participant[] = [
  { slot: 0, provider: "jev", modelId: "jev-latest" },
  { slot: 1, provider: "cursor", modelId: "claude-opus" },
];

const idle: DecisionAdapter = {
  async decide() {
    throw new Error("o teste injeta os lances");
  },
};

const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"];

function fensOf(moves: string[]): string[] {
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const move of moves) {
    chess.move({ from: move.slice(0, 2), to: move.slice(2, 4) });
    fens.push(chess.fen());
  }
  return fens;
}

function scriptedEngine(): Engine & { calls: number } {
  const fens = fensOf(FOOLS_MATE);
  const table = new Map<string, EngineScore>([
    [fens[0]!, { cp: 30, mate: null, bestMove: "e2e4" }],
    [fens[1]!, { cp: 50, mate: null, bestMove: "e7e5" }],
    [fens[2]!, { cp: -60, mate: null, bestMove: "e2e4" }],
    [fens[3]!, { cp: null, mate: 1, bestMove: "d8h4" }],
  ]);
  const engine = {
    name: "roteiro",
    depth: 1,
    calls: 0,
    async evaluate(fen: string) {
      engine.calls += 1;
      const score = table.get(fen);
      if (!score) throw new Error(`posição fora do roteiro: ${fen}`);
      return score;
    },
  };
  return engine;
}

async function playedSession(moves: string[]) {
  const store = createSessionStore(idle);
  const created = store.create({ mode: "battle", scenarioId: "game", participants });
  for (const [index, move] of moves.entries()) {
    await store.decide(created.sessionId, (index % 2) as 0 | 1, move);
  }
  return store.get(created.sessionId);
}

describe("análise", () => {
  it("converte avaliação em chance de vitória e precisão", () => {
    assert.equal(winPercent(0), 50);
    assert.ok(winPercent(300) > 75 && winPercent(300) < 76);
    assert.equal(Math.round(moveAccuracy(0)), 100);
    assert.ok(moveAccuracy(20) < 45);
    assert.equal(labelFor(40, true), "melhor");
    assert.equal(labelFor(4.9, false), "bom");
    assert.equal(labelFor(5, false), "imprecisão");
    assert.equal(labelFor(10, false), "erro");
    assert.equal(labelFor(15, false), "erro grave");
  });

  it("lê a nota do motor só da linha principal exata", () => {
    assert.deepEqual(parseUciScore("info depth 12 seldepth 19 multipv 1 score cp 28 nodes 31743 pv g1f3"), { cp: 28, mate: null });
    assert.deepEqual(parseUciScore("info depth 9 score mate -3 pv a1a2"), { cp: null, mate: -3 });
    assert.equal(parseUciScore("info depth 12 multipv 2 score cp 10 pv e2e4"), null);
    assert.equal(parseUciScore("info depth 12 score cp 40 lowerbound pv e2e4"), null);
    assert.equal(parseUciScore("bestmove e2e4"), null);
  });

  it("avalia cada lance, resume por jogador e monta o PGN", async () => {
    const session = await playedSession(FOOLS_MATE);
    assert.equal(session.outcome?.kind, "checkmate");
    const engine = scriptedEngine();
    const analysis = await analyzeGame(session, engine);

    assert.equal(engine.calls, 4);
    assert.deepEqual(analysis.moves.map((move) => move.san), ["f3", "e5", "g4", "Qh4#"]);
    assert.deepEqual(analysis.moves.map((move) => move.label), ["imprecisão", "melhor", "erro grave", "melhor"]);
    assert.equal(analysis.moves[0]?.cpLoss, 80);
    assert.equal(analysis.moves[0]?.bestSan, "e4");
    assert.equal(analysis.moves[0]?.whiteCp, -50);
    assert.equal(analysis.moves[3]?.whiteCp, -1000);
    assert.equal(analysis.moves[3]?.clockAfterMs != null, true);

    const [white, black] = analysis.players;
    assert.equal(white.modelId, "jev-latest");
    assert.equal(white.moves, 2);
    assert.equal(white.inaccuracies, 1);
    assert.equal(white.blunders, 1);
    assert.equal(white.best, 0);
    assert.equal(black.best, 2);
    assert.equal(black.acpl, 0);
    assert.equal(black.accuracy, 100);
    assert.ok((white.accuracy ?? 100) < 50);

    assert.match(analysis.pgn, /\[White "Jev"\]/);
    assert.match(analysis.pgn, /\[Black "claude-opus"\]/);
    assert.match(analysis.pgn, /\[Result "0-1"\]/);
    assert.match(analysis.pgn, /1\. f3 \{\[%eval -0\.50\] \[%clk 0:0\d:\d\d\]\}/);
    assert.match(analysis.pgn, /g4 \{\[%eval #-1\] /);
    assert.match(analysis.pgn, /Qh4# \{\[%clk /);
    assert.match(analysis.pgn, /0-1$/);
  });

  it("conta id ilegal corrigido como resposta inválida e cobra o tempo da tentativa", async () => {
    const budgets: Array<number | null | undefined> = [];
    const adapter: DecisionAdapter = {
      async decide(input) {
        budgets.push(input.budgetMs);
        return {
          choiceId: "f2f3",
          modelReturned: null,
          rawResponse: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          costNature: "unavailable",
          sdkDurationMs: null,
          durationMs: 1000,
          failureReason: null,
          confidence: null,
          distribution: null,
          prompt: input.context.objective,
          preludes: [{
            logical: false,
            choiceId: "f4e5",
            durationMs: 4000,
            failureReason: "id fora da lista",
            modelReturned: null,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            costNature: "unavailable",
            rawResponse: { result: "f4e5" },
          }],
        };
      },
    };
    const store = createSessionStore(adapter);
    const created = store.create({ mode: "battle", scenarioId: "game", participants });
    await store.decide(created.sessionId, 0);
    const session = store.get(created.sessionId);
    assert.deepEqual(budgets, [300_000]);
    assert.equal(session.history[0]?.choiceId, "f4e5");
    assert.equal(session.history[0]?.logical, false);

    const analysis = await analyzeGame(session, scriptedEngine());
    assert.equal(analysis.moves.length, 1);
    assert.equal(analysis.players[0].invalid, 1);
    assert.equal(analysis.players[0].totalMs, 5000);
    assert.equal(analysis.moves[0]?.clockAfterMs, 295_000);
  });
});
