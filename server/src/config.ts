import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { repoRoot } from "./env.js";

export type CliInput = "stdin" | "arg";
export type CliOutput = "text" | "claude-json";

export interface CliEntry {
  id: string;
  label: string;
  command: string;
  args: string[];
  input: CliInput;
  output: CliOutput;
  timeoutMs: number;
}

export interface OpenAiEntry {
  id: string;
  label: string;
  baseUrl: string;
  /** Nome da variável de ambiente com a chave. Sem ele, a chamada vai sem Authorization (Ollama, LM Studio). */
  apiKeyEnv?: string;
  model: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  timeoutMs: number;
}

export interface ArenaConfig {
  cli: CliEntry[];
  openai: OpenAiEntry[];
  /** Caminho do arquivo lido, ou null se não existia. */
  source: string | null;
}

export class ConfigError extends Error {}

export const DEFAULT_CLI_TIMEOUT_MS = 90_000;
export const DEFAULT_OPENAI_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emptyConfig(): ArenaConfig {
  return { cli: [], openai: [], source: null };
}

/** `ARENA_CONFIG` ou `./arena.config.json` na raiz do repositório. Arquivo padrão ausente = config vazia. */
export function loadConfig(env: Record<string, string | undefined> = process.env, root: string = repoRoot()): ArenaConfig {
  const chosen = env.ARENA_CONFIG?.trim();
  const path = chosen ? (isAbsolute(chosen) ? chosen : resolve(root, chosen)) : resolve(root, "arena.config.json");
  if (!existsSync(path)) {
    if (chosen) throw new ConfigError(`ARENA_CONFIG aponta para um arquivo que não existe: ${path}`);
    return emptyConfig();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`${path} não é um JSON válido.`);
  }
  return { ...parseConfig(raw), source: path };
}

export function parseConfig(raw: unknown): ArenaConfig {
  if (!isRecord(raw)) throw new ConfigError("arena.config.json deve ser um objeto.");
  const cli = list(raw.cli, "cli").map((item, index) => parseCli(item, `cli[${index}]`));
  const openai = list(raw.openai, "openai").map((item, index) => parseOpenAi(item, `openai[${index}]`));
  unique(cli.map((entry) => entry.id), "cli");
  unique(openai.map((entry) => entry.id), "openai");
  return { cli, openai, source: null };
}

function parseCli(item: unknown, where: string): CliEntry {
  if (!isRecord(item)) throw new ConfigError(`${where}: esperado um objeto.`);
  const id = text(item.id, `${where}.id`);
  if (!ID.test(id)) throw new ConfigError(`${where}.id: use letras, números, ponto, hífen ou sublinhado.`);
  const command = text(item.command, `${where}.command`);
  const args = item.args === undefined ? [] : item.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new ConfigError(`${where}.args: esperado uma lista de textos.`);
  }
  const input = item.input === undefined ? "stdin" : item.input;
  if (input !== "stdin" && input !== "arg") throw new ConfigError(`${where}.input: use "stdin" ou "arg".`);
  const output = item.output === undefined ? "text" : item.output;
  if (output !== "text" && output !== "claude-json") throw new ConfigError(`${where}.output: use "text" ou "claude-json".`);
  if (input === "arg" && !(args as string[]).some((arg) => arg.includes("{prompt}"))) {
    throw new ConfigError(`${where}.args: com input "arg" algum argumento precisa conter {prompt}.`);
  }
  return {
    id,
    label: label(item.label, id, where),
    command,
    args: args as string[],
    input,
    output,
    timeoutMs: timeout(item.timeoutMs, DEFAULT_CLI_TIMEOUT_MS, where),
  };
}

function parseOpenAi(item: unknown, where: string): OpenAiEntry {
  if (!isRecord(item)) throw new ConfigError(`${where}: esperado um objeto.`);
  const id = text(item.id, `${where}.id`);
  if (!ID.test(id)) throw new ConfigError(`${where}.id: use letras, números, ponto, hífen ou sublinhado.`);
  const baseUrl = text(item.baseUrl, `${where}.baseUrl`).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError(`${where}.baseUrl: URL inválida.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${where}.baseUrl: use http ou https.`);
  }
  const apiKeyEnv = item.apiKeyEnv === undefined ? undefined : text(item.apiKeyEnv, `${where}.apiKeyEnv`);
  if (apiKeyEnv !== undefined && !ENV_NAME.test(apiKeyEnv)) {
    throw new ConfigError(`${where}.apiKeyEnv: informe o NOME da variável, não a chave.`);
  }
  return {
    id,
    label: label(item.label, id, where),
    baseUrl,
    apiKeyEnv,
    model: text(item.model, `${where}.model`),
    inputUsdPerMillion: rate(item.inputUsdPerMillion, `${where}.inputUsdPerMillion`),
    outputUsdPerMillion: rate(item.outputUsdPerMillion, `${where}.outputUsdPerMillion`),
    timeoutMs: timeout(item.timeoutMs, DEFAULT_OPENAI_TIMEOUT_MS, where),
  };
}

function list(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`"${name}" deve ser uma lista.`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${where}: esperado um texto não vazio.`);
  return value.trim();
}

function label(value: unknown, fallback: string, where: string): string {
  return value === undefined ? fallback : text(value, `${where}.label`);
}

function rate(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${where}: esperado um número maior ou igual a zero.`);
  }
  return value;
}

function timeout(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(`${where}.timeoutMs: use entre 100 e ${MAX_TIMEOUT_MS}.`);
  }
  return Math.round(value);
}

function unique(ids: string[], name: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ConfigError(`"${name}": id repetido "${id}".`);
    seen.add(id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
