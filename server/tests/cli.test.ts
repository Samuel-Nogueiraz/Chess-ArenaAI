import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { inspect, SCENARIOS, type DecisionContext } from "@arena/core";
import type { CliEntry } from "../src/config.js";
import { askCli, createCliProvider, needsShell, parseCliOutput, quoteForShell, runCli } from "../src/providers/cli.js";

// Processo falso: um script node que imita uma CLI de agente. Nenhuma CLI real é chamada.
const FAKE = `
const { appendFileSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const [mode, file] = process.argv.slice(2);
if (file && mode === "hang") writeFileSync(file, String(process.pid));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const argvText = process.argv.join(" ");
  if (mode === "text") {
    const leaked = argvText.includes("FEN:");
    const ok = !leaked && input.includes("legal_moves") && input.includes("FEN:");
    console.log(ok ? "Vou jogar e2e4 porque abre o centro." : "ERRO: prompt fora do stdin");
  } else if (mode === "json") {
    console.log(JSON.stringify({ type: "result", is_error: false, result: "d2d4", duration_ms: 456, total_cost_usd: 0.0123, usage: { input_tokens: 123, output_tokens: 4 }, modelUsage: { "claude-sonnet-x": {} } }));
  } else if (mode === "json-error") {
    console.log(JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low" }));
  } else if (mode === "retry") {
    const count = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
    writeFileSync(file, String(count + 1));
    if (count === 0) console.log("e2e5");
    else console.log(input.includes('"e2e5" is not in legal_moves') ? "d2d4" : "ERRO: sem correção");
  } else if (mode === "illegal") {
    appendFileSync(file, "x");
    console.log("e2e5");
  } else if (mode === "babble") {
    console.log("não sei o que jogar");
  } else if (mode === "fail") {
    appendFileSync(file, "x");
    console.error("falha interna secreta-do-processo");
    process.exit(3);
  } else if (mode === "env") {
    console.log(process.env.TYPESAFE_API_KEY || process.env.CURSOR_API_KEY ? "LEAK" : "e2e4");
  } else if (mode === "hang") {
    setInterval(() => {}, 1000);
  }
});
if (mode === "arg") {
  console.log(process.argv[3] && process.argv[3].includes("legal_moves") ? "e2e4" : "ERRO: sem prompt no argumento");
  process.exit(0);
}
`;

let dir = "";
let script = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "arena-cli-"));
  script = join(dir, "fake-cli.cjs");
  writeFileSync(script, FAKE);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(mode: string, patch: Partial<CliEntry> = {}, file?: string): CliEntry {
  return {
    id: `fake-${mode}`,
    label: `Falsa ${mode}`,
    command: process.execPath,
    args: file ? [script, mode, file] : [script, mode],
    input: "stdin",
    output: "text",
    timeoutMs: 15_000,
    ...patch,
  };
}

function opening(): DecisionContext {
  const view = inspect(SCENARIOS.opening.fen);
  return { sessionId: "s", fen: view.fen, sideToMove: view.sideToMove, objective: SCENARIOS.opening.objective, candidates: view.candidates };
}

function counter(name: string): { file: string; count(): number } {
  const file = join(dir, name);
  return { file, count: () => (existsSync(file) ? readFileSync(file, "utf8").length : 0) };
}

