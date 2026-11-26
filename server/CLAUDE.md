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

Body parsers: 5 MB por padrão e 15 MB em SETE procedimentos de upload —
`meetings.submitRecording`, `meetings.anexarAoResumo` (as fotos e os desenhos do resumo,
H4g e H4h), `contexts.uploadMedia`, `network.uploadPhoto`,
`network.uploadCard`, `dealRoom.uploadDocument` e `sivc.uploadDocument`. Antes deles vem
`corpoGrandeParaUploads` (`_core/corpo-grande-para-uploads.ts`), que reconhece os mesmos
procedimentos quando chegam dentro de um LOTE do tRPC (`/api/trpc/a,b` não casa com
nenhum recorte por caminho). Upload novo entra nos dois lugares. O lote tem teto: até
`CHAMADAS_POR_LOTE_MAX` chamadas (50, `shared/lote-do-trpc.ts`), e o navegador corta os
dele em 20, porque o limite da API conta o lote inteiro como um pedido.

`meetings.submitRecording` (o envio único: o áudio inteiro, em base64, até 10 min e 10 MB)
não é mais caminho do gravador desde a G14: a tela só o chama no recuo do corte (o arquivo
curto de um formato que o corte reconhece mas não lê), com `recuoDoCorte: true`, e cada
chamada deixa no log a linha `[Reuniões] envio único (submitRecording)`, com a marca ou sem
ela (a sem marca é de um cliente de fora do app). Áudio novo de reunião vai pela rota das
partes, abaixo.

A exceção é binária: as partes da reunião gravada em partes chegam por
`POST /api/reunioes/{meetingId}/partes/{seq}` (`_core/rota-das-partes.ts`, até 16 MB de áudio
cru, autenticada pelo cookie), montada ANTES de todo `express.json`; a ordem é guardada por
`server/agendados-autenticacao.test.ts`. A linha da parte é gravada antes do upload, com a
chave exata do objeto (`storagePut(..., { chaveExata: true })`). O documento da reunião
(H12 e H12b: o PDF, ou as fotos de um texto juntas num PDF no aparelho) chega do mesmo
jeito, por `POST /api/reunioes/{meetingId}/documento` (`_core/rota-do-documento.ts`, até
15 MB, 10 por hora por dona, autenticada antes de ler o corpo), e o `GET` do mesmo endereço
devolve o PDF guardado só à dona; os arquivos do leitor de PDF da tela saem por
`/pdfjs/<versão>/` (`_core/arquivos-do-leitor-de-pdf.ts`).

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

**Mas Ouro NÃO é staff em tudo.** São CINCO os pontos em que admin e president valem
mais que Ouro (a frase "a única assimetria é `isStaff`" era falsa). Antes de repetir
qualquer contagem, rode `grep -rn "role ===\|role !==\|users.role" server --include=*.ts`
e confira:

1. **Abrir oportunidade que não é sua**: `isStaff` em `oportunidade-acesso.ts` — uma conta
   Ouro APROVA uma oportunidade pendente e leva 403 ao tentar ABRI-LA.
2. **Rastreabilidade das conexões**: `plataformaProcedure` em `routers/_procedures.ts`,
   usado em `routers/networkInteligente.ts` (a lista de conexões registradas de todas as
   donas e a apuração de comissão, com auditoria `NETWORK_CONNECTIONS_READ`; a aba some do Painel
   Ouro para Ouro sem cargo).
3. **Bloqueio automático por eventos críticos**: `checkAutoLockThreshold` em
   `server/security.ts` isenta president e admin — conta Ouro é desativada como qualquer
   outra ao cruzar o limite.
4. **Quem é avisada**: os destinatários de "oportunidade aguardando análise"
   (`routers/opportunities.ts`) e de "não há distribuidor" (`idsDaPresidenciaAtiva` em
   `db.ts`) são president e admin; Ouro não recebe nenhum dos dois, embora possa agir
   sobre o primeiro.
5. **Consultar a reunião gravada de outra conta** (R1a): `routers/consultaDeReunioes.ts`,
   com o mesmo `plataformaProcedure`. Abrir pede o motivo e grava `MEETING_ADMIN_READ` na
   transação antes de ler (`server/consulta-da-administracao.ts`); a lista grava
   `MEETINGS_ADMIN_LIST`; as duas sobrevivem à exclusão da conta de quem consultou; a
   reunião gravada antes do aviso 2026-11-23 fica fechada; o áudio sai por
   `/consulta-da-administracao/{id}/audio`, com a consulta aberta na última hora; a dona vê
   só as datas (`meetings.consultasDaAdministracao`).

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

