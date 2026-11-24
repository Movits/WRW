# CLAUDE.md

<!-- Para quem mantém: aqui só entra o que vale em TODA sessão. Detalhe de área vai para o
CLAUDE.md da pasta (com uma linha de ponteiro aqui se o aviso for crítico); decisão datada,
para docs/arquitetura/decisoes-tomadas.md. Teto: 170 linhas. -->

## O projeto

**MarquesaMatch**: CRM de networking em que cada usuária mantém uma base
privada de contatos e a IA cruza o que cada contato **possui** com o que cada contato
**procura** para gerar oportunidades. Produção em wrwglobal.org. O nome mais antigo, MMM
(Mulheres que Movem o Mundo), segue em nomes de infraestrutura e em dados gravados.
Desde 23/11/2026 o nome visível é MarquesaMatch (decisão da cliente); o anterior, WRW
(Women Rocking the World), segue com o MMM em infraestrutura, domínio, artes da logo e
dados gravados. Todo o
texto do repositório (docs, commits, PRs, comentários) é em português do Brasil. Commit e
PR dizem o que mudou, por quê e como verificar, em português claro.

**Pessoas.** Roberto (`Movits`) lidera e fala com a cliente. Nicolas (`nicolasriber19`),
Gabriel (`DevGabriel03`) e Lucas Yan (`pacocateamo123-max`) desenvolvem, cada um instruindo
o próprio Claude. Dra. Glenda é a cliente e dona do produto; Rosber, sócio da Glenda, traz
pedidos de produto pelo grupo; o jurídico é do Dr. Ronei (contratos) e da Cris (textos
legais), que não usam o repositório.

**Gestão.** Escopo, responsáveis, status e prazos ficam no **Notion**, não aqui; o
repositório é para código e desenho técnico. As decisões da cliente nascem no grupo de
WhatsApp "Projetos IA", canal principal do time, e nem sempre chegam ao Notion. Sem acesso
ao Notion ou ao grupo, diga isso e pergunte à pessoa o que houve lá; nunca declare que
conferiu o que não abriu.

## Comandos e ambiente

```bash
pnpm install              # Node 20 + pnpm (corepack pnpm se não estiver no PATH)
pnpm dev                  # http://localhost:3000
pnpm check                # tsc --noEmit (não checa *.test.ts nem *.test.tsx)
pnpm test                 # vitest: projeto server (Node) + client (jsdom)
pnpm vitest run server/match-service.test.ts   # um arquivo só
pnpm build                # vite build + esbuild → dist/; pnpm start roda; pnpm format = prettier
pnpm db:generate          # depois de editar drizzle/schema.ts (ver drizzle/CLAUDE.md)
DATABASE_URL='mysql://...' pnpm db:migrate                # aplica as migrações pendentes
DATABASE_URL='mysql://...' node scripts/criar-banco.mjs   # banco novo do zero
node scripts/conferir-locales.mjs         # os 10 idiomas com as mesmas chaves
```

- **Requisitos:** Node 20 (o do CI e do `Dockerfile`; saiu de suporte em 30/04/2026, e a
  troca para a 22 é cartão), pnpm e um MySQL acessível. **No Windows, Git Bash obrigatório**
  (`dev` e `start` usam sintaxe POSIX) e, uma vez por computador,
  `pnpm config set script-shell "C:\\Program Files\\Git\\bin\\bash.exe"` (sem isso o pnpm
  roda os scripts no cmd mesmo chamado do Git Bash; a configuração é global e vale para todo
  projeto pnpm da máquina).
- **Permissões do projeto:** `.claude/settings.json` recusa ler `.env*` e pergunta antes de
  script de banco, no Bash e no PowerShell (ligado no Windows, com travas próprias). Rode
  na forma `node scripts/x.mjs`, sem `./` nem `bash -c`, e nunca contorne uma recusa.
- **Variáveis:** `cp .env.example .env`. Os scripts `criar-banco`, `migrar` e `nivelar-banco`
  NÃO leem o `.env`; o `checar-producao` lê um arquivo (`--env`; sem ele, `.env.producao`,
  senão `.env`). Ver `scripts/CLAUDE.md`. Sem `JWT_SECRET` o servidor não sobe; sem
  `DATABASE_URL` ele SOBE e todo acesso ao banco responde "Banco de dados indisponível". Não
  há valor padrão, de propósito.
- **Na nuvem (claude.ai/code):** `gh pr` e `gh issue` dão 403 (leia e abra PR por
  `mcp__github__*` ou `gh api`; o CI por `gh run`); não há MySQL; a branch é `claude/...`; o clone
  vem sem carimbo e instala as dependências no início da sessão (hook).

## Fluxo de trabalho (como trabalhamos, para pessoas e para o Claude)

