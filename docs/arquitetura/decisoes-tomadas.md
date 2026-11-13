# Decisões tomadas

Registro datado das decisões que já valem no código: quando, quem decidiu, o que mudou e
onde está. É o par de [decisoes-em-aberto.md](./decisoes-em-aberto.md), que lista o que
ainda trava por decisão de produto.

As regras em si moram nos CLAUDE.md (o da raiz e os de `server/`, `client/`, `drizzle/`,
`scripts/` e `shared/`), que dizem o que fazer hoje. Este arquivo guarda a história: de
onde cada regra veio, para ninguém desfazer sem saber. A fonte de status continua sendo o
Notion; as decisões da cliente nascem no grupo "Projetos IA" e nem sempre chegam ao
Notion, e contradição entre pedido, Notion e grupo é para parar e perguntar.

Formato: data, quem, o quê, onde no código. Da mais antiga para a mais nova.

---

## 25/08 a 06/09/2026 — os uploads de 15 MB, um por vez

O limite do corpo é 5 MB, e cada upload ganhou o seu recorte de 15 MB em
`server/_core/index.ts` quando apareceu o problema:

| Data  | Procedimento                                                        | Origem           |
| ----- | ------------------------------------------------------------------- | ---------------- |
| 25/08 | `meetings.submitRecording`                                          | resgate do Manus |
| 01/09 | `contexts.uploadMedia`                                              | etapa 5          |
| 03/09 | `network.uploadPhoto` e `network.uploadCard`                        | PR #58           |
| 04/09 | `dealRoom.uploadDocument` e `sivc.uploadDocument`                   | PR #59           |
| 06/09 | `corpoGrandeParaUploads` (os mesmos seis dentro de um LOTE do tRPC) | PR #79           |

Lição: upload novo entra nos dois lugares (recorte por caminho e
`server/_core/corpo-grande-para-uploads.ts`).

## 02/09/2026 — o `adminProcedure` estrito sai do `_core`

