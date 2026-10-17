# JEV Chess Arena — Spec de reestruturação para GitHub

Data: 2026-10-15. Status: implementada em 2026-10-17 (lint, testes da web, licença MIT e remoção do `docs/archive/` vieram depois).

## 1. Objetivo

Levar a arena para um repositório público no GitHub como **protótipo de demonstração**:

1. Rodar sem nenhuma chave. O modo padrão é **demo**: partidas reais (regras de xadrez reais, relógio real), decisões e métricas simuladas, tudo no navegador. Esse modo vai para o GitHub Pages.
2. Rodar em **modo local** (`npm run dev`) com chaves que só existem no `.env` da máquina. O servidor escuta só em `127.0.0.1` e nunca devolve chave.
3. Deixar de depender do Cursor. O Cursor vira um provedor entre vários: JEV (TypeSafe API), qualquer CLI de agente (Claude Code, Codex, Gemini, Cursor Agent…), qualquer API compatível com OpenAI, e o provedor demo.
4. Trocar o design system para preto e azul ("Deep Blue").
5. Limpar o código: tipos e regras num só lugar, sem atalhos da apresentação antiga (Grok 4.7 High, Composer).

Fora de escopo: criar repositório remoto, publicar branch, push, licença (decisão do dono).

## 2. Estrutura

```
jev-chess-arena/
├─ package.json                 # npm workspaces: packages/core, server, web
├─ packages/core/               # @arena/core — TS puro, roda em Node e no browser
│  ├─ src/types.ts scenarios.ts engine.ts brief.ts cost.ts sanitize.ts
│  │      session.ts analysis.ts prompt.ts demo.ts heuristic-engine.ts index.ts
│  └─ tests/
├─ server/                      # @arena/server — HTTP local + provedores reais
│  ├─ src/index.ts http.ts env.ts config.ts stockfish.ts stockfish-host.cjs static.ts
│  ├─ src/providers/registry.ts jev.ts cursor.ts cli.ts openai.ts demo.ts
│  └─ tests/
├─ web/                         # @arena/web — React 19 + Vite
│  └─ src/client/{types,http,demo,index}.ts …
├─ docs/SPEC.md ARCHITECTURE.md PROVIDERS.md
├─ scripts/check-secrets.mjs dev.mjs
├─ .github/workflows/ci.yml pages.yml
├─ .env.example  arena.config.example.json
├─ AGENTS.md  CLAUDE.md  README.md  .gitignore
```

`@arena/core` é consumido como fonte TS (`"exports": { ".": "./src/index.ts" }`). O servidor roda com `tsx`; o Vite compila direto. Imports internos mantêm sufixo `.js` (estilo NodeNext), que tsx e Vite resolvem para `.ts`.

## 3. Scripts da raiz (contrato)

| Script | Faz |
|---|---|
| `npm install` | instala todos os workspaces |
| `npm run dev` | servidor (8780) + Vite (5173) juntos, via `scripts/dev.mjs` (sem dependência extra) |
| `npm run demo` | só o Vite em modo demo (`VITE_ARENA_MODE=demo`), sem servidor |
| `npm start` | servidor em 8780 servindo `web/dist` + `/api` |
| `npm run build` | build da web (modo automático) |
| `npm run build:demo` | build estático só-demo para o Pages (`VITE_ARENA_MODE=demo`, `VITE_BASE` opcional) |
| `npm test` | testes de `packages/core` e `server` (node:test via tsx) |
| `npm run typecheck` | `tsc --noEmit` nos três workspaces |
| `npm run check:secrets` | `node scripts/check-secrets.mjs` |
| `npm run check` | typecheck + test + check:secrets + build:demo |

## 4. Núcleo (`@arena/core`)

Sai de `server/src` para `packages/core/src`, sem dependência de Node: `types`, `scenarios`, `engine`, `brief`, `cost`, `sanitize`, `session`, `analysis`.

- `session.ts`: `randomUUID` de `node:crypto` vira `globalThis.crypto.randomUUID()`.
- `analysis.ts`: continua recebendo um `Engine`. O Stockfish fica no servidor.
- `prompt.ts` (novo): prompt de lance compartilhado por todos os provedores de LLM — `buildMovePrompt(context)`, `buildCorrection(context, answer)`, `parseMoveId(text, candidates)` (aceita resposta exata ou o primeiro token UCI `[a-h][1-8][a-h][1-8][qrbn]?` que esteja na lista). Reaproveita `brief.ts`. O Cursor pode manter o próprio prompt se os testes dele dependem do texto.
- `heuristic-engine.ts` (novo): `createHeuristicEngine({ depth })` implementa `Engine` com busca alfa-beta rasa (material + mobilidade leve + mate). `name: "heurística (demo)"`. Serve para a análise no modo demo.
- `demo.ts` (novo): `createDemoAdapter(options?)` implementa `DecisionAdapter` sem rede.

