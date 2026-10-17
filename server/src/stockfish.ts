import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUciScore, type Engine, type EngineScore } from "@arena/core";

const HOST = join(dirname(fileURLToPath(import.meta.url)), "stockfish-host.cjs");

export function createStockfish(depth = 12, timeoutMs = 30_000): Engine & { close(): void } {
  let child: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let onLine: ((line: string | null) => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function boot(): Promise<void> {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => {
      const proc = fork(HOST, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child = proc;
      proc.on("message", (message) => {
        const line = String(message);
        if (line === "hostready") resolve();
        else onLine?.(line);
      });
      proc.on("error", reject);
      proc.on("exit", () => {
        child = null;
        ready = null;
        reject(new Error("Stockfish encerrou antes de iniciar."));
        onLine?.(null);
      });
    });
    return ready;
  }

  function search(fen: string): Promise<EngineScore> {
    return new Promise((resolve, reject) => {
      let score: { cp: number | null; mate: number | null } = { cp: null, mate: null };
      const timer = setTimeout(() => {
        onLine = null;
        child?.kill();
        reject(new Error("Stockfish não respondeu a tempo."));
      }, timeoutMs);
      onLine = (line) => {
        if (line == null) {
          clearTimeout(timer);
          onLine = null;
          reject(new Error("Stockfish encerrou durante a análise."));
          return;
        }
        score = parseUciScore(line) ?? score;
        const best = line.match(/^bestmove (\S+)/);
        if (!best) return;
        clearTimeout(timer);
        onLine = null;
        resolve({ ...score, bestMove: best[1] === "(none)" ? null : best[1] ?? null });
      };
      child?.send(`position fen ${fen}`);
      child?.send(`go depth ${depth}`);
    });
  }

  return {
    name: "Stockfish 19 Lite",
    depth,
    evaluate(fen) {
      const job = queue.then(async () => {
        await boot();
        return search(fen);
      });
      queue = job.catch(() => undefined);
      return job;
    },
    close() {
      child?.kill();
      child = null;
      ready = null;
    },
  };
}