1. **Antes de começar** (`/comecar-tarefa` conduz): `git fetch --prune`, base na `main` atual,
   o que entrou (`git log --oneline -15 origin/main`, `gh pr list --state all --limit 10`,
   `gh run list --limit 5`; abra o diff do que toca a sua área: título de commit não é
   evidência), o quadro do Notion (concluído, removido, adicionado, notificações) e o grupo.
2. **Carimbo** (`--status` mostra o estado):
   `node .claude/hooks/carimbo.mjs --carimbar --github "..." --notion "..." --whatsapp "..."`.
   Cada texto tem 20 caracteres ou mais e diz a verdade: o `--github` cita o SHA curto de
   `origin/main`; no WhatsApp, `"lido por mim em DD/MM: <o que vi>"` ou, se o Claude não lê o
   grupo, ele pergunta à pessoa e registra `"informado por <pessoa> em <DD/MM>: <resumo>"`,
   sem inventar. Vale 6 h e vence quando `origin/main` muda. Sem ele, o hook recusa
   `git commit`, `git push`, `git merge` e `gh pr merge` (prova o registro, não a conferência).
   **Se a branch ficou atrás de `origin/main`:** anote a branch (`git branch --show-current`),
   `git switch main && git pull --ff-only`, carimbe, volte com `git switch <branch anotada>` e
   rode `git merge origin/main`. Nunca rebase de branch já empurrada.
3. **Branch, nunca a `main`** (`feat/...`, `fix/...`, `docs/...`, `chore/...`): a `main` é
   protegida e cada merge nela vira deploy em produção. PR pequena, um assunto por PR.
   Contradição entre pedido, Notion e grupo: pare e pergunte.
4. **Rode o que o CI (`testes.yml`) roda**, com a `main` trazida: `conferir-locales`,
   `pnpm db:generate` sem criar arquivo, `pnpm check`, `node --check` em `scripts/*.mjs`,
   `scripts/*/*.mjs` e `.claude/hooks/*.mjs`, `pnpm test` e `pnpm build`. Confira o diff
   contra segredos, dado pessoal e `sql.raw`. Schema: `/mudar-schema`; texto: `/texto-de-tela`;
   tela: "testado" no front inclui abrir cada tela afetada no nível certo (`client/CLAUDE.md`).
5. **Abra a PR com `/abrir-pr`**; com o CI verde, mova o cartão conforme a regra de status
   (abaixo), com o link da PR na Comprovação.
6. **Validar é outro LLM revisar, antes do merge**: o Claude de outra pessoa
   (`/validar-tarefa`) ou outro modelo (o Codex, por exemplo), nunca o que fez a PR. Lê o
   diff contra o cartão (não o título), testa o que a PR diz e registra na PR o que conferiu.
   Revisão humana só para mudança visual (abrir as telas no nível de conta certo). Sem código
   (painel, DNS, texto jurídico), outra pessoa confere e registra no cartão o que viu.
7. **Merge** com aprovação e CI verde, só por `gh pr merge` (o botão do site e a ferramenta
   MCP de merge passam ao largo do carimbo); quem mescla segue a regra do README (hoje: quem
   revisou e aprovou mescla). O Claude não aprova nem mescla por conta própria. Se a pessoa
   pedir, mescla no computador com `gh pr merge N --merge` e carimbo válido. Na nuvem, não
   mescla: pede à pessoa que mescle do computador.
8. **Depois do merge**, com o deploy do Render no ar, quem tem o `.env.producao` roda
   `/conferir-producao` (`node scripts/checar-producao.mjs --env .env.producao`; PULADO não é
   "passou"); o cartão anda conforme a regra de status, com a saída na Comprovação.

**Regra de status do quadro** (do Roberto, 16/09 e 19/10). "Feito (a validar)": feita numa
branch com PR aberta e CI verde, esperando a validação do passo 6; quem fez move o cartão
para lá. "Concluído": validada e já na `main`, depois do merge e do exame de produção (passo
8); move quem validou ou quem mesclou depois da validação, nunca quem fez. Sem código (painel,
DNS, texto jurídico): "Concluído" quando já está em vigor e foi conferida por outra pessoa,
com a evidência no cartão. Exame com falha: volta a "Em andamento". Validar trabalho de colega
faz parte do trabalho.

## Regras que não são estilo

- **Produção só com o Roberto.** Nada contra o banco de produção (Aiven), Render, Backblaze
  B2, Resend ou wrwglobal.org sem autorização explícita dele, nem "só simular". A exceção de
  rotina é o exame do passo 8.
- **Antes de rodar qualquer script de `scripts/`, leia `scripts/CLAUDE.md`** (rodar pelo Bash
  não o carrega). Gravam no banco apontado, sem recusar o remoto, já na primeira chamada:
  `criar-banco.mjs`, `migrar.mjs`, `semear-rede-de-teste.mjs` e `migrar-rotulos-para-chaves.mjs`;
  com a flag de gravar: `nivelar-banco.mjs`, `importar-participantes.mjs`,
  `corrigir-colunas-json.mjs`, `normalizar-buscas-antigas.mjs`, `recuperar-enriquecimento.ts`,
  `demonstrar-etapa-11.ts`, `limpar-contextos-how-met.ts` e `reavaliar-prata-antiga.ts`. O
  exame `checar-producao.mjs` cria e apaga contas QA no banco do `--env`. Só
  `definir-senha-local.mjs` recusa banco remoto; `publicar-documento.mjs` exige
  `--confirmo-producao`.
