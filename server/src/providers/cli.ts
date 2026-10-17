import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  buildCorrection,
  buildStandalonePrompt,
  MOVE_SYSTEM_PROMPT,
  type AdapterDecision,
  type DecisionContext,
} from "@arena/core";
import type { CliEntry } from "../config.js";
import { askWithCorrection, type TextAttempt } from "./loop.js";
import type { ProviderModule } from "./registry.js";
import { failedDecision, finite } from "./util.js";

const OUTPUT_LIMIT = 1_000_000;
const STDERR_SHOWN = 300;
/** Chaves da arena que um agente externo não precisa herdar. */
const HIDDEN_ENV = ["TYPESAFE_API_KEY", "CURSOR_API_KEY"];

type Spawn = typeof nodeSpawn;

export interface CliRunDeps {
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  env?: Record<string, string | undefined>;
}

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Preenchido se o processo nem chegou a iniciar ou se a execução foi recusada. */
  error: string | null;
  durationMs: number;
}

/**
 * No Windows, `.cmd`/`.bat`/`.ps1` (e comandos sem extensão, que são shims npm) só rodam com shell.
 * `.exe` e `.com` rodam direto.
 */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  return !/\.(exe|com)$/i.test(command.trim());
}

/** Aspas para cmd.exe. Só para `command`/`args` que vêm do config local (confiável); o prompt nunca passa por aqui. */
export function quoteForShell(value: string): string {
  if (value !== "" && !/[\s"&|<>^%()]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function runCli(entry: CliEntry, prompt: string, deps: CliRunDeps = {}): Promise<CliRun> {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? nodeSpawn;
  const shell = needsShell(entry.command, platform);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const refuse = (error: string): Promise<CliRun> =>
    Promise.resolve({ stdout: "", stderr: "", code: null, timedOut: false, error, durationMs: 0 });

  let args = entry.args;
  if (entry.input === "arg") {
    if (shell) {
      return refuse('input "arg" não é aceito quando a execução exige shell (Windows com .cmd); use input "stdin"');
    }
    args = args.map((arg) => arg.split("{prompt}").join(prompt));
  }
  const env = { ...(deps.env ?? process.env) };
  for (const name of HIDDEN_ENV) delete env[name];

  return new Promise<CliRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = shell
        ? spawn(quoteForShell(entry.command), args.map(quoteForShell), { shell: true, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(entry.command, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ stdout: "", stderr: "", code: null, timedOut: false, error: "não foi possível iniciar o comando", durationMs: elapsed() });
      return;
    }

    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (patch: Partial<CliRun>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut: false, error: null, durationMs: elapsed(), ...patch });
    };
    const timer = setTimeout(() => {
      killTree(child, platform);
      finish({ timedOut: true });
    }, entry.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ error: error.code === "ENOENT" ? "comando não encontrado" : "não foi possível iniciar o comando" });
    });
    child.on("close", (code) => finish({ code }));
    child.stdin?.on("error", () => undefined);
    if (entry.input === "stdin") child.stdin?.end(prompt);
    else child.stdin?.end();
  });
}

function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  try {
    if (platform === "win32" && child.pid != null) {
      nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    }
    child.kill("SIGKILL");
  } catch {
    // O processo já saiu.
  }
}

export interface ParsedCli {
  text: string | null;
  failureReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costNature: "reported" | "unavailable";
  sdkDurationMs: number | null;
  modelReturned: string | null;
}

/** Interpreta a saída da CLI segundo `entry.output`. */
export function parseCliOutput(output: CliEntry["output"], stdout: string): ParsedCli {
  const base: ParsedCli = {
    text: null,
    failureReason: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costNature: "unavailable",
    sdkDurationMs: null,
    modelReturned: null,
  };
  if (output === "text") return { ...base, text: stdout };

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ...base, failureReason: "resposta inválida" };
  }
  const root = Array.isArray(json) ? [...json].reverse().find((item) => isRecord(item) && item.type === "result") : json;
  if (!isRecord(root)) return { ...base, failureReason: "resposta inválida" };
  const usage = isRecord(root.usage) ? root.usage : {};
  const cost = finite(root.total_cost_usd);
  const models = isRecord(root.modelUsage) ? Object.keys(root.modelUsage) : [];
  const parsed: ParsedCli = {
    ...base,
    inputTokens: finite(usage.input_tokens),
    outputTokens: finite(usage.output_tokens),
    costUsd: cost,
    costNature: cost == null ? "unavailable" : "reported",
    sdkDurationMs: finite(root.duration_ms),
    modelReturned: models[0] ?? null,
  };
  if (root.is_error === true) return { ...parsed, failureReason: "execução com erro" };
  if (typeof root.result !== "string") return { ...parsed, failureReason: "resposta inválida" };
  return { ...parsed, text: root.result };
}

export async function askCli(
  context: DecisionContext,
  entry: CliEntry,
  deps: CliRunDeps & { budgetMs?: number | null } = {},
): Promise<AdapterDecision> {
  const prompt = buildStandalonePrompt(context);
  return askWithCorrection({
    context,
    prompt,
    budgetMs: deps.budgetMs,
    correction: (ctx, answer) => `${MOVE_SYSTEM_PROMPT}\n\n${buildCorrection(ctx, answer)}`,
    async ask(text): Promise<TextAttempt> {
      const run = await runCli(entry, text, deps);
      const failed = (failureReason: string, rawResponse: unknown = null): TextAttempt => ({
        text: null,
        failureReason,
        durationMs: run.durationMs,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        costNature: "unavailable",
        modelReturned: null,
        rawResponse,
      });
      if (run.error) return failed(run.error);
      if (run.timedOut) return failed("tempo esgotado");
      if (run.code !== 0) {
        return failed(`a CLI saiu com código ${run.code ?? "desconhecido"}`, { stderr: run.stderr.trim().slice(0, STDERR_SHOWN) });
      }
      const parsed = parseCliOutput(entry.output, run.stdout);
      if (parsed.failureReason || parsed.text == null) {
        return { ...failed(parsed.failureReason ?? "resposta inválida"), inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens };
      }
      return {
        text: parsed.text,
        failureReason: null,
        durationMs: run.durationMs,
        sdkDurationMs: parsed.sdkDurationMs,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        costUsd: parsed.costUsd,
        costNature: parsed.costNature,
        modelReturned: parsed.modelReturned ?? entry.id,
        rawResponse: { output: entry.output, result: parsed.text.trim().slice(0, 200) },
      };
    },
  });
}

export function createCliProvider(entries: CliEntry[], deps: CliRunDeps = {}): ProviderModule {
  return {
    id: "cli",
    label: "CLI de agente",
    kind: "cli",
    strictModels: true,
    async status() {
      return entries.length > 0
        ? { available: true, reason: null }
        : { available: false, reason: 'nenhuma entrada "cli" em arena.config.json' };
    },
    async models() {
      return entries.map((entry) => ({ id: entry.id, label: entry.label }));
    },
    decide(request) {
      const entry = entries.find((item) => item.id === request.participant.modelId);
      if (!entry) return Promise.resolve(failedDecision(request.context.objective, "CLI não configurada"));
      return askCli(request.context, entry, { ...deps, budgetMs: request.budgetMs ?? null });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
