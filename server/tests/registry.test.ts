import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inspect, SCENARIOS, SessionError, type AdapterDecision, type AdapterRequest, type ProviderId } from "@arena/core";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";
import { loadEnv, resolveListen } from "../src/env.js";
import { createDemoProvider } from "../src/providers/demo.js";
import { createRegistry, type ProviderModule } from "../src/providers/registry.js";

function decision(choiceId: string): AdapterDecision {
  return {
    choiceId,
    modelReturned: "m",
    rawResponse: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs: null,
    durationMs: null,
    failureReason: null,
    confidence: null,
    distribution: null,
    prompt: "p",
    preludes: [],
  };
}

function request(provider: ProviderId, modelId = "m"): AdapterRequest {
  const view = inspect(SCENARIOS.opening.fen);
  return {
    sessionId: "s",
    slot: 0,
    participant: { slot: 0, provider, modelId },
    context: { sessionId: "s", fen: view.fen, sideToMove: "w", objective: "o", candidates: view.candidates },
  };
}

function module(id: ProviderId, patch: Partial<ProviderModule> = {}): ProviderModule {
  return {
    id,
    label: id,
    kind: "api",
    status: async () => ({ available: true, reason: null }),
    models: async () => [{ id: "m", label: "M" }],
    decide: async () => decision("e2e4"),
    ...patch,
  };
}

describe("registro de provedores", () => {
  it("despacha por participant.provider", async () => {
    const registry = createRegistry([
      module("jev", { decide: async () => decision("e2e4") }),
      module("cli", { decide: async () => decision("d2d4") }),
    ]);
    assert.equal((await registry.decide(request("jev"))).choiceId, "e2e4");
    assert.equal((await registry.decide(request("cli"))).choiceId, "d2d4");
  });

  it("provedor indisponível ou ausente não é chamado e devolve falha clara", async () => {
    let calls = 0;
    const registry = createRegistry([
      module("jev", {
        status: async () => ({ available: false, reason: "TYPESAFE_API_KEY ausente" }),
        decide: async () => {
          calls += 1;
          return decision("e2e4");
        },
      }),
    ]);
    const blocked = await registry.decide(request("jev"));
    assert.equal(calls, 0);
    assert.equal(blocked.choiceId, null);
    assert.match(blocked.failureReason ?? "", /indisponível.*TYPESAFE_API_KEY ausente/);
    const missing = await registry.decide(request("openai"));
    assert.equal(missing.failureReason, "provedor não registrado");
  });

  it("exceção do provedor vira falha sem vazar a mensagem", async () => {
    const registry = createRegistry([module("jev", { decide: async () => { throw new Error("Bearer segredo-123"); } })]);
    const result = await registry.decide(request("jev"));
    assert.equal(result.failureReason, "falha interna do provedor");
    assert.equal(JSON.stringify(result).includes("segredo"), false);
  });

  it("list devolve id, rótulo, tipo, disponibilidade, motivo e modelos", async () => {
    const registry = createRegistry([
      createDemoProvider(),
      module("jev", { kind: "api", status: async () => ({ available: false, reason: "TYPESAFE_API_KEY ausente" }), models: async () => [] }),
      module("cursor", { status: async () => { throw new Error("quebrou"); }, models: async () => { throw new Error("quebrou"); } }),
    ]);
    const list = await registry.list();
    assert.deepEqual(list.map((item) => item.id), ["demo", "jev", "cursor"]);
    assert.deepEqual(Object.keys(list[0]!).sort(), ["available", "id", "kind", "label", "models", "reason"]);
    assert.equal(list[0]!.available, true);
    assert.equal(list[0]!.reason, null);
    assert.equal(list[1]!.available, false);
    assert.equal(list[1]!.reason, "TYPESAFE_API_KEY ausente");
    assert.equal(list[2]!.available, false);
    assert.deepEqual(list[2]!.models, []);
  });

  it("assertUsable recusa provedor ausente, indisponível e modelo desconhecido com 400", async () => {
    const registry = createRegistry([
      createDemoProvider(),
      module("jev", { status: async () => ({ available: false, reason: "TYPESAFE_API_KEY ausente" }) }),
    ]);
    const part = (provider: ProviderId, modelId: string) => ({ slot: 0 as const, provider, modelId });
    await registry.assertUsable([part("demo", "jev-demo")]);
    await assert.rejects(registry.assertUsable([part("jev", "x")]), (error: unknown) => error instanceof SessionError && error.status === 400 && /TYPESAFE_API_KEY ausente/.test(error.message));
    await assert.rejects(registry.assertUsable([part("cursor", "x")]), /não está registrado/);
    await assert.rejects(registry.assertUsable([part("demo", "gpt")]), /desconhecido/);
  });

  it("repete openSession e closeAll para todos os módulos e recusa id duplicado", () => {
    const events: string[] = [];
    const registry = createRegistry([
      module("jev", { openSession: (session) => events.push(`jev:${session.sessionId}`), closeAll: () => events.push("jev:close") }),
      module("cli", { openSession: (session) => events.push(`cli:${session.sessionId}`) }),
    ]);
    registry.openSession({ sessionId: "abc", participants: [] });
    registry.closeAll();
    assert.deepEqual(events, ["jev:abc", "cli:abc", "jev:close"]);
    assert.throws(() => createRegistry([module("jev"), module("jev")]), /duplicado/);
  });
});