**O resumo por e-mail (H22, `server/resumo-por-email.ts`)** é o único e-mail que a WRW
manda a terceiros: o link aberto da reunião, a quem a dona escolhe (ela, participantes da
agenda, até 10 e-mails digitados), com texto fixo no idioma da reunião (`emailDoResumo.*`
dos JSONs da tela, importado por `server/email-do-resumo.ts`). Link desligado só liga com a
confirmação do "Compartilhar", na mesma transação das linhas de `resumo_por_email` e da
auditoria. O envio automático vai só à dona, com o link da conta, e nunca liga o link.
O texto segue a senha e o áudio do link na hora de cada envio (H23): sem o áudio, não
promete a gravação; com a senha, diz que ela não vai no e-mail (ela nunca vai) e o aviso
de encaminhamento fala do link e da senha (`avisoComSenha`). O link
que o envio liga é o de antes da H23, sem senha e com o áudio, salvo na reunião sem gravação
(a de documento, H12 e H12b, e a de vídeo do YouTube, H13; `reuniaoSemGravacao`): o link
dela liga sem o áudio, a caixa e a prova são a frase da origem, como no "Compartilhar", e o
e-mail nunca promete a gravação (nem no link antigo, com o `share_audio` verdadeiro do padrão
da 0023) nem diz que a reunião foi gravada (`emailDoResumo.*SemGravacao`).

**A legenda ao vivo (G15b, `server/legenda-ao-vivo.ts`)** é do navegador da dona: o
texto dela nunca chega ao servidor. `meetings.ligarLegendaAoVivo` só grava a confirmação
da dona (o aviso que ela viu, com o hash, e a concordância das pessoas) em `audit_logs`
(`MEETING_LIVE_CAPTION_ON`), na transação com a leitura travada da reunião dela que está
gravando (pela `reuniaoVisivel()`, o ponto da regra da lixeira); sem a linha, a tela não
liga a legenda.

**Nada extraído por IA entra sozinho:** no enriquecimento, só sugestões com
`confidence >= 0.7` viram pendência (`routers/enrichment.ts`); entidades e sugestões de
reunião nascem `pending`; o SIVC pondera a fonte em `CONFIDENCE_WEIGHTS`.

**Da reunião ao perfil e às conexões (N5, `server/reuniao-no-match.ts`):** decidida a
pessoa da reunião (criar, vincular ou "Sou eu"), a dona confirma cada Tenho/Preciso ali
mesmo. No "Sou eu" o destino é o PERFIL dela (`network_sugestoes.alvo = 'perfil'`): o
"tenho" vai a `whatIHave`, o "preciso" vira demanda de "O que preciso", item que nomeia
alguém da reunião é recusado e o motor de perfis recalcula uma vez por reunião. A origem do
item é a linha confirmada de `network_sugestoes` (excluir a reunião a apaga; o item fica).
O portão derruba o "preciso" hipotético (`necessidadeHipotetica`): conta o verbo que rege o
item, com modal ("poderia precisar", "talvez a gente precise", "pode ser que") ou condição
("se a gente precisar"); a menção sem verbo não sustenta a hipótese, e "eventualmente
precisamos" é declarada. Forma nova entra com teste negativo e positivo.

## A base das associações (N1, `server/entidades.ts`)

A entidade (federação, associação, sindicato) é UMA conta com o poder `users.isEntidade`
(`entidadeProcedure`, como o distribuidor) e uma linha em `entidades`; cada associado é um
contato da rede dela, com o código anônimo, e uma linha em `entidade_membros` com o CNPJ só
em HMAC (`ENTIDADES_HMAC_KEY`) e cifrado, os contatos cifrados e as CNAEs (que NUNCA viram
necessidade). A carga vem da planilha lida no aparelho, em blocos de 500 com transação, e
só com o convênio vigente; o cruzamento global tira as entidades sem convênio
(`entidadesSemConvenio`). Desenho, decisões e limites (o teto de 1000 da rede global e o
motor privado quadrático: não carregar base real antes da N4b, o índice) em
`docs/arquitetura/entidades.md`. A ativação do cadastro importado (N3,
`server/entidades-ativacao.ts`) é um link por associado, de uso único e com validade, só em
hash; ativar cria a conta com só o que a pessoa confirmou, marca o associado `ativado` e tira o
contato da entidade da rede global, numa transação com a auditoria (seção 9a do desenho).