Na limpeza dos resíduos do Manus (commit `5bce2aa`, "chore: remove os resíduos do Manus, do
Codex/OpenAI e do SDK da Anthropic"), `server/_core/trpc.ts` deixou de exportar o
`adminProcedure` que só aceitava admin; as procedures de acesso foram para
`server/routers/_procedures.ts`. Desde então o `_core/trpc.ts` exporta só `router`,
`publicProcedure` e `protectedProcedure`.

## 02/09/2026 — Ouro = Presidente = administradora

- **Quem:** pedido da cliente (Dra. Glenda), confirmado pelo Roberto.
- **O quê:** `adminProcedure`, `presidentProcedure` e `goldProcedure` aceitam o mesmo
  conjunto {admin, president, gold}; toda conta Ouro tem o painel administrativo.
  Consequência: contas Ouro criadas só para teste (inclusive a do Roberto) voltam a Prata
  antes da entrega.
- **Onde:** `server/routers/_procedures.ts`. As quatro exceções estão em `server/CLAUDE.md`
  (ver a revisão da PR #97 abaixo).

## 12/09/2026 — PR #89, revisão atribuída ao Nicolas: a ressalva do consentimento

- **Quem:** Nicolas, revisando a #89 (CLAUDE.md sem os fatos que envelheceram).
- **Fonte:** a #89 foi mesclada em 12/09. A revisão não tem comentário nem aprovação no
  GitHub; a atribuição ao Nicolas entrou no CLAUDE.md em 15/09 (commit `dfbab70`, na
  `main` desde 16/09 com a #135).
- **O quê:** o consentimento só trava quando existe versão VIGENTE do termo publicada.
  Sem linha `isCurrent` em `document_versions`, `hasValidConsent` e
  `usersComConsentimento` respondem "sim" para todas, em todo termo. Publicar o termo é o
  que liga a exigência.
- **Onde:** `server/routers/consent.ts`; publicação por `scripts/publicar-documento.mjs`.

## 12/09/2026 — PR #97, revisão atribuída ao Nicolas: três correções de fato

- **Quem:** Nicolas, revisando a #97 (README que começa pelo produto e pelas pessoas).
- **Fonte:** a #97 foi mesclada em 12/09. Como na #89, a revisão não tem registro no
  GitHub, e as três correções entraram no CLAUDE.md em 15/09 (commit `dfbab70`).
- **O quê:**
  1. `criar-banco.mjs`, `migrar.mjs` e `nivelar-banco.mjs` NÃO leem o `.env`: preencher o
     arquivo não basta (`scripts/CLAUDE.md`).
  2. "A única assimetria entre Ouro e staff é `isStaff`" era falso: são QUATRO pontos
     (`isStaff` em `server/oportunidade-acesso.ts`, `plataformaProcedure` em
     `server/routers/networkInteligente.ts`, `checkAutoLockThreshold` em
     `server/security.ts` e os avisos de `routers/opportunities.ts` e
     `idsDaPresidenciaAtiva` em `server/db.ts`). Antes de citar contagem, rode o `grep` de
     `server/CLAUDE.md`.
  3. O motor de perfis (`server/matching.ts`) não aplica a regra dos concorrentes:
     `satisfaz` devolve `true` no `have === need` sem passar por `saoConcorrentes`.
     Uniformizar com o motor privado é decisão de produto.

## 12/09/2026 — regra da demanda expressa

- **Quem:** pedido do Nicolas: "não fazemos match porque alguém poderia precisar; fazemos
  match porque alguém declarou que precisa".
- **O quê:** item de "o que tenho" classificado como SERVIÇO só casa com necessidade
  DECLARADA em "o que preciso", nos três motores e nos prompts. Setor, porte, cargo e
  obrigações legais não são necessidade; só sobem a nota de um match que já passou pelo
  portão.
- **Onde:** `shared/tipo-da-oferta.ts`, `server/match-service.ts`, `server/matching.ts`,
  `server/routers/matching.ts` e `server/portao-da-demanda-expressa.ts` (commits
  `0eef9c1`, `6cedec3` e `9ecc28c`). Limites aceitos em [README.md](./README.md) §2c.

## 13/09/2026 — o distribuidor do Smart Match

- **O quê:** o distribuidor é um PODER (`users.isDistributor`, migração 0010, PR #112),
  não um nível, e o pedido de interesse passa pela análise dele (`connections.status`
  com `in_review` e `not_forwarded`, migração 0011, PR #113).
- **Onde:** `distribuidorProcedure` em `server/routers/_procedures.ts`,
  `server/routers/distribuicao.ts` e `pedidoVisivelPara` em `server/db.ts`.
- **Nota:** o CLAUDE.md da época dizia "mesclar a fila só depois de conceder o poder em
  produção". A fila entrou na `main` com a #113; enquanto ninguém tiver o poder concedido
  em produção, todo pedido novo espera e a presidência recebe o aviso.

## 14/09/2026 — decisões sobre o tipo da oferta

- **Logística, transporte, frete e armazenagem são serviço** (decisão do Nicolas),
  inclusive a opção fixa "Logística"; galpão, armazém e frota continuam imóvel e ativo.
- **A categoria digitada ainda decide o tipo quando o texto não decide** (decisão do
  time).
- **"O que você busca?"** passou das 5 opções antigas para as 12 do Lucas
  (`shared/o-que-busca.ts`); nenhuma libera serviço sozinha.
- **Onde:** `shared/tipo-da-oferta.ts` e `shared/o-que-busca.ts`.

## 14/09/2026 — idiomas novos na regra de serviço (revisão da PR #127, portada em 15/09)

- **O quê:** em fr, de, ru, hi, ar, zh e ja, onde as listas são curtas, o par que só não
  casa por palavra que elas não leem NÃO é bloqueado nos motores determinísticos: vale a
  categoria em comum, nunca 0 por falta de regra. pt, en e es seguem estritos.
- **Onde:** `regraNaoLeOPar` em `shared/tipo-da-oferta.ts`, usado por
  `server/match-service.ts` e `server/matching.ts` (commit `8896e1a`).

## 15/09/2026 — a marca passa a WRW

A marca passou de MMM (Mulheres que Movem o Mundo) a WRW (Women Rocking the World), com a
logo da Cris (commit `e794a48`). O nome técnico MMM continua onde está gravado (ver "Nome
gravado não se renomeia" no CLAUDE.md da raiz).

## 15 e 16/09/2026 — revisão do Nicolas na PR #135: oferta genérica com público

- **O quê:** a oferta GENÉRICA diante da necessidade da mesma família com só público ou
  finalidade ("Contabilidade" × "Contador para pequenas empresas", "Logística" ×
  "logística para exportar meu café") dava 0 e voltou a valer 60 (commit `d030b7d`).
- **Em aberto:** dar 100 quando o público está em `DESTINATARIOS_COMUNS` (dispara e-mail;
  a lista está marcada "a confirmar com o Roberto").
- **Onde:** `necessidadeGenericaNomeiaOServico` em `shared/tipo-da-oferta.ts`.

## 16/09/2026 — a entrega de 16/09 (PR #135)

- **O quê:** as specs da Dra. Glenda de 14/09 e os pedidos do grupo. Entre elas, o Termo
  Geral de Uso passa a ser exigido para concluir o cadastro, e cadastro não concluído não
  usa a plataforma (PRECONDITION_FAILED fora da lista liberada). O Termo Geral não se
  revoga à parte: quem não o aceita mais exclui a conta.
- **Em aberto:** contas que concluíram o cadastro antes do termo existir não são obrigadas
  a aceitá-lo; obrigar depende de decisão de produto.
- **Onde:** `server/cadastro-concluido.ts`, `server/termo-geral-de-uso.ts` e o
  `ProtectedRoute` do client.

## 16/09/2026 — cadastro só para maiores de 18 (PR #155)

- **O quê:** `profile.completeOnboarding` exige `declaraMaioridade: true` (cláusula 3.4 do
  Termo Geral), gravada em `audit_logs` como `AGE_MAJORITY_DECLARED` antes de concluir.
- **Onde:** `server/maioridade.ts` (commit `e616786`).

## 16/09/2026 — regra de status do quadro (PR #152, absorvida pela reorganização do CLAUDE.md)

- **Quem:** Roberto.
- **O quê:**
  - **"Feito (a validar)"**: a tarefa está pronta numa PR aberta, com CI verde, esperando
    validação. Quem fez move o cartão ao abrir a PR, com o link da PR na Comprovação.
  - **Validar** é trabalho de OUTRA pessoa, ANTES do merge: ler o diff (não o título),
    testar o que a PR diz e aprovar a PR no GitHub escrevendo o que conferiu. Quem fez não
    aprova a própria PR. Em 19/10, "outra pessoa" passou a ser outro LLM (abaixo).
  - **"Concluído"**: validado por outra pessoa E na `main`. O exame de produção depois do
    merge vem do fluxo que já existia na `main`; se ele falhar, o cartão volta para "Em
    andamento".
  - Tarefa sem código (painel de serviço, DNS, texto jurídico): "Concluído" quando já está
    em vigor e foi conferida por outra pessoa, com a evidência no cartão.
- **Antes:** o cartão só ia para "Feito (a validar)" depois do merge e do exame, e a
  validação era no link de teste.
- **Onde:** "Fluxo de trabalho" (regra de status do quadro) no CLAUDE.md da raiz e
  "Como trabalhamos" no README.

## 14/10/2026 — o carimbo fica

- **Quem:** Roberto.
- **O quê:** a conferência antes de commit e push continua obrigatória, com GitHub, Notion
  e o grupo do WhatsApp, registrada por `.claude/hooks/carimbo.mjs`, com textos de 20
  caracteres ou mais. Quem não consegue ler o grupo pergunta à pessoa o que houve lá e
  registra "informado por FULANA em DD/MM: resumo"; nunca inventa.
- **Onde:** `.claude/settings.json` e `.claude/hooks/carimbo.mjs`.

## 19/10/2026 — validar é outro LLM revisar

- **Quem:** Roberto.
- **O quê:** a validação antes do merge é a revisão de um LLM diferente do que fez a PR: o
  Claude de outra pessoa (com `/validar-tarefa`) ou outro modelo, como o Codex. O que conta
  são dois olhos de modelos diferentes; a equipe não programa, então não há revisão humana
  do código. Revisão humana só entra para mudança visual no app ou no site: alguém abre a
  tela e confere. Quem fez continua não validando a própria PR, e o que foi conferido fica
  registrado na PR.
- **Antes:** a regra de 16/09 dizia "outra pessoa", e dava para ler como revisão humana do
  código.
- **Onde:** passo 6 e "Regra de status do quadro" no CLAUDE.md da raiz, "Como trabalhamos"
  no README e o guia de entrada.

## 19/10/2026 — PowerShell do Claude com travas próprias (PR #160)

- **Quem:** Roberto.
- **O quê:** no Windows, a ferramenta PowerShell do Claude fica ligada e ganha no
  `.claude/settings.json` do projeto travas equivalentes às do Bash (push na `main`, push
  forçado, `git add -f`, ler o `.env`, scripts de banco). O Git Bash continua obrigatório
  para os scripts do pnpm. Para desligar a ferramenta: `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`.
- **Antes:** as regras eram só de Bash, e o PowerShell ficava sem trava na máquina de quem
  tinha regra PowerShell no settings do usuário.
- **Onde:** `.claude/settings.json` e CLAUDE.md da raiz.

## 10/11/2026 — login persistente: a sessão dura 90 dias desde o último uso

- **Quem:** Roberto.
- **O quê:** quem já entrou não digita e-mail e senha de novo. A sessão passou a ser
  deslizante: cada requisição autenticada empurra o prazo no banco para 90 dias à frente,
  e o token (JWT) e o cookie são reemitidos uma vez por dia. O corte de 30 minutos sem
  mexer na tela saiu, e o `/login` com a sessão viva segue direto para o destino do login.
  Sair da conta, redefinir a senha, excluir a conta e a desativação continuam encerrando a
  sessão na hora, porque o sdk confere a linha no banco em toda requisição.
- **Junto, porque a sessão longa os tornava graves** (revisão da PR #179): desativar a
  conta pelo painel passou a revogar as sessões; o botão "Revogar" da aba Sessões mandava o
  id da linha no lugar do id da conta; o "Sair" com o banco fora do ar responde erro em vez
  de sucesso; o cookie que o servidor recusa sai do navegador; o IP da sessão acompanha a
  usuária depois do primeiro alerta de IP novo; o cadastro e a redefinição de senha mandam a
  `/login?entrar=1`, que mostra o formulário mesmo com outra conta logada no aparelho.
- **Antes:** 8 horas fixas desde o login (no banco, no token e no cookie) e, no navegador,
  logout automático aos 30 minutos parada.
- **Onde:** `server/duracao-da-sessao.ts`, `assinarTokenDaSessao` e
  `renovarCookieDaSessao` em `server/auth.ts`, `validateSessionToken` em
  `server/security.ts`, `server/_core/context.ts` e `client/src/pages/Login.tsx`.

## 12/11/2026 — a reunião se compartilha por link aberto, por enquanto

- **Quem:** Roberto, na conversa com o Claude de 12/11: "quero que mude por enquanto para
  qualquer pessoa que esse link for compartilhado possa acessar tudo das funcionalidades
  [...], não só os participantes e admin".
- **O quê:** a dona liga o link de uma reunião pronta, e quem tem o endereço
  `/r/{token}` ouve a gravação, lê e traduz a transcrição e pede à IA o resumo e respostas,
  sem conta na WRW. O link é só leitura: excluir, reprocessar e o que é da rede particular
  da dona (contatos e entidades) continuam só com ela, e o nome dela não aparece. Ligar
  pede de novo a confirmação de que as pessoas que falaram autorizaram compartilhar, porque
  o consentimento da gravação foi para um áudio privado; a confirmação vai para
  `audit_logs`, com IP, user-agent, a frase que a dona viu, o idioma dela e o hash da
  frase, na mesma transação que liga o link. Desligar corta o
  acesso na hora (a página e os pedidos novos; quem já tinha a gravação carregada segue
  ouvindo até a URL assinada vencer, em até 1 hora), e o link novo sai com outro endereço.
  Os pedidos à IA pelo link têm dois tetos, os dois pela reunião: 10 por visitante (rede do
  IP) e 60 no total, a cada 10 minutos. O token é comparado com a caixa exata: a coluna
  herda a collation do banco, que não distingue maiúsculas.
- **Junto:** compartilhar é por WhatsApp e por e-mail (o app da própria dona abre com a
  mensagem pronta), em vez do Outlook que a H16 previa para a agenda.
- **Antes:** decisão de 10/11, "sem link público e sem senha": só as participantes
  adicionadas e, para consulta, a presidência e a admin (R1). Ela fica para depois.
- **Exceção a uma regra:** o áudio do link sai pela rota do token
  (`/reuniao-aberta/{token}/audio`), sem sessão. Os outros arquivos seguem só pelo proxy
  `/manus-storage/`, com sessão e posse. Como no proxy, a rota responde 307 para a URL
  assinada do bucket, e o endereço dela traz o caminho do arquivo: o openId da dona
  (aleatório, não o e-mail) e o id da reunião. Nenhum dos dois abre nada sem sessão.
- **Onde:** `server/link-aberto-da-reuniao.ts`, `server/routers/reuniaoAberta.ts`,
  `meetings.ligarLinkAberto` e `meetings.desligarLinkAberto` em `server/routers/meetings.ts`,
  `client/src/components/CompartilharReuniao.tsx` e `client/src/pages/ReuniaoAberta.tsx`;
  migração 0015 (`meetings.share_token`).

---

## Lições sem data registrada

Vieram no CLAUDE.md antigo sem data. Cada uma virou regra:

- **`sql.raw` proibido:** havia 21 pontos de SQL por concatenação, um deles permitia
  execução arbitrária no banco; todos foram eliminados.
- **Schema só por `db:generate` + `db:migrate`:** editar o `schema.ts` sem gerar a
  migração quebrou produção (a coluna existia no código e não no banco). Daí o passo do CI
  que falha se `pnpm db:generate` criar arquivo.
- **A suíte nunca lê `DATABASE_URL`:** o `.env` de trabalho apontava para produção e
  `pnpm test` promoveu uma usuária real e semeou contas fictícias no Aiven
  (`server/test/setup-banco.ts`).
- **Modelo de IA concreto:** o alias `gemini-flash-latest` passou a apontar para um modelo
  com cota gratuita de 20 requisições/dia e derrubou a IA em produção (`server/gemini.ts`,
  `server/_core/llm.ts`).
- **Título de commit não é evidência:** houve push na `main` com a tarefa marcada
  "concluída" no Notion e o código não resolvendo o que dizia. Daí o carimbo e a validação
  por outra pessoa.
