import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import type { Engine, EngineScore, Participant } from "@arena/core";
import { createApp } from "../src/http.js";
import { createRegistry } from "../src/providers/registry.js";
import { createStockfish } from "../src/stockfish.js";

const participants: Participant[] = [
  { slot: 0, provider: "jev", modelId: "jev-latest" },
  { slot: 1, provider: "cursor", modelId: "claude-opus" },
];

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

describe("análise no servidor", () => {
  it("rota de análise devolve o mesmo resultado sem refazer o motor", async () => {
    const engine = scriptedEngine();
    const app = createApp({ registry: createRegistry([]), engine });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const created = app.store.create({ mode: "battle", scenarioId: "game", participants });
      for (const [index, move] of FOOLS_MATE.slice(0, 2).entries()) {
        await app.store.decide(created.sessionId, (index % 2) as 0 | 1, move);
      }
      const first = await (await fetch(`${base}/api/sessions/${created.sessionId}/analysis`)).json();
      const again = await (await fetch(`${base}/api/sessions/${created.sessionId}/analysis`)).json();
      assert.equal(first.moves.length, 2);
      assert.deepEqual(again, first);
      assert.equal(engine.calls, 3);
      assert.match(first.pgn, /\[Result "\*"\]/);
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });

  it("Stockfish real acha o melhor lance e o mate em um", async () => {
    const engine = createStockfish(8);
    try {
      const opening = await engine.evaluate(new Chess().fen());
      assert.match(opening.bestMove ?? "", /^[a-h][1-8][a-h][1-8]/);
      assert.equal(typeof opening.cp, "number");
      const mate = await engine.evaluate(fensOf(FOOLS_MATE)[3]!);
      assert.equal(mate.bestMove, "d8h4");
      assert.equal(mate.mate, 1);
    } finally {
      engine.close();
    }
  });
});
