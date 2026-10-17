import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DecisionContext } from "@arena/core";
import { askCursor, buildCursorPrompt, buildCursorTurn, cacheDir, createCursorProvider, CURSOR_ONLY_ID_PHRASE, cursorPromptOptions, listCursorModels, pickModelParams } from "../src/providers/cursor.js";

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

describe("Cursor", () => {
  it("pede só um id, proíbe editar arquivo e não inventa modelo", () => {
    const prompt = buildCursorPrompt(context);
    assert.match(prompt, new RegExp(CURSOR_ONLY_ID_PHRASE));
    assert.match(prompt, /e2e4/);
    assert.match(prompt, /d2d4/);
    assert.match(prompt, /Escolher uma jogada para desenvolver a posição/);
    assert.match(prompt, /e2e4 e4/);
    assert.match(prompt, /8 r n b q k b n r/);
    assert.match(prompt, /strongest legal move/);
    const options = cursorPromptOptions({
      apiKey: "test-key",
      modelId: "id-vindo-da-lista",
      cacheDir: cacheDir(),
    });
    assert.equal(options.model.id, "id-vindo-da-lista");
    assert.deepEqual(options.tools, []);
    assert.equal("systemPrompt" in options, false);
    assert.match(prompt, /not a coding assistant/);
    assert.match(prompt, /Do not read files/);
    assert.equal(options.local.enableAgentRetries, false);
    assert.deepEqual(options.local.settingSources, []);
    assert.match(options.local.cwd.replaceAll("\\", "/"), /server\/\.cache\/cursor$/);
  });

  it("depois do primeiro turno manda só o lance do adversário, o FEN e os lances legais", async () => {
    const turn = buildCursorTurn({ ...context, lastMove: { id: "e7e5", san: "e5" } });
    assert.match(turn, /Opponent played e7e5 \(e5\)\./);
    assert.match(turn, /FEN: rnbqkbnr/);
    assert.match(turn, /legal_moves: e2e4 e4, d2d4 d4/);
    assert.match(turn, /You never capture the king/);
    assert.match(turn, /checkmates: none/);
    assert.match(turn, new RegExp(CURSOR_ONLY_ID_PHRASE));
    assert.doesNotMatch(turn, /not a coding assistant/);
    assert.doesNotMatch(turn, /8 r n b q k b n r/);
    assert.doesNotMatch(buildCursorTurn(context), /Opponent/);

    const prompts: string[] = [];
    const keys: string[] = [];
    const run = () => askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      conversation: "sessao-turnos:1",
      prompt: async (prompt, _options, key) => {
        prompts.push(prompt);
        keys.push(key);
        return { status: "finished", result: "e2e4" };
      },
    });
    const first = await run();
    const second = await run();
    assert.match(prompts[0] ?? "", /Play to win/);
    assert.match(prompts[0] ?? "", /8 r n b q k b n r/);
    assert.equal(prompts[1], buildCursorTurn(context));
    assert.equal(second.prompt, prompts[1]);
    assert.equal(first.prompt.length > second.prompt.length, true);
    assert.deepEqual(keys, ["sessao-turnos:1", "sessao-turnos:1"]);
  });

  it("corrige id fora da lista na mesma conversa até acertar enquanto houver relógio", async () => {
    const prompts: string[] = [];
    const replies = ["f4e5", "e2e4"];
    const corrected = await askCursor(context, {
      apiKey: "test-key",
      modelId: "composer-2.5",
      cacheDir: cacheDir(),
      conversation: "sessao-correcao:1",
      prompt: async (prompt) => {
        prompts.push(prompt);
        return { status: "finished", result: replies.shift() ?? "e2e4", durationMs: 5, usage: { inputTokens: 7, outputTokens: 1 } };
      },
    });
    assert.equal(corrected.choiceId, "e2e4");
    assert.equal(corrected.failureReason, null);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /"f4e5" is not in legal_moves/);
    assert.match(prompts[1] ?? "", /You play white\./);
    assert.match(prompts[1] ?? "", /legal_moves: e2e4 e4, d2d4 d4/);
    assert.equal(corrected.prompt, prompts[1]);
    assert.equal(corrected.preludes.length, 1);
    assert.equal(corrected.preludes[0]?.choiceId, "f4e5");
    assert.equal(corrected.preludes[0]?.failureReason, "id fora da lista");
    assert.equal(corrected.preludes[0]?.inputTokens, 7);
    assert.match(buildCursorTurn({ ...context, sideToMove: "b" }), /You play black\./);

    let calls = 0;
    const stubborn = await askCursor(context, {
      apiKey: "test-key",
      modelId: "composer-2.5",
      cacheDir: cacheDir(),
      prompt: async () => {
        calls += 1;
        return { status: "finished", result: calls === 2 ? "não sei" : "e9e9" };
      },
    });
    assert.equal(calls, 3);
    assert.equal(stubborn.choiceId, "e9e9");
    assert.deepEqual(stubborn.preludes.map((attempt) => attempt.failureReason), ["id fora da lista", "resposta inválida"]);

    const wrong = ["e9e9", "f4e5", "xx", "a1a1", "h8h9"];
    let clockedCalls = 0;
    const clocked = await askCursor(context, {
      apiKey: "test-key",
      modelId: "composer-2.5",
      cacheDir: cacheDir(),
      budgetMs: 10_000,
      prompt: async () => {
        clockedCalls += 1;
        return { status: "finished", result: wrong.shift() ?? "d2d4" };
      },
    });
    assert.equal(clockedCalls, 6);
    assert.equal(clocked.choiceId, "d2d4");
    assert.equal(clocked.preludes.length, 5);

    let lateCalls = 0;
    const late = await askCursor(context, {
      apiKey: "test-key",
      modelId: "composer-2.5",
      cacheDir: cacheDir(),
      budgetMs: 60,
      prompt: async () => {
        lateCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: "finished", result: "e9e9" };
      },
    });
    assert.ok(lateCalls >= 2 && lateCalls <= 4);
    assert.equal(late.choiceId, "e9e9");

    let networkCalls = 0;
    const network = await askCursor(context, {
      apiKey: "test-key",
      modelId: "composer-2.5",
      cacheDir: cacheDir(),
      prompt: async () => {
        networkCalls += 1;
        throw new Error("offline");
      },
    });
    assert.equal(networkCalls, 1);
    assert.equal(network.failureReason, "falha de rede");
    assert.deepEqual(network.preludes, []);
  });

  it("escolhe Fast, esforço High e o menor contexto que o modelo oferece", () => {
    const grok = pickModelParams([
      { id: "context", values: [{ value: "500k" }, { value: "256k" }] },
      { id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }, { value: "xhigh" }] },
      { id: "fast", values: [{ value: "false" }, { value: "true" }] },
    ]);
    assert.deepEqual(grok, [
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "true" },
    ]);
    assert.deepEqual(pickModelParams([{ id: "effort", values: [{ value: "high" }] }]), [{ id: "effort", value: "high" }]);
    assert.deepEqual(pickModelParams([{ id: "fast", values: [{ value: "false" }, { value: "true" }] }]), [{ id: "fast", value: "true" }]);
    assert.deepEqual(pickModelParams([{ id: "context", values: [{ value: "1m" }, { value: "200k" }] }]), [{ id: "context", value: "200k" }]);
    assert.deepEqual(pickModelParams(undefined), []);
    const options = cursorPromptOptions({ apiKey: "k", modelId: "grok-4.7", cacheDir: cacheDir(), params: grok });
    assert.deepEqual(options.model, { id: "grok-4.7", params: grok });
  });

  it("fica indisponível, com motivo, sem chave ou sem o SDK opcional", async () => {
    const noKey = createCursorProvider({ env: {}, loadSdk: async () => null });
    assert.deepEqual(await noKey.status(), { available: false, reason: "CURSOR_API_KEY ausente" });
    assert.deepEqual(await noKey.models(), []);

    const noSdk = createCursorProvider({ env: { CURSOR_API_KEY: "test-key" }, loadSdk: async () => null });
    const status = await noSdk.status();
    assert.equal(status.available, false);
    assert.match(status.reason ?? "", /@cursor\/sdk não instalado/);
    assert.equal(JSON.stringify(status).includes("test-key"), false);
    assert.deepEqual(await noSdk.models(), []);
  });

  it("com chave e SDK lista os modelos da conta", async () => {
    const sdk = {
      Agent: { create: async () => { throw new Error("não deveria criar agente"); } },
      Cursor: { models: { list: async () => [{ id: "conta-grok", displayName: "Grok 4.7 High" }, { id: "c1" }] } },
      SqliteLocalAgentStore: { open: async () => ({}) },
    };
    const provider = createCursorProvider({ env: { CURSOR_API_KEY: "test-key" }, loadSdk: async () => sdk });
    assert.deepEqual(await provider.status(), { available: true, reason: null });
    assert.deepEqual(await provider.models(), [{ id: "conta-grok", label: "Grok 4.7 High" }, { id: "c1", label: "c1" }]);
  });

  it("normaliza a lista e separa falha de início de execução com erro", async () => {
    let listed = 0;
    const catalog = await listCursorModels({
      apiKey: "test-key",
      list: async () => {
        listed += 1;
        return [{ id: "conta-grok", displayName: "Grok 4.7 High", aliases: ["grok"] }];
      },
    });
    assert.equal(listed, 1);
    assert.equal(catalog.models[0]?.id, "conta-grok");
    const missing = await listCursorModels({ apiKey: undefined, list: async () => [] });
    assert.equal(missing.error, "credencial ausente");
    assert.deepEqual(missing.models, []);

    const prompts: string[] = [];
    const accepted = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      timeoutMs: 1000,
      prompt: async (prompt, options) => {
        prompts.push(prompt);
        assert.equal(options.model.id, "conta-grok");
        assert.deepEqual(options.tools, []);
        return {
          status: "finished",
          result: "e2e4",
          durationMs: 18,
          model: { id: "conta-grok" },
          usage: { inputTokens: 12, outputTokens: 3 },
          getUsage: async () => ({ cost: { chargedCents: 0 } }),
        };
      },
    });
    assert.equal(prompts.length, 1);
    assert.equal(accepted.choiceId, "e2e4");
    assert.equal(accepted.sdkDurationMs, 18);
    assert.equal(accepted.inputTokens, 12);
    assert.equal(accepted.outputTokens, 3);
    assert.equal(accepted.costNature, "included");
    assert.equal(accepted.costUsd, null);
    assert.equal(accepted.failureReason, null);

    const reported = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      prompt: async () => ({
        status: "finished",
        result: "e2e4",
        getUsage: async () => ({ cost: { chargedCents: 250 } }),
      }),
    });
    assert.equal(reported.costUsd, 2.5);
    assert.equal(reported.costNature, "reported");

    const unavailable = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      prompt: async () => ({ status: "finished", result: "e2e4" }),
    });
    assert.equal(unavailable.inputTokens, null);
    assert.equal(unavailable.costNature, "unavailable");
    assert.equal(unavailable.costUsd, null);

    const prose = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      prompt: async () => ({ status: "finished", result: "eu escolho e2e4" }),
    });
    assert.equal(prose.choiceId, null);
    assert.equal(prose.failureReason, "resposta inválida");

    const marked = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      prompt: async () => ({ status: "finished", result: "g8f7<|eos|>" }),
    });
    assert.equal(marked.choiceId, "g8f7");
    assert.equal(marked.failureReason, null);

    const outside = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      prompt: async () => ({ status: "finished", result: "e9e9" }),
    });
    assert.equal(outside.choiceId, "e9e9");
    assert.equal(outside.failureReason, null);

    const startup = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      prompt: async () => {
        const error = new Error("auth");
        error.name = "CursorAgentError";
        throw error;
      },
    });
    assert.equal(startup.failureReason, "falha de início");
    assert.equal(startup.choiceId, null);

    const ran = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      prompt: async () => ({ status: "error", error: { message: "tool" }, usage: { inputTokens: 2 } }),
    });
    assert.equal(ran.failureReason, "execução com erro. tool");
    assert.equal(ran.inputTokens, 2);
    assert.equal(ran.outputTokens, null);

    const timed = await askCursor(context, {
      apiKey: "test-key",
      modelId: "conta-grok",
      cacheDir: cacheDir(),
      timeoutMs: 20,
      prompt: () => new Promise(() => undefined),
    });
    assert.equal(timed.failureReason, "tempo esgotado");
  });
});