describe("config", () => {
  const example = {
    cli: [
      { id: "claude-sonnet", label: "Claude Code · Sonnet", command: "claude", args: ["-p", "--model", "sonnet", "--output-format", "json"], input: "stdin", output: "claude-json", timeoutMs: 90000 },
      { id: "codex", label: "Codex CLI", command: "codex", args: ["exec", "-"], input: "stdin", output: "text", timeoutMs: 90000 },
    ],
    openai: [
      { id: "gpt-mini", label: "OpenAI · gpt-4.1-mini", baseUrl: "https://api.openai.com/v1/", apiKeyEnv: "OPENAI_API_KEY", model: "gpt-4.1-mini", inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
    ],
  };

  it("aceita o exemplo da spec e normaliza", () => {
    const config = parseConfig(example);
    assert.equal(config.cli.length, 2);
    assert.equal(config.cli[0]!.output, "claude-json");
    assert.equal(config.openai[0]!.baseUrl, "https://api.openai.com/v1");
    assert.equal(config.openai[0]!.timeoutMs, 60_000);
  });

  it("aplica padrões e aceita listas ausentes", () => {
    const config = parseConfig({ cli: [{ id: "a", command: "x" }] });
    assert.deepEqual(config.cli[0], { id: "a", label: "a", command: "x", args: [], input: "stdin", output: "text", timeoutMs: 90_000 });
    assert.deepEqual(config.openai, []);
    assert.deepEqual(parseConfig({}), { cli: [], openai: [], source: null });
  });

  it("recusa entradas malformadas com a mensagem apontando o campo", () => {
    const bad = (value: unknown) => () => parseConfig(value);
    assert.throws(bad([]), ConfigError);
    assert.throws(bad({ cli: {} }), /"cli" deve ser uma lista/);
    assert.throws(bad({ cli: [{ id: "a b", command: "x" }] }), /cli\[0\]\.id/);
    assert.throws(bad({ cli: [{ id: "a" }] }), /cli\[0\]\.command/);
    assert.throws(bad({ cli: [{ id: "a", command: "x", input: "arg", args: ["-p"] }] }), /\{prompt\}/);
    assert.throws(bad({ cli: [{ id: "a", command: "x", output: "xml" }] }), /output/);
    assert.throws(bad({ cli: [{ id: "a", command: "x", timeoutMs: 5 }] }), /timeoutMs/);
    assert.throws(bad({ cli: [{ id: "a", command: "x" }, { id: "a", command: "y" }] }), /repetido/);
    assert.throws(bad({ openai: [{ id: "a", baseUrl: "ftp://x", model: "m" }] }), /baseUrl/);
    assert.throws(bad({ openai: [{ id: "a", baseUrl: "https://x", model: "m", apiKeyEnv: "sk-proj-abc123" }] }), /NOME da variável/);
    assert.throws(bad({ openai: [{ id: "a", baseUrl: "https://x", model: "m", inputUsdPerMillion: -1 }] }), /inputUsdPerMillion/);
  });

  it("arquivo ausente vira config vazia; ARENA_CONFIG ausente é erro; arquivo válido é lido", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-config-"));
    try {
      assert.deepEqual(loadConfig({}, dir), { cli: [], openai: [], source: null });
      assert.throws(() => loadConfig({ ARENA_CONFIG: "nao-existe.json" }, dir), /não existe/);
      writeFileSync(join(dir, "arena.config.json"), JSON.stringify(example));
      const config = loadConfig({}, dir);
      assert.equal(config.cli.length, 2);
      assert.equal(config.source, join(dir, "arena.config.json"));
      writeFileSync(join(dir, "outro.json"), JSON.stringify({ cli: [{ id: "z", command: "z" }] }));
      assert.equal(loadConfig({ ARENA_CONFIG: "outro.json" }, dir).cli[0]!.id, "z");
      writeFileSync(join(dir, "ruim.json"), "{ não é json");
      assert.throws(() => loadConfig({ ARENA_CONFIG: "ruim.json" }, dir), /JSON válido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ambiente", () => {
  it("escuta em 127.0.0.1:8780 por padrão, aceita ARENA_PORT e o apelido CHESS_API_PORT", () => {
    assert.deepEqual(resolveListen({}), { host: "127.0.0.1", port: 8780 });
    assert.deepEqual(resolveListen({ ARENA_PORT: "9000" }), { host: "127.0.0.1", port: 9000 });
    assert.deepEqual(resolveListen({ CHESS_API_PORT: "9100" }), { host: "127.0.0.1", port: 9100 });
    assert.deepEqual(resolveListen({ ARENA_PORT: "9000", CHESS_API_PORT: "9100" }), { host: "127.0.0.1", port: 9000 });
    assert.deepEqual(resolveListen({ ARENA_HOST: "localhost" }), { host: "localhost", port: 8780 });
    assert.throws(() => resolveListen({ ARENA_PORT: "abc" }), /Porta inválida/);
    assert.throws(() => resolveListen({ ARENA_PORT: "70000" }), /Porta inválida/);
  });

  it("recusa host fora do loopback sem ARENA_ALLOW_REMOTE=1", () => {
    assert.throws(() => resolveListen({ ARENA_HOST: "0.0.0.0" }), /ARENA_ALLOW_REMOTE=1/);
    assert.throws(() => resolveListen({ ARENA_HOST: "192.168.0.10" }), /ARENA_ALLOW_REMOTE=1/);
    assert.throws(() => resolveListen({ ARENA_HOST: "0.0.0.0", ARENA_ALLOW_REMOTE: "true" }), /ARENA_ALLOW_REMOTE=1/);
    assert.deepEqual(resolveListen({ ARENA_HOST: "0.0.0.0", ARENA_ALLOW_REMOTE: "1" }), { host: "0.0.0.0", port: 8780 });
  });

  it("loadEnv lê ARENA_ENV_FILE sem sobrescrever o que já existe e sem devolver conteúdo", () => {
    const dir = mkdtempSync(join(tmpdir(), "arena-env-"));
    const name = "ARENA_TESTE_VARIAVEL_NOVA";
    const kept = "ARENA_TESTE_VARIAVEL_EXISTENTE";
    const previous = process.env[kept];
    try {
      process.env[kept] = "do-processo";
      writeFileSync(join(dir, "teste.env"), `${name}=valor-do-arquivo\n${kept}=do-arquivo\n`);
      const loaded = loadEnv({ ARENA_ENV_FILE: join(dir, "teste.env") }, dir);
      assert.equal(loaded, join(dir, "teste.env"));
      assert.equal(process.env[name], "valor-do-arquivo");
      assert.equal(process.env[kept], "do-processo");

      writeFileSync(join(dir, "vazio.env"), "");
      assert.equal(loadEnv({ ARENA_ENV_FILE: join(dir, "vazio.env") }, dir), join(dir, "vazio.env"));
      assert.equal(loadEnv({}, dir), null);
      assert.throws(() => loadEnv({ ARENA_ENV_FILE: join(dir, "nao-existe.env") }, dir), /não existe/);
    } finally {
      delete process.env[name];
      if (previous === undefined) delete process.env[kept];
      else process.env[kept] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