**A CNAE como oferta (N4, `server/cnae.ts`):** a tabela da
CNAE 2.3 do IBGE (`server/cnae/cnae-2-3.json`, com fonte e data) vira item de "o que tem" com
`contact_assets.origem = 'cnae'`, sem categoria, sem a cláusula "exceto" e sem as subclasses
residuais; nunca vira necessidade (`contact_needs` não tem a coluna). O match só nasce de uma
necessidade declarada, pelas regras de sempre. Tabela nova: `refazerOfertasDaCnae`.

**O pedido de contato pela entidade (N2, `server/pedidos-pela-entidade.ts`):** na conexão
da rede global com um associado, quem está do outro lado vê só "membro da entidade X" (o
nome com a autorização do convênio) e pede o contato; a entidade encaminha à empresa e
registra o aceite com o canal. O telefone e o e-mail saem decifrados só no aceito, a quem
pediu, com a auditoria na transação. A anotação das conexões é uma leitura à parte
(`anotarConexoesComEntidade`), fora de `listarConexoesDaSolicitante`. Seção 12 do desenho.

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
e "Serviços contábeis" × "Contador", também com o destinatário comum dos dois lados —
decisão do Roberto de 16/09: "Contabilidade para pequenas empresas" × "Contador",
"Contabilidade" × "Contador para MEI", "Contador de MEI" ou "Contador MEI", "Contabilidade
para MEI" × "Contador de MEI"; depois de "para" vale a lista `DESTINATARIOS_COMUNS` (MEI,
pequenas empresas, startups, negócios, clientes...), e sem "para" só o inequívoco
(`destinatarioNosLemas`: MEI, EPP, startup, o porte com a empresa, pessoa física), porque
ali "de" também é assunto: "Consultoria de negócios", "Advogado de empresas" e "Tradutor
particular" não são destinatário —, `mesmaFamiliaEEspecialidade`), necessidade que nomeia
só a família do serviço → 60 (`necessidadeGenericaNomeiaOServico`, que inclui a oferta
GENÉRICA diante da necessidade da mesma família com finalidade ou público que não é
destinatário comum — "Logística" × "logística para exportar meu café", "Marketing" ×
"Marketing para restaurantes" — e, quando o texto PEDE o serviço (marca de pedido de
pt/en/es antes dele, `pedidoPedeOServico`), com complemento que as listas não conhecem —
"Advocacia" × "Preciso de advogado marítimo", "Contabilidade" × "Procuro contador rural" —,
salvo o complemento que nomeia contraparte em qualquer alternativa (`PAPEIS_DE_COMERCIO`,
`SOCIOS` e o que a decisão nomeia: representante e parceiro comerciais, atacadista,
franqueado, cliente...), que dá 0: "Preciso de consultoria de distribuidor"; decisões do
Roberto de 16/09; sem o pedido, "advogado marítimo" e "We are maritime lawyers" seguem 0; e
a prestadora que PROCURA clientes — "Contador procura clientes", marca de pedido depois do
serviço — não pede o serviço e dá 0, `servicoEhQuemPede`), necessidade que declara o ASSUNTO do serviço
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
  nenhum serviço do perfil presta é barrada quando não nomeia serviço; "Preciso de
  consultoria de distribuidor" e "Contador procura clientes" ainda passam ali, limite em
  `docs/arquitetura/README.md` §2c). Oportunidade que OFERECE serviço só vai a
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
(`sdk.ts`), e-mail (Resend), storage S3 com URLs assinadas, Vite em dev. A sessão de
usuária nasce só por `abrirSessao` (`server/sessao.ts`: a linha em `sessions` e o JWT com o
`sessionToken` dela, 90 dias desde o último uso), e o `sdk.authenticateRequest` recusa JWT
de usuária sem `sessionToken`, que escaparia da revogação (só o cron, openId `cron_`, passa
sem ele).

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
  origem e valor e também cai no padrão. O boot imprime `[IA] áudio … · reserva … · texto …
  · extração … · resumo … · pergunta …` sem a chave (id de outro provedor no texto sai como
  "fora do log", porque a guarda do texto não o distingue de uma chave colada no campo
  errado), e logo depois `[IA] raciocínio · extração … · resumo … · pergunta …`. Os ids que
  a chave do Gemini enxerga saem de `node scripts/listar-modelos-gemini.mjs`.
