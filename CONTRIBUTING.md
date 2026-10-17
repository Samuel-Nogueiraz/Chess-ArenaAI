# Contribuir

## Antes de abrir um PR

```bash
npm install
npm run check
```

`npm run check` é o mesmo comando do CI: typecheck, lint, testes, varredura de segredos e build demo. O PR precisa passar nele.

## Regras curtas

- Tipos e regras de xadrez vivem só em `packages/core`. Não duplique em `server` nem em `web`.
- Imports internos mantêm o sufixo `.js` (estilo NodeNext).
- Cor na web só via tokens em `web/src/styles.css`.
- Nenhuma chave, token ou valor de `.env` em código, teste, fixture ou doc.
- Teste acompanha mudança de comportamento. Em `web`, funções puras (`parse`, `format`, `view`, `matchups`) têm testes em `web/tests`.

O mapa do repositório e os invariantes de segurança estão em [AGENTS.md](AGENTS.md).
