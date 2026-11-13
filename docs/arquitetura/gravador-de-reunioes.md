# Gravador de reuniões: o desenho em ondas

Plano aprovado pelo Roberto em 30/10/2026 e atualizado com as decisões dele de
10/11/2026. É desenho, não retrato do código: onde a `main` divergir deste texto, vale a
`main`. Em 10/11 entraram na `main` a A1 (#169), a A3 (#170), a A4 (#172), a G1a
(#174) e uma primeira versão do resumo e do "Pergunte à reunião" (#171), descrita nas
linhas da H4 e da H6. Até a G13, a gravação continua com o teto de 10 minutos. Quem faz cada PR, o prazo e o status ficam no Notion. O detalhe de cada PR
(arquivos, testes e as correções que a revisão do desenho pediu) fica fora do
repositório, com o Roberto: quem pegar uma PR pede esse detalhe a ele.

Os códigos de PR deste plano são A1 a A8, D1, G1a, G1b, G2 a G10, G13, G14, H1r, H3 a
H16, H9b, R1, S e DOC-0 (este documento). A numeração tem lacunas porque a revisão do
desenho juntou, dividiu e tirou PRs: a G1 virou G1a e G1b; da H1 sobrou a H1r, e o resto
foi para a A3; a H2 e a G11 foram absorvidas pela D1; a G12 saiu do plano, porque a
importação é a H9, pelo navegador; e a H9b completa a H9 com WAV, OGG e WebM longos, na
Onda 5. A H16, da agenda, entrou em 10/11. Estes códigos valem só para este plano: não
são os ajustes A1 a A14 nem as decisões D1, D2… do glossário, em
[docs/README.md](../README.md).

## O pedido

A cliente pediu no grupo em 20/10/2026, e cobrou de novo em 29/10:

1. que o gravador de reunião tenha as funções de um app de notas de reunião com IA:
   gravar, transcrever separando quem fala, resumir, responder perguntas sobre a
   reunião, buscar e importar arquivos;
2. um link exclusivo para o gravador, que seja a primeira tela depois do login;
3. gravações de 60 minutos, em vez de 10. Em 09/11, ela disse no grupo que o tempo de
   gravação é ilimitado;
4. login com acesso facial;
5. a correção do "Esqueci a senha": com um e-mail diferente do cadastrado, a tela dizia
   "Link enviado!" e nada chegava.

A paridade é só de função. Nada de copiar nome, logo, texto ou tela de outro app, e nada
de descompilar.

## Decisões de 30/10/2026

Do Roberto:

- **Esqueci a senha:** a tela fica neutra e o servidor continua sem revelar quem é
  membro, como decidido na PR #90 (o commit d72de7d da PR entrou na `main` como
  d9b722d).
- **60 minutos para todos os níveis, sem teto mensal.** Revisa a decisão de 14/09 (10
  minutos grátis e mensalidade). Os 60 minutos caíram em 10/11: a gravação ficou
  ilimitada (ver as decisões de 10/11).
- **Aviso de gravação em rascunho:** o aviso novo cita a IA do Google que transcreve o
  áudio, a transferência internacional dos dados (o áudio pode ser processado fora do
  Brasil), a retenção do áudio e a separação das falas por pessoa. Ele vai ao ar em
  rascunho, versionado, com a versão gravada em cada reunião, e a Cris revisa depois.
- **A reunião é compartilhada.** Uma pessoa grava, e o mesmo arquivo serve a todas:
  - quem gravou adiciona as participantes que têm conta na WRW, e elas ouvem, leem o
    resumo e fazem perguntas à reunião;
  - a presidência e a admin abrem qualquer reunião para consultar, com auditoria de
    cada abertura;
  - uma conta Ouro sem cargo vê só as reuniões em que foi adicionada (o mesmo critério
    da rastreabilidade das conexões, em `server/CLAUDE.md`).

Delegadas ao Claude e aprovadas no plano:

- **Acesso facial = passkeys (WebAuthn).** O próprio aparelho confere a pessoa (Face ID,
  Touch ID, digital ou rosto no Android, Windows Hello) e manda à WRW só uma assinatura.
  A WRW vai guardar a chave pública e dados técnicos da chave e do aparelho, como o
  identificador da chave, o contador de uso, o tipo e o modelo do autenticador, as
  formas de conexão da chave, se ela é sincronizada, o apelido e as datas de criação e
  de último uso. Esses campos são exemplos, não uma lista fechada: a lista final sai no
  schema da A6. A WRW não coleta nem guarda biometria: não há câmera nem biometria
  própria. O texto para a próxima versão do Termo Geral de Uso fica com a Cris.
- **`/gravar`** é o link exclusivo e o destino depois do login.
- **App instalável (PWA)** antes das lojas.
- **Áudio em fatias pelo próprio servidor**, com a **fila de transcrição no MySQL**.

A confirmar pelo Roberto e pela cliente: os nomes de quem falou. A gravação sai de um
microfone só, e a IA separa as vozes sem saber de quem é cada uma. A proposta é a IA
sugerir os nomes pela lista de participantes, cada participante marcar "sou eu" na
própria voz e quem gravou confirmar.

## Decisões de 10/11/2026

Do Roberto, depois de a cliente dizer no grupo, em 09/11, que o tempo de gravação é
ilimitado. Elas mudam o plano de 30/10 e valem sobre ele.

- **Gravação ilimitada.** Sai o teto de 60 minutos: a G13 tira o teto de tempo da
  gravação, para todos os níveis e sem teto mensal. No lugar do teto, a G10 avisa a
  cada hora completa de gravação ("1 hora de gravação", "2 horas"...), sem parar a
  gravação, para quem grava acompanhar o tempo. O envio único em base64 continua em 10
  minutos e 10 MB até sair na G14. O teto de 3 gravações abertas por conta, que é
  contra abuso e não de tempo, segue como pergunta ao Roberto.
- **Compartilhar sem link público e sem senha.** A reunião continua visível só para as
  participantes adicionadas e, para consulta, para a presidência e a admin, como na R1.
  O motivo da consulta: a administração pode conferir se algo na reunião infringe o
  Termo Geral de Uso da WRW.
- **Agenda sem robô de reunião.** Hoje a WRW não tem agendamento de reunião. Entra a
  H16, na Onda 4: agendar a reunião na WRW e pô-la na Google Agenda e no Outlook por
  link de criação de evento e por arquivo .ics, sem que a WRW faça login na Google ou na
  Microsoft. Pôr o evento na agenda sozinho, por API com OAuth (Google Calendar API e
  Microsoft Graph), fica como passo seguinte, porque pede a verificação do app pela
  Google e pela Microsoft.
- **Prazo da cliente:** o app ativo perto de 28/11/2026, cerca de 20 dias a partir de
  08/11. Reordenar as ondas para o prazo é com o Roberto (ver "As ondas").

## Decisões de 12/11/2026

Do Roberto. Valem sobre as de 10/11 nos dois pontos abaixo.

- **Compartilhar por link aberto, por enquanto.** Troca o "sem link público e sem senha"
  de 10/11. A dona liga o link de uma reunião pronta, e qualquer pessoa com o endereço
  `/r/{token}` ouve a gravação, lê e traduz a transcrição e pede à IA o resumo e respostas,
  sem conta na WRW. O que já entrou (em
  [decisoes-tomadas.md](./decisoes-tomadas.md), 12/11):
  - só leitura: excluir, reprocessar e a rede particular da dona (contatos e entidades)
    continuam só com ela, e o nome dela não aparece;
  - ligar pede de novo a confirmação de que as pessoas que falaram autorizaram
    compartilhar, e fica na auditoria; desligar corta o acesso na hora (quem já tinha a
    gravação carregada segue ouvindo até a URL assinada vencer, em até 1 hora), e o link
    novo é outro;
  - os pedidos à IA pelo link têm dois tetos pela reunião, um por visitante e um do
    total, e a página fica fora dos buscadores.

  A R1 (participantes e consulta auditada pela administração) fica para depois. Quando
  voltar, o desenho dela parte do link aberto que já existe.
- **Agenda: WhatsApp e e-mail no lugar do Outlook.** A H16 continua pondo a reunião na
  Google Agenda por link de criação de evento, e o convite sai por WhatsApp e por e-mail.
  O compartilhar do link aberto já usa os dois: o app da própria dona abre com a mensagem
  pronta, e ela escolhe para quem mandar.

Proposta do Claude, explicada ao Roberto em 10/11, que vale enquanto ele não a vetar:
**a gravação é contínua para quem grava.** O pedido dele é que ninguém precise lembrar
de gravar de novo no meio e que nenhum trecho fique cortado. Pela proposta, quem grava
aperta um botão para começar e outro para encerrar. As fatias do desenho técnico são
internas: o app envia o áudio em partes por baixo, para não perder a gravação se a
internet cair ou o aparelho travar, e as partes se emendam na transcrição sem corte. A
palavra "fatia" não aparece na tela. A exceção vem do celular, não das fatias: no
iPhone, bloquear a tela ou trocar de app corta o microfone, e a G10 trata disso.

A confirmar com o Roberto: ele disse que a administração vê a gravação, a transcrição e
"o chat" da reunião. Falta saber se "o chat" inclui as perguntas feitas à IA sobre a
reunião (H6). Pelo plano, a H6 não guarda as perguntas nem as respostas. Se a
administração precisar vê-las, a H6 passa a guardá-las, e o aviso de gravação (G4) diz
isso.

## Por que o gravador muda por dentro

Hoje o áudio vai em base64 dentro do JSON do tRPC, com teto de 10 MB e 600 s
(`server/meeting-service.ts`), e o servidor transcreve na mesma requisição. Com reuniões
longas, quebram:

- o tamanho do corpo e a memória do processo;
- o limite de áudio inline do Gemini e o tempo da requisição;
- as colunas TEXT da transcrição (`drizzle/schema.ts`);
- os cortes silenciosos de 24 mil, 48 mil e 20 mil caracteres na extração, na tradução e
  na Memória;
- o corte por inatividade de 30 minutos, que deslogava no meio da gravação (saiu em
  10/11, com a sessão de 90 dias desde o último uso: ver `decisoes-tomadas.md`).

O desenho novo, abaixo, é técnico. Quem grava não vê as fatias: para ela, a gravação é
contínua, do botão de começar ao de encerrar (ver, nas decisões de 10/11, a proposta da
gravação contínua).

1. **Fatias de 10 minutos, cada uma um arquivo válido.** O gravador reinicia o
   MediaRecorder a cada fatia e pede mp4 antes de webm (o webm já falhou no Gemini; ver a
   PR #158). A troca de fatia não pode deixar buraco no áudio, e a bancada B confere a
   emenda.
2. **Cópia no aparelho.** A fatia fica no IndexedDB até o servidor confirmar. O trecho
   em curso também vai para o aparelho aos poucos, e não só no fim da fatia, para um
   travamento perder no máximo os últimos segundos. Queda de rede, recarregar a página e
   um novo login depois de a sessão vencer não perdem nada. Sair da conta ou excluí-la
   apaga a cópia; enquanto há gravação ou envio, sair pede confirmação antes (PR S).
3. **Rota binária autenticada.** Cada fatia vai por um POST montado antes do
   `express.json`, e o upload ao bucket acontece depois do commit no banco.
4. **Fila no MySQL.** Cada fatia é uma tarefa com reserva atômica, retomada no boot, e
   transcrita assim que chega, inclusive durante a gravação. Quem faz a fila andar é o
   servidor, nunca o polling da tela. Assim um deploy no meio não derruba a reunião.
5. **Transcrição por fatia no Gemini**, com falantes e tempos, passando adiante os
   falantes e as últimas falas da fatia anterior. O resultado é montado numa
   transcrição só.
6. **Janelas no lugar dos cortes** na extração, na tradução e na Memória, e as colunas
   da transcrição passam a MEDIUMTEXT.

## Contratos entre as PRs

Fixados antes da transcrição por fatia, para as PRs não se contradizerem:

- **Segmento da transcrição:** `{inicio, fim, falante, texto, lacuna?}`.
  - O tempo vai em segundos absolutos da reunião.
  - O falante é gravado como `F1`, `F2`... O rótulo "Falante 1" só existe na tela, numa
    chave de texto só.
  - O trecho que não chegou é um segmento com `lacuna: true` e texto vazio.
- **`meetings.get`** devolve `recording.partes`, com
  `[{seq, url, mimeType, inicioSegundos, duracaoSegundos, expiresAt}]`. A reunião de
  envio único vira uma parte só.
- **`origem` e `audio_pipeline`** nascem juntas, na migração das fatias:
  - `origem` diz de onde a reunião veio: gravação, arquivo, aba, PDF ou YouTube
    (varchar, com o enum só no TypeScript);
  - `audio_pipeline` diz como o áudio chegou: envio único ou fatias.
- **Idioma:** uma função só, `nomeDoIdioma`, em que `'pt'` vira `'pt-BR'`. O código do
  idioma fica gravado; o nome só vai no prompt. O resumo (H4) sai no idioma da reunião,
  que por padrão é o da tela de quem grava (G1b). Os outros idiomas virão da tradução do
  resumo (H11, na Onda 5).
- **Reunião pronta:** a fila expõe o gancho `aoFicarPronta`, e o resumo se pendura nele
  sem editar a fila.
- **Prazo do áudio da fatia:** segue a mesma regra do áudio das gravações, numa função
  só. Hoje, na `main`, o prazo é de 30 dias contados do envio. A regra-alvo do plano,
  com o prazo definido quando a reunião fica pronta e encurtado na falha, vem com a #134
  ou com a retenção refeita depois da G7. A duração depende da cliente (24 h ou 30
  dias).
- **Rotas:** vêm na A3, em `shared/rotas.ts` (`ROTA_GRAVAR`, `ROTA_DAS_REUNIOES`,
  `rotaDaReuniao`).
  - O `/gravar` é o link do gravador e a primeira tela depois do login.
  - A lista continua em `/meetings`, o endereço que já existia, para os favoritos e
    links salvos seguirem valendo. O endereço (`href`) gravado nos documentos da Memória
    não prende o nome: a partir da A3, a tela abre a reunião pelo `metadata.meetingId`.
  - Os links para dentro de uma reunião usam `?t` (o segundo da fala), `?q` (o termo
    buscado) e `?item` (o combinado). A H1r faz o `/meetings/:id` repassá-los à tela, a
    D1 lê `?t` e `?q`, a H4 lê `?item`, e a H5, a H7 e a H15 montam os links.
- **Um dono por tela:** a A3 é dona das rotas, e o detalhe da reunião é um componente
  só, o da PR D1. Desde 12/11 há uma segunda tela de detalhe, a página do link aberto
  (`client/src/pages/ReuniaoAberta.tsx`), que repete o player e a tradução; a D1 junta
  as duas.
- **Acesso à reunião compartilhada:** uma função só decide quem vê, na consulta, e não na
  tela. A lista, o detalhe, o player, as perguntas e o proxy de arquivos passam por ela.
  - A participante e a administração só leem. O que muda dado (editar, confirmar,
    excluir) continua com a dona no WHERE da consulta, e exportar também fica com ela.
    A exceção é a marca "sou eu" na própria voz (H3), que a participante põe e quem
    gravou confirma.
  - O que é da rede particular da dona (sugestões de contato, ligação de quem falou a um
    contato, combinados ligados a contatos dela) nunca aparece para participante nem
    para a administração.
- **Aviso de gravação**, em duas camadas:
  - o aviso curto fica nos 10 idiomas, e a versão aceita vai em cada reunião, na coluna
    `consent_notice_version`, que nasce na G3. As versões anteriores continuam aceitas,
    e o servidor grava a que veio, para não perder a gravação de quem estava com a aba
    aberta quando o texto mudou. É o contrário do aceite dos termos
    (`server/routers/consent.ts`), que recusa a versão que não é a vigente;
  - o rascunho da G4 cita a IA do Google que transcreve, a transferência internacional
    dos dados, quanto tempo o áudio fica guardado e a separação das falas por pessoa. Ele
    já nasce cobrindo também tudo o que está planejado: quem terá acesso, a cópia no
    aparelho até o envio, o resumo, as perguntas e a tradução pela IA, a importação e a
    reunião online. A PR que mudar o que acontece com o áudio além disso sobe a versão,
    como uma mudança na retenção ou a frase "não é usado para treinar", que só entra com
    o faturamento confirmado;
  - o texto jurídico completo é o Termo de Gravação de Reuniões. O tipo `termo_gravacao`
    já existe em `document_versions`, mas nenhuma tela o usa. A Cris redige, e o Roberto
    publica depois, em produção, pelo `scripts/publicar-documento.mjs`.
- **Passkeys:**
  - redefinir a senha também apaga as chaves de acesso da conta, com auditoria. Sem
    isso, uma chave cadastrada por um invasor sobreviveria ao reset;
  - o desafio de uso único fica numa tabela pequena, na mesma migração das chaves, e é
    consumido por um UPDATE condicional. Ele não fica no `audit_logs`, porque o insert
    de lá engole o erro: se falhasse, o mesmo desafio continuaria valendo;
  - sem `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGENS`, a função some (a entrada, o cadastro e a
    gestão das chaves);
  - o RP ID é o domínio a que cada chave de acesso fica presa. Os valores das duas
    variáveis dependem do `FRONTEND_URL` de produção e de o www existir ou não, e o
    Roberto os define no Render antes da A7. Depois que a primeira usuária cadastrar uma
    chave, o RP ID não pode mais mudar. Por isso o `FRONTEND_URL` e o www se decidem
    antes da Onda 2, sem esperar a A8: se o RP ID nascesse no endereço `.onrender.com`, o
    redirecionamento da A8 para o domínio próprio deixaria sem uso as chaves já
    cadastradas.

## As ondas

Prazo: a cliente quer o app ativo em cerca de 20 dias a partir de 08/11, perto de
28/11/2026. As ondas abaixo seguem a ordem do plano de 30/10, com as mudanças de 10/11.
Se a ordem mudar para caber no prazo, quem decide é o Roberto.

Tamanho: P é pequena, M é média e G é grande.

**Onda 1: acesso e navegação.**

| PR | O que faz | Depende de |
|---|---|---|
| A1 `fix/esqueci-senha-tela-neutra` (M) | A tela do "Esqueci a senha" diz "Pedido recebido", repete o e-mail digitado, explica o que fazer se nada chegar e oferece "Corrigir o e-mail" e "Criar conta". | — |
| A2 `fix/redefinir-senha-derruba-sessoes` (P) | O reset derruba as sessões abertas, grava a auditoria e consome o token num UPDATE condicional. | — |
| A3 `feat/gravar-primeira-tela` (M) | `/gravar` abre o gravador e o login cai nele (quem não concluiu o cadastro segue indo ao onboarding); `?voltar=` seguro; `/meetings/:id`; Reuniões em primeiro no menu; botão "Gravar reunião" no Dashboard; a Memória abre o detalhe da reunião. | — |
| G2 `chore/modelo-de-audio-configuravel` (P) | `LLM_AUDIO_MODEL` com guarda contra alias, e um script que lista os modelos que a chave enxerga. | — |
| A4 `feat/pwa-instalavel` (P) | Manifest com `start_url /gravar`, só com a marca (WRW) e sem atalhos (`shortcuts`), para não ter texto a traduzir. Ele aponta os ícones que já existem em `client/public/brand/`, e a A4 acrescentou ao `client/index.html` as meta tags da Apple (`apple-mobile-web-app-*`); o `apple-touch-icon` já existe. Sem service worker, e o `.webmanifest` sai sem cache, como o HTML. A dica de instalação fica no `/gravar`, nos 10 idiomas, e avisa que, no iPhone, o app instalado pede um login separado do Safari. Se a dica entrar no `Meetings.tsx`, a A4 segue a regra dos arquivos em série. A #172 entrou sem a dica, que fica para uma PR seguinte. | A3 |
| A5 `chore/abrir-sessao-reaproveitavel` (P) | A sessão nasce numa função só, pronta para a passkey (desde 10/11 o token já é assinado num lugar só, `assinarTokenDaSessao` em `server/auth.ts`; falta a linha no banco). Uma guarda (um teste) impede que o servidor abra sessão pelo `sdk.signSession`: o token (JWT) dele não leva o `sessionToken` conferido no banco, por padrão dura 1 ano e escapa da revogação das sessões. | A2 |
| G1a `fix/gravadores-mp4` (M) | Um hook de gravação só para os três gravadores (o da reunião, o do ditado e o da voz no perfil do contato), com mp4 antes de webm, como o do ditado já faz desde a #158. O hook já nasce aceitando um MediaStream de fora (um fluxo de áudio entregue pronto, no lugar do microfone que ele abre por padrão), que a H14 vai usar para gravar a aba. Entrou na `main` em 10/11 (#174). | A3 |
| S `feat/sessao-ocupada` (M) | Enquanto há gravação ou envio, o redirecionamento ao login espera, até um teto de tempo; sair pede confirmação antes de revogar a sessão. O corte por inatividade já saiu em 10/11 (sessão de 90 dias desde o último uso). | A3 |

**Onda 2: a base da gravação longa e as passkeys.**

| PR | O que faz | Depende de |
|---|---|---|
| G3 (M, migração) | Tabela de fatias, estado "enviando", versão do aviso, `origem` e `audio_pipeline`, transcrição em MEDIUMTEXT. A lista e o detalhe passam a escolher as colunas e deixam de mandar as colunas de controle da fila. | decisão sobre a #134 |
| G1b (M) | Seletor do idioma da reunião, que por padrão é o da tela de quem grava. A G1b traz a função `nomeDoIdioma` (ver os contratos), e o ditado e a voz do contato passam a usá-la também. Na tradução, o servidor e a tela deixam de tratar o pt-BR como o original fixo: sem isso, uma reunião em inglês "traduzida" para pt-BR voltaria em inglês. | G1a, G2 |
| A6 (G, migração) | Servidor das passkeys com `@simplewebauthn/server`: a tabela das chaves e a do desafio de uso único, a entrada sem senha e a gestão pela dona, seguindo os contratos das passkeys. Sem `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGENS`, a função some. | A5 |
| G4 (M) | Aviso de gravação em rascunho, versionado como dizem os contratos. Ele cita a IA do Google, a transferência internacional, a retenção e a separação de falantes, e diz quem terá acesso: as participantes adicionadas e, para consulta, a presidência e a admin, com registro, e quem receber o link aberto que a dona ligar (decisões de 12/11). O rascunho completo fica em `docs/termos/` para a Cris. | G1b, G3 |
| G6 (M) | Transcrição de uma fatia no Gemini, com falantes e tempos, e o script da bancada A (ver "As duas bancadas de teste"). | G1b |
| G8 (M) | Extração, tradução e Memória leem a reunião inteira, em janelas. A tradução de uma reunião longa sai da requisição e vira trabalho em segundo plano. | G1b, A3 |
| A7 (G) | Tela das passkeys: login, convite depois da senha e gestão no Perfil. | A6 |

**Onda 3: o gravador sem teto de tempo.**

| PR | O que faz | Depende de |
|---|---|---|
| G5 (G) | Reunião criada no início e rota binária das fatias. | G4, G8, #149 |
| H1r (P) | A Memória e o perfil do contato abrem a reunião certa. A abertura pela Memória, pelo `metadata.meetingId`, vem na A3; a H1r põe os links da reunião no perfil do contato e faz o `/meetings/:id` repassar à tela `?t` (o segundo da fala), `?q` (o termo buscado) e `?item` (o combinado). | G8 |
| G7 (G) | Fila de transcrição no MySQL. | G5, G6 |
| R1 (G, migração) | Reunião compartilhada com participantes e consulta auditada da administração. Adiada em 12/11: por ora, no lugar dela, entrou o link aberto (decisões de 12/11). | G3, A3, #149 |
| D1 (G) | Detalhe único: transcrição por falante, player que renova a URL, andamento, busca e tempo de fala, também na página do link aberto (`ReuniaoAberta.tsx`). | G7, S, R1 (adiada em 12/11) |
| G9 (G) | Gravador que envia em fatias por baixo, numa gravação contínua para quem grava, com cópia no aparelho até o servidor confirmar e retomada do envio. Uma trava do navegador (Web Locks) impede duas abas de enviarem a mesma gravação, e a cópia é apagada ao sair e ao excluir a conta. | D1, G4, G5, G7, S |
| G10 (M) | Gravação longa no celular: tela acesa, aviso do iPhone, pausa e "continuar gravando". Em vez do aviso de limite, que não há mais, um aviso a cada hora completa de gravação ("1 hora de gravação", "2 horas"...), sem parar a gravação. | G9 |
| H9 (G) | Importar M4A, MP3, MP4 e MOV pelas fatias, com o mesmo teto de tempo da gravação, que a G13 tira. O navegador corta o MP3 nas fronteiras de quadro e tira o áudio (AAC) de M4A, MP4 e MOV com o `mp4box`; do vídeo, só o áudio sai do aparelho. | G9 |
| G13 (M) | Tira o teto de tempo da reunião em fatias (a gravação e a importação da H9), que até ela segue em 600 s, para todos os níveis e sem teto mensal. No lugar do teto fica o aviso de hora completa da G10. O envio único em base64 (`meetings.submitRecording`, que até a H9b ainda recebe WAV, OGG e WebM) continua em 600 s e 10 MB, numa constante própria e com os textos dele, até sair na G14. O FAQ (`server/routers/faq.ts`) e os textos de tela que falam em 10 minutos se ajustam junto, menos os do envio único. Só entra com a bancada B aprovada (ver "As duas bancadas de teste"). | G4, G7 a G10, D1, H9 |

**Onda 4: resumo e funções em volta.** H3 e H4 podem correr ao lado de G9 e G10.

| PR | O que faz | Depende de |
|---|---|---|
| H3 (M, migração) | Nomes dos falantes. | D1, R1 (adiada em 12/11) |
| H4 (G, migração) | Resumo com tópicos, decisões e combinados, no idioma da reunião, cada item pendente até a dona confirmar. Os modelos de resumo são Geral, Networking, Mentoria, Vendas e 1:1. A #171 já pôs na `main` uma primeira versão, gerada a pedido, sem modelos, sem guardar nada e só para a dona; a H4 parte dela. | H3, G7 |
| H6 (M) | "Pergunte à reunião", só com o que foi dito e citando os tempos. Pelo plano, as perguntas e as respostas não ficam guardadas (ver o ponto sobre "o chat" nas decisões de 10/11). A #171 já pôs na `main` uma primeira versão, só para a dona e citando o trecho, ainda sem os tempos. | H4 |
| H5 (M) | Combinados confirmados viram "Próximas ações". | H4 |
| H8 (M) | Quem gravou exporta em TXT, Markdown, SRT, Word e PDF, com auditoria. | H4 |
| H7 (M, migração) | Busca entre reuniões, etiquetas e "Onde foi". | H4 |
| H16 (M, migração) | Agendar a reunião na WRW, com título, data, hora e participantes, pô-la na Google Agenda por link de criação de evento ou por um arquivo .ics e mandar o convite por WhatsApp e por e-mail (o botão do Outlook saiu em 12/11; se o .ics fica, por servir também à agenda do iPhone, é do desenho detalhado). A agenda por API, com OAuth, fica para depois (ver as decisões de 10/11). A H16 ainda não tem desenho detalhado: ele vai ser feito com o Roberto antes de alguém pegá-la (ver "O que depende de quem"). | R1 (adiada em 12/11) |

**Onda 5: depois, conforme a cliente.**

- **H10:** mapa mental em Mermaid (diagrama escrito em texto), sem dependência nova.
- **H11:** tradução do resumo.
- **H12:** resumo de PDF.
- **H13:** resumo de vídeo do YouTube. O recurso do Gemini para isso ainda está em
  prévia.
- **H14:** gravar a aba de uma reunião online, só no Chrome e no Edge do computador. Usa
  o hook da G1a, passando a ele o áudio da aba.
- **H15:** lembrete no sino.
- **H9b:** importar WAV, OGG e WebM longos. Até lá, esses formatos seguem no envio único
  de hoje.
- **G14:** tirar o envio único em base64. Só entra quando houver uma semana de logs sem
  `submitRecording`, nenhum cliente fora do repositório que ainda use esse envio, e o
  H9b pronto ou o aval da cliente.
- **A8:** redirecionar o endereço `.onrender.com` do Render para o domínio próprio,
  quando o Roberto confirmar o `FRONTEND_URL`, o www e o health check.

## As duas bancadas de teste

O áudio e as transcrições das duas bancadas ficam fora do repositório, que é público.

- **Bancada A (G6):** um script transcreve as fatias de um áudio de desenvolvimento e
  mede o modelo, o formato, se os falantes ficam estáveis entre as fatias e se aparece
  MAX_TOKENS (a resposta do Gemini cortada no teto de saída). É ela que escolhe o modelo
  de áudio, e a fila (G7) só vai a produção com um id que esteja na lista de modelos que
  a chave enxerga (o script da G2).
- **Bancada B (antes da G13):** reuniões reais de 45 minutos ou mais, ao menos uma com
  mais de 1 hora, com o consentimento de quem fala, gravadas por HTTPS no iPhone (Safari
  e app instalado), no Android (Chrome) e no Chrome do computador. Ela confere que:
  - as fatias chegam;
  - a emenda entre as fatias não perde fala;
  - queda de rede, recarregar a página e um novo login depois de a sessão vencer não
    perdem nada;
  - fechar o navegador à força no meio da gravação perde no máximo os últimos segundos;
  - a fila transcreve durante a gravação;
  - a transcrição final tem falantes e tempos;
  - ninguém é deslogado aos 30 minutos;
  - o aviso de 1 hora de gravação aparece, e a gravação continua;
  - a extração e a Memória leem a reunião inteira;
  - o player toca as partes e renova a URL;
  - `kill -TERM` no processo do `pnpm start` devolve na hora as tarefas que a fila tinha
    reservado. A prova roda em Linux, macOS ou WSL: no Windows o Node não recebe SIGTERM,
    e o `kill` do Git Bash encerra o processo sem passar pelo tratador.

## Regras de trânsito

- **Migrações:**
  - uma aberta por vez, na ordem G3, A6, R1, H3, H4, H7, H16, H11, H12, H13 e H15;
  - cada uma traz a `main` e roda `pnpm db:generate` de novo (`/mudar-schema`);
  - conflito em `drizzle/meta` nunca se resolve à mão.
- **Arquivos em série:** só uma PR por vez mexe em `client/src/pages/Meetings.tsx`,
  `server/routers/meetings.ts`, `server/meeting-service.ts`, `server/_core/index.ts` e
  `package.json`.
- **Exclusão de conta:** cada tabela nova com coluna de usuária entra em
  `server/exclusao-de-conta.ts` e em `scripts/exame/limpeza.mjs`. Na mesma PR sobe a
  contagem dos dois testes que conferem os pares (tabela, coluna de usuária) do schema,
  recalculada sobre a `main`: `PARES`, em `server/exclusao-de-conta.test.ts`, e
  `paresDeUsuariaNoSchema`, em `server/exame-de-producao.test.ts` (hoje 63). Ela sobe
  na G3, na A6, na R1, na H3 e na H4, e também na H16, se ela criar tabela com coluna
  de usuária.
- **Decisões:** as entradas de `decisoes-tomadas.md` saem numa PR de docs por onda, e
  não dentro de cada PR.
- **Dependências novas previstas:** `@simplewebauthn/server` e `@simplewebauthn/browser`
  (MIT), `mp4box` (BSD-3-Clause) e `docx` (MIT). Nenhuma entra sem o aval do Roberto,
  que está entre as pendências dele, abaixo.

## Como cada PR é feita e revisada

O repositório não tem skill nem workflow próprio para estas rodadas: cada pessoa as roda
com o próprio Claude, antes de abrir a PR.

1. **Branch e código.** A branch sai da `main` atualizada, e o código entra junto com os
   testes.
2. **CI na máquina:** o que o CI (`testes.yml`) roda, como manda o passo 4 do fluxo de
   trabalho do `CLAUDE.md`.
3. **Rodada de revisão.** Um revisor por ângulo lê o diff contra a `main`. De preferência,
   cada revisor é um subagente do Claude, e os cinco rodam em paralelo. Os ângulos são:
   - **código apagado ou lógica mudada:** cada trecho removido ou alterado precisa de
     explicação no objetivo da PR;
   - **efeito fora do diff:** cada função, variável, tipo, constante, chave de texto,
     rota, coluna ou procedimento alterado é procurado no repositório inteiro, e cada uso
     é conferido;
   - **regras do projeto:** privacidade na consulta, nada de `sql.raw`, banco fora do ar
     é erro (nunca "sem dados"), nada da IA entra sozinho, os pares da exclusão de conta,
     migração gerada pelo `pnpm db:generate`, texto novo nos 10 idiomas e nenhum segredo
     ou dado pessoal;
   - **testes:** o comportamento novo e o antigo estão cobertos, sem assert fraco (um
     teste que passaria com o código errado);
   - **falhas silenciosas:** `catch` vazio, erro engolido e valor de reserva que esconde
     o erro.

   Para os testes e as falhas silenciosas, o plano contava com dois agentes prontos
   (`pr-test-analyzer` e `silent-failure-hunter`), que não estão neste repositório. Sem
   eles, esses dois ângulos vão como os outros, cada um com o seu revisor.
4. **Cético.** Outro agente, que não fez a revisão, tenta derrubar cada achado. Só o
   achado confirmado é corrigido.
5. **Correção e nova rodada.** Depois da correção, o CI roda de novo e o ciclo volta ao
   passo 3. Ele para depois de duas rodadas seguidas sem achado novo confirmado.
6. **Fecho.** O `/code-review` fica para o diff final, e o `/abrir-pr` já o roda, no
   passo 7 dele. O registro das rodadas, com o que cada uma achou e o que mudou, vai na
   descrição da PR, na seção "Como verifiquei" do modelo
   (`.github/pull_request_template.md`). Quem fez a PR escreve esse registro; o
   `/abrir-pr` não tem passo para ele.

Nada disso substitui a validação do passo 6 do fluxo de trabalho do `CLAUDE.md`, feita
por outro LLM do time. O merge segue a regra do README (hoje: quem revisou e aprovou
mescla, só por `gh pr merge`).

## PRs abertas no caminho

- **#134** (retenção de 24 h do áudio): aberta em 14/09, no horário de Brasília (no
  GitHub, 15/09 às 02:50 UTC). Em 30/10, estava em conflito com a `main` e sem
  aprovação. Ou traz a `main` e entra antes da G3, ou fecha e a retenção é refeita
  depois da G7, já cobrindo as fatias.
- **#149** (imagens e URL assinada): precisa de validação e merge antes da G5 e da R1,
  porque mexe em `server/storage.ts` e no proxy de arquivos.

## O que depende de quem

- **Roberto:**
  - já:
    - com a R1 adiada em 12/11, se a D1, a H3 e a H16 seguem esperando por ela ou
      passam a partir do link aberto;
    - se a ordem das ondas muda para o prazo da cliente, perto de 28/11;
    - se veta a proposta da gravação contínua com o envio em partes interno (ver as
      decisões de 10/11); sem veto, ela fica;
  - na Onda 1, depois da G2: rodar o script da G2 com a chave de produção do Gemini, ou
    confirmar que a chave de desenvolvimento é do mesmo projeto, para saber que modelos
    a chave enxerga;
  - antes da Onda 2:
    - o destino da #134, com o Nicolas, e a validação e o merge da #149 (ver "PRs
      abertas no caminho");
    - o `FRONTEND_URL` de produção e se existe www, que definem `WEBAUTHN_RP_ID` e
      `WEBAUTHN_ORIGENS` (só os nomes vão ao código). Depois da primeira chave
      cadastrada, o RP ID não muda mais (ver os contratos das passkeys);
    - o aval às dependências novas;
    - se existe app ou outro cliente fora do repositório chamando
      `meetings.submitRecording` (o `shared/const.ts` cita "o app Expo"), porque a G14
      só entra sem cliente externo;
    - se "o chat" que a administração consulta inclui as perguntas feitas à IA sobre a
      reunião (H6), porque isso muda a H6 e o aviso de gravação (G4);
  - antes da Onda 3:
    - o faturamento da chave do Gemini, com alerta de orçamento: a gravação ilimitada
      para todas, sem teto mensal, deixa o custo em aberto;
    - o plano do Render em vigor;
    - a cota de download do B2 e um bucket de desenvolvimento;
    - o aval ao teto de 3 gravações abertas por conta, que é contra abuso e não um teto
      de minutos;
    - aparelhos, HTTPS para o celular e reuniões reais de 45 minutos ou mais, ao menos
      uma com mais de 1 hora, para a bancada B, com o consentimento de quem fala. O
      áudio e a transcrição ficam fora do repositório;
  - antes da H3 (Onda 4): confirmar a proposta dos nomes de quem falou;
  - antes da H16 (Onda 4): o desenho detalhado dela, que ainda não existe. Nele se decide
    se gravar uma reunião agendada usa a mesma reunião ou cria outra; se usar a mesma, a
    H16 passa a depender também da G5, da G9 e da D1.
- **Cliente:**
  - confirmar que a presidência e a admin abrem qualquer reunião para consulta, com
    auditoria, para conferir o cumprimento do Termo Geral de Uso, e que o aviso de
    gravação diz isso a todos os membros;
  - antes da Onda 2:
    - quanto tempo o áudio fica (24 h ou 30 dias);
    - se o `/gravar` vale também para a presidência e as administradoras;
    - se o app instalável atende por ora o pedido das lojas;
    - se Face ID e digital atendem o "acesso facial";
    - qual canal de suporte oferecer a quem não lembra o e-mail do cadastro;
  - antes das Ondas 3 e 4:
    - se serve "Continuar gravando", na mesma reunião, quando o iPhone corta o
      microfone (tela bloqueada ou troca de app);
    - se serve esperar 24 h pelas partes que não chegaram e transcrever o que chegou,
      marcando "trecho não recebido";
    - se M4A do iPhone, MP3 e MP4 ou MOV do Zoom, do Meet e do Teams cobrem o uso, e se
      WAV, WebM e OGG longos podem ficar para depois (o OGG é o formato dos áudios do
      WhatsApp); até a H9b, esses formatos seguem no envio único de hoje, até 10 MB e
      10 minutos;
    - se o aviso de gravação aparece inteiro antes de cada gravação ou só na primeira
      vez de cada versão;
    - se os modelos de resumo (Geral, Networking, Mentoria, Vendas e 1:1) servem;
    - se basta o combinado aparecer em "Próximas ações" e no perfil do contato, ou se
      ela quer um lembrete no sino;
    - se a IA pode sugerir os nomes de quem falou, para a dona confirmar, e se a dona
      pode ligar quem falou a um contato;
    - se a exportação fica liberada;
    - se o resumo de PDF (H12), o resumo de vídeo do YouTube (H13) e a gravação da aba
      de uma reunião online (H14) entram já, logo depois da Onda 4, ou ficam para mais
      tarde.
- **Cris:**
  - o rascunho do aviso de gravação (G4) e o Termo de Gravação de Reuniões completo;
  - o texto do acesso às reuniões compartilhadas (as participantes adicionadas e a
    consulta pela presidência e pela admin, com registro, para conferir o cumprimento do
    Termo Geral de Uso), no aviso e no termo de gravação;
  - o link aberto (12/11): a caixa que a dona marca ao ligar o link ("todas as pessoas
    que falaram nesta reunião autorizaram compartilhar a gravação e a transcrição com quem
    receber o link"), o aviso de privacidade do detalhe, que agora fala do link, e o que o
    aviso de gravação e o termo de gravação dizem dele;
  - o texto das passkeys para a próxima versão do Termo Geral de Uso (cláusulas 7.3 e
    9.3). Ele espera a próxima versão porque republicar o Termo só por isso revogaria os
    aceites;
  - a Política de Privacidade, que ainda não existe;
  - o aviso da exportação (H8), se a cliente liberar.

## Fora do escopo

- Bots que entram no Zoom, no Meet e no Teams: serviço pago por hora, ou software que
  não cabe no servidor de hoje. A agenda entra pela H16, sem robô.
- Transcrição ao vivo e app de relógio.
- Integrações com Notion, Google Docs e OneNote.
- Espaços de equipe: a reunião compartilhada cobre o caso.
- Link público com senha. O link aberto, sem senha, entrou em 12/11, por enquanto (ver
  as decisões de 12/11): o áudio dele é a única exceção à regra de servir arquivo só pelo
  proxy, com sessão e posse.