- **Modelo de texto por função:** quem chama `invokeLLM` (ou `pedirJsonAIA`, de
  `server/ia-em-json.ts`, onde a função é obrigatória) passa a `funcao`, e não o id. A
  ordem é `LLM_MODEL_<FUNÇÃO>` > o padrão da função no código > `LLM_MODEL` > o padrão
  (`FUNCOES_DE_TEXTO`, em `_core/modelos-de-ia.ts`); o padrão da função só vale com o
  `LLM_API_URL` na API do Gemini. As três que a bancada mediu não têm padrão próprio (seguem o
  `LLM_MODEL`): a extração da reunião (`extracao`), o resumo guardado (`resumo`) e o
  Pergunte (`pergunta`). A quarta, a escolha do modelo do resumo (`escolha_do_modelo`, H4e,
  `server/escolha-do-modelo.ts`), nasceu no `gemini-3.5-flash-lite`. O Lite que a bancada A de texto (16/11) indicou para a extração
  não devolveu as entidades de cargo, ativo, necessidade e oportunidade, que a tela usa:
  leia o `docs/deploy.md` antes de trocar. Chamada nova de texto sem função fica no
  `LLM_MODEL`; função nova entra na tabela, no `docs/deploy.md` e no `.env.example` (um
  teste confere os dois).
- **Raciocínio:** o `invokeLLM` manda `reasoning_effort`, no nível de cima do corpo, só
  quando recebe `raciocinio`. Os campos `reasoning` e `thinking` saíram: o endpoint do
  Gemini compatível com a OpenAI recusa os dois com 400. Passados por fora do tipo (de um
  script em JS), eles e o `reasoning_effort` falham antes do fetch, em vez de sumirem em
  silêncio. A extração, o resumo guardado e o Pergunte pedem o nível da variável da
  própria função (`LLM_RACIOCINIO_EXTRACAO`, `LLM_RACIOCINIO_RESUMO` e
  `LLM_RACIOCINIO_PERGUNTA`, guarda em `_core/raciocinio-de-ia.ts`, lidas a cada chamada);
  sem ela, nada vai e o modelo raciocina no padrão dele. As funções do raciocínio são as
  mesmas do modelo (`FuncaoDeTexto`, um tipo só).
- **Função que a bancada não mediu** (o mapa mental, a tradução do resumo, o e-mail de
  retorno) passa `funcao: null` ao `pedirJsonAIA`: fica no `LLM_MODEL`, sem raciocínio, e
  não lê nenhuma das variáveis de função. Rotulá-la com uma das três a faria seguir as
  variáveis de outra. A `funcao` é obrigatória justamente para isso: num merge que
  reescreva quem chama, o `pnpm check` acusa a função que sumiu, em vez de o pedido voltar
  ao `LLM_MODEL` em silêncio enquanto as linhas `[IA]` do boot mostram o da função.
- **Arquivos** (áudio de reunião, documentos, mídia de contexto) vão para storage
  compatível com S3 (`STORAGE_*`; Backblaze B2 em produção), servidos pelo proxy
  autenticado `/manus-storage/*`, que exige sessão e posse. Esse prefixo está gravado nas
  URLs do banco: não renomeie sem migração de dados. A única exceção é o áudio da reunião
  com link aberto (decisão do Roberto de 12/11/2026, "por enquanto"): sai por
  `/reuniao-aberta/{token}/audio`, sem sessão, só enquanto a dona mantém o link ligado
  (`server/link-aberto-da-reuniao.ts`; procedimentos públicos em `routers/reuniaoAberta.ts`).
  As fotos e os desenhos do resumo (H4g e H4h, `server/anexos-do-resumo.ts`, tabela
  `meeting_attachments`) saem pelo link do mesmo jeito, por
  `/reuniao-aberta/{token}/anexo/{id}`, com a senha do link; tirar o áudio do link não os
  tira. Seguem a regra do PDF da reunião: 30 dias, a varredura, a exclusão da reunião e
  da conta; o servidor confere o conteúdo e tira os metadados (o GPS do EXIF).
  Desde a H23 a dona tira o áudio do link (a consulta deixa de servi-lo) e põe uma senha
  de 6 dígitos: o link com senha só abre com o cookie HttpOnly de quem a acertou
  (`reuniaoAberta.entrar`), conferido em `reuniaoDoLink` pelos cookies que
  `procedimentoDoLink` põe no contexto do pedido. Procedimento novo pelo token usa
  `procedimentoDoLink`; `server/link-com-senha-rota.test.ts` varre o router.
  O download do áudio pela dona (H8c) também não passa pelo proxy: sai por
  `GET /api/reunioes/baixar-audio/{ficha}` (`_core/rota-do-audio-baixado.ts`), com a ficha
  de uso único de `meetings.baixarAudio` e a sessão da dona; o servidor lê as partes do
  bucket e as converte com o ffmpeg da imagem (`server/conversao-do-audio.ts`), que roda
  sem as variáveis do servidor e, com o Node como root, como o usuário nobody (se o sistema
  recusar a troca, o ffmpeg não sobe e o download fica indisponível: como root, ele leria o
  ambiente do servidor em `/proc/1/environ`).
