import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeGame } from "../src/analysis.js";
import { createDemoAdapter } from "../src/demo.js";
import { createHeuristicEngine, HEURISTIC_ENGINE_NAME, mateIn, searchRoot } from "../src/heuristic-engine.js";
import { SCENARIOS } from "../src/scenarios.js";
import { createSessionStore } from "../src/session.js";

// 1. f3 e5 2. g4: as pretas dão Qh4#.
const BLACK_MATES = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
const WHITE_MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

describe("motor heurístico", () => {
  it("se apresenta como heurística (demo)", () => {
    const engine = createHeuristicEngine({ depth: 2 });
    assert.equal(engine.name, "heurística (demo)");
    assert.equal(engine.name, HEURISTIC_ENGINE_NAME);
    assert.equal(engine.depth, 2);
  });

  it("vê o mate em um, com o sinal de quem joga", async () => {
    const engine = createHeuristicEngine({ depth: 2 });
    const score = await engine.evaluate(SCENARIOS.mate.fen);
    assert.equal(score.mate, 1);
    assert.equal(score.cp, null);
    assert.equal(score.bestMove, "h5f7");
    const black = await engine.evaluate(BLACK_MATES);
    assert.equal(black.mate, 1);
    assert.equal(black.bestMove, "d8h4");
  });

  it("mateIn converte a nota em lances e mantém o sinal", () => {
    assert.equal(mateIn(100_000 - 1), 1);
    assert.equal(mateIn(100_000 - 3), 2);
    assert.equal(mateIn(-(100_000 - 2)), -1);
    assert.equal(mateIn(-(100_000 - 4)), -2);
  });

  it("material tem o sinal certo para quem joga", async () => {
    const engine = createHeuristicEngine({ depth: 2 });
    const whiteUp = await engine.evaluate("4k3/8/8/8/8/8/8/3QK3 w - - 0 1");
    assert.ok((whiteUp.cp ?? 0) > 500, `cp das brancas ${whiteUp.cp}`);
    const blackDown = await engine.evaluate("4k3/8/8/8/8/8/8/3QK3 b - - 0 1");
    assert.ok((blackDown.cp ?? 0) < -500, `cp das pretas ${blackDown.cp}`);
    const equal = await engine.evaluate("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    assert.ok(Math.abs(equal.cp ?? 9999) < 100);
  });

  it("afogamento vale zero e xeque-mate no tabuleiro vale mate 0", async () => {
    const engine = createHeuristicEngine({ depth: 2 });
    assert.deepEqual(await engine.evaluate("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"), { cp: 0, mate: null, bestMove: null });
    assert.deepEqual(await engine.evaluate(WHITE_MATED), { cp: null, mate: 0, bestMove: null });
  });

  it("ganha a peça de graça em vez de deixar a dama atacada", () => {
    const result = searchRoot("4k3/8/8/4p3/3Q4/8/8/4K3 w - - 0 1", 2);
    assert.equal(result.best[0]?.uci, "d4e5");
    assert.ok(result.score > 0);
  });

  it("alimenta analyzeGame com uma partida demo", async () => {
    const store = createSessionStore(createDemoAdapter({ speed: 0 }));
    const created = store.create({
      mode: "battle",
      scenarioId: "mate",
      participants: [
        { slot: 0, provider: "demo", modelId: "jev-demo" },
        { slot: 1, provider: "demo", modelId: "rival-greedy" },
      ],
    });
    await store.decide(created.sessionId, 0);
    const analysis = await analyzeGame(store.get(created.sessionId), createHeuristicEngine({ depth: 2 }));
    assert.equal(analysis.engine, "heurística (demo)");
    assert.equal(analysis.moves.length, 1);
    assert.equal(analysis.moves[0]?.san, "Qxf7#");
    assert.equal(analysis.moves[0]?.label, "melhor");
    assert.equal(analysis.players[0].provider, "demo");
    assert.match(analysis.pgn, /\[Result "1-0"\]/);
  });
});
