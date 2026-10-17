import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8780;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Raiz do repositório (server/src, dois níveis acima). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * Carrega o `.env` da raiz, ou o arquivo de `ARENA_ENV_FILE`. Variáveis já definidas no processo vencem.
 * Devolve o caminho carregado (nunca o conteúdo) ou null.
 */
export function loadEnv(env: Record<string, string | undefined> = process.env, root: string = repoRoot()): string | null {
  const chosen = env.ARENA_ENV_FILE?.trim();
  const path = chosen ? (isAbsolute(chosen) ? chosen : resolve(root, chosen)) : resolve(root, ".env");
  if (!existsSync(path)) {
    if (chosen) throw new Error(`ARENA_ENV_FILE aponta para um arquivo que não existe: ${path}`);
    return null;
  }
  loadEnvFile(path);
  return path;
}

export interface Listen {
  host: string;
  port: number;
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

/** `ARENA_HOST`/`ARENA_PORT` (com `CHESS_API_PORT` como apelido antigo). Recusa host remoto sem `ARENA_ALLOW_REMOTE=1`. */
export function resolveListen(env: Record<string, string | undefined> = process.env): Listen {
  const host = env.ARENA_HOST?.trim() || DEFAULT_HOST;
  if (!isLoopback(host) && env.ARENA_ALLOW_REMOTE !== "1") {
    throw new Error(
      `ARENA_HOST=${host} expõe a arena fora desta máquina. Use 127.0.0.1 ou defina ARENA_ALLOW_REMOTE=1 para aceitar o risco.`,
    );
  }
  const rawPort = env.ARENA_PORT?.trim() || env.CHESS_API_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Porta inválida: ${rawPort}. Use um inteiro entre 1 e 65535.`);
  }
  return { host, port };
}