- **Segredos:** `JWT_SECRET` é obrigatória — o servidor se recusa a iniciar sem ela
  (`requireSecret()` em `server/_core/env.ts`, chamado ao carregar `server/sessao.ts`).
  `VAULT_ENCRYPTION_KEY` deve existir em produção, mas o código não a exige: sem ela,
  `server/security.ts` e `server/matching.ts` derivam a chave do cofre do `JWT_SECRET`.
  A exceção é a Google Agenda (H16b, `server/google-oauth.ts`): sem ela, com 32
  caracteres ou mais, a conexão some, porque o refresh token não pode ficar preso ao
  `JWT_SECRET`.

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
A reunião que nasceu de um documento (origem `pdf` ou `foto`, `server/documento-da-reuniao.ts`)
se reprocessa pelo PDF guardado em `meeting_documents`, que segue a regra do áudio: 30 dias,
a varredura, a exclusão da reunião e da conta, e a falha grava um CÓDIGO em
`processing_error` (`shared/documento-da-reuniao.ts`), que a tela traduz.

## Organizar as reuniões: detalhes, busca, junção, pastas e lixeira (H7c, H7b, H17 e H7d)

- **Detalhes** (`server/detalhes-da-reuniao.ts`): etiquetas e "Onde foi" (colunas de
  `meetings`), contato e contexto. A posse do contato (da dona) e do contexto (dela ou do
  catálogo) é conferida em `meetings.create`, `iniciarGravacao`, `iniciarDocumento` e
  `atualizarDetalhes`, com o código traduzido (`shared/detalhes-da-reuniao.ts`). O `updated_at`
  (a ficha de quem processa a reunião) só muda com o título, e nunca em 'processing'. Excluir um
  contexto (`deleteContext`) anula `meetings.context_id` das reuniões da dona, na mesma
  transação. O link aberto não leva nada disto.
- **Busca** (`server/busca-de-reunioes.ts`): LIKE parametrizado com `ESCAPE '!'` na
  transcrição e nos itens não ignorados, a dona nas duas tabelas, o trecho cortado no SQL
  (SUBSTRING/LOCATE), até 30 resultados e teto de 120 a cada 10 min. A etiqueta do filtro
  vale pela chave da tela (`chaveDaEtiqueta`, sem caixa), e não pela grafia exata.
- **Junção** (`server/juntar-reunioes.ts`): uma transação, sem bucket, move as LINHAS das
  partes para a primeira reunião (posição, início, falas e rótulos deslocados; a gravação do
  envio único vira parte 'received', e dali em diante tudo é transcrito de novo), apaga o
  que a IA gerou das outras e do alvo, desliga o link aberto (com a senha) e grava
  `MEETINGS_JOINED`, com a hora e a versão do aviso de gravação de cada reunião; a fila
  monta. A primeira parte retranscrita de cada reunião leva a marca de outra conversa
  (`MARCA_DE_OUTRA_REUNIAO`): a fila a transcreve sem o contexto da anterior e com os
  rótulos depois dos já usados, para vozes e nomes não passarem de uma reunião à outra.
  Por isso a montagem passa `zerarNomes: false` a `gravarResultadoDaReuniao`, e quem
  transcreve de novo zera os nomes antes (o reprocesso das partes, na tomada).