### Tipos

- `Provider` deixa de ser `"typesafe" | "cursor"` e vira `ProviderId = "demo" | "jev" | "cursor" | "cli" | "openai"`. `"typesafe"` é renomeado para `"jev"` em todo lugar (custo JEV = entradas com `provider === "jev"`).
- `mode` em `NormalizedDecision` e `HistoryEntry` passa a ser `"real" | "demo"`. O provedor demo grava `"demo"`.
- `CostNature` não muda. Demo usa `"estimated"`; a UI mostra a etiqueta **simulado** sempre que `mode === "demo"`.

### Provedor demo

Modelos (ids estáveis):

| id | rótulo | comportamento |
|---|---|---|
| `jev-demo` | JEV · simulado | mate em 1 se houver; senão alfa-beta profundidade 2 com material + mobilidade |
| `rival-greedy` | Rival guloso · simulado | captura a peça mais valiosa; senão lance aleatório |
| `rival-random` | Rival aleatório · simulado | lance legal aleatório |

- Determinístico: PRNG semeado por `sessionId + ply + slot`.
- Latência simulada real (aguarda de fato), faixa por modelo (JEV 250–700 ms, rivais 600–1800 ms), com `speed` opcional para testes (`speed: 0` = sem espera).
- Tokens: entrada ≈ `ceil(prompt.length / 4)`, saída 2–6. Custo estimado com tarifa ilustrativa por modelo, `costNature: "estimated"`.
- Respeita `budgetMs` (relógio): se a latência estourar, devolve como estouro, igual a um provedor real.

## 5. Servidor (`@arena/server`)

### Ambiente

`env.ts` carrega `.env` da raiz do repositório; se `ARENA_ENV_FILE` estiver definido, carrega esse arquivo. Variáveis:

```
ARENA_HOST=127.0.0.1        # não aceitar 0.0.0.0 sem ARENA_ALLOW_REMOTE=1
ARENA_PORT=8780
ARENA_CONFIG=./arena.config.json
TYPESAFE_API_KEY=
JEV_MODEL=jev-latest
CURSOR_API_KEY=
OPENAI_API_KEY=             # ou outro nome, referenciado em arena.config.json
```

### Registro de provedores

```ts
interface ProviderModule {
  id: ProviderId;
  label: string;                       // "JEV · TypeSafe API"
  kind: "demo" | "api" | "sdk" | "cli";
  status(): Promise<{ available: boolean; reason: string | null }>; // "TYPESAFE_API_KEY ausente"
  models(): Promise<Array<{ id: string; label: string }>>;
  decide(request: AdapterRequest): Promise<AdapterDecision>;
  openSession?(session: { sessionId: string; participants: Participant[] }): void;
  closeAll?(): void;
}
```

`createRegistry(modules)` monta um `DecisionAdapter` que despacha por `participant.provider` e recusa provedor indisponível com mensagem clara. Criar sessão com provedor indisponível → 400.

| Provedor | Disponível quando | Custo |
|---|---|---|
| `demo` | sempre | estimado (simulado) |
| `jev` | `TYPESAFE_API_KEY` presente | estimado pela tarifa JEV (como hoje) |
| `cursor` | `CURSOR_API_KEY` presente **e** `@cursor/sdk` importável (dependência opcional, import dinâmico) | como hoje (`reported`/`included`/`unavailable`) |
| `cli` | `arena.config.json` tem entradas em `cli` | do JSON da CLI se vier (`claude-json`), senão `unavailable` |
| `openai` | `arena.config.json` tem entradas em `openai` e a env de chave existe | estimado pelas tarifas do config, senão `unavailable` |

Cache local do Cursor: `server/.cache/cursor` (ignorado no git), no lugar de `.scratch/`.

### `arena.config.json` (ignorado no git; o exemplo é versionado)