describe("CLI", () => {
  it("manda o prompt por stdin, nunca na linha de comando, e lê o id no texto", async () => {
    const decision = await askCli(opening(), entry("text"));
    assert.equal(decision.choiceId, "e2e4");
    assert.equal(decision.failureReason, null);
    assert.equal(decision.modelReturned, "fake-text");
    assert.equal(decision.costNature, "unavailable");
    assert.equal(decision.costUsd, null);
    assert.equal(decision.preludes.length, 0);
    assert.match(decision.prompt, /legal_moves/);
    assert.ok((decision.durationMs ?? 0) >= 0);
  });

  it("claude-json traz resposta, tokens, custo reportado e duração", async () => {
    const decision = await askCli(opening(), entry("json", { output: "claude-json" }));
    assert.equal(decision.choiceId, "d2d4");
    assert.equal(decision.inputTokens, 123);
    assert.equal(decision.outputTokens, 4);
    assert.equal(decision.costUsd, 0.0123);
    assert.equal(decision.costNature, "reported");
    assert.equal(decision.sdkDurationMs, 456);
    assert.equal(decision.modelReturned, "claude-sonnet-x");
  });

  it("claude-json com is_error vira falha legível", async () => {
    const decision = await askCli(opening(), entry("json-error", { output: "claude-json" }));
    assert.equal(decision.choiceId, null);
    assert.equal(decision.failureReason, "execução com erro");
  });

  it("corrige uma vez quando o id vem fora da lista", async () => {
    const calls = counter("retry-count");
    const decision = await askCli(opening(), entry("retry", {}, calls.file));
    assert.equal(decision.choiceId, "d2d4");
    assert.equal(decision.failureReason, null);
    assert.equal(decision.preludes.length, 1);
    assert.equal(decision.preludes[0]?.choiceId, "e2e5");
    assert.equal(decision.preludes[0]?.failureReason, "id fora da lista");
    assert.match(decision.prompt, /"e2e5" is not in legal_moves/);
  });

  it("depois da correção ainda ilegal devolve o id para a sessão recusar, sem terceira chamada", async () => {
    const calls = counter("illegal-count");
    const decision = await askCli(opening(), entry("illegal", {}, calls.file));
    assert.equal(calls.count(), 2);
    assert.equal(decision.choiceId, "e2e5");
    assert.equal(decision.failureReason, null);
    assert.equal(decision.preludes.length, 1);
  });

  it("resposta sem nenhum id vira resposta inválida", async () => {
    const decision = await askCli(opening(), entry("babble"));
    assert.equal(decision.choiceId, null);
    assert.equal(decision.failureReason, "resposta inválida");
    assert.equal(decision.preludes[0]?.failureReason, "resposta inválida");
  });

  it("não corrige quando o orçamento do relógio já acabou", async () => {
    const calls = counter("budget-count");
    const decision = await askCli(opening(), entry("illegal", {}, calls.file), { budgetMs: 0 });
    assert.equal(calls.count(), 1);
    assert.equal(decision.preludes.length, 0);
    assert.equal(decision.choiceId, "e2e5");
  });

  it("saída com código diferente de zero falha sem corrigir e sem vazar o stderr no motivo", async () => {
    const calls = counter("fail-count");
    const decision = await askCli(opening(), entry("fail", {}, calls.file));
    assert.equal(calls.count(), 1);
    assert.equal(decision.choiceId, null);
    assert.equal(decision.failureReason, "a CLI saiu com código 3");
    assert.equal(decision.failureReason?.includes("secreta"), false);
  });

  it("o timeout mata o processo e vira falha legível", async () => {
    const pidFile = join(dir, "hang.pid");
    const started = performance.now();
    const decision = await askCli(opening(), entry("hang", { timeoutMs: 400 }, pidFile));
    const elapsed = performance.now() - started;
    assert.equal(decision.failureReason, "tempo esgotado");
    assert.equal(decision.choiceId, null);
    assert.ok(elapsed < 5000, `demorou ${elapsed}`);
    assert.ok(existsSync(pidFile), "o script chegou a iniciar");
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 30 && alive; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "o processo continuou vivo depois do timeout");
  });

  it("comando inexistente vira falha legível", async () => {
    const decision = await askCli(opening(), { ...entry("text"), command: join(dir, "nao-existe.exe") });
    assert.equal(decision.choiceId, null);
    assert.equal(decision.failureReason, "comando não encontrado");
  });

  it("não repassa as chaves da arena ao processo filho", async () => {
    const decision = await askCli(opening(), entry("env"), {
      env: { ...process.env, TYPESAFE_API_KEY: "segredo-a", CURSOR_API_KEY: "segredo-b" },
    });
    assert.equal(decision.choiceId, "e2e4");
  });

  it('input "arg" troca {prompt} por um argumento e não passa por shell fora do Windows', async () => {
    const decision = await askCli(opening(), entry("arg", { input: "arg", args: [script, "arg", "{prompt}"] }));
    assert.equal(decision.choiceId, "e2e4");
  });
});