- **O repositório é PÚBLICO.** Nunca commitar `.env*`, chave de API, senha de banco, dump do
  banco (tem e-mails e senhas de usuárias reais; vive só no repositório privado de backup)
  ou dado pessoal de usuária ou contato, nem em teste. Peça o NOME da variável, nunca o valor.
- **`sql.raw` é proibido.** Havia 21 pontos de SQL por concatenação (um permitia execução
  arbitrária no banco), todos eliminados. Query nova é parametrizada ou via ORM.
- **Schema só por `pnpm db:generate` + `pnpm db:migrate`.** Editar o `schema.ts` sem gerar a
  migração já quebrou produção. Nunca edite à mão SQL, snapshot ou journal de migração. Em
  produção as migrações rodam no boot e falha aborta a subida (`drizzle/CLAUDE.md`).
- **Privacidade é regra de consulta, não de tela.** O nível público nunca seleciona coluna
  pessoal; esconder no front não basta. Ressalva do consentimento: `server/CLAUDE.md`.
- **Nada extraído por IA entra sozinho:** leva origem e confiança e espera a usuária confirmar.
- **Serviço só casa com necessidade DECLARADA**, nos três motores de match e nos prompts:
  "não fazemos match porque alguém poderia precisar; fazemos match porque alguém declarou
  que precisa". Setor, porte, cargo ou obrigação legal não são necessidade.
- **Match nunca cruza por palavra solta, e concorrentes zeram** ("exportar vinho" ×
  "importar vinho" casam; "exportar" × "exportar" não). Hoje só o motor privado aplica;
  uniformizar com o de perfis é decisão de produto. Os três motores: `server/CLAUDE.md`.
- **Banco fora do ar é ERRO, nunca "sem dados".** Não crie `catch` que devolva vazio; se
  precisar de um, relance quando `ehErroDeBancoIndisponivel`.
- **A suíte NUNCA lê `DATABASE_URL`** (só `DATABASE_URL_TESTES`, banco descartável): o
  `.env` de trabalho já apontou para produção e `pnpm test` chegou a promover uma usuária
  real. Falha na suíte é regressão, sem exceções toleradas.
- **Ouro = Presidente = administradora** (pedido da cliente): as procedures de acesso aceitam
  os três papéis, com QUATRO exceções em `server/CLAUDE.md` (rode o `grep` de lá antes de
  citar contagem). Distribuidor do Smart Match é um PODER, não um nível. Contas Ouro
  criadas só para teste voltam a Prata antes da entrega. `grantGoldAccess` grava `gold` por
  cima do papel e REBAIXA presidente ou admin (`server/CLAUDE.md`).
- **Modelo de IA concreto** (ex.: `gemini-3.5-flash`), nunca alias como
  `gemini-flash-latest`, que já apontou para um modelo de 20 requisições/dia e derrubou a IA.
- **Nome gravado não se renomeia** sem migração de dados: o prefixo `/manus-storage/` (nas
  URLs do banco), as chaves `mmm.*` e `mmm:*` no navegador das usuárias, o slug `evento-mmm`,
  o `appId` `mmm-os` e os textos jurídicos publicados (republicar revoga aceites).

## Onde fica cada coisa

- **Código:** TypeScript num pacote só (React 19 + Vite no client, tRPC 11 sobre Express 4 no
  servidor, MySQL via Drizzle; Render pelo `Dockerfile`, sem `render.yaml`, variáveis no
  painel): `server/` (entrada real em `server/_core/index.ts`; `_core/` é herança do Manus),
  `client/`, `shared/`, `drizzle/` e `scripts/`, cada um com o seu CLAUDE.md, que só carrega
  quando o Claude lê ou edita arquivo da pasta (rodar pelo Bash não carrega; aviso crítico
  de pasta tem ponteiro aqui). No appRouter, `matches` é o `profileMatchesRouter`, e
  `routers/matches.ts` entra como `intelligentMatches`.
- **Documentação:** `docs/README.md` (índice e glossário) e `docs/guia-de-entrada.md`.
  `docs/arquitetura/` é a referência de projeto, não o retrato do código (assume Postgres
  com RLS; o código roda MySQL, decisão D6): `decisoes-em-aberto.md` trava por decisão de
  produto, `decisoes-tomadas.md` é o histórico datado. `docs/deploy.md`: produção e variáveis.
- **`vitrine/`** é a página estática do GitHub Pages (`.github/workflows/pages.yml`), não a
  aplicação. `docs/spec-*.md` são as specs por etapa vindas do Manus.