```json
{
  "cli": [
    {
      "id": "claude-sonnet",
      "label": "Claude Code · Sonnet",
      "command": "claude",
      "args": ["-p", "--model", "sonnet", "--output-format", "json"],
      "input": "stdin",
      "output": "claude-json",
      "timeoutMs": 90000
    },
    {
      "id": "codex",
      "label": "Codex CLI",
      "command": "codex",
      "args": ["exec", "-"],
      "input": "stdin",
      "output": "text",
      "timeoutMs": 90000
    }
  ],
  "openai": [
    {
      "id": "gpt-mini",
      "label": "OpenAI · gpt-4.1-mini",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-4.1-mini",
      "inputUsdPerMillion": 0.4,
      "outputUsdPerMillion": 1.6
    }
  ]
}
```

CLI:
- `spawn` sem interpolar o prompt em linha de comando: o prompt vai por stdin (`input: "stdin"`). `input: "arg"` substitui `{prompt}` num argumento, e é recusado no Windows quando a execução exige shell.
- No Windows, comandos `.cmd`/`.ps1` exigem `shell: true`; os `args` vêm do config local (confiável), o prompt nunca entra na linha de comando nesse caso.
- `timeoutMs` mata o processo; falha vira `failureReason` legível.
- Parsers: `text` (usa `parseMoveId` no stdout) e `claude-json` (`result`, `usage.input_tokens`/`output_tokens`, `total_cost_usd` → `reported`, `duration_ms`).
- Uma correção (`buildCorrection`) se a resposta não for um id legal.

OpenAI-compatível: `POST {baseUrl}/chat/completions`, mensagens system + user de `prompt.ts`, `temperature: 0`, `usage.prompt_tokens`/`completion_tokens`, uma correção. Funciona com OpenAI, OpenRouter, Ollama, LM Studio etc.

### HTTP

| Rota | Resposta |
|---|---|
| `GET /api/health` | `{ ok: true, mode: "live", version }` |
| `GET /api/providers` | `{ providers: [{ id, label, kind, available, reason, models: [{ id, label }] }] }` |
| `POST /api/sessions` | como hoje, `provider` aceita os cinco ids |
| `GET/POST /api/sessions/:id[/decide|pause|resume|stop|restart|export|analysis]` | como hoje |
| `GET /*` | arquivos de `web/dist` se existir (SPA fallback para `index.html`); senão texto curto dizendo para rodar `npm run build` ou `npm run dev` |

`/api/models` sai. Nenhuma resposta leva valor de variável de ambiente.

### Testes

Todos os 47 testes atuais continuam passando (movidos para `packages/core/tests` ou `server/tests`, com `typesafe` → `jev`). Novos:
- demo: determinismo por semente, `jev-demo` acha mate em 1, só lances legais, respeita `budgetMs`.
- heurística: avalia mate e material com sinal certo.
- prompt: `parseMoveId` aceita exato, token embutido, recusa ilegal.
- cli: processo falso (script node) com saída `text` e `claude-json`; timeout.
- openai: `fetch` falso, uso e custo.
- registry/http: `/api/providers` sem chave nenhuma no corpo; sessão com provedor indisponível → 400.

## 6. Web (`@arena/web`)

### Cliente

```ts
interface ArenaClient {
  mode: "demo" | "live";
  providers(): Promise<ProvidersResponse>;
  createSession(input): Promise<SessionSnapshot>;
  getSession(id): Promise<SessionSnapshot>;
  decide(id, slot): Promise<DecideParse>;
  action(id, action: "pause" | "resume" | "stop" | "restart"): Promise<SessionSnapshot>;
  exportSession(id): Promise<unknown>;
  analysis(id): Promise<GameAnalysis>;
}
```

- `client/http.ts`: o `api.ts` atual adaptado.
- `client/demo.ts`: `createSessionStore(createDemoAdapter())` de `@arena/core` no navegador, análise com `createHeuristicEngine()`. Respostas passam por `JSON.parse(JSON.stringify(x))` e pelos mesmos `parse*` do HTTP.
- `client/index.ts`: `VITE_ARENA_MODE=demo` força demo. Sem isso, tenta `GET /api/health` (timeout 1,2 s): responde → live; falha → demo.
- Em live, o seletor mostra provedores indisponíveis desabilitados com o motivo.
- Saem `modelMatch.ts` e os atalhos Grok/Composer. Entram **confrontos rápidos** genéricos: os dois primeiros provedores disponíveis (demo: `JEV · simulado × Rival guloso`).
- Selo de modo sempre visível: **DEMO · dados simulados, sem chaves** ou **LOCAL · chaves só no servidor**.

