import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, loadConfig } from "./config.js";
import { isLoopback, loadEnv, repoRoot, resolveListen } from "./env.js";
import { createApp } from "./http.js";
import { createCliProvider } from "./providers/cli.js";
import { createCursorProvider } from "./providers/cursor.js";
import { createDemoProvider } from "./providers/demo.js";
import { createJevProvider } from "./providers/jev.js";
import { createOpenAiProvider } from "./providers/openai.js";
import { createRegistry } from "./providers/registry.js";

function fail(message: string): never {
  console.error(`Erro: ${message}`);
  process.exit(1);
}

function main() {
  try {
    loadEnv();
  } catch (error) {
    fail(error instanceof Error ? error.message : "falha ao carregar o ambiente");
  }

  let listen: ReturnType<typeof resolveListen>;
  try {
    listen = resolveListen();
  } catch (error) {
    fail(error instanceof Error ? error.message : "endereço inválido");
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    fail(error instanceof ConfigError ? error.message : "falha ao ler arena.config.json");
  }

  const root = repoRoot();
  const registry = createRegistry([
    createDemoProvider(),
    createJevProvider(),
    createCursorProvider(),
    createCliProvider(config.cli),
    createOpenAiProvider(config.openai),
  ]);
  const app = createApp({
    registry,
    staticDir: resolve(root, "web/dist"),
    version: readVersion(root),
    localOnly: isLoopback(listen.host),
  });

  app.server.listen(listen.port, listen.host, () => {
    console.log(`Arena em http://${listen.host}:${listen.port}`);
    if (config.source) console.log(`Configuração: ${config.source}`);
    void registry.list().then((providers) => {
      for (const provider of providers) {
        console.log(`  ${provider.available ? "ok " : "-- "} ${provider.id}${provider.reason ? ` (${provider.reason})` : ""}`);
      }
    });
  });

  const shutdown = () => {
    app.close();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "server/package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main();
