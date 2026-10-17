# Segurança

## Reportar uma vulnerabilidade

Use **Security > Report a vulnerability** no GitHub (relato privado). Não abra issue pública com detalhes de exploração.

Inclua: versão ou commit, passos para reproduzir e impacto. A resposta inicial sai em até 7 dias.

## O que o projeto garante

- Nenhuma chave no repositório. `.env` e `arena.config.json` são ignorados pelo git e `npm run check:secrets` roda no CI.
- O servidor local escuta só em `127.0.0.1` e recusa `Host`/`Origin` que não sejam da própria máquina.
- Nenhuma resposta HTTP contém valor de variável de ambiente. O export de partida é sanitizado.
- Prompts vão para CLIs por stdin, nunca pela linha de comando.
- O build do GitHub Pages é só-demo e não chama `/api`.

## Fora de escopo

- Expor o servidor com `ARENA_ALLOW_REMOTE=1`. Essa flag existe para quem aceita o risco.
- Vulnerabilidades nas CLIs ou APIs de terceiros configuradas em `arena.config.json`.
