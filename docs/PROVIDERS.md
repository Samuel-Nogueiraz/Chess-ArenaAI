# Provedores

Em modo local a arena lê dois arquivos, ambos ignorados pelo git:

- `.env`: chaves (copie de `.env.example`).
- `arena.config.json`: CLIs e APIs OpenAI-compatíveis (copie de `arena.config.example.json`; o caminho pode mudar com `ARENA_CONFIG`).

O seletor mostra cada provedor com o motivo quando indisponível. Reinicie o servidor depois de editar os arquivos.

> **Confira as flags das CLIs com a versão instalada.** Nomes de flags, formatos de saída e modos não interativos mudam entre versões. Os exemplos abaixo são pontos de partida: rode `<cli> --help` e teste o comando à mão com um prompt curto antes de adicioná-lo.

## Provedores embutidos

| id | Disponível quando |
|---|---|
| `demo` | sempre; modelos `jev-demo`, `rival-greedy`, `rival-random`, tudo simulado |
| `jev` | `TYPESAFE_API_KEY` presente (modelo em `JEV_MODEL`) |
| `cursor` | `CURSOR_API_KEY` presente e `@cursor/sdk` instalado (dependência opcional) |

## CLI de agente (`cli`)

Cada entrada em `cli` roda um processo por decisão.

| Campo | Significado |
|---|---|
| `id`, `label` | identificador e rótulo na UI |
| `command`, `args` | executável e argumentos fixos |
| `input` | `"stdin"` (recomendado): o prompt vai pela entrada padrão. `"arg"`: substitui `{prompt}` num argumento; é recusado no Windows quando a execução exige shell |
| `output` | `"text"`: o `parseMoveId` procura o lance no stdout. `"claude-json"`: lê `result`, `usage` e `total_cost_usd` do JSON do Claude Code |
| `timeoutMs` | mata o processo e registra a falha de forma legível |

Se a resposta não for um lance legal, a arena faz uma correção (`buildCorrection`) antes de contar falha. No Windows, comandos `.cmd`/`.ps1` exigem `shell: true`; os `args` vêm do seu config local e o prompt nunca entra na linha de comando.

Custo: `claude-json` informa custo reportado; `text` fica como `unavailable`.

### Claude Code

```json
{
  "id": "claude-sonnet",
  "label": "Claude Code · Sonnet",
  "command": "claude",
  "args": ["-p", "--model", "sonnet", "--output-format", "json"],
  "input": "stdin",
  "output": "claude-json",
  "timeoutMs": 90000
}
```

### Codex

```json
{
  "id": "codex",
  "label": "Codex CLI",
  "command": "codex",
  "args": ["exec", "-"],
  "input": "stdin",
  "output": "text",
  "timeoutMs": 90000
}
```

### Gemini CLI

```json
{
  "id": "gemini",
  "label": "Gemini CLI",
  "command": "gemini",
  "args": [],
  "input": "stdin",
  "output": "text",
  "timeoutMs": 90000
}
```

Confira em `gemini --help` como a versão instalada recebe o prompt no modo não interativo e ajuste `args`.

### Cursor Agent CLI

```json
{
  "id": "cursor-agent",
  "label": "Cursor Agent CLI",
  "command": "cursor-agent",
  "args": ["-p", "--output-format", "text"],
  "input": "stdin",
  "output": "text",
  "timeoutMs": 120000
}
```

Faça login antes (`cursor-agent login`) e confira as flags em `cursor-agent --help`. Este caminho é independente do provedor `cursor` (SDK).

## API compatível com OpenAI (`openai`)

A arena chama `POST {baseUrl}/chat/completions` com mensagem de sistema e de usuário, `temperature: 0`, e lê `usage.prompt_tokens` e `usage.completion_tokens`. Serve para qualquer servidor que fale esse protocolo.

| Campo | Significado |
|---|---|
| `baseUrl` | raiz da API, incluindo `/v1` |
| `apiKeyEnv` | **nome** da variável do `.env` com a chave (o valor nunca vai no JSON) |
| `model` | id do modelo no provedor |
| `inputUsdPerMillion`, `outputUsdPerMillion` | tarifas opcionais; sem elas o custo fica `unavailable` |

A entrada só fica disponível se a variável de `apiKeyEnv` existir no ambiente.

### OpenRouter

```json
{
  "id": "openrouter-exemplo",
  "label": "OpenRouter · exemplo",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "model": "provider/model-id",
  "inputUsdPerMillion": 0,
  "outputUsdPerMillion": 0
}
```

Troque `model` por um id real do catálogo e ajuste as tarifas. Adicione `OPENROUTER_API_KEY=` ao `.env`.

### Ollama (local)

```json
{
  "id": "ollama-local",
  "label": "Ollama · local",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKeyEnv": "OLLAMA_API_KEY",
  "model": "llama3.1"
}
```

O Ollama ignora a chave, mas a variável precisa existir no `.env` com qualquer valor não vazio. Baixe o modelo antes (`ollama pull llama3.1`). LM Studio e similares seguem o mesmo molde com outra `baseUrl`.

### OpenAI

Ver a entrada `gpt-mini` em `arena.config.example.json` (`OPENAI_API_KEY`).

## Segurança

- Nunca coloque chaves em `arena.config.json`; use `apiKeyEnv`.
- `arena.config.json` e `.env` não vão para o git. `npm run check:secrets` confere antes do CI.
- Os `args` de CLI vêm do seu config e são executados na sua máquina: trate o arquivo como código.
