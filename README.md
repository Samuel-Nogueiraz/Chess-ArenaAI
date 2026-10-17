# JEV Chess Arena

[![CI](https://github.com/samuel-nogueiraz/Chess-ArenaAI/actions/workflows/ci.yml/badge.svg)](https://github.com/samuel-nogueiraz/Chess-ArenaAI/actions/workflows/ci.yml)
[![Pages](https://github.com/samuel-nogueiraz/Chess-ArenaAI/actions/workflows/pages.yml/badge.svg)](https://github.com/samuel-nogueiraz/Chess-ArenaAI/actions/workflows/pages.yml)

**Demo online:** https://samuel-nogueiraz.github.io/Chess-ArenaAI/

> **In English.** JEV Chess Arena pits AI models against each other in real chess games: real rules, a real clock, per-move latency and token cost. It runs with no API keys in a browser-only demo mode (simulated decisions and metrics, real chess), and locally with real providers (JEV/TypeSafe API, any agent CLI such as Claude Code, Codex, Gemini or Cursor Agent, and any OpenAI-compatible API). Keys live only in a local `.env`; the server binds to `127.0.0.1` and never returns them. This is a demonstration prototype.

## O que é

Uma arena em que dois participantes (modelos de IA, CLIs de agente ou um motor simulado) jogam xadrez de verdade: regras reais, relógio real, latência e custo por lance, resultado e análise da partida. O foco é comparar provedores sob as mesmas condições.

Duas formas de rodar:

| Modo | Chaves | Onde roda | Decisões e métricas |
|---|---|---|---|
| **Demo** | nenhuma | tudo no navegador (é o que vai ao GitHub Pages) | simuladas; o xadrez e o relógio são reais |
| **Local** | no `.env` da sua máquina | servidor em `127.0.0.1` + navegador | reais, dos provedores que você configurar |

A tela mostra sempre o selo do modo: **DEMO · dados simulados, sem chaves** ou **LOCAL · chaves só no servidor**.

## Início rápido

```bash
git clone https://github.com/samuel-nogueiraz/Chess-ArenaAI.git && cd Chess-ArenaAI
npm install
npm run dev
```

Abra http://localhost:5173. Sem `.env`, só o provedor demo aparece e uma partida vai até o fim com tela de resultado e análise. Requer Node 22.

Só o modo demo, sem servidor: `npm run demo`.

## Modo local com provedores reais

```bash
cp .env.example .env                              # preencha só o que for usar
cp arena.config.example.json arena.config.json    # CLIs e APIs OpenAI-compatíveis
npm run dev
```

Em modo local o seletor lista todos os provedores; os que faltam configuração aparecem desabilitados com o motivo (por exemplo, `TYPESAFE_API_KEY ausente`).

## Provedores

| Provedor | Tipo | Disponível quando |
|---|---|---|
| `demo` | simulado | sempre |
| `jev` (TypeSafe API) | API | `TYPESAFE_API_KEY` presente |
| `cursor` | SDK | `CURSOR_API_KEY` presente e `@cursor/sdk` instalado (opcional) |
| `cli` | processo local | `arena.config.json` tem entradas em `cli` (Claude Code, Codex, Gemini CLI, Cursor Agent CLI…) |
| `openai` | API compatível | `arena.config.json` tem entradas em `openai` e a variável de chave existe (OpenAI, OpenRouter, Ollama, LM Studio…) |

Como configurar cada um, com exemplos: [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Segurança

- Nenhuma chave no repositório. `.env`, `arena.config.json`, `server/.cache/` e `.scratch/` são ignorados pelo git.
- O servidor escuta só em `127.0.0.1`; outro endereço exige `ARENA_ALLOW_REMOTE=1` explícito.
- Nenhuma resposta HTTP contém valor de variável de ambiente, e o export de partida é sanitizado.
- O build do GitHub Pages é só-demo e não chama `/api`.
- `npm run check:secrets` varre os arquivos versionáveis atrás de padrões de chave e dos valores do seu `.env`; roda no CI.
- Prompts vão para CLIs por stdin, nunca na linha de comando.

## Scripts

| Script | Faz |
|---|---|
| `npm run dev` | servidor (8780) + Vite (5173) |
| `npm run demo` | só o Vite em modo demo, sem servidor |
| `npm start` | servidor em 8780 servindo `web/dist` + `/api` |
| `npm run build` | build da web (modo automático) |
| `npm run build:demo` | build estático só-demo (Pages); aceita `VITE_BASE` |
| `npm test` | testes de `packages/core`, `server` e `web` (node:test) |
| `npm run typecheck` | `tsc --noEmit` nos três workspaces |
| `npm run lint` | ESLint (TypeScript + regras de hooks do React) |
| `npm run check:secrets` | procura chaves nos arquivos versionáveis |
| `npm run check` | typecheck + lint + test + check:secrets + build:demo (o mesmo do CI) |

## Estrutura

```
Chess-ArenaAI/
├─ packages/core/   @arena/core: tipos, regras, sessão, custo, prompt, provedor demo (TS puro)
├─ server/          @arena/server: HTTP local, registro de provedores, Stockfish, CLI, OpenAI-compatível
├─ web/             @arena/web: React 19 + Vite, cliente demo ou HTTP; testes puros em tests/
├─ docs/            SPEC, ARCHITECTURE, PROVIDERS
├─ scripts/         check-secrets.mjs, dev.mjs, with-env.mjs
├─ .github/         workflows de CI e Pages
├─ .env.example  arena.config.example.json  eslint.config.js
└─ AGENTS.md  CLAUDE.md  CONTRIBUTING.md  SECURITY.md  LICENSE
```

Arquitetura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Spec: [docs/SPEC.md](docs/SPEC.md). Como contribuir: [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilidades: [SECURITY.md](SECURITY.md).

## Publicar no GitHub Pages

O workflow `pages.yml` roda a cada push na `main`: `npm run build:demo` com `VITE_BASE=/<nome-do-repo>/` e deploy de `web/dist`. Em Settings > Pages, escolha **GitHub Actions** como fonte.

## Licença

[MIT](LICENSE).
