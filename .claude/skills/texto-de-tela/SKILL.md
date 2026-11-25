---
name: texto-de-tela
description: "Como pôr, mudar ou remover texto que a usuária lê na tela: a chave entra nos 10 idiomas de client/src/i18n/locales/ no mesmo commit, editando arquivo por arquivo, e node scripts/conferir-locales.mjs precisa passar. Use ao mexer em qualquer texto visível do client."
paths:
  - "client/src/**/*.tsx"
  - "client/src/i18n/locales/*.json"
allowed-tools:
  - "Bash(node scripts/conferir-locales.mjs)"
  - "Bash(pnpm vitest run *)"
  - "Bash(pnpm check)"
---

**Nuvem × computador.** Igual nos dois, menos o passo 7: o smoke das telas só dá para fazer no computador (Windows: Git Bash e, uma vez por computador, `pnpm config set script-shell "C:\\Program Files\\Git\\bin\\bash.exe"`), com `pnpm dev` e banco local. Antes do `pnpm dev`, confirme que o `DATABASE_URL` do `.env` aponta para banco local, sem mostrar o valor (o aviso de início de sessão diz a classe: local, Aiven ou remoto); se não for local, pare e pergunte. Na nuvem, escreva "smoke não feito" na PR.

1. **Nada de texto fixo em JSX.** Use `const { t } = useTranslation()` e `t("area.chave")`. A exceção é `AdminPanel`, `PresidentPanel` e `LegalPage`, que seguem em pt-BR fixo: traduzi-los é o cartão F1, não misture com outra tarefa.
2. **Os 10 arquivos** de `client/src/i18n/locales/`: `pt-BR.json`, `en.json`, `es.json`, `fr.json`, `de.json`, `ru.json`, `hi.json`, `ar.json`, `zh.json` e `ja.json`. Cada um tem de 120 a 226 KB e cerca de 2.500 linhas, com as chaves na mesma ordem. **Não leia nenhum inteiro:** ache uma chave vizinha com Grep (`"chaveVizinha"`, com número de linha), leia só aquele trecho e faça a mesma edição com Edit, arquivo por arquivo, usando a vizinha como âncora.
3. **Tradução de verdade** em cada idioma, não cópia do pt-BR. Texto jurídico ou comercial leva "revisar tradução" na PR, com a lista das chaves.
4. **Remover ou renomear** uma chave: nos 10 arquivos, no mesmo commit, e procure os usos dela em `client/src` com Grep antes.
5. **Vocabulário que os testes cobram:**
   - a marca é Marquesa Global Match (desde 24/11/2026, por pedido da Cris; em 23/11 foi MarquesaMatch, e antes WRW e MMM), escrita assim, em caracteres latinos, nos 10 idiomas; há testes que barram o nome antigo (a chave `contextoCatalogoMmm` fica como está: o nome é interno) e a varredura de "match" aceita a marca como nome próprio;
   - "conexão", não "match", fora dos nomes próprios "Business Match" e "Smart Match";
   - "palavra-chave", não "tag".
   `client/src/i18n/palavras-da-tela.test.ts` varre os 10 JSONs inteiros só atrás de "match"; "tag" ele confere apenas no campo da Nova Oportunidade (`newOpportunity.tagInputPlaceholder`), então nos outros textos quem garante é você.
6. **Conferir:** `node scripts/conferir-locales.mjs` (os 10 com as mesmas chaves), `pnpm vitest run client/src/i18n` e os `*.test.tsx` da tela que você mexeu (`pnpm vitest run <caminho>`).
7. **Smoke:** abra a tela em pt-BR e, se mexeu em layout, também em `ar` (escrita da direita para a esquerda) e num idioma de texto longo, como `de`. Console sem erro.
8. **Texto jurídico não é texto de tela.** O Termo Geral, os termos do Smart Match e do acervo Ouro e o contrato de comissão vivem em `docs/termos/` e entram no banco por `scripts/publicar-documento.mjs`, com o jurídico e o Roberto. Publicar versão nova desliga o recurso para quem tinha aceitado a anterior: não é por esta skill.