- **Pastas** (`server/pastas-de-reunioes.ts`, H7d): nome, ícone e cor de listas fechadas
  (`shared/pastas-de-reunioes.ts`), até 50 por dona, nome sem repetir (sem caixa nem
  acento) e uma pasta por reunião (`meetings.folder_id`). Apagar a pasta solta as reuniões
  dela na mesma transação; mover é todo ou nada e não mexe no `updated_at`. O link aberto
  não leva a pasta.
- **Lixeira** (`server/lixeira-de-reunioes.ts`, H7d): exclusão ADIADA, por
  `meetings.trashed_at`. Mandar para a lixeira desliga o link aberto (com a senha), tira os
  avisos da reunião do sino e grava `MEETINGS_TRASHED`, na mesma transação; a gravação em
  partes ainda no ar não vai (CONFLICT `LIXEIRA_GRAVANDO`). A reunião na lixeira sai de toda
  consulta: as entre reuniões (lista, busca, Memória, link aberto, filas, pendências,
  agenda, perfil do contato) filtram por `server/reuniao-visivel.ts`, e todo procedimento
  de `routers/meetings.ts`, menos os cinco da lixeira e o Excluir imediato
  (`meetings.delete`, o do descarte da gravação, que tira a reunião de vez também da
  lixeira), passa pela guarda `procedimentoDaReuniao` (`server/guarda-da-lixeira.ts`, com a
  varredura do router em `server/guarda-da-lixeira.test.ts`). A guarda recusa com NOT_FOUND
  e o código `REUNIAO_NA_LIXEIRA` (só a dona o recebe: ela lê só as reuniões da dona, e o id
  de outra conta segue "não encontrada"), e o detalhe diz que a reunião está na lixeira,
  com o restaurar. A rota das partes ACEITA a
  parte atrasada da reunião em `uploading` que foi para a lixeira (a tela apagaria a única
  cópia no 404): a fila não a transcreve enquanto ela está lá, e restaurar devolve a reunião
  inteira. Consulta nova de reunião filtra por ali. Restaurar vale por 30 dias e devolve a reunião à pasta, com o
  link desligado; apagar de vez, esvaziar e o fim dos 30 dias (a varredura das gravações,
  `esvaziarLixeiraVencida`) passam por `deletePrivateMeeting`. A lixeira não muda o prazo
  do áudio.

## As participantes da reunião e as vozes ligadas às contas (R1b e H3c)

`server/participantes-da-reuniao.ts` e `server/vozes-da-reuniao.ts`, tabela
`meeting_participants` e as colunas `meetings.speaker_accounts` e `speaker_merges`. A dona
convida por link de uso único (`/convite/{token}`, 192 bits, só o sha256 no banco, 7 dias) ou
uma conexão ACEITA dela; nunca por e-mail digitado (revelaria quem é membro, e o e-mail não é
verificado). A primeira vez em cada reunião pede a confirmação de que as pessoas que falaram
autorizaram (`MEETING_PARTICIPANTS_AUTHORIZED`, por `tx.insert(auditLogs)`). Até 50 por
reunião e 30 convites a cada 10 min por dona. A participante LÊ pelas mesmas consultas do link
aberto, com a credencial `participante:<id da reunião>` no lugar do token: `reuniaoDoLink`
abre pela participação ATIVA da conta logada (a leitora, que `procedimentoDoLink` e as rotas
do áudio e da imagem põem no contexto do pedido) e nunca pelo token; a reunião na lixeira, a
dona desativada, a saída e a remoção cortam na próxima leitura. A participante não muda nada:
todo procedimento que muda a reunião tem a dona no WHERE. As vozes guardam `"owner"` ou o id
da PARTICIPAÇÃO (nunca o `users.id`), e o nome da conta é resolvido na leitura
(`vozesParaQuemLe`); reprocessar e juntar reuniões zeram as três colunas das vozes
(`VOZES_ZERADAS`). A exclusão da reunião e da conta (das duas pontas) levam as participações.

## O perfil de voz da dona (H3d)

`server/perfil-de-voz.ts` (router `perfilDeVoz`), `shared/perfil-de-voz.ts`, tabelas
`voice_profiles` (uma linha por dona) e `voice_profile_consents`, e a seção do Perfil
(`client/src/components/PerfilDeVoz.tsx`). A dona grava 10 a 60 s da própria voz (a tela pede
cerca de 30 s, lendo um texto; até 1 MB, o conteúdo conferido pelos primeiros bytes), guardados
no bucket sob `perfis-de-voz/<openId>/`, prefixo que o proxy `/manus-storage` nega a todo
mundo: só a dona ouve, por `perfilDeVoz.ouvir`, e o link aberto, as participantes e a
consulta da administração (R1a) nunca leem a amostra. É dado biométrico (LGPD art. 11):

