# Decisões tomadas

Registro datado das decisões que já valem no código, ou nas PRs já planejadas: quando,
quem decidiu, o que mudou e onde está. É o par de
[decisoes-em-aberto.md](./decisoes-em-aberto.md), que lista o que ainda trava por decisão
de produto.

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
  `renovarCookieDaSessao` em `server/sessao.ts` (até a A5 do plano do gravador, em
  `server/auth.ts`), `validateSessionToken` em `server/security.ts`,
  `server/_core/context.ts` e `client/src/pages/Login.tsx`.

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
- **Nota:** com a #208 (aberta), o link passa a mostrar o resumo guardado, no lugar do
  resumo pedido à IA (ver 15/11). As perguntas à IA continuam.
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

## 14/11/2026 — a gravação em partes fica atrás de um interruptor até a G13b

- **Quem:** a #202, que trouxe o gravador em partes (G9), mesclada em 14/11. Manter o
  interruptor até a G13b foi proposto no plano do gravador de 15/11 e aprovado pelo
  Roberto.
- **O quê:** o gravador em partes só liga com `/gravar?emPartes=1`. Sem o parâmetro, o
  gravador é o de sempre, com o envio único (`meetings.submitRecording`). O motivo, na
  #202: com o teto de 600 s por reunião ainda valendo, a gravação em partes teria uma
  parte só, e trocar o padrão mexeria em cerca de 80 testes de tela sem ganho para quem
  grava. A G13a (#209) ainda fica atrás do interruptor; a G13b faz das partes o padrão
  (ver 15/11, abaixo).
- **Onde:** `client/src/pages/Meetings.tsx` e `client/src/hooks/useGravacaoEmPartes.ts`.

## 14/11/2026 — os nomes das vozes ficam fora do link aberto

- **Quem:** a #204, em que a dona dá nome às vozes da transcrição (H3), mesclada em 14/11.
  Estender a regra ao texto que a IA escreve foi proposto no plano de 15/11 e aprovado
  pelo Roberto.
- **O quê:** a dona troca "Falante 1" por um nome, e só ela vê os nomes. O link aberto
  continua com "Falante n". Reprocessar a reunião apaga os nomes, porque a transcrição nova
  renumera as vozes.
- **No texto que a IA escreve** (o resumo, desde a #205): cada voz vai como `{F1}`, `{F2}`,
  e os nomes nunca vão ao prompt. O servidor não troca o token pelo nome; a tela troca,
  pelo nome para a dona e por "Falante n" no link aberto. Pelo plano, as duas exceções são
  as próximas ações (H5a), que gravam o nome quando a reunião é excluída ou reprocessada,
  e o lembrete no sino (H15), que troca o token na hora do aviso. O mapa mental (H10) não
  aceita token nos rótulos.
- **Em aberto:** mostrar os nomes no link é decisão de produto, a confirmar com a Glenda
  (#204).
- **Revista em 16/11:** o Roberto decidiu que o link mostra os nomes, com a confirmação
  nova da dona (ver 16/11, abaixo).
- **Onde:** a coluna `meetings.speaker_names` (migração 0016) e `nomearFalante` em
  `server/meeting-service.ts`. A troca do token na tela vem com `shared/vozes-no-texto.ts`,
  na #208 (aberta).

## 15/11/2026 — Face ID e digital voltam ao plano, com as chaves presas a `wrwglobal.org`

- **Quem:** Roberto, na conversa com o Claude de 15/11 que montou o plano do gravador da
  H4 em diante: a volta das chaves de acesso, o RP ID, as origens e a biblioteca. A
  posição na fila, logo depois da G13, foi proposta no plano de 15/11, com a ressalva "se
  preferir as passkeys no fim, é só dizer", e aprovada pelo Roberto.
- **O quê:** a sessão continua durando 90 dias desde o último uso (#179). Quando ela vence,
  ou num aparelho novo, a pessoa entra com Face ID ou digital, em vez de e-mail e senha, no
  site e no app. As chaves de acesso (WebAuthn) voltam ao plano logo depois da G13: a A6
  (servidor) e a A7 (tela).
  - **Domínio:** o RP ID é `wrwglobal.org`, e `WEBAUTHN_ORIGENS` leva
    `https://wrwglobal.org` e `https://www.wrwglobal.org`. A chave presa a `wrwglobal.org`
    vale com e sem www. No endereço `.onrender.com` ela não vale, e lá o botão não aparece.
  - **Biblioteca:** `@simplewebauthn/server` e `@simplewebauthn/browser` (MIT), pelo aval
    às bibliotecas seguras (abaixo).
  - **App:** o app das lojas (M1) vem depois da #180, a casca Expo do app, ainda aberta.
    Ele usa a mesma A6, com as chaves ligadas na WebView.
- **Antes:** o desenho deixava o RP ID para depois, a decidir pelo `FRONTEND_URL` de
  produção e pela existência do www.
- **Depende do Roberto:** pôr `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGENS` no Render. Até lá, a
  função fica invisível em produção.
- **Onde:** ainda não está no código. Entra na A6 e na A7.

## 15/11/2026 — bibliotecas aprovadas

- **Quem:** Roberto, em 15/11.
- **O quê:** a `mp4box` (importar M4A, MP4 e MOV, na H9c) e a `docx` (exportar em Word, na
  H8) estão aprovadas. Também está aprovada qualquer outra biblioteca segura: licença
  aberta, mantida e com a versão publicada há pelo menos duas semanas. Só entra
  dependência quando a plataforma não resolve bem.
- **Antes:** pelo desenho do gravador, nenhuma dependência nova entrava sem o aval do
  Roberto.
- **Onde:** nenhuma delas está no `package.json` ainda. Cada uma entra com a sua PR.

## 15/11/2026 — a gravação sem o teto de 10 minutos, com um OK a cada hora (G13)

- **Quem:** Roberto, em 15/11. O teto técnico de 12 h e a divisão em duas PRs foram
  propostos no plano de 15/11 e aprovados por ele.
- **O quê:**
  - sai o teto de 10 minutos da gravação;
  - a cada hora cheia de gravação, um aviso pequeno pede OK e fica ativo por 10 minutos;
  - sem o "Continuar gravando", a gravação para sozinha e o que foi gravado é entregue;
  - fora isso, só o "Encerrar" para a gravação. Ela não para ao fechar a aba compartilhada
    (H14) nem no horário de término de uma reunião agendada (H16);
  - um teto técnico de 12 h por reunião, no servidor, contra gasto: quem confirma a cada
    hora grava até 12 h;
  - a G13 vem logo depois da H4.
- **Antes:** pelo desenho de 10/11, a G10 avisava a cada hora completa de gravação, sem
  parar a gravação. A G13 só entrava com a bancada B aprovada (ver os testes, abaixo).
- **Em duas PRs:**
  - a G13a (#209, aberta) traz o aviso de hora e o teto de 12 h, ainda só no
    `/gravar?emPartes=1`. O envio único segue em 10 minutos e 10 MB até a G14;
  - a G13b, ainda sem PR em 15/11, faz das partes o padrão para todas, com o
    `?envioUnico=1` como saída de suporte até a G14. Junto vêm o "Descartar gravação", com
    confirmação, porque some a revisão antes de enviar, os avisos de parte recusada e de
    cópia no aparelho indisponível, o painel de minutos com o limite de 12 h por reunião,
    os textos que ainda falam em 10 minutos e o conserto do duplo clique em "Iniciar
    gravação". Esse defeito veio com a G9 e foi achado na revisão da #209: no modo em
    partes, o duplo clique cria duas reuniões, e a gravação em curso perde as partes.
- **Em aberto:** o faturamento do Gemini, com alerta de orçamento, sem resposta do Roberto
  em 15/11. A G13b libera gravações de horas para todas, e a H4c (#208, aberta) passa a
  gerar o resumo de toda reunião pronta (abaixo). Sem faturamento, a cota grátis pode
  travar também a transcrição.
- **Onde:** na #209, `shared/const.ts` (os tetos e o prazo do aviso),
  `server/fatias-de-reuniao.ts` (a parte até 720 s, até 200 partes e a soma até 12 h, com
  10 min de folga) e os novos `useAvisoDeHora` e `AvisoDeHoraDeGravacao`.

## 15/11/2026 — o teste que dá para automatizar entra na PR; o resto vira cartão

- **Quem:** Roberto, em 15/11, respondendo à pergunta sobre a bancada B do desenho: que o
  Claude teste o que puder, e que o que precisa de toque humano vire cartão no Notion para
  o Gabriel e o Nicolas testarem. O plano aprovado no mesmo dia aplicou a resposta a toda PR.
- **O quê:** o teste que dá para automatizar entra na PR. O que exige mão humana vira
  cartão no Notion para o Gabriel e o Nicolas, um por PR que precise.
- **Na G13:** isso troca a bancada B do desenho, que pedia reuniões reais de 45 minutos ou
  mais antes da G13. No lugar dela:
  - os testes de relógio falso e os de integração dos tetos, que estão na #209 (aberta);
  - um ponta a ponta com o microfone dublado e o relógio adiantado, previsto no plano de
    15/11 e ainda não rodado: a #209 diz que não o verificou;
  - a gravação real de mais de 1 hora, no cartão de teste humano "Gravação real de mais de
    1 hora", em produção com `?emPartes=1`. O roteiro está no desenho, em "As duas
    bancadas de teste".
- **Antes:** a G13 só entrava com a bancada B aprovada, e as reuniões reais para ela
  estavam entre as pendências do Roberto.
- **Onde:** fora do código: os cartões ficam no quadro do Notion.

## 15/11/2026 — o resumo guardado, também no link aberto (H4, H6 e H8)

- **Quem:** proposto no plano do gravador de 15/11 e aprovado pelo Roberto. O formato vem
  do app de referência que a Glenda mandou no grupo em 10/11.
- **O quê:**
  - o resumo fica guardado e passa a ser gerado sozinho, em segundo plano, quando a
    reunião fica pronta. O disparo automático só entra com a H4c (#208, ainda aberta); até
    lá, a produção segue com o resumo a pedido da #171. O resumo sai no idioma da reunião
    e no formato que a cliente pediu: ações com caixa de marcar, foco do trabalho, tarefas
    por assunto, decisões, bloqueios e questões pendentes. Cada item fica pendente até a
    dona confirmar;
  - reunião antiga, já pronta, não ganha resumo em lote: a dona toca em "Gerar resumo";
  - o link aberto mostra o resumo guardado: os itens confirmados e os pendentes, estes com
    um aviso de que foram gerados pela IA e a dona ainda não os conferiu. Os ignorados
    nunca aparecem;
  - na exportação (H8), só saem os itens confirmados;
  - o "Pergunte à reunião" (H6) lê até 400 mil caracteres da transcrição, cerca de 7 h, e
    recusa acima disso, com aviso. O resumo lê a transcrição inteira até o mesmo limite e,
    acima dele, em janelas (#205).
- **Antes:** o resumo da #171 era gerado a pedido, não ficava guardado e lia só os
  primeiros 24 mil caracteres. Pelo link, o visitante também pedia esse resumo à IA
  (12/11).
- **Em cinco PRs:** H4a1 (#205), a base, com as tabelas, o prompt e a conferência de cada
  item; H4a2 (#206), a fila que gera o resumo e as rotas para ler e decidir; H4b (#207), o
  player fixo no rodapé, um só para todas as abas; H4c (#208, aberta), o resumo na tela e
  no link aberto, com o disparo automático e o fim do resumo a pedido; e H4d, os modelos
  de resumo, que esperam a Glenda. As três primeiras estão no ar desde 15/11.
- **Em aberto:** o faturamento do Gemini, ainda sem resposta (ver a G13, acima). A H4c
  (#208, aberta) passa a gerar o resumo de toda reunião pronta.
- **Onde:** `server/resumo-da-reuniao.ts` e a migração 0017 (#205),
  `server/fila-do-resumo.ts` e `server/resumo-guardado.ts` (#206) e
  `client/src/components/BarraDoPlayer.tsx` (#207). O `ResumoGuardado.tsx` vem na #208. A
  H6 vem na PR da branch `feat/pergunte-com-tempos`, empilhada sobre a #208
  (`server/reuniao-com-ia.ts` e `client/src/components/ReuniaoComIA.tsx`): a resposta
  traz de 1 a 3 trechos, cada um com o "▶" do tempo. Nela, a pergunta sobre reunião longa
  (mais de 100 mil caracteres na entrada da IA, cerca de 1h45 de fala) gasta duas vagas
  do teto de pedidos à IA. O plano pedia o teto menor para o link aberto, por causa do
  custo; a revisão da PR estendeu a regra ao teto da dona. A H8 ainda não está no código.

## 15/11/2026 — a agenda fala com a Google Agenda pela API (H16)

- **Quem:** proposto no plano do gravador de 15/11 e aprovado pelo Roberto.
- **O quê:** a H16 vira três PRs.
  - **H16a:** a agenda na WRW (título, início, duração, fuso, local ou link, participantes
    e lembrete), o .ics gerado no navegador, o link de criação de evento da Google Agenda e
    o convite por WhatsApp e por e-mail, abertos no app da própria dona.
  - **H16b:** a dona conecta a própria conta Google, por OAuth. O refresh token fica
    cifrado; desconectar revoga o token, e a exclusão de conta também. Sem as variáveis, a
    função some.
  - **H16c:** a WRW cria, atualiza e exclui o evento na Google Agenda, com convidados e
    lembrete. O convite enviado pela conta Google da dona fica desmarcado por padrão.
  - A reunião agendada só ganha a gravação quando a dona toca em "Gravar agora", que abre o
    gravador com o título preenchido e liga a reunião. A agenda guarda só o ponteiro.
- **Antes:** em 10/11, pôr o evento na agenda pela API, com OAuth, ficava para depois,
  porque pede a verificação do app pela Google. Em 12/11, WhatsApp e e-mail entraram no
  lugar do Outlook.
- **Depende do Roberto, antes da H16b:**
  - no Google Cloud: ativar a Calendar API; o branding (nome WRW, e-mail de suporte e
    domínio verificado); o público "Externo", em modo Teste, com as contas da Glenda e do
    time como usuárias de teste; os escopos `openid`, `email` e `calendar.events`; e um
    cliente "Aplicativo da Web" com o retorno
    `https://wrwglobal.org/api/google-agenda/retorno`, mais outro para o localhost;
  - no Render: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` e
    `VAULT_ENCRYPTION_KEY` (só os nomes vão ao código). Se a `VAULT_ENCRYPTION_KEY` ainda
    não existir lá, criá-la torna ilegível o `encryptedSensitiveData` antigo de
    `server/matching.ts`, que hoje ninguém lê;
  - no modo Teste, o token vence em 7 dias. Para sair dele, a Google exige uma Política de
    Privacidade real (Cris) e um vídeo.
- **Onde:** ainda não está no código.

## 16/11/2026 — os nomes das vozes aparecem no link aberto (H3b)

- **Quem:** Roberto, 16/11, no chat: "se alguém atribuiu as vozes numa reunião e
  compartilhar com alguém o link, como tem no HiNoter, deveria sim estar o nome das vozes
  que foram atribuídas". O jeito de fazer (a versão da confirmação, o link antigo seguir
  com "Falante n" e o texto novo da caixa) foi proposto no desenho da H3b e vale enquanto
  o Roberto não o vetar.
- **O quê:** quem recebe o link vê os nomes que a dona deu às vozes: no resumo, na
  transcrição (as falas e o tempo de fala) e na resposta do "Pergunte à reunião". A voz
  sem nome segue "Falante n". `reuniaoAberta.ver` ganha um campo só, `vozes`
  (`{F1: "Ana"}`), lido de `meetings.speaker_names` por `nomesDosFalantes`: só as chaves
  F1 a F99, cada nome aparado e cortado em 60 caracteres. Nada mais da dona sai pelo
  link: nem o nome, nem o e-mail, nem a conta.
- **A confirmação nova:** a caixa que a dona marca ao ligar o link passa a falar dos
  nomes: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram que quem
  receber o link ouça a gravação e leia a transcrição, com os nomes que eu der às vozes."
  O "que eu der" cobre o nome dado depois de ligar o link, e o campo do nome da voz avisa
  que ele aparece também para quem tem o link. A tela manda a versão 2, que vai para os
  `details` da linha `MEETING_OPEN_LINK_ON`, na mesma transação que liga o link, junto da
  frase, do idioma e do hash. A aba aberta antes do deploy não manda versão e grava 1. O
  link mostra os nomes só quando a última linha `MEETING_OPEN_LINK_ON` da reunião tem a
  versão 2.
- **Link ligado antes:** segue com "Falante n" até a dona desligar e ligar de novo,
  porque a confirmação daquele dia não falava dos nomes. O painel de compartilhar avisa a
  dona quando há nomes e o link é da confirmação antiga (`meetings.get` devolve
  `linkMostraNomes`). O campo do nome da voz também avisa: quem tem esse link não vê o
  nome, e para mostrá-lo a dona desliga o link e compartilha de novo.
- **Os nomes não vão à IA:** a pergunta e o resumo seguem com o rótulo `{Fn}`, e a página
  do link troca o rótulo pelo nome. Perguntar pelo nome ("o que a Ana decidiu?") ainda
  não funciona: a IA não sabe quem é a Ana. Fica para a H6b.
- **Antes:** 14/11, "os nomes das vozes ficam fora do link aberto" (#204), com a pergunta
  em aberto para a Glenda.
- **Exceção a uma regra:** o nome dado à voz é a única coluna pessoal que sai pelo link,
  sem conta, coberta pela confirmação nova da dona. O nome da dona continua fora; se ela
  der à própria voz o próprio nome, ele sai como nome de voz, por escolha dela.
- **Com a Cris:** o texto novo da caixa (e a tradução dele nos outros 9 idiomas) e o ponto
  4 do rascunho do aviso de gravação, que passa a dizer que os nomes dados às vozes
  aparecem também pelo link. O aviso muda na versão nova, com a H6b.
- **Onde:** `linkMostraOsNomes` em `server/autorizacao-do-link-aberto.ts`;
  `ligarLinkAberto` e `verReuniaoPeloLink` em `server/link-aberto-da-reuniao.ts`;
  `meetings.ligarLinkAberto` em `server/routers/meetings.ts`; `getPrivateMeeting` em
  `server/meeting-service.ts`; `VERSAO_DA_AUTORIZACAO_COM_NOMES` em `shared/const.ts`; na
  tela, `CompartilharReuniao.tsx`, `TranscricaoPorFalante.tsx` e `ReuniaoAberta.tsx`. Sem
  migração.

## 16/11/2026 — a reunião se exporta só em PDF, por enquanto (H8)

- **Quem:** Roberto, 16/11, ao mandar fazer a H8: só PDF nesta entrega.
- **O quê:** a dona baixa a reunião pelo "Baixar PDF" do detalhe. O PDF leva o título com
  o emoji do resumo e a data, os itens do resumo que ela CONFIRMOU (nas seções da tela,
  com o responsável, o prazo e a caixa da ação) e a transcrição com os tempos e os nomes
  das vozes. Os rótulos saem no idioma da reunião, dos 10 JSONs. Antes de baixar, um
  aviso diz o que vai no arquivo.
- **Como:** o PDF sai da impressão do aparelho (`window.print()` sobre um documento
  próprio, com `@media print` e fundo branco), e não de biblioteca. As fontes do sistema
  já têm o árabe (da direita para a esquerda), o hindi, o chinês e o japonês, no celular
  e no computador. Uma biblioteca no navegador pediria fontes embutidas de vários
  megabytes e não montaria as letras do árabe nem do hindi; no servidor, pediria um
  navegador sem tela na instância de 2 GB.
- **Regras:** só a dona exporta (o link aberto não tem o botão nem rota); a leitura e a
  auditoria `MEETING_EXPORTED` vão na mesma transação, e sem a linha nada sai; teto de 30
  exportações a cada 10 minutos por dona, contando só as que saíram.
- **Antes:** o plano de 15/11 previa TXT, Markdown, SRT, Word (com a `docx`, aprovada em
  15/11) e PDF.
- **Fica de fora:** TXT, Markdown, SRT e Word; a `docx` não entra no `package.json`. Na
  casca das lojas (PR #180, uma WebView), a impressão pode não abrir sem código nativo: no
  app instalado, o aviso manda abrir a reunião no navegador.
- **Com a Cris:** o texto do aviso (`meetings.export.notice`) e a tradução dele nos outros
  9 idiomas.
- **Onde:** `server/exportar-reuniao.ts`, `meetings.exportar` em
  `server/routers/meetings.ts` e `shared/exportar-reuniao.ts`; na tela,
  `ExportarReuniao.tsx`, `ImpressaoDaReuniao.tsx` e o trecho "Exportar a reunião em PDF"
  de `client/src/index.css`. Sem migração.

## 21/11/2026 — o gravador sem o envio único, com o recuo do corte (G14, parte 1)

- **Quem:** o Claude, no pacote 5b do gravador, pelo pedido de fazer a G14 "pelo caminho
  mais seguro e vetável". Decisão vetável pelo Roberto.
- **O quê:** o gravador grava sempre em partes. Saíram o `?envioUnico=1` (a URL antiga
  grava em partes, como o `?emPartes=1` da G9), a revisão antes de enviar ("Transcrever
  áudio", "Descartar e gravar novamente") e os textos dos 10 minutos e 10 MB onde as
  partes já cobrem o caso (a dica sob o relógio, o FAQ da Home e a ajuda do painel de
  minutos). A gravação ganha em todas as URLs o que era só das partes: a cópia no
  aparelho, a retomada, o aviso de hora, a entrega ao sair da tela e o Descartar com
  confirmação.
- **O que ficou, e por quê:**
  - `meetings.submitRecording`, com os 10 minutos e 10 MB: é o recuo do corte do pacote
    4b (o arquivo curto de um formato que o corte reconhece mas não lê, como o ALAC do
    Gravador do iPhone, o AC-3 e o Vorbis no WebM). Sem ele, esse arquivo só receberia o
    aviso de converter. A tela o marca com `recuoDoCorte: true`;
  - a rota também fica para um cliente de fora do repositório, se houver (a pergunta ao
    Roberto sobre o "app Expo" segue sem resposta, e o log de produção não foi lido):
    cada chamada deixa uma linha `[Reuniões] envio único (submitRecording)`, com a marca
    do recuo ou sem ela;
  - os tetos do envio único seguem no servidor também porque o reprocesso e a junção
    (H17) leem a gravação inteira das reuniões antigas com eles;
  - o ditado e a voz do contato não usam o envio único da reunião: têm rotas próprias
    (`assistenteTexto.transcrever`, 2 minutos e 3 MB, e
    `networkInteligente.complementarPorVoz`) e não mudaram.
- **Antes:** a G13b (15/11) fez das partes o padrão e deixou o `?envioUnico=1` como saída
  de suporte até a G14. O desenho pedia, para tirar o envio único, uma semana de logs sem
  `submitRecording`, nenhum cliente externo e a H9b pronta (pronta desde o pacote 4b).
- **Por fazer (parte 2):** tirar a rota, ou levar o recuo do corte às partes (o arquivo
  inteiro como uma parte só), depois de uma semana de log sem chamada sem a marca do
  recuo e com o aval do Roberto.
- **Onde:** `client/src/pages/Meetings.tsx` (`enviarPeloEnvioUnico` e `importarArquivo`),
  `client/src/hooks/useGravacaoEmPartes.ts` (sem o modo inativo), `meetings.submitRecording`
  em `server/routers/meetings.ts`, o FAQ em `server/routers/faq.ts` e
  `networkPanel.minutesLimitHelp` nos 10 JSONs. Sem migração.

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
