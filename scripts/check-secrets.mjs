#!/usr/bin/env node
// Varre os arquivos versionaveis atras de padroes de chave e dos valores do .env local.
// Node puro, sem dependencias. Exit 1 se achar algo, 0 se limpo.
//
// Uso:
//   node scripts/check-secrets.mjs               varre o repositorio
//   node scripts/check-secrets.mjs --self-test   planta uma chave falsa num tmp e confirma a deteccao
//
// Nunca imprime a chave inteira: so arquivo:linha, o tipo e um trecho mascarado.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_ENV_VALUE = 12;
const ALWAYS_SKIP_DIRS = new Set(["node_modules", "dist", ".scratch", ".git"]);
const ALWAYS_SKIP_PREFIXES = ["server/.cache"];

/** Padroes de chave (secao 8 da spec). */
const PATTERNS = [
  { label: "sk-ant (Anthropic)", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: "sk- (OpenAI/compativel)", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { label: "key_ (token de API)", re: /\bkey_[A-Za-z0-9]{20,}/g },
  { label: "crsr_ (Cursor)", re: /\bcrsr_[A-Za-z0-9]{16,}/g },
  { label: "ghp_ (GitHub)", re: /\bghp_[A-Za-z0-9]{30,}/g },
  { label: "Bearer token", re: /\bBearer\s+([A-Za-z0-9._~+/=-]{24,})/g, group: 1 },
  { label: "AKIA (AWS)", re: /\bAKIA[0-9A-Z]{16}\b/g },
];

/** Mostra so o comeco; nunca o valor inteiro. */
function mask(value) {
  const head = value.slice(0, Math.min(4, Math.floor(value.length / 4)));
  return `${head}*** (${value.length} chars)`;
}

// ---------- .env ----------

function parseEnvValues(text) {
  const values = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (value.length >= MIN_ENV_VALUE) values.add(value);
  }
  return [...values];
}

function envFilePath(root) {
  const custom = process.env.ARENA_ENV_FILE;
  return custom ? resolve(custom) : join(root, ".env");
}

function loadEnvValues(root) {
  const path = envFilePath(root);
  if (!existsSync(path) || !statSync(path).isFile()) return { path: null, values: [] };
  return { path, values: parseEnvValues(readFileSync(path, "utf8")) };
}

// ---------- varredura de arquivo ----------

function looksBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}

/** Retorna achados { line, label, excerpt } de um arquivo. */
function scanFile(path, envValues) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size === 0 || size > MAX_BYTES) return [];
  const buffer = readFileSync(path);
  if (looksBinary(buffer)) return [];
  const findings = [];
  const lines = buffer.toString("utf8").split(/\r?\n/);
  lines.forEach((text, index) => {
    for (const { label, re, group } of PATTERNS) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) {
        findings.push({ line: index + 1, label, excerpt: mask(group ? match[group] : match[0]) });
      }
    }
    for (const value of envValues) {
      if (text.includes(value)) findings.push({ line: index + 1, label: "valor do .env", excerpt: mask(value) });
    }
  });
  return findings;
}

// ---------- lista de arquivos ----------

function gitFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((p) => join(root, p));
  } catch {
    return null;
  }
}

/** Glob do .gitignore -> RegExp. Suporta *, **, ? e classes simples. */
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        re += glob.slice(i, end + 1);
        i = end;
      } else re += "\\[";
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function parseGitignore(root) {
  const file = join(root, ".gitignore");
  if (!existsSync(file)) return [];
  const rules = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ negate, dirOnly, anchored, re: globToRegex(line) });
  }
  return rules;
}

function isIgnored(rules, relPath, isDir) {
  let ignored = false;
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const hit = rule.anchored ? rule.re.test(relPath) : rule.re.test(base);
    if (hit) ignored = !rule.negate;
  }
  return ignored;
}

function walkFiles(root) {
  const rules = parseGitignore(root);
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        if (ALWAYS_SKIP_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
        if (isIgnored(rules, rel, true)) continue;
        visit(abs);
      } else if (entry.isFile()) {
        if (isIgnored(rules, rel, false)) continue;
        out.push(abs);
      }
    }
  };
  visit(root);
  return out;
}

function listFiles(root) {
  const fromGit = gitFiles(root);
  const files = fromGit ?? walkFiles(root);
  return {
    source: fromGit ? "git" : "diretório",
    files: files.filter((abs) => {
      const rel = relative(root, abs).split(sep).join("/");
      const parts = rel.split("/");
      if (parts.some((p) => ALWAYS_SKIP_DIRS.has(p))) return false;
      if (ALWAYS_SKIP_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
      if (parts[parts.length - 1] === ".env.example") return false;
      return existsSync(abs);
    }),
  };
}

// ---------- execucao ----------

function run(root) {
  const { source, files } = listFiles(root);
  const env = loadEnvValues(root);
  const envAbs = env.path ? resolve(env.path) : null;
  let total = 0;
  for (const abs of files) {
    if (envAbs && resolve(abs) === envAbs) continue;
    for (const f of scanFile(abs, env.values)) {
      total++;
      const rel = relative(root, abs).split(sep).join("/");
      console.log(`${rel}:${f.line}  ${f.label}  ${f.excerpt}`);
    }
  }
  const envNote = env.path ? `${env.values.length} valor(es) do .env comparados` : "sem .env para comparar";
  if (total > 0) {
    console.error(`check-secrets: ${total} achado(s) em ${files.length} arquivo(s) [${source}; ${envNote}].`);
    return 1;
  }
  console.log(`check-secrets: limpo. ${files.length} arquivo(s) varridos [${source}; ${envNote}].`);
  return 0;
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "arena-secrets-"));
  try {
    // Montadas em tempo de execucao para este arquivo nao conter uma chave literal.
    const fakeKey = ["sk", "ant", "FAKE0123456789abcdefghijkl"].join("-");
    const fakeEnvValue = "valor-de-teste-" + "x".repeat(16);
    const target = join(dir, "exemplo.txt");
    writeFileSync(target, `linha limpa\nconst k = "${fakeKey}";\noutra: ${fakeEnvValue}\n`);
    const patternHits = scanFile(target, []);
    const envHits = scanFile(target, [fakeEnvValue]);
    const okPattern = patternHits.some((f) => f.line === 2 && f.label.startsWith("sk-ant"));
    const okEnv = envHits.some((f) => f.line === 3 && f.label === "valor do .env");
    const leaked = [...patternHits, ...envHits].some((f) => f.excerpt.includes(fakeKey) || f.excerpt.includes(fakeEnvValue));
    if (okPattern && okEnv && !leaked) {
      console.log("check-secrets --self-test: ok (padrão e valor de .env detectados, trecho mascarado).");
      return 0;
    }
    console.error(`check-secrets --self-test: FALHOU (padrão=${okPattern}, env=${okEnv}, vazou=${leaked}).`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const code = process.argv.includes("--self-test") ? selfTest() : run(ROOT);
process.exit(code);
