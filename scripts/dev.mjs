// Sobe o servidor (ARENA_PORT, padrão 8780) e o Vite (5173) juntos. Ctrl+C derruba os dois.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lê só o valor de ARENA_PORT do .env, para o proxy do Vite apontar para a mesma porta. Nada é impresso. */
function portFromEnvFile() {
  const chosen = process.env.ARENA_ENV_FILE?.trim();
  const file = chosen ? (isAbsolute(chosen) ? chosen : resolve(root, chosen)) : join(root, ".env");
  if (!existsSync(file)) return null;
  const match = readFileSync(file, "utf8").match(/^\s*ARENA_PORT\s*=\s*["']?(\d+)["']?\s*$/m);
  return match ? match[1] : null;
}

const port = process.env.ARENA_PORT?.trim() || process.env.CHESS_API_PORT?.trim() || portFromEnvFile() || "8780";
const env = { ...process.env, ARENA_PORT: port, CHESS_API_PORT: port };

/** Acha o executável do Vite sem depender de shell (o npm instala o Vite em web/node_modules ou na raiz). */
function findViteBin() {
  for (const base of [join(root, "web", "node_modules", "vite"), join(root, "node_modules", "vite")]) {
    const manifest = join(base, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vite;
    if (bin) return join(base, bin);
  }
  console.error("[dev] Vite não encontrado. Rode `npm install` na raiz.");
  process.exit(1);
}

const viteBin = findViteBin();

const children = [
  { name: "servidor", child: spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: join(root, "server"), env, stdio: "inherit" }) },
  { name: "web", child: spawn(process.execPath, [viteBin], { cwd: join(root, "web"), env, stdio: "inherit" }) },
];

let stopping = false;
let exitCode = 0;

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

for (const { name, child } of children) {
  child.on("error", (error) => {
    console.error(`[dev] ${name} não iniciou: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) console.error(`[dev] ${name} encerrou (código ${code ?? "?"}).`);
    stop(code ?? 1);
    if (children.every(({ child: other }) => other.exitCode !== null || other.signalCode !== null)) process.exit(exitCode);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
