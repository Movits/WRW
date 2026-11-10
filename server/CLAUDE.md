# server/

<!-- Carregado quando o Claude lê ou edita um arquivo de server/. As regras que valem
em toda sessão estão no CLAUDE.md da raiz; aqui fica o detalhe do servidor. Datas e
autoria das decisões: docs/arquitetura/decisoes-tomadas.md. -->

Servidor tRPC 11 sobre Express 4, MySQL via Drizzle. Toda lógica nova aqui ganha ou
atualiza um `*.test.ts` ao lado (ver "Testes do servidor", no fim).

## Boot e uploads

A entrada real é `server/_core/index.ts` (carrega o `.env` com `dotenv`). Ordem:
migrações no boot (só em produção: roda `scripts/migrar.mjs` como processo filho antes de
aceitar tráfego; falha aborta a subida e o Render mantém a versão anterior no ar), helmet,
compression, cabeçalhos de segurança, bloqueio de scanners, rate limit global, body
parsers, proxy de storage, tRPC em `/api/trpc` e, por fim, Vite em middleware (dev) ou
estático de `dist/public` (prod). Não há proxy de dev: front e API na mesma origem.

Body parsers: 5 MB por padrão e 15 MB em SEIS procedimentos de upload —
`meetings.submitRecording`, `contexts.uploadMedia`, `network.uploadPhoto`,
`network.uploadCard`, `dealRoom.uploadDocument` e `sivc.uploadDocument`. Antes deles vem
`corpoGrandeParaUploads` (`_core/corpo-grande-para-uploads.ts`), que reconhece os mesmos
procedimentos quando chegam dentro de um LOTE do tRPC (`/api/trpc/a,b` não casa com
nenhum recorte por caminho). Upload novo entra nos dois lugares.

## tRPC, procedures e papéis

Cada área de negócio tem um router em `server/routers/`, agregados em `server/routers.ts`
(atenção aos apelidos: `matches` no appRouter é o `profileMatchesRouter`;
`routers/matches.ts` entra como `intelligentMatches`). O client consome tudo tipado via
`client/src/lib/trpc.ts` + React Query. `server/_core/trpc.ts` exporta só `router`,
`publicProcedure` e `protectedProcedure` (o `adminProcedure` estrito saiu na limpeza do
Manus, commit `5bce2aa`, 02/09/2026). As procedures de acesso ficam em
`server/routers/_procedures.ts`: `adminProcedure`, `presidentProcedure` e `goldProcedure`, e
**as três aceitam o mesmo conjunto {admin, president, gold}** — a regra
"Ouro = Presidente = administradora": toda conta Ouro tem o painel administrativo. Por isso
contas Ouro criadas só para teste (inclusive a do Roberto) voltam a Prata antes da entrega.

**Mas Ouro NÃO é staff em tudo.** São QUATRO os pontos em que admin e president valem
mais que Ouro (a frase "a única assimetria é `isStaff`" era falsa). Antes de repetir
qualquer contagem, rode `grep -rn "role ===\|role !==\|users.role" server --include=*.ts`
e confira:

1. **Abrir oportunidade que não é sua**: `isStaff` em `oportunidade-acesso.ts` — uma conta
   Ouro APROVA uma oportunidade pendente e leva 403 ao tentar ABRI-LA.
2. **Rastreabilidade das conexões**: `plataformaProcedure` em
   `routers/networkInteligente.ts` (a lista de conexões registradas de todas as donas e a
   apuração de comissão, com auditoria `NETWORK_CONNECTIONS_READ`; a aba some do Painel
   Ouro para Ouro sem cargo).
3. **Bloqueio automático por eventos críticos**: `checkAutoLockThreshold` em
   `server/security.ts` isenta president e admin — conta Ouro é desativada como qualquer
   outra ao cruzar o limite.
4. **Quem é avisada**: os destinatários de "oportunidade aguardando análise"
   (`routers/opportunities.ts`) e de "não há distribuidor" (`idsDaPresidenciaAtiva` em
   `db.ts`) são president e admin; Ouro não recebe nenhum dos dois, embora possa agir
   sobre o primeiro.

Outra armadilha: `grantGoldAccess` grava `role = "gold"` por cima do que havia, e
`revokeGoldAccess` grava o nível que o perfil sustenta (`"silver"` se
`avaliarQualificacaoDoPerfil` o qualifica, `"bronze"` se não) sem olhar o papel anterior
— conceder Ouro a uma presidente a REBAIXA, e revogar a joga em Prata ou Bronze.
Checagens "Ouro ou acima" ainda estão repetidas inline em `routers/dealRoom.ts`,
`routers/matching.ts`, `routers/opportunities.ts`, `_core/storageProxy.ts` e no client
(`ProtectedRoute`, `AppHeader`, `Connections`).

