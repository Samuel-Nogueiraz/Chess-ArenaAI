import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export const NOT_BUILT_MESSAGE =
  "A interface ainda não foi compilada. Rode `npm run build` (e depois `npm start`) ou use `npm run dev`.\n";

export type StaticHandler = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>;

/** Serve a pasta compilada da web, com fallback de SPA para `index.html`. */
export function createStaticHandler(dir: string): StaticHandler {
  const root = resolve(dir);
  return async (req, res, pathname) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      text(res, 405, "Método não permitido.\n");
      return;
    }
    const index = join(root, "index.html");
    if (!(await isFile(index))) {
      text(res, 404, NOT_BUILT_MESSAGE);
      return;
    }
    let target = index;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      text(res, 400, "Caminho inválido.\n");
      return;
    }
    if (decoded.includes("\0")) {
      text(res, 400, "Caminho inválido.\n");
      return;
    }
    const candidate = resolve(root, `.${normalize(`/${decoded}`)}`);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      text(res, 403, "Acesso negado.\n");
      return;
    }
    if (candidate !== root && (await isFile(candidate))) {
      target = candidate;
    } else if (extname(decoded) !== "") {
      // Pedido de arquivo que não existe: não responder com a página.
      text(res, 404, "Arquivo não encontrado.\n");
      return;
    }
    const hashed = target.startsWith(join(root, "assets") + sep);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(target).on("error", () => res.destroy()).pipe(res);
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
