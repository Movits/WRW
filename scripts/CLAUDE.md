# scripts/

<!-- Carregado quando o Claude lê ou edita um arquivo de scripts/; rodar `node scripts/x.mjs`
pelo Bash NÃO o carrega, por isso o CLAUDE.md da raiz manda lê-lo antes e repete a lista de
quem grava sem recusar banco remoto (mudou a tabela abaixo, mude a linha de lá). O mapa de
cada script fica em scripts/README.md; aqui ficam as armadilhas. Este arquivo não é .mjs,
então o "node --check scripts/*.mjs scripts/*/*.mjs" do CI não o vê. -->

Ferramentas de linha de comando, rodadas da raiz do repositório: `node` para os `.mjs`,
`npx tsx` para os `.ts`. O cabeçalho de cada arquivo tem o uso; `scripts/README.md` é o
mapa.

## Quem lê o `.env` e quem não lê

**`criar-banco.mjs`, `migrar.mjs` e `nivelar-banco.mjs` NÃO leem o `.env`** (preencher o
arquivo não basta). Os três, inclusive o `migrar.mjs` chamado por `pnpm db:migrate` e com
`--simular`, leem `process.env.DATABASE_URL` e param se ela não estiver no ambiente, cada um
com a sua mensagem: `criar-banco.mjs` imprime "DATABASE_URL não definida." seguida de um
exemplo de linha de comando; `migrar.mjs` e `nivelar-banco.mjs` imprimem
"Defina DATABASE_URL." (o `migrar.mjs` com o exemplo na linha seguinte). Os outros scripts
de banco também só leem do ambiente, menos o `importar-participantes.mjs`, que aceita
`--env arquivo` (sem ele, vale a `DATABASE_URL` do ambiente), e o `checar-producao.mjs`,
que não lê `DATABASE_URL` do ambiente: lê o arquivo de `--env` e, sem ele, o
`.env.producao` ou o `.env`. Passe sempre `--env`.

- **Como passar:** na linha de comando,
  `DATABASE_URL='mysql://...' node scripts/criar-banco.mjs`, ou, no terminal da PESSOA
  (Git Bash), exportando o arquivo inteiro antes: `set -a; . ./.env; set +a`. Ali o
  `.env` vira script do shell, então valor com espaço, `{` ou `#` precisa estar entre
  aspas no arquivo. O Claude não lê nem carrega o `.env`, e senha não passa pelo chat: com
  banco remoto, quem roda o comando é a pessoa, no terminal dela.
- **`pnpm db:generate` é a exceção:** o `drizzle.config.ts` também só lê
  `process.env.DATABASE_URL`, mas a CLI do drizzle-kit carrega o `.env` do diretório atual
  (ela embute o `dotenv/config`) antes de abrir a configuração, então para ele o arquivo
  basta. Sem a variável em lugar nenhum, a mensagem é
  "DATABASE_URL is required to run drizzle commands", que vem da configuração, não de um
  script.
- **Quem mais carrega o `.env` sozinho:** o servidor (`dotenv` em `server/_core/index.ts`,
  logo `pnpm dev` e `pnpm start`), a suíte (`import "dotenv/config"` em
  `vitest.config.ts`, mas ela troca `DATABASE_URL` por `DATABASE_URL_TESTES`) e o
  `checar-producao.mjs`, que lê o arquivo de `--env` e, sem ele, o `.env.producao` ou o
  `.env`, nunca a `DATABASE_URL` do ambiente. Passe sempre `--env`, para o exame não cair no
  `.env` de trabalho.

## Scripts que gravam em banco: produção só com o Roberto

Nunca rode script contra o banco de produção (Aiven), nem para ler ou "só simular", sem
autorização explícita do Roberto. Antes de rodar qualquer um, leia o cabeçalho e confirme
o banco alvo (local ou remoto).