- a primeira gravação exige o consentimento da caixa (texto da Cris, desmarcada, separada do
  aceite dos Termos), com a versão do texto (`VERSOES_DO_TEXTO_DO_PERFIL_DE_VOZ`), o idioma e
  o texto exibido; `voice_profile_consents` guarda cada consentimento e cada revogação (data,
  hora, versão, idioma, texto e hash, IP e navegador, sem a voz), nunca recebe UPDATE e
  sobrevive à exclusão do perfil e da conta;
- desligar é DEFINITIVO: na transação com a linha travada, a linha sai, a revogação entra e a
  amostra sai do bucket com TODAS as versões (`storageApagarTodasAsVersoes`); se o bucket
  recusar, a transação desfaz e nada muda. Regravar apaga a antiga do mesmo jeito antes de a
  troca valer, sem pedir a caixa de novo. A exclusão da conta registra a revogação (origem
  `exclusao_da_conta`), apaga a amostra com todas as versões e a linha
  (`server/exclusao-de-conta.ts`, regra 7); o exame de produção não grava perfil;
- a fila (`server/fila-de-transcricao.ts`) manda a amostra ANTES do trecho em cada parte da
  reunião da dona (`amostraDaVozDaDona`; cerca de US$ 0,0007 por parte), e o prompt pede o
  rótulo fixo `F1` (`ROTULO_DA_VOZ_DA_DONA`) para a voz dela, com as outras a partir de F2 e
  "na dúvida, outro rótulo". A parte guarda a marca `vozDaDona`; a seguinte só leva a amostra
  se a anterior levou (o perfil gravado no meio de uma reunião não entra nela), e na junção
  (H17) o F1 fica fixo e as outras vozes vão para depois das usadas. A montagem liga o F1 à
  conta da dona em `speaker_accounts` (H3c), sem tirar a ligação que já havia
  (`contasComAVozDaDona`): nada entra sozinho que a dona não corrija no "Quem é cada voz".
  Desligar o perfil não mexe nas reuniões já transcritas.

## Os espaços de equipe (R2)

`server/espacos-de-equipe.ts` (router `equipes`), tabelas `meeting_folder_members` e
`meeting_folder_tasks` e a coluna `agenda_reunioes.folder_id`. A equipe é uma pasta da
dona (H7d) com membras, que entram como as participantes da R1b (link de uso único ou
conexão ACEITA, nunca e-mail digitado; 192 bits, só o sha256, 7 dias; até 50 por equipe e 30
convites a cada 10 min) com um papel: `member` lê as reuniões e escreve as tarefas, `reader`
só lê. O primeiro convite de cada pasta pede a confirmação de que as pessoas que falaram
autorizaram (`MEETING_FOLDER_TEAM_AUTHORIZED`, por `tx.insert(auditLogs)`). A membra LÊ as
reuniões prontas da pasta pela mesma credencial da participante (`reuniaoDaMembra`, chamada
em `leituraDaParticipante` quando não há participação): a reunião que sai da pasta ou vai
para a lixeira, a dona desativada, a saída e a remoção cortam na próxima leitura. Nenhum
procedimento de `equipes` recebe o id de uma reunião. Anonimato: a membra vê a dona e só as
membras ATIVAS (sem ids nem convites); o convite por link não tem nome até ser aceito. A
agenda da equipe nunca seleciona os participantes da reunião marcada. O papel de quem escreve
uma tarefa é conferido no banco, na transação, com a linha da membra travada. Apagar a pasta
leva as membras e as tarefas e solta a agenda (`apagarEquipeDaPasta`, na transação de
`apagarPasta`); a exclusão de conta leva as linhas das duas pontas.

## Editar a transcrição (H18)

