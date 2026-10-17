// Roda um comando com variáveis de ambiente extras, igual em Windows, macOS e Linux.
// Uso: node scripts/with-env.mjs CHAVE=valor [OUTRA=valor] -- comando arg1 arg2
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 0 || split === argv.length - 1) {
  console.error("Uso: node scripts/with-env.mjs CHAVE=valor -- comando [args]");
  process.exit(2);
}

const extra = {};
for (const pair of argv.slice(0, split)) {
  const at = pair.indexOf("=");
  if (at < 1) {
    console.error(`Variável inválida: ${pair}`);
    process.exit(2);
  }
  extra[pair.slice(0, at)] = pair.slice(at + 1);
}

const [command, ...args] = argv.slice(split + 1);
const env = { ...process.env, ...extra };

/**
 * `npm` é um .cmd no Windows e só rodaria com shell, o que o Node desaconselha (DEP0190).
 * Dentro de um script npm, `npm_execpath` aponta para o npm-cli.js: rodamos ele com o próprio Node, sem shell.
 */
function resolveCommand() {
  if (command === "npm" && process.env.npm_execpath) {
    return { file: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { file: command, args };
}

const target = resolveCommand();
const child = spawn(target.file, target.args, { stdio: "inherit", env });
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