## Distribuidor e pedidos de interesse

**Distribuidor do Smart Match é um PODER, não um nível.** `users.isDistributor`
(migração 0010) marca a pessoa real que confere cada pedido de interesse antes de
encaminhá-lo. `distribuidorProcedure` (em `_procedures.ts`) exige
`ctx.user.isDistributor === true` e não olha `role`: Ouro sem a flag leva 403, Prata com a
flag passa. Quem concede e revoga é `distribuicao.conceder/revogar` (`presidentProcedure`;
auditoria `DISTRIBUTOR_GRANTED`/`DISTRIBUTOR_REVOKED` de risco alto e aviso `system` no
sino), na aba Distribuição do Painel Ouro. O painel e o item de menu abrem também para
quem tem a flag, mas só essa aba.

**O pedido passa pelo distribuidor.** `connections.status` (migração 0011): `in_review`
(nasceu; espera o distribuidor) → `pending` (encaminhado; espera a destinatária) →
`accepted` | `declined`; ou `in_review` → `not_forwarded` (não encaminhado).
`reciprocatedAt` marca que a destinatária também clicou durante a análise (uma linha por
par; a aprovação já vira `accepted` e revela os dois nomes). A destinatária NÃO vê
`in_review` nem `not_forwarded`: o predicado `pedidoVisivelPara` em `db.ts` tira a linha
do join em `getMatchesForUser` e do WHERE em `getConnectionsForUser` (regra de consulta,
não de tela). A decisão (`distribuicao.decidir`) é um UPDATE com `status = 'in_review'`
no WHERE: 0 linhas = CONFLICT, sem efeito; `respondToConnection` e o interesse mútuo em
`sendConnectionRequest` também levam o status no WHERE. Sem distribuidor ativo o pedido
FICA esperando e a presidência recebe o aviso. A fila está na `main` desde a #113: enquanto
ninguém tiver o poder concedido em produção, todo pedido novo espera (a ordem entre a #115
e conceder o poder está no cartão dela). Detalhes em `docs/arquitetura/fluxos.md` e
`privacidade.md`.

## Cadastro concluído

Cadastro não concluído não usa a plataforma. `profile.completeOnboarding` exige o Termo
Geral de Uso aceito (`server/termo-geral-de-uso.ts`) e a declaração de maioridade
(`declaraMaioridade: true`, cláusula 3.4 do Termo; gravada em `audit_logs` como
`AGE_MAJORITY_DECLARED` ANTES de concluir, por `server/maioridade.ts`), e é quem marca
`users.onboardingCompleted`. O `protectedProcedure` (e, por herança, admin, Ouro e
distribuidor) passa por `exigirCadastroConcluido` (`server/cadastro-concluido.ts`), que
responde PRECONDITION_FAILED a quem tem `onboardingCompleted = false` fora de `auth`,
`consent`, `conta`, `assistenteTexto`, `system`, `profile.get` e
`profile.completeOnboarding`. Procedimento novo que a tela de Onboarding chame entra nessa
lista; procedimento público novo entra em `PUBLICOS` de `server/cadastro-concluido.test.ts`,
que varre o appRouter inteiro. No client, o `ProtectedRoute` manda para /onboarding (só a
rota do cadastro liga `permitirCadastroIncompleto`). O Termo Geral não se revoga à parte
(`consent.revoke` recusa): quem não o aceita mais exclui a conta. Contas que concluíram o
cadastro antes do termo existir não são obrigadas a aceitá-lo: depende de decisão de
produto.

## Privacidade e consentimento

O nível público nunca seleciona colunas pessoais: `listVitrineColetiva` em `server/db.ts`
lê só id, país e cidade e devolve id opaco; `listAcervoOuro` exige nível 'ouro' no
contato, consentimento da dona ao termo, `goldProcedure` e registro de auditoria (ver
`docs/arquitetura/privacidade.md`). **Ressalva no consentimento:** ele só trava quando
existe versão VIGENTE do termo publicada. Sem linha `isCurrent` em `document_versions`,
`hasValidConsent` e `usersComConsentimento` (`server/routers/consent.ts`) respondem "sim"
para todas — é a única porta que libera sem consentimento, e vale para todo termo, não só
o do acervo. Cai só essa trava: nível 'ouro' no contato, `goldProcedure` e auditoria
seguem valendo. Publicar o termo (`scripts/publicar-documento.mjs`) é o que liga a
exigência.