`server/editar-transcricao.ts`: a dona corrige o texto ou a voz de um trecho, localiza e
substitui e volta um trecho (ou tudo) ao original, só na reunião pronta dela e nunca no
documento. A reunião na lixeira (H7d) não se edita: a guarda `procedimentoDaReuniao` e a
leitura travada da reunião (`reuniaoVisivel`) a recusam como não encontrada. `transcript`
e `segments` guardam a versão que ela vê, e todo leitor lê essa (o resumo refeito, o mapa,
o Pergunte, a busca, a Memória, a exportação, a tradução e o link aberto). O que a IA
escreveu fica em `original_transcript` e `original_segments`: só a dona os lê (o link
nunca os seleciona), e a conferência das pendências da extração (`ditosNaReuniao`) também.
Cada mudança é uma transação que trava a reunião antes da transcrição (a ordem da fila do
resumo), confere a revisão que a tela viu, apaga as traduções e grava
`MEETING_TRANSCRIPT_EDITED`, sem fala. O resumo e o mapa que a IA escreveu sobre uma
revisão anterior (a dona editou durante a geração) são gravados como de outra versão, com a
hora antes da edição, e não refeitos sozinhos: descartar e refazer a cada edição gastava a
IA sem teto. O resumo de outra versão faz a tela oferecer "Refazer o resumo" (uma vaga do
teto de IA), que refaz também o mapa. O resumo grava se a transcrição que leu estava editada
(`meeting_summaries.transcript_edited`, nulo nos de antes da H18, que leram a da IA): diante
de um resumo que leu a da IA, a volta ao original não é outra versão, e a tela não oferece
refazer. O link manda vazio o trecho de item que não está mais na
transcrição, no resumo e na tradução dele (`trechosNaTranscricaoDeAgora`: leitura nova de
item pelo link passa por ele). A junção (H17) remonta a transcrição pelo áudio: as
correções não passam, e a tela avisa.

## O mapa mental editável (H10b)

`server/mapa-mental-edicao.ts` e `shared/mapa-mental-edicao.ts`: a dona renomeia, arrasta,
acrescenta e apaga ramos, volta ao mapa da IA e pede "Refazer em outro estilo" (visão
geral, hierárquico, linha do tempo, conceito). O mapa da IA fica em `mind_map` (só a fila
grava); o da dona em `mind_map_edited`, e a tela, o link e a tradução leem o que vale
(`mapaQueVale`). A edição confere as regras da H10 sem podar (código traduzido), confere a
`mind_map_revision` e grava `MEETING_MIND_MAP_EDITED` na transação, sem rótulos. O refazer
põe o mapa na fila no estilo (`mind_map_style`), com o de antes à vista até o novo chegar, e
gasta uma vaga do teto comum de IA e uma do teto do refazer (6 por hora); o mapa novo da
fila substitui a edição. O resumo refeito não refaz sozinho o mapa que a dona editou.

## O Pergunte a várias reuniões e a resposta visual (H6c e H6d)

- **Várias reuniões** (`server/perguntar-a-varias-reunioes.ts`, router `perguntasEntreReunioes`):
  a dona escolhe por etiqueta (as prontas, pela chave da busca) ou uma a uma (até 30). A IA lê
  a transcrição rotulada inteira de cada uma, num bloco por reunião, até o teto da pergunta a
  uma reunião (400 mil caracteres). Acima dele, entram primeiro as mais ligadas à pergunta,
  pelos vetores que a Memória já guardou (nada é indexado na hora), e, sem eles, as mais
  novas; a que não cabe fica de fora com o motivo, nunca cortada. As vozes são por reunião
  (`{R2:F1}`): o rótulo sem a reunião, com mais de uma lida, derruba a resposta, e cada
  citação é conferida na transcrição da reunião que ela diz. Toda consulta de reunião daqui
  passa por `reuniaoVisivel()` (`server/reuniao-visivel.ts`), o ponto da regra da lixeira
  (H7d). Gasta de 1 a 4 vagas do `tetoDaIADaReuniao` (uma a cada 100 mil caracteres) e conta
  no teto de 20 em 24 h, contado no banco (`perguntas_entre_reunioes`, com a conta da dona
  travada). A linha não guarda a pergunta, a resposta nem as reuniões: só quantas, o tamanho,
  como terminou, o modelo e a avaliação da dona ("ajudou" ou "não ajudou").
- **Visual** (`server/resposta-visual.ts` e `shared/resposta-visual.ts`): o Pergunte (a uma
  reunião, durante a gravação, pelo link e a várias) pode devolver uma tabela ou os dados de
  um gráfico (barras ou linhas), num esquema fixo. O servidor confere a forma, os números (só
  o número; o resto vira tabela) e as vozes (a inventada derruba só o visual), e o visual só
  vai com a resposta que passou. A tela o desenha (`VisualDaResposta.tsx`); nunca recebe
  HTML, SVG ou código da IA.

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
