import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GAME_OBJECTIVE, inspect, SCENARIOS, type DecisionContext } from "@arena/core";
import { askJev, buildJevRequest, createJevProvider, JEV_QUESTION_ID, JEV_URL } from "../src/providers/jev.js";
import { buildCursorPrompt, buildCursorTurn } from "../src/providers/cursor.js";

const context: DecisionContext = {
  sessionId: "s",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  sideToMove: "w",
  objective: "Escolher uma jogada para desenvolver a posição.",
  candidates: [
    { id: "e2e4", san: "e4" },
    { id: "d2d4", san: "d4" },
  ],
};

describe("Jev", () => {
  it("pede Choice com a pergunta em instructions e critérios UCI", () => {
    const body = buildJevRequest(context);
    const question = body.questions[JEV_QUESTION_ID];
    assert.equal(body.model, "jev-latest");
    assert.equal(Array.isArray(body.questions), false);
    assert.equal(question?.type, "choice");
    assert.deepEqual(question?.criteria, { e2e4: "e4", d2d4: "d4" });
    assert.match(question?.instructions ?? "", /legal_moves/);
    assert.match(question?.instructions ?? "", /Escolher uma jogada para desenvolver a posição/);
    assert.match(question?.instructions ?? "", /e2e4 e4/);
    assert.match(question?.instructions ?? "", /8 r n b q k b n r/);
    assert.match(question?.instructions ?? "", /strongest legal move/);
    assert.match(question?.instructions ?? "", /You never capture the king/);
    assert.match(question?.instructions ?? "", /checkmates: none/);
    assert.equal(JSON.stringify(body).includes("Authorization"), false);
    assert.equal(JSON.stringify(body).includes("Bearer"), false);
  });

  it("marca o xeque-mate imediato e o lance que entrega o jogo", () => {
    const view = inspect(SCENARIOS.mate.fen);
    const mate: DecisionContext = {
      sessionId: "s",
      fen: view.fen,
      sideToMove: view.sideToMove,
      objective: SCENARIOS.mate.objective,
      candidates: view.candidates,
    };
    const body = buildJevRequest(mate);
    const instructions = body.questions[JEV_QUESTION_ID]?.instructions ?? "";
    assert.match(instructions, /checkmates: h5f7 Qxf7#/);
    assert.match(body.questions[JEV_QUESTION_ID]?.criteria.h5f7 ?? "", /checkmate, you win now/);
    assert.match(buildCursorPrompt(mate), /checkmates: h5f7 Qxf7#/);
    assert.match(buildCursorTurn(mate), /checkmates: h5f7 Qxf7#/);
    assert.match(buildCursorTurn(mate), /opponent_mates_after:/);
  });

  it("na partida o objetivo pede vitória, mate e 5 minutos", () => {
    const instructions = buildJevRequest({ ...context, objective: GAME_OBJECTIVE }).questions[JEV_QUESTION_ID]?.instructions ?? "";
    assert.match(instructions, /Vencer a partida/);
    assert.match(instructions, /xeque-mate/);
    assert.match(instructions, /evitar empate/);
    assert.match(instructions, /5 minutos/);
  });

  it("não chama a rede sem chave", async () => {
    let calls = 0;
    const result = await askJev(context, {
      apiKey: undefined,
      fetch: async () => {
        calls += 1;
        throw new Error("não deveria chamar");
      },
      sleep: async () => undefined,
    });
    assert.equal(calls, 0);
    assert.equal(result.failureReason, "credencial ausente");
    assert.equal(result.inputTokens, null);
    assert.equal(result.costUsd, null);
  });

  it("retenta só 429 e 529, no máximo duas, e respeita retry-after", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await askJev(context, {
      apiKey: "test-key",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async (url, init) => {
        calls += 1;
        assert.equal(url, JEV_URL);
        assert.equal(init.headers.Authorization, "Bearer test-key");
        if (calls < 3) {
          return { status: 429, headers: { get: () => "2" }, json: async () => ({}) };
        }
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            model: "jev-1.13.0",
            answers: {
              [JEV_QUESTION_ID]: {
                type: "choice",
                choice: "e2e4",
                confidence: 0.4,
                probabilities: { e2e4: 0.4, d2d4: 0.1 },
              },
            },
            usage: { input_tokens: 1_000_000, output_tokens: 8 },
          }),
        };
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2000, 2000]);
    assert.equal(result.choiceId, "e2e4");
    assert.equal(result.modelReturned, "jev-1.13.0");
    assert.equal(result.inputTokens, 1_000_000);
    assert.equal(result.outputTokens, 8);
    assert.equal(result.costUsd, 0.042);
    assert.equal(result.costNature, "estimated");
    assert.equal(result.confidence, 0.4);
    assert.equal(result.distribution?.e2e4, 0.4);
    assert.equal(result.preludes.length, 2);
    assert.equal(JSON.stringify(result.rawResponse).includes("test-key"), false);
  });

  it("usa backoff quando não há retry-after e para após duas retentativas", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await askJev(context, {
      apiKey: "test-key",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        calls += 1;
        return { status: 529, headers: { get: () => null }, json: async () => ({}) };
      },
    });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [200, 400]);
    assert.equal(result.failureReason, "provedor sobrecarregado");
    assert.equal(result.preludes.length, 2);
  });

  it("não retenta 401, 422, timeout nem resposta inválida", async () => {
    for (const status of [401, 422]) {
      let calls = 0;
      const result = await askJev(context, {
        apiKey: "test-key",
        sleep: async () => {
          throw new Error("não deveria esperar");
        },
        fetch: async () => {
          calls += 1;
          return { status, headers: { get: () => "9" }, json: async () => ({}) };
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.failureReason, status === 401 ? "credencial recusada" : "corpo recusado");
    }

    const detailed = await askJev(context, {
      apiKey: "test-key",
      sleep: async () => undefined,
      fetch: async () => ({
        status: 422,
        headers: { get: () => null },
        json: async () => ({
          detail: [{ loc: ["body", "questions"], msg: "Input should be a valid dictionary" }],
        }),
      }),
    });
    assert.equal(detailed.failureReason, "corpo recusado. questions: Input should be a valid dictionary");

    const secret = await askJev(context, {
      apiKey: "test-key",
      sleep: async () => undefined,
      fetch: async () => ({
        status: 422,
        headers: { get: () => null },
        json: async () => ({ message: "Authorization: Bearer segredo" }),
      }),
    });
    assert.equal(secret.failureReason, "corpo recusado");
    assert.equal(secret.failureReason.includes("segredo"), false);

    let invalidCalls = 0;
    const invalid = await askJev(context, {
      apiKey: "test-key",
      sleep: async () => undefined,
      fetch: async () => {
        invalidCalls += 1;
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => {
            throw new Error("json");
          },
        };
      },
    });
    assert.equal(invalidCalls, 1);
    assert.equal(invalid.failureReason, "resposta inválida");

    let hung = 0;
    const timed = await askJev(context, {
      apiKey: "test-key",
      timeoutMs: 20,
      sleep: async () => undefined,
      fetch: () => {
        hung += 1;
        return new Promise(() => undefined);
      },
    });
    assert.equal(hung, 1);
    assert.equal(timed.failureReason, "tempo esgotado");
    assert.equal(timed.choiceId, null);
  });

  it("sem input_tokens o custo fica indisponível e a saída não entra na conta", async () => {
    const result = await askJev(context, {
      apiKey: "test-key",
      sleep: async () => undefined,
      fetch: async () => ({
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          model: "jev-1.13.0",
          answers: { [JEV_QUESTION_ID]: { type: "choice", choice: "e2e4" } },
          usage: { output_tokens: 4 },
        }),
      }),
    });
    assert.equal(result.inputTokens, null);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.costUsd, null);
    assert.equal(result.costNature, "unavailable");
  });
});

describe("provedor Jev", () => {
  it("só fica disponível com a chave e nunca a devolve", async () => {
    const without = createJevProvider({ env: {} });
    assert.deepEqual(await without.status(), { available: false, reason: "TYPESAFE_API_KEY ausente" });
    const withKey = createJevProvider({ env: { TYPESAFE_API_KEY: "test-key", JEV_MODEL: "jev-x" } });
    assert.deepEqual(await withKey.status(), { available: true, reason: null });
    assert.deepEqual(await withKey.models(), [{ id: "jev-x", label: "JEV" }]);
    assert.equal(JSON.stringify([await withKey.status(), await withKey.models()]).includes("test-key"), false);
    assert.equal(withKey.id, "jev");
  });
});