### Build

`vite.config.ts`: `base: process.env.VITE_BASE ?? "/"`. `build:demo` gera `web/dist` que funciona aberto no GitHub Pages sem nenhuma chamada a `/api`.

## 7. Design system "Deep Blue" (preto e azul)

Referência: sala de controle de um torneio entre máquinas. Preto profundo, azul elétrico, linhas finas, números em mono. Nome em homenagem ao Deep Blue.

Tokens base (o agente de design pode refinar, mantendo o espírito):

```
--bg #04060A   --bg-elev #070B13   --surface #0B111D   --surface-2 #0F1726
--line rgba(110,150,255,.09)   --line-strong rgba(110,150,255,.18)
--text #E6ECF8  --dim #9DAAC4  --muted #6A7895
--blue-700 #1238C7  --blue-600 #1F4FFF  --blue-500 #3D6BFF  --blue-400 #6A90FF  --blue-300 #A3BEFF
--cyan #48D1FF (ao vivo / pensando)   --glow rgba(61,107,255,.35)
--danger #FF4D6A  --warn #FFB547
fontes: Space Grotesk (display), Inter (texto), JetBrains Mono (números)
raios: 6 / 10 / 14 / pill
```

Regras:
- Tudo em `web/src/styles.css` via tokens em `:root`; nenhum hex solto fora dele.
- Tabuleiro azul: casas escuras e claras em dois azuis-noite, peças com contraste ≥ 3:1 nas duas cores de casa, último lance em azul com brilho, foco de teclado visível.
- Layout "versus": participante branco | tabuleiro | participante preto no desktop; empilhado no celular, sem rolagem horizontal a 360 px.
- Indicador de "pensando" em ciano no participante da vez. Movimento só sutil (transições curtas), e nada se `prefers-reduced-motion`.
- Tela de resultado com o mesmo sistema; destaque do custo JEV mantido.
- Favicon SVG (cavalo em quadrado azul).

## 8. Segurança (invariantes)

1. Nenhuma chave no repositório: `.env`, `arena.config.json`, `server/.cache/`, `.scratch/`, `node_modules/`, `dist/` no `.gitignore`.
2. Servidor só em `127.0.0.1`, salvo `ARENA_ALLOW_REMOTE=1` explícito.
3. Nenhuma resposta HTTP contém valor de variável de ambiente; export continua sanitizado (teste).
4. Build do Pages é só-demo: não referencia `/api`.
5. `scripts/check-secrets.mjs` varre os arquivos versionáveis (respeitando `.gitignore`) atrás de padrões de chave (`sk-…`, `sk-ant-…`, `key_…`, `crsr_…`, `ghp_…`, `Bearer <token longo>`, `AKIA…`) e dos valores do `.env` local se existir; sai com código 1 se achar. Roda no CI.

## 9. Repositório

- `README.md` (português, com um parágrafo em inglês no topo): o que é, demo online (link do Pages a preencher), início rápido em 3 comandos, modos, provedores, segurança, scripts, estrutura.
- `AGENTS.md`: mapa curto e agnóstico de agente (comandos de prova, onde fica o quê, invariantes de segurança). `CLAUDE.md` só aponta para `@AGENTS.md`. Sem `.cursor/` obrigatório.
- `docs/ARCHITECTURE.md` (diagrama do fluxo de decisão), `docs/PROVIDERS.md` (como plugar CLI/API).
- `docs/archive/` foi removido antes da publicação: o protótipo antigo referenciava recursos internos.
- CI (`ci.yml`): Node 22, `npm ci`, `npm run check`. Pages (`pages.yml`): em push na `main`, `build:demo` com `VITE_BASE=/<repo>/` e deploy com `actions/deploy-pages`.

## 10. Aceite

1. `npm install && npm run check` passa do zero.
2. `npm run dev` abre a arena em `http://localhost:5173`; sem `.env`, só o provedor demo aparece e uma partida demo vai até o fim com tela de resultado e análise.
3. Com `.env` válido, JEV e os demais aparecem como disponíveis.
4. `npm run build:demo` + servir `web/dist` estático funciona sem servidor.
5. `check:secrets` passa e acusa uma chave falsa plantada num arquivo de teste temporário.
6. Visual preto e azul em 1440 px e 360 px.