**Nada extraído por IA entra sozinho:** no enriquecimento, só sugestões com
`confidence >= 0.7` viram pendência (`routers/enrichment.ts`); entidades e sugestões de
reunião nascem `pending`; o SIVC pondera a fonte em `CONFIDENCE_WEIGHTS`.

## Acesso a dados: banco fora do ar é erro

`server/db.ts` é a camada única (usuárias, oportunidades, Ouro, segurança, matches, rede
privada, contextos, enriquecimento). Todo helper abre com `exigirDb()`, que lança
`BancoIndisponivel` (classe em `server/banco-indisponivel.ts`) quando não há
`DATABASE_URL`. Em produção a variável existe sempre e `drizzle(url)` não conecta ao
criar o pool, então a queda real chega na primeira query como erro de conexão do driver
(`DrizzleQueryError` com `cause.code` ECONNREFUSED, ETIMEDOUT, PROTOCOL_CONNECTION_LOST...);
`ehErroDeBancoIndisponivel()` reconhece os dois casos na cadeia de `cause`. O middleware de
`server/_core/trpc.ts` traduz qualquer um deles, em todo procedimento, num
`INTERNAL_SERVER_ERROR` com `MENSAGEM_BANCO_INDISPONIVEL` (em português), e o
`errorFormatter` do mesmo arquivo mascara os demais erros do driver ("Erro ao consultar o
banco de dados") para o SQL nunca chegar ao navegador. Se a sessão não pôde ser lida por
isso, `createContext` marca `ctx.bancoIndisponivel`, `auth.me` lança em vez de devolver
`null` e o `ProtectedRoute` mostra "tentar de novo" em vez de mandar ao login. Exceções
deliberadas: `system.health` (responde `ok:false` com HTTP 503) e `stats.platform` (zeros
na página inicial) degradam em vez de lançar. Não crie `catch` que devolva vazio: se
precisar de um, relance quando `ehErroDeBancoIndisponivel`. `sql.raw` é proibido.

## Os três motores de match

**`server/match-service.ts`** cruza contatos da mesma dona: `scoreMatch` aplica, nesta
ordem, concorrentes → 0 (`saoConcorrentes`, de `shared/direcao-do-termo.ts`, ANTES de
qualquer outro critério), slug exato → 100, mesmo objeto do termo → 100, mesmo núcleo →
100, o mesmo serviço escrito de outro jeito → 100 (só para serviço: a mesma especialidade
na mesma família, entre consultoria e assessoria, no apoio que nomeia a profissão, na
assessoria sobre área da profissão — "Assessoria tributária" diante da advocacia ou da
contabilidade tributária — ou os dois lados só com a família, "Contabilidade" × "Contador"
e "Serviços contábeis" × "Contador", também com a oferta dirigida só a um destinatário
comum, "Contabilidade para pequenas empresas" × "Contador", `mesmaFamiliaEEspecialidade`),
necessidade que nomeia só a família do serviço → 60 (`necessidadeGenericaNomeiaOServico`,
que inclui a oferta GENÉRICA diante da necessidade da mesma família com só público ou
finalidade — "Contabilidade" × "Contador para pequenas empresas", "Logística" ×
"logística para exportar meu café"; dar 100 quando o público está em
`DESTINATARIOS_COMUNS` é decisão em aberto), necessidade que declara o ASSUNTO do serviço
sem nomeá-lo → 60 com tipo `semantic` (`necessidadeDeclaraOAssuntoDoServico`: vocabulário
curado de tributário, internacionalização e regulatório sanitário, e a necessidade tem de
pedir ajuda ou uma ação, sem pedir no resto a contraparte, o capital ou o registro de
marca: "Entrada de investidor internacional" não casa), mesma categoria → 60 (para
serviço, só no par que a regra não lê num idioma novo, `regraNaoLeOPar`). O critério
semântico vale 45, abaixo do limiar 50: está desligado por construção e o texto não sai
para embeddings. A regra da spec é tag exata, mesmo objeto ou mesmo núcleo em direções
OPOSTAS, ou mesma categoria; duas pontas que querem a mesma coisa são concorrentes.

**`server/matching.ts`** cruza perfis de usuárias em 6 dimensões ponderadas, com LLM só no
insight: complementaridade 30, setor 20, investimento 20, especialidade 15, valores 10,
localização 5 (somam 100), com corte em 40 — um par vira match sem nenhum termo cruzado.
**Este motor não aplica a regra dos concorrentes:** `satisfaz` devolve `true` já no
`have === need` e no slug igual, sem passar por `saoConcorrentes`, então "exportar" ×
"exportar" conta como necessidade atendida e ainda SOBE a complementaridade, a dimensão de
maior peso. Uniformizar os dois motores é decisão de produto, não ajuste local: a nota do
motor de perfis mudaria para todas. **`routers/profileMatches.ts`** expõe esses matches no
Dashboard com trava de consentimento dos dois lados.

**Regra da demanda expressa, nos três motores e nos prompts.** Item de "o que tenho"
classificado como SERVIÇO (`shared/tipo-da-oferta.ts`) só casa com necessidade DECLARADA
em "o que preciso". Setor, porte, localização, cargo, atividade econômica, problemas
típicos do segmento, obrigações legais ou "poderia se beneficiar" não são necessidade; a
IA não pode inferir o que ninguém declarou, e essas informações só sobem a nota de um
match que já passou pelo portão. Palavra igual não é serviço igual ("Consultoria
jurídica" não atende "Consultoria em marketing"); a mesma coisa escrita de outro jeito é a
mesma necessidade ("Advogado tributarista" × "Advocacia tributária"). Os outros tipos
(produtos, ativos, investimento, conexões, tecnologia e imóveis) seguem as regras de sempre.

- **Motor privado:** a categoria em comum não vale para serviço (salvo os idiomas novos).
- **Motor de perfis:** o par sustentado só por serviço sem demanda expressa dá zero, não é
  gravado e a leitura da lista esconde a linha antiga (sem apagá-la, para a dispensa da
  dona sobreviver); com "o que tenho" vazio, a especialidade e a área de atuação são a
  oferta.
- **Prompts de `routers/matching.ts`:** o modelo classifica o item e cita o trecho da
  oportunidade que declara a necessidade; `server/portao-da-demanda-expressa.ts` confere a
  citação, e que ela pede um serviço que o perfil oferece, antes de exibir (citação de
  contraparte — distribuidor, investidor —, de autodescrição da empresa ou de assunto que
  nenhum serviço do perfil presta é barrada). Oportunidade que OFERECE serviço só vai a
  quem declarou algo que possa ser aquele serviço.
- **"O que você busca?"** (12 opções, `shared/o-que-busca.ts`): nenhuma opção libera
  serviço sozinha ("Serviço Especializado" é genérica), e o texto de "Outra necessidade"
  (`seekingOtherNeed`) vale como "o que preciso". A categoria digitada ainda decide o tipo
  quando o texto não decide.
- **Logística, transporte, frete e armazenagem são serviço**, inclusive a opção fixa
  "Logística"; galpão, armazém e frota continuam imóvel e ativo.
- **Família de serviço é lema, não área, e a equivalência é ESTRITA:** só casa o que as
  listas entendem (palavra desconhecida precisa aparecer igual dos dois lados; na IA, o que
  o texto não entende fica com o modelo).
- **Idiomas novos** (fr, de, ru, hi, ar, zh e ja, onde as listas são curtas): o par que só
  não casa por palavra que elas não leem NÃO é bloqueado nos motores determinísticos — vale
  a categoria em comum, nunca 0 por falta de regra (`regraNaoLeOPar`). Onde há regra no
  idioma (lema curado, marcador de pedido, chinês e japonês lidos pelo fim do termo) o
  motor decide como em português, o pedido precisa pedir o serviço e o que ele entende
  continua barrado. pt, en e es seguem estritos, também dentro de rótulo bilíngue.
- Entrada nova no vocabulário de assunto entra com o teste negativo dela
  (`server/demanda-expressa-exemplos-da-spec.test.ts`). Os limites aceitos da regra estão
  em `docs/arquitetura/README.md` §2c.

## IA, storage e segredos (`_core/`)

`server/_core/` é a infraestrutura herdada do Manus (o projeto nasceu na plataforma Manus
e foi extraído: ver `docs/recuperacao-do-manus.md`): entrada, auth por cookie HttpOnly
(`sdk.ts`), e-mail (Resend), storage S3 com URLs assinadas, Vite em dev.

- **IA:** as chamadas de texto passam por `server/_core/llm.ts`, que aceita qualquer
  endpoint compatível com a API da OpenAI via `fetch` (não há SDK de IA no projeto),
  configurado por `LLM_API_URL`, `LLM_API_KEY` e `LLM_MODEL`; retenta 4 vezes com backoff.
  `LLM_API_URL` não tem fallback. `server/gemini.ts` (transcrição e embeddings) não usa o
  `LLM_API_URL`: fala direto com a API do Gemini, com a mesma chave, distingue cota esgotada
  (`GeminiCotaEsgotadaError`) de sobrecarga e cai para um modelo reserva.
- **Modelo concreto (regra da raiz):** todo id passa pela guarda de
  `server/_core/modelos-de-ia.ts`, lido do ambiente a cada chamada. O do áudio
  (`LLM_AUDIO_MODEL` e `LLM_AUDIO_MODEL_RESERVA`) só passa no formato `gemini-<versão>`,
  porque vai sempre ao Gemini, com o id na URL. O do texto (`LLM_MODEL`) não fica preso ao
  Gemini: recusa só `latest` e id sem número de versão, e aceita id de outro provedor
  (`gpt-4o-2024-08-06`). Vazio usa o padrão em silêncio; recusado avisa no log uma vez por
  origem e valor e também cai no padrão. O boot imprime `[IA] áudio … · reserva … · texto …`
  sem a chave (id de outro provedor no texto sai como "fora do log", porque a guarda do
  texto não o distingue de uma chave colada no campo errado). Os ids que a chave do Gemini
  enxerga saem de `node scripts/listar-modelos-gemini.mjs`.
- **Arquivos** (áudio de reunião, documentos, mídia de contexto) vão para storage
  compatível com S3 (`STORAGE_*`; Backblaze B2 em produção), servidos pelo proxy
  autenticado `/manus-storage/*`, que exige sessão e posse. Esse prefixo está gravado nas
  URLs do banco: não renomeie sem migração de dados.
- **Segredos:** `JWT_SECRET` é obrigatória — o servidor se recusa a iniciar sem ela
  (`requireSecret()` em `server/_core/env.ts`, chamado ao carregar `server/auth.ts`).
  `VAULT_ENCRYPTION_KEY` deve existir em produção, mas o código não a exige: sem ela,
  `server/security.ts` e `server/matching.ts` derivam a chave do cofre do `JWT_SECRET`.

## Reunião que falha na IA se reprocessa pelo áudio guardado

`processMeetingRecording` guarda o áudio no bucket antes da IA; `meetings.reprocess`
(`iniciarReprocessamento` em `server/meeting-service.ts`) lê esses bytes de volta
(`storageGetBytes`) e roda de novo transcrição e extração, sem gravar áudio nem renovar os
30 dias. Cada execução tem uma FICHA: o `updated_at` que ela grava ao tomar a reunião para
`processing` (UPDATE condicional a partir de `recording` no envio e de `failed` no
reprocesso). Releitura, `ready` e `failed` exigem `status = 'processing' AND updated_at =
ficha`: quem tomou a reunião por último (reprocesso novo, ou a varredura de interrompidas,
que grava `updated_at` novo) vence, e a execução velha sai sem escrever. O reprocesso
responde na hora e segue em segundo plano (a tela consulta a cada 5 s); o trabalho nunca
rejeita, porque rejeição solta derruba o processo. Os derivados da tentativa anterior só
saem depois de a IA dar certo, e decidir sobre sugestão ou entidade com a reunião em
`processing` dá CONFLICT. Teto brando de 3 reprocessos aceitos por dona a cada 10 min.

## Testes do servidor

- Lógica nova em `server/` ganha ou atualiza um `*.test.ts` ao lado (fora os
  `*.integracao.test.ts`). Padrão: `vi.mock` das dependências; credencial ausente (ex.:
  Resend) se auto-pula com `skipIf`.
- A suíte NUNCA lê `DATABASE_URL`: `server/test/setup-banco.ts` a troca por
  `DATABASE_URL_TESTES`, um banco descartável; sem ela o `*.integracao.test.ts` se pula. A
  suíte carrega o `.env` sozinha (`import "dotenv/config"` em `vitest.config.ts`).
- `RUN_LIVE_CREDENTIAL_TESTS=true` liga os testes que falam com a API real do Gemini; fora
  dele, `pnpm test` não gasta cota. Com `.env` completo (banco de testes + chave do Gemini)
  a suíte passa inteira.
- Ninguém checa os tipos dos testes: o `tsconfig` exclui `*.test.ts` e `*.test.tsx` do
  `pnpm check`, e o Vitest só transpila (esbuild remove os tipos sem conferir). Um mock com
  a forma errada passa em silêncio: escreva o dublê a partir do tipo real e prefira
  asserções que discriminem comportamento.
- Função pura do client pode ser testada aqui (padrão: `server/transcricao-destacada.test.ts`).