describe("CLI no Windows", () => {
  it(".cmd e comandos sem extensão exigem shell; .exe não", () => {
    assert.equal(needsShell("claude", "win32"), true);
    assert.equal(needsShell("claude.cmd", "win32"), true);
    assert.equal(needsShell("codex.ps1", "win32"), true);
    assert.equal(needsShell("C:\\Program Files\\nodejs\\node.exe", "win32"), false);
    assert.equal(needsShell("claude", "linux"), false);
    assert.equal(needsShell("claude", "darwin"), false);
  });

  it("aspas só onde precisa, e dobradas por dentro", () => {
    assert.equal(quoteForShell("--model"), "--model");
    assert.equal(quoteForShell("C:\\Arquivos de Programas\\x.cmd"), '"C:\\Arquivos de Programas\\x.cmd"');
    assert.equal(quoteForShell('a"b'), '"a""b"');
    assert.equal(quoteForShell(""), '""');
  });

  function spyChild(output: string) {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    let stdinText = "";
    const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 4242,
        kill: () => true,
      });
      child.stdin.on("data", (chunk: Buffer) => {
        stdinText += chunk.toString("utf8");
      });
      setImmediate(() => {
        child.stdout.write(output);
        child.stdout.end();
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    return { spawn, calls, stdin: () => stdinText };
  }

  it("com shell, o prompt vai por stdin e a linha de comando só leva o config", async () => {
    const spy = spyChild("e2e4");
    const cli: CliEntry = { ...entry("text"), command: "claude", args: ["-p", "--model", "sonnet 4"], input: "stdin" };
    const run = await runCli(cli, "PROMPT-SECRETO com legal_moves", { platform: "win32", spawn: spy.spawn });
    assert.equal(run.code, 0);
    assert.equal(spy.calls.length, 1);
    const call = spy.calls[0]!;
    assert.equal(call.options.shell, true);
    assert.equal(call.command, "claude");
    assert.deepEqual(call.args, ["-p", "--model", '"sonnet 4"']);
    assert.equal(JSON.stringify(call).includes("PROMPT-SECRETO"), false);
    assert.equal(spy.stdin(), "PROMPT-SECRETO com legal_moves");
  });

  it('input "arg" é recusado no Windows quando exige shell, sem iniciar nada', async () => {
    const spy = spyChild("e2e4");
    const cli: CliEntry = { ...entry("text"), command: "codex", args: ["exec", "{prompt}"], input: "arg" };
    const run = await runCli(cli, "prompt", { platform: "win32", spawn: spy.spawn });
    assert.equal(spy.calls.length, 0);
    assert.match(run.error ?? "", /input "arg" não é aceito/);

    const decision = await askCli(opening(), cli, { platform: "win32", spawn: spy.spawn });
    assert.equal(decision.choiceId, null);
    assert.match(decision.failureReason ?? "", /input "arg"/);
    assert.equal(spy.calls.length, 0);
  });

  it(".exe no Windows roda sem shell", async () => {
    const spy = spyChild("e2e4");
    const cli: CliEntry = { ...entry("text"), command: "C:\\bin\\agent.exe", args: ["--x"] };
    await runCli(cli, "prompt", { platform: "win32", spawn: spy.spawn });
    assert.equal(spy.calls[0]?.options.shell, undefined);
  });
});

describe("saída da CLI", () => {
  it("text devolve o stdout; claude-json lê result, usage, custo e modelo", () => {
    assert.equal(parseCliOutput("text", "e2e4\n").text, "e2e4\n");
    const parsed = parseCliOutput("claude-json", JSON.stringify({ result: "e2e4", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.5, duration_ms: 99 }));
    assert.equal(parsed.text, "e2e4");
    assert.equal(parsed.inputTokens, 10);
    assert.equal(parsed.costUsd, 0.5);
    assert.equal(parsed.costNature, "reported");
    assert.equal(parsed.sdkDurationMs, 99);
  });

  it("claude-json sem custo fica indisponível; lixo e erro viram falha", () => {
    assert.equal(parseCliOutput("claude-json", JSON.stringify({ result: "e2e4" })).costNature, "unavailable");
    assert.equal(parseCliOutput("claude-json", "isto não é json").failureReason, "resposta inválida");
    assert.equal(parseCliOutput("claude-json", JSON.stringify({ usage: {} })).failureReason, "resposta inválida");
    assert.equal(parseCliOutput("claude-json", JSON.stringify({ is_error: true, result: "x" })).failureReason, "execução com erro");
    const stream = JSON.stringify([{ type: "system" }, { type: "result", result: "d2d4" }]);
    assert.equal(parseCliOutput("claude-json", stream).text, "d2d4");
  });
});

describe("provedor CLI", () => {
  it("fica indisponível sem entradas e lista as configuradas", async () => {
    const empty = createCliProvider([]);
    const status = await empty.status();
    assert.equal(status.available, false);
    assert.match(status.reason ?? "", /arena\.config\.json/);

    const provider = createCliProvider([entry("text"), entry("json")]);
    assert.deepEqual(await provider.status(), { available: true, reason: null });
    assert.deepEqual(await provider.models(), [{ id: "fake-text", label: "Falsa text" }, { id: "fake-json", label: "Falsa json" }]);
    assert.equal(provider.id, "cli");
    assert.equal(provider.kind, "cli");
  });

  it("decide pela entrada escolhida e recusa id desconhecido", async () => {
    const provider = createCliProvider([entry("text")]);
    const context = opening();
    const ok = await provider.decide({ sessionId: "s", slot: 0, participant: { slot: 0, provider: "cli", modelId: "fake-text" }, context });
    assert.equal(ok.choiceId, "e2e4");
    const unknown = await provider.decide({ sessionId: "s", slot: 0, participant: { slot: 0, provider: "cli", modelId: "outra" }, context });
    assert.equal(unknown.choiceId, null);
    assert.equal(unknown.failureReason, "CLI não configurada");
  });
});