| Script                           | O que grava                                                                                | Ensaio                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `criar-banco.mjs`                | o mesmo que `migrar.mjs`: aplica as migrações pendentes em qualquer banco, não só no vazio | `node scripts/migrar.mjs --simular`                          |
| `migrar.mjs`                     | aplica as migrações pendentes                                                              | `--simular`                                                  |
| `nivelar-banco.mjs`              | cria tabela, coluna e índice que faltam; nunca apaga                                       | só grava com `--aplicar`                                     |
| `publicar-documento.mjs`         | versão nova de termo; quem não aceitou perde o consentimento                               | `--simular`; fora do banco local exige `--confirmo-producao` |
| `importar-participantes.mjs`     | cria contas em lote, sem volta por aqui                                                    | só grava com `--aplicar`                                     |
| `semear-rede-de-teste.mjs`       | contatos fictícios (`--limpar` apaga); NÃO recusa banco remoto                             | nenhum                                                       |
| `definir-senha-local.mjs`        | senha de uma conta; recusa host que não seja local                                         | nenhum                                                       |
| `migrar-rotulos-para-chaves.mjs` | UPDATE em todos os perfis                                                                  | nenhum                                                       |
| `corrigir-colunas-json.mjs`      | altera colunas                                                                             | só grava com `--aplicar`                                     |
| `normalizar-buscas-antigas.mjs`  | converte "O que você busca?" antigo                                                        | só grava com `--aplicar`                                     |
| `limpar-contextos-how-met.ts`    | apaga contextos antigos                                                                    | `--executar --confirmar-banco=...`                           |
| `reavaliar-prata-antiga.ts`      | rebaixa a Bronze, com auditoria                                                            | `--executar --confirmar-banco=...`                           |
| `recuperar-enriquecimento.ts`    | reaplica respostas do enriquecimento                                                       | só grava com `--aplicar`                                     |
| `demonstrar-etapa-11.ts`         | `--exercitar` revoga e reaceita de verdade (e devolve o estado)                            | sem `--exercitar` só mostra                                  |

**Quem recusa banco remoto:** só o `definir-senha-local.mjs` e o `semear-rede-com-armadilhas.mjs`
(recusam host que não seja `localhost`, `127.0.0.1` ou `::1`) e o `publicar-documento.mjs` (fora do banco local, exige
`--confirmo-producao`). Os dois `.ts` com `--confirmar-banco` só gravam se você repetir o
alvo que o ensaio mostrou, mas aceitam banco remoto. Todos os outros da tabela gravam no
banco que recebem (a `DATABASE_URL` ou, no `importar-participantes.mjs`, o arquivo de
`--env`), local ou não; `criar-banco.mjs`, `migrar.mjs`, `semear-rede-de-teste.mjs` e
`migrar-rotulos-para-chaves.mjs` já na primeira chamada, sem flag nenhuma.

Três rotinas tocam a produção por desenho: `migrar.mjs` no boot do servidor,
`checar-producao.mjs` depois de todo deploy e `publicar-documento.mjs` quando o jurídico
entrega texto novo.

## Script que apaga do bucket: produção só com o Roberto

`expurgar-audio-escondido.ts` (`npx tsx`) é o único script que APAGA do bucket. Lista, só
sob `meetings/`, as chaves de áudio de reunião que o DELETE antigo (sem `VersionId`) só
escondeu no B2 e, com `--apagar`, tira cada uma com todas as versões, pela mesma função do
servidor (`storageApagarTodasAsVersoes`); sem `--apagar` só lista. Lê as `STORAGE_*` do
arquivo de `--env`, obrigatório, e a variável que já estiver no ambiente vale no lugar da
do arquivo. É o passivo de antes da retenção do áudio (novembro de 2026), que a varredura
não alcança porque as linhas já saíram: rode uma vez com o Roberto, ou aplique a regra de
ciclo de vida do B2 no prefixo `meetings/`, e registre no cartão qual das duas foi feita.

## O exame de produção (`checar-producao.mjs`)

`node scripts/checar-producao.mjs --env .env.producao` depois de todo deploy na `main`
(`--com-ia` inclui as checagens de IA e gasta cota; `--somente-faxina` só apaga resíduos).
Cria e apaga duas contas QA, faz login de verdade e prova site, isolamento, storage,
consentimento, Ouro, vitrine e acervo. Precisa só da `DATABASE_URL` da produção, num
`.env.producao` separado do `.env` de trabalho; nunca do `JWT_SECRET`. Sai com 0 só se nada
reprovar; PULADO é "não provado", não "passou". Roda quem tem o `.env.producao`
(`/conferir-producao`); os efeitos colaterais estão no cabeçalho do script. A biblioteca
dele fica em `scripts/exame/` (`limpeza.mjs`, `relatorio.mjs`), e tabela nova com dado de
usuária entra em `limpeza.mjs` (ver `drizzle/CLAUDE.md`).

## Para desenvolver

- `node scripts/conferir-locales.mjs`: os 10 idiomas com as mesmas chaves (não precisa de
  banco; o CI roda).
- `node scripts/semear-rede-de-teste.mjs email@da.usuaria` (com `DATABASE_URL` local):
  contatos fictícios na rede de uma usuária; `--limpar` desfaz.
- `node scripts/definir-senha-local.mjs email 'senha'` (com `DATABASE_URL` local): senha de
  conta em banco LOCAL, porque em dev não há Resend para recuperar senha.
- O CI (`.github/workflows/testes.yml`) roda `node --check` em `scripts/*.mjs`,
  `scripts/*/*.mjs` e `.claude/hooks/*.mjs`: script novo em subpasta já entra.
