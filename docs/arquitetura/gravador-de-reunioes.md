# Gravador de reuniões: o desenho em ondas

Plano aprovado pelo Roberto em 30/10/2026 e atualizado com as decisões de 10/11,
12/11 e 15/11/2026, e com a de 16/11 sobre os nomes das vozes no link aberto (H3b, ver
os contratos). É desenho, não retrato do código: onde a `main` divergir deste texto,
vale a `main`. Em 10/11 entraram na `main` a A1 (#169), a A3 (#170), a A4 (#172), a G1a
(#174) e uma primeira versão do resumo e do "Pergunte à reunião" (#171), descrita nas
linhas da H4 e da H6. Na `main` de 15/11, a gravação ainda para em 10 minutos, também no
gravador em partes, que só liga com `/gravar?emPartes=1` (G9, #202). A G13a (#209, aberta)
tira esse teto no `/gravar?emPartes=1`, e a G13b, ainda sem PR, faz das partes o padrão
para todas (ver as decisões de 15/11). Quem faz cada PR, o prazo e o status ficam no
Notion. O detalhe de cada PR (arquivos, testes e as correções que a revisão do desenho
pediu) fica fora do repositório, com o Roberto: quem pegar uma PR pede esse detalhe a ele.

Os códigos de PR deste plano são A1 a A8, D1, G1a, G1b, G2 a G10, G13, G14, H1r, H3 a
H16, H9b, R1, S, DOC-0 (este documento), DOC-1 e DOC-2. A numeração tem lacunas porque a
revisão do desenho juntou, dividiu e tirou PRs: a G1 virou G1a e G1b; da H1 sobrou a H1r,
e o resto foi para a A3; a H2 e a G11 foram absorvidas pela D1; a G12 saiu do plano,
porque a importação é a H9, pelo navegador; e a H9b completa a H9 com WAV, OGG e WebM
longos, na Onda 5. A H16, da agenda, entrou em 10/11. Em 15/11, o plano aprovado pelo
Roberto dividiu PRs grandes, para cada uma caber numa rodada de revisão: a H4 virou H4a1,
H4a2, H4b, H4c e H4d; a G13 virou G13a e G13b; e a H16 virou H16a, H16b e H16c. A H5, a H7
e a H9 também foram divididas, e o desenho delas vem na DOC-2, depois da fila. A DOC-1
registra as decisões de 12/11 a 15/11. Estes códigos valem só para este plano: não são os
ajustes A1 a A14 nem as decisões D1, D2… do glossário, em [docs/README.md](../README.md).

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
  gravação, para quem grava acompanhar o tempo (trocado em 15/11: o aviso passa a pedir
  OK, ver "Decisões de 15/11/2026"). O envio único em base64 continua em 10
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
  sem conta na WRW. Com a #208 (aberta), o link passa a mostrar o resumo guardado, no
  lugar do resumo pedido à IA (ver as decisões de 15/11). As perguntas à IA continuam. O
  que já entrou (em [decisoes-tomadas.md](./decisoes-tomadas.md), 12/11):
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

## Decisões de 15/11/2026

Do Roberto, na conversa com o Claude de 15/11 que montou o plano do gravador da H4 em
diante. Valem sobre as de 10/11 e 12/11 nos pontos abaixo. O registro, com o que cada uma
mudou, está em [decisoes-tomadas.md](./decisoes-tomadas.md), em 14/11 e 15/11.

- **Gravação sem o teto de 10 minutos, com um OK a cada hora (G13).** A cada hora cheia de
  gravação, um aviso pequeno pede OK e fica ativo por 10 minutos. Sem o "Continuar
  gravando", a gravação para sozinha e o que foi gravado é entregue. Fora isso, só o
  "Encerrar" para a gravação: ela não para ao fechar a aba compartilhada (H14) nem no
  horário de término de uma reunião agendada (H16). Isso troca o aviso de hora "sem parar
  a gravação" de 10/11. O plano acrescentou um teto técnico de 12 h por reunião, no
  servidor, contra gasto. A G13 vem logo depois da H4.
- **Face ID e digital, no site e no app.** A A6 e a A7 voltam ao plano, com o RP ID
  `wrwglobal.org` (ver os contratos das passkeys). O app das lojas (M1) usa a mesma A6,
  com as chaves ligadas na WebView.
- **Bibliotecas.** A `mp4box` e a `docx` estão aprovadas, e também qualquer outra
  biblioteca segura: licença aberta, mantida e versão publicada há pelo menos duas
  semanas. Só entra dependência quando a plataforma não resolve bem.
- **Testes.** O que dá para automatizar entra na PR. O que exige mão humana vira cartão no
  Notion para o Gabriel e o Nicolas, um por PR que precise. Na G13, isso troca a bancada B
  (ver "As duas bancadas de teste").

Propostas no plano do mesmo dia e aprovadas pelo Roberto:

- a A6 e a A7 vêm logo depois da G13, com a ressalva do plano: "se preferir as passkeys no
  fim, é só dizer";
- reunião antiga, já pronta, não ganha resumo em lote: a dona toca em "Gerar resumo";
- o link aberto mostra o resumo guardado: os itens confirmados e os pendentes, estes com
  um aviso de que foram gerados pela IA e a dona ainda não os conferiu. Os ignorados nunca
  aparecem. As vozes seguiam como "Falante n"; desde a decisão de 16/11 (H3b), levam os
  nomes que a dona deu (ver os contratos);
- na exportação (H8), só saem os itens confirmados;
- o "Pergunte à reunião" (H6) lê até 400 mil caracteres, cerca de 7 h, e recusa acima
  disso, com aviso;
- a H16 põe o evento na Google Agenda também pela API, com o OAuth da conta da própria
  dona. A reunião agendada só ganha a gravação quando a dona toca em "Gravar agora".

Em aberto: o faturamento do Gemini, com alerta de orçamento (ver "O que depende de quem").

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
   PR #158). A troca de parte não pode deixar buraco no áudio. A bancada B, que conferiria
   a emenda, foi trocada em 15/11 (ver "As duas bancadas de teste"). Desde 16/11 o
   MediaRecorder da parte seguinte começa antes de o da atual parar, e a troca espera uma
   pausa da fala de uns 300 ms, ouvida por um AnalyserNode no mesmo fluxo: sem pausa, troca
   aos 620 s; sem AudioContext, ou com o contexto suspenso do iPhone, troca no tempo, aos
   600 s (`client/src/hooks/useGravadorDeAudio.ts` e `client/src/lib/detector-de-pausa.ts`).
   A emenda ainda deixa um buraco de dezenas de milissegundos, porque o stop() descarta
   o fim que o codificador AAC segurava: medido só no Chrome, de 10 a 58 ms (num cenário,
   as duas partes gravaram 153 ms em comum). Nenhuma palavra se perdeu na medida, porque a
   troca caiu numa pausa da fala; a troca sem pausa, ou no tempo, pode pôr o buraco no meio
   da fala.
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

Fixados antes da transcrição por fatia, para as PRs não se contradizerem. Fatia e parte
são a mesma coisa: o desenho antigo diz "fatia", e o texto novo diz "parte", o nome que a
tela e a rota usam (`/gravar?emPartes=1` e `/api/reunioes/:id/partes/:seq`).

- **Segmento da transcrição:** `{inicio, fim, falante, texto, lacuna?}`.
  - O tempo vai em segundos absolutos da reunião.
  - O modelo escreve o tempo da fala DENTRO da parte como texto `"MM:SS"`, num esquema com
    padrão, e o servidor o converte em segundos e soma o início da parte
    (`server/transcricao-de-fatia.ts`). Pedido como número de segundos, o Gemini escrevia
    os minutos e os segundos juntos (1:00 virava 100): na bancada de 17/11, a fala depois
    dos ~6 min de cada parte ficou presa no fim dela ou não veio. Fala com tempo fora da
    parte fica presa no fim, nunca é descartada. Tempo que ainda chegar como número se lê
    em segundos; os minutos e os segundos juntos só valem com evidência clara nos inícios
    (dois mais de 30 s depois do fim da parte, ou um mais de 1 min depois do teto).
  - Parte com mais da metade das falas (de 2 em diante) presas no fim ou sem tempo
    legível volta à fila (`TEMPOS_FORA_DA_PARTE`); na última tentativa entra, com as
    contagens em `result.tempos` (`{presasNoFim, semTempo, total}`) para uma consulta
    achá-la. Resposta com todas as falas fora do formato (sem `texto`) é erro, como o
    JSON inválido, e não parte em silêncio.
  - O falante é gravado como `F1`, `F2`... O rótulo "Falante 1" só existe na tela, numa
    chave de texto só.
  - Os nomes que a dona dá às vozes (H3, #204) aparecem para ela e, desde a H3b
    (decisão do Roberto de 16/11, em [decisoes-tomadas.md](./decisoes-tomadas.md)),
    para quem tem o link aberto. No link, só quando a última vez que a dona o ligou foi
    com a confirmação que fala dos nomes (a versão 2, gravada na linha
    `MEETING_OPEN_LINK_ON` da auditoria). O link ligado antes segue com "Falante n" até
    ela desligar e ligar de novo. `reuniaoAberta.ver` manda os nomes no campo `vozes`
    (`{F1: "Ana"}`), só as chaves `F1` a `F99`, cada nome aparado e cortado em 60
    caracteres, e nada mais da dona. A voz sem nome é "Falante n" em toda tela. No texto
    que a IA escreve (o resumo, desde a #205, e a resposta do Pergunte), a voz vai como
    `{F1}`, e os nomes nunca vão ao prompt. Quem troca o token pelo nome é a tela, também
    no link aberto. Pelo plano de 15/11, há duas exceções: as próximas ações (H5a)
    gravam o nome quando a reunião é excluída ou reprocessada, e o lembrete no sino (H15)
    troca o token na hora do aviso. O mapa mental (H10) não aceita token nos rótulos.
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
  - cadastrar uma chave pede entrada recente: só a sessão aberta há até 10 minutos
    (com a senha ou com outra chave) cadastra; depois disso, a tela pede a senha e entra
    de novo. E a dona recebe um e-mail a cada chave cadastrada. Sem as duas coisas,
    quem estivesse com a sessão de outra pessoa (o computador do evento esquecido
    aberto, o cookie copiado) criaria uma credencial que sobrevive a "Sair" e à
    revogação das sessões (revisão da A6, 16/11);
  - o identificador da conta que vai para o aparelho é fixo por conta: cadastrar de
    novo, depois de a conta ficar sem chaves, substitui a chave antiga no aparelho, em
    vez de deixar duas;
  - o desafio de uso único fica numa tabela pequena, na mesma migração das chaves, e é
    consumido por um UPDATE condicional. Ele não fica no `audit_logs`, porque o insert
    de lá engole o erro: se falhasse, o mesmo desafio continuaria valendo;
  - sem `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGENS`, a função some (a entrada, o cadastro e a
    gestão das chaves);
  - o RP ID é o domínio a que cada chave de acesso fica presa. Depois que a primeira
    usuária cadastrar uma chave, ele não pode mais mudar. Decidido pelo Roberto em 15/11:
    `WEBAUTHN_RP_ID` é `wrwglobal.org`, e `WEBAUTHN_ORIGENS` leva `https://wrwglobal.org` e
    `https://www.wrwglobal.org`. A chave presa a `wrwglobal.org` vale com e sem www. Ela
    não nasce no endereço `.onrender.com`, que a A8 vai redirecionar para o domínio
    próprio: lá a chave não vale, e o botão não aparece, como em qualquer origem fora da
    lista. O Roberto põe as duas variáveis no Render; até lá, a função fica invisível em
    produção.

## As ondas

Prazo: a cliente quer o app ativo em cerca de 20 dias a partir de 08/11, perto de
28/11/2026. As ondas abaixo seguem a ordem do plano de 30/10, com as mudanças de 10/11.
Se a ordem mudar para caber no prazo, quem decide é o Roberto. Em 15/11, o plano aprovado
por ele fixou a ordem da fila daqui em diante: a H4 (H4a1, H4a2, H4b e H4c), a G13 (G13a e
G13b), a A6 e a A7, e depois a H6, a H5, a H7, a H10, a H16, a H8, a H9 e a H11 a H15. A
H4d vem por último, porque espera a Glenda. A H9b, a R1, a A8, a G14 e o app das lojas
(M1) ficam fora desta fila.

Tamanho: P é pequena, M é média e G é grande.

**Onda 1: acesso e navegação.**

| PR | O que faz | Depende de |
|---|---|---|
| A1 `fix/esqueci-senha-tela-neutra` (M) | A tela do "Esqueci a senha" diz "Pedido recebido", repete o e-mail digitado, explica o que fazer se nada chegar e oferece "Corrigir o e-mail" e "Criar conta". | — |
| A2 `fix/redefinir-senha-derruba-sessoes` (P) | O reset derruba as sessões abertas, grava a auditoria e consome o token num UPDATE condicional. | — |
| A3 `feat/gravar-primeira-tela` (M) | `/gravar` abre o gravador e o login cai nele (quem não concluiu o cadastro segue indo ao onboarding); `?voltar=` seguro; `/meetings/:id`; Reuniões em primeiro no menu; botão "Gravar reunião" no Dashboard; a Memória abre o detalhe da reunião. | — |
| G2 `chore/modelo-de-audio-configuravel` (P) | `LLM_AUDIO_MODEL` com guarda contra alias, e um script que lista os modelos que a chave enxerga. | — |
| A4 `feat/pwa-instalavel` (P) | Manifest com `start_url /gravar`, só com a marca (WRW) e sem atalhos (`shortcuts`), para não ter texto a traduzir. Ele aponta os ícones que já existem em `client/public/brand/`, e a A4 acrescentou ao `client/index.html` as meta tags da Apple (`apple-mobile-web-app-*`); o `apple-touch-icon` já existe. Sem service worker, e o `.webmanifest` sai sem cache, como o HTML. A dica de instalação fica no `/gravar`, nos 10 idiomas, e avisa que, no iPhone, o app instalado pede um login separado do Safari. Se a dica entrar no `Meetings.tsx`, a A4 segue a regra dos arquivos em série. A #172 entrou sem a dica, que veio na PR seguinte (`feat/dica-de-instalacao`, 13/11/2026): o botão do pedido do Chromium ou os passos de cada aparelho, a marca `mmm:dica-de-instalacao` no aparelho (fechada ou app instalado) e, durante a gravação, invisível sem perder o lugar. | A3 |
| A5 `chore/abrir-sessao-reaproveitavel` (P) | A sessão nasce numa função só, pronta para a passkey: `abrirSessao` (`server/sessao.ts`) grava a linha em `sessions` e assina o token (JWT) com o `sessionToken` dela. Uma guarda (um teste, `server/sessao-guarda.test.ts`) impede que o servidor assine JWT fora desse módulo, e o `sdk.signSession` saiu: o token dele não levava o `sessionToken` conferido no banco, por padrão durava 1 ano e escapava da revogação das sessões. O sdk passa a recusar JWT de usuária sem `sessionToken` (só o cron passa sem ele), e quem ainda tiver um token antigo, da época do Manus, precisa entrar de novo. | A2 |
| G1a `fix/gravadores-mp4` (M) | Um hook de gravação só para os três gravadores (o da reunião, o do ditado e o da voz no perfil do contato), com mp4 antes de webm, como o do ditado já faz desde a #158. O hook já nasce aceitando um MediaStream de fora (um fluxo de áudio entregue pronto, no lugar do microfone que ele abre por padrão), que a H14 vai usar para gravar a aba. Entrou na `main` em 10/11 (#174). | A3 |
| S `feat/sessao-ocupada` (M) | Enquanto há gravação, envio ou áudio gravado ainda não enviado, o Sair da conta pede confirmação antes de revogar a sessão, e fechar ou recarregar a aba pede a do navegador (no computador; no iPhone e no iPad o navegador não pergunta, e fechar o app instalado também não: no celular, a proteção é a cópia no aparelho da G9). Sair da conta, ou excluí-la, solta as ocupações que sobraram, como o envio ainda no ar. Reduzida depois da #179 (sessão de 90 dias desde o último uso, sem o corte por inatividade): sem teto de tempo, que só existia por causa do corte, e sem adiamento automático da ida ao login, porque agora só uma revogação derruba a sessão no meio, e aí vale a regra de segurança. Ressalvas: a ida ao login troca de página, e com a sessão ocupada o navegador pergunta também nela; quem escolhe ficar mantém a aba e o áudio, e o servidor recusa tudo até ela entrar de novo. O recarregar automático depois de um deploy (o `vite:preloadError` do `main.tsx`, que vem na primeira ida a uma tela que a aba ainda não baixou) também pergunta, e ali ficar não protege o áudio: o app cai na tela de erro (o `ErrorBoundary`), a gravação e o áudio por enviar se perdem com qualquer resposta, como já se perdiam nessa ida, e só um envio já no ar segue até o fim, sem o aviso do resultado. Tirar essas perguntas exige mexer no `main.tsx` (e, na do login, no `ProtectedRoute`), fora desta PR; na do deploy, só deixar de recarregar não basta, porque a tela pedida continua sem código. | A3 |

**Onda 2: a base da gravação longa e as passkeys.**

| PR | O que faz | Depende de |
|---|---|---|
| G3 (M, migração) | Tabela de fatias, estado "enviando", versão do aviso, `origem` e `audio_pipeline`, transcrição em MEDIUMTEXT. A lista e o detalhe passam a escolher as colunas e deixam de mandar as colunas de controle da fila. | decisão sobre a #134 |
| G1b (M) | Seletor do idioma da reunião, que por padrão é o da tela de quem grava. A G1b traz a função `nomeDoIdioma` (ver os contratos), e o ditado e a voz do contato passam a usá-la também. Na tradução, o servidor e a tela deixam de tratar o pt-BR como o original fixo: sem isso, uma reunião em inglês "traduzida" para pt-BR voltaria em inglês. | G1a, G2 |
| A6 (G, migração) | Servidor das passkeys com `@simplewebauthn/server`: a tabela das chaves e a do desafio de uso único, a entrada sem senha e a gestão pela dona, seguindo os contratos das passkeys. Sem `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGENS`, a função some. Voltou ao plano em 15/11, por decisão do Roberto, com o RP ID `wrwglobal.org`. A posição, logo depois da G13, foi proposta no plano do mesmo dia e aprovada por ele (ver as decisões de 15/11). | A5 |
| G4 (M) | Aviso de gravação em rascunho, versionado como dizem os contratos. Ele cita a IA do Google, a transferência internacional, a retenção e a separação de falantes, e diz quem terá acesso: as participantes adicionadas e, para consulta, a presidência e a admin, com registro, e quem receber o link aberto que a dona ligar (decisões de 12/11). O rascunho completo fica em `docs/termos/` para a Cris. | G1b, G3 |
| G6 (M) | Transcrição de uma fatia no Gemini, com falantes e tempos, e o script da bancada A (ver "As duas bancadas de teste"). | G1b |
| G8 (M) | Extração, tradução e Memória leem a reunião inteira, em janelas. A tradução de uma reunião longa sai da requisição e vira trabalho em segundo plano. | G1b, A3 |
| A7 (G) | Tela das passkeys: login, convite depois da senha e gestão no Perfil. Voltou ao plano em 15/11 com a A6, por decisão do Roberto. A posição, logo depois da A6, foi proposta no plano do mesmo dia e aprovada por ele. | A6 |

**Onda 3: o gravador sem teto de tempo.**

| PR | O que faz | Depende de |
|---|---|---|
| G5 (G) | Reunião criada no início e rota binária das fatias. | G4, G8, #149 |
| H1r (P) | A Memória e o perfil do contato abrem a reunião certa. A abertura pela Memória, pelo `metadata.meetingId`, vem na A3; a H1r põe os links da reunião no perfil do contato e faz o `/meetings/:id` repassar à tela `?t` (o segundo da fala), `?q` (o termo buscado) e `?item` (o combinado). | G8 |
| G7 (G) | Fila de transcrição no MySQL. | G5, G6 |
| R1 (G, migração) | Reunião compartilhada com participantes e consulta auditada da administração. Adiada em 12/11: por ora, no lugar dela, entrou o link aberto (decisões de 12/11). | G3, A3, #149 |
| D1 (G) | Detalhe único: transcrição por falante, player que renova a URL, andamento, busca e tempo de fala, também na página do link aberto (`ReuniaoAberta.tsx`). | G7, S, R1 (adiada em 12/11) |
| G9 (G) | Gravador que envia em partes por baixo, numa gravação contínua para quem grava, com cópia no aparelho até o servidor confirmar e retomada do envio. Uma trava do navegador (Web Locks) impede duas abas de enviarem a mesma gravação, e a cópia é apagada ao sair e ao excluir a conta. Entrou em 14/11 (#202) atrás de um interruptor: só liga com `/gravar?emPartes=1`, até a G13b. | D1, G4, G5, G7, S |
| G10 (M) | Gravação longa no celular: tela acesa, aviso do iPhone, pausa e "continuar gravando". Em vez do aviso de limite, que não há mais, um aviso a cada hora completa de gravação ("1 hora de gravação", "2 horas"...), sem parar a gravação. Pela decisão de 15/11, esse aviso passa a pedir OK: na G13a (#209), ele vira o aviso que para a gravação quando ninguém responde em 10 minutos (ver a G13). | G9 |
| H9 (G) | Importar M4A, MP3, MP4 e MOV pelas partes, com o mesmo teto de tempo da gravação: 12 h, depois da G13. O navegador corta o MP3 nas fronteiras de quadro e tira o áudio (AAC) de M4A, MP4 e MOV com o `mp4box`; do vídeo, só o áudio sai do aparelho. | G9, G13 |
| G13 (M) | Tira o teto de tempo da gravação em partes, que até ela segue em 600 s, para todos os níveis e sem teto mensal. Pelas decisões de 15/11, no lugar do aviso sem parar da G10, a cada hora cheia de gravação um aviso pede OK e fica ativo por 10 minutos; sem resposta, a gravação para sozinha e entrega o que gravou. Fora isso, só o Encerrar para a gravação. Fica um teto técnico de 12 h por reunião, no servidor, contra gasto. O envio único em base64 (`meetings.submitRecording`, que até a H9b ainda recebe WAV, OGG e WebM) continua em 600 s e 10 MB, numa constante própria e com os textos dele, até sair na G14. Vem logo depois da H4, em duas PRs: a **G13a** (#209, aberta) traz o aviso de hora e o teto de 12 h, ainda só no `/gravar?emPartes=1`; a **G13b**, ainda sem PR, faz das partes o padrão para todas, com o `?emPartes=1` aceito e sem efeito e o `?envioUnico=1` como saída de suporte até a G14. A G13b traz também o "Descartar gravação", com confirmação, os avisos de parte recusada e de cópia no aparelho indisponível, o conserto do duplo clique em "Iniciar gravação", o painel de minutos com o limite de 12 h por reunião, o FAQ (`server/routers/faq.ts`) e os textos de tela que ainda falam em 10 minutos. A importação (H9), que agora vem depois, já nasce com o teto de 12 h. No lugar da bancada B, testes automatizados e um cartão de teste humano no Notion (ver "As duas bancadas de teste"). | G4, G7 a G10, D1 |

**Onda 4: resumo e funções em volta.** H3 e H4 podem correr ao lado de G9 e G10.

| PR | O que faz | Depende de |
|---|---|---|
| H3 (M, migração) | Nomes dos falantes. Entrou em 14/11 (#204), só para a dona. Pela decisão do Roberto de 16/11, a **H3b** (P, sem migração) leva os nomes ao link aberto ligado com a confirmação que fala deles; o link ligado antes segue com "Falante n" (ver os contratos). | D1, R1 (adiada em 12/11) |
| H4 (G, migração) | Resumo guardado, no formato que a cliente pediu (ações com caixa de marcar, foco do trabalho, tarefas por assunto, decisões, bloqueios e questões pendentes), no idioma da reunião, cada item pendente até a dona confirmar. Os modelos de resumo são Geral, Networking, Mentoria, Vendas e 1:1. A #171 já pôs na `main` uma primeira versão, gerada a pedido, sem modelos, sem guardar nada e só para a dona; a H4 parte dela. Dividida em 15/11: **H4a1** (#205), a base, com as tabelas, o prompt e a conferência de cada item; **H4a2** (#206), a fila que gera o resumo em segundo plano e as rotas para ler e decidir; **H4b** (#207), o player fixo no rodapé, um só para todas as abas; **H4c** (#208, aberta), o resumo na tela e no link aberto, gerado sozinho quando a reunião fica pronta, no lugar do resumo a pedido da #171; e **H4d**, os modelos de resumo, que esperam a Glenda. As três primeiras estão no ar desde 15/11. | H3, G7 |
| H6 (M) | "Pergunte à reunião", só com o que foi dito e citando os tempos. Pelo plano, as perguntas e as respostas não ficam guardadas (ver o ponto sobre "o chat" nas decisões de 10/11). A #171 já pôs na `main` uma primeira versão, só para a dona e citando o trecho, ainda sem os tempos. Pelo plano de 15/11, lê até 400 mil caracteres da transcrição, cerca de 7 h, e recusa acima disso, com aviso. | H4 |
| H5 (M) | Combinados confirmados viram "Próximas ações". Em 16/11, a **H5c** levou a ação aberta com prazo à agenda da dona (pedido da Glenda em 11/11, R-27): um evento às 9h do dia do prazo, com aviso na hora, na Google Agenda conectada (a conexão da H16b, sem variável nova) ou, sem ela, pelo link de criar evento e pelo `.ics`. Feita, sem prazo ou apagada, a ação sai da agenda (`server/acoes-na-google.ts`, `shared/acoes-na-agenda.ts`). | H4 |
| H8 (M) | Quem gravou exporta a reunião, com auditoria. Pelo plano de 15/11, só saem os itens confirmados do resumo. Em 16/11 o Roberto deixou só o **PDF** nesta entrega (TXT, Markdown, SRT e Word ficam de fora, e a `docx` não entra): o "Baixar PDF" do detalhe abre a impressão do aparelho sobre um documento próprio, com as fontes do sistema, para o árabe, o hindi, o chinês e o japonês saírem certos no celular. A leitura e a linha `MEETING_EXPORTED` vão na mesma transação, com teto de 30 a cada 10 min (ver as decisões de 16/11). | H4 |
| H8c (M/G) | A dona baixa o áudio da reunião num arquivo só, em MP3 ou M4A (HN-60 no HiNoter). Pelo **servidor**: o ffmpeg na imagem do `Dockerfile` emenda as partes, na ordem e no tempo do player (silêncio no trecho que falta), em qualquer mistura de formatos (WebM/Opus, MP4/AAC, MP3 e os da importação em partes da H9b e da H9c: WAV, OGG, FLAC e AAC em ADTS), e converte enquanto o arquivo sai, sem guardar o resultado (`server/conversao-do-audio.ts`). O navegador ficou de fora: o iPhone teria de decodificar o WebM/Opus gravado no Android, o MP3 pediria um codificador em JavaScript, e 12 h de áudio não cabem na memória de um celular. Em dois passos: `meetings.baixarAudio` confere a dona, a gravação encerrada, os 30 dias e o teto, lê as partes e grava `MEETING_AUDIO_DOWNLOADED` na mesma transação, e devolve uma ficha de uso único, de 2 minutos e só para a sessão da dona; a rota `GET /api/reunioes/baixar-audio/{ficha}` transmite o arquivo, sem URL nem chave do bucket no navegador. Teto de 10 áudios por hora por dona e 2 conversões por vez na instância; depois dos 30 dias o botão some e o servidor recusa com `AUDIO_VENCIDO`, que a tela traduz. O link aberto não baixa áudio. | H8; a retenção de 30 dias |
| H7 (M, migração) | Busca entre reuniões, etiquetas e "Onde foi". | H4 |
| H16 (M, migração) | Agendar a reunião na WRW, com título, data, hora e participantes, pô-la na Google Agenda por link de criação de evento ou por um arquivo .ics e mandar o convite por WhatsApp e por e-mail (o botão do Outlook saiu em 12/11). Em 15/11, o desenho detalhado entrou no plano aprovado pelo Roberto, em três PRs: **H16a**, a agenda na WRW (também com fuso, local ou link e lembrete), o .ics gerado no navegador, o link de criação de evento e o convite, aberto no app da própria dona; **H16b**, a dona conecta a própria conta Google por OAuth; e **H16c**, a WRW cria, atualiza e exclui o evento na Google Agenda, com convidados e lembrete, e o convite pela conta Google da dona fica desmarcado por padrão. A agenda por API, que em 10/11 ficava para depois, entrou na fila. A reunião agendada só ganha a gravação quando a dona toca em "Gravar agora", que abre o gravador e liga a reunião. O que falta do Roberto no Google Cloud está em "O que depende de quem". | G5, G9 e D1, pelo "Gravar agora" (a R1 ficou fora da fila de 15/11) |

**Onda 5: depois, conforme a cliente.**

- **H10:** mapa mental, com migração: colunas novas em `meeting_summaries`. A IA gera o
  mapa numa chamada separada, depois do resumo; se o mapa falhar, o resumo continua
  pronto. O mapa tem de 2 a 12 ramos e até 3 níveis, com rótulos de até 60 caracteres e
  sem token de voz. Na tela, o `MapaMental.tsx` é feito em CSS: árvore horizontal a partir
  de 768 px, contorno vertical que recolhe no celular, e funciona também da direita para a
  esquerda (árabe). A aba "Mapa mental" fica no detalhe da reunião e no link aberto.
- **H11:** tradução do resumo.
- **H12:** resumo de PDF. Na reunião de documento, os textos do detalhe e do link aberto
  falam do documento, e não da transcrição ou do que foi dito (o resumo, o Pergunte, o
  mapa mental, as entidades e a tradução); com o teto de 10 documentos por hora já
  cheio, `meetings.iniciarDocumento` recusa antes de a reunião nascer, e a reunião de um
  envio que não terminou aceito sai quando a dona deixa a tela (menos a da rede que
  caiu, que o servidor pode ter recebido).
- **H13:** resumo de vídeo do YouTube, como no HiNoter que a Glenda viu (o Roberto decidiu
  em 16/11 que entra). A dona cola o link de um vídeo público, e a reunião nasce com a
  origem `youtube` e a URL canônica do vídeo em `meetings.source_url` (migração 0022):
  - `shared/youtube.ts` tira o id do link (watch, youtu.be, shorts, embed, live e v, com e
    sem parâmetros), com a mesma regra na tela e no servidor;
  - o servidor nunca busca a URL: o Gemini lê o vídeo pela própria URL (`file_data`), só
    a primeira hora (`video_metadata.end_offset`), com um quadro a cada 5 s em baixa
    resolução, e devolve as falas no contrato da transcrição em partes, com os tempos em
    "MM:SS"; daí em diante é o caminho de sempre (resumo guardado, mapa mental e
    Pergunte);
  - teto de 5 vídeos por dona a cada 24 h, contado na auditoria do pedido
    (`MEETING_YOUTUBE_REQUESTED`), que vale também para o "Tentar de novo";
  - as falhas que se repetem com o mesmo vídeo (fala demais para uma resposta e nenhuma
    fala) não têm "Tentar de novo", e o servidor o recusa nelas sem gastar vaga; o mesmo
    vale para o "Reprocessar" do PDF longo demais e do PDF corrompido que o Gemini não
    abre (`DOCUMENTO_ILEGIVEL`, H12);
  - o aviso do YouTube tem versão própria, gravada em `consent_notice_version`
    (`docs/termos/aviso-de-gravacao-rascunho.md`), e o link aberto do vídeo tem caixa
    própria (`meetings.youtube.shareAuthorization`), que fala da transcrição, e não da
    gravação, que não existe;
  - a marca entre colchetes sem fala (`[música]`, `[ruído]`) não é voz: fica fora do tempo
    de fala e sem o rótulo do falante (`shared/fala-na-transcricao.ts`), também no áudio;
  - na tela não há player, porque a CSP proíbe frames de outros sites: o ▶ de cada fala,
    item e citação abre `youtube.com/watch?v=ID&t=Ns` numa aba nova, também no link
    aberto;
  - os erros (vídeo privado, longo demais, sem fala, link inválido, IA ocupada, teto)
    saem como código traduzido.
  O recurso do Gemini para vídeo do YouTube ainda está em prévia.
- **H14:** gravar a aba de uma reunião online, só no Chrome e no Edge do computador. Usa
  o hook da G1a, passando a ele o áudio da aba.
- **H15:** lembrete no sino.
- **H9b e H9c** (`feat/importar-outros-formatos`): importar em partes, até 12 h, o M4A, o
  MP4 e o MOV (H9c, só o áudio AAC sai do aparelho, cada parte um MP4 fragmentado), o WAV,
  o OGG (Opus e Vorbis), o WebM e o MKV (o Opus vira Ogg Opus; o AAC, MP4 fragmentado), o
  FLAC e o AAC em ADTS (H9b), sem recodificar (`client/src/lib/corte-do-arquivo.ts`). O
  arquivo curto de um formato que o corte reconhece mas não lê (ALAC, AC-3, o Vorbis no
  WebM) segue no envio único de hoje; o maior recebe o aviso com o nome do formato. Cada
  parte fecha na última pausa da fala antes do teto, até 20 s antes dele, como a gravação
  ao vivo (`client/src/lib/pausas-do-corte.ts`): o WAV mede o volume das amostras na
  janela antes do teto; os comprimidos são lidos duas vezes, a primeira para achar as
  pausas pelo global_gain (MP3, AAC), pela marca de voz (Opus em modo SILK) ou pelos bits
  por amostra (FLAC). Sem pausa na janela, o corte cai no teto. O Vorbis e o Opus em modo
  CELT só acham a pausa em silêncio digital (conferência de tela do pacote 4b: a fala que
  atravessava a emenda do WAV, cortado a cada 14 MB, sumia da transcrição).
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
- **Bancada B (antes da G13), trocada em 15/11.** Pela resposta do Roberto à pergunta sobre
  esta bancada, em 15/11 (teste o que der; o que precisa de toque humano vira cartão), a
  G13 passa a ser provada por testes automatizados e por um cartão de teste humano no Notion para o
  Gabriel e o Nicolas. O roteiro do cartão e os testes foram propostos no plano de 15/11 e
  aprovados por ele. O cartão é "Gravação real de mais de 1 hora", em produção com
  `?emPartes=1`: no iPhone (Safari e app instalado), no Android e no computador, com uma
  das reuniões passando de 2 h e o aviso deixado sem resposta, 20 minutos em outra aba e 2
  minutos em modo avião. Os testes automatizados são os de relógio falso, a integração dos
  tetos e um ponta a ponta sem humano, com o microfone dublado por uma fala sintética e o
  relógio adiantado. O desenho antigo da bancada B era este: reuniões reais de 45 minutos
  ou mais, ao menos uma com mais de 1 hora, com o consentimento de quem fala, gravadas por
  HTTPS no iPhone (Safari e app instalado), no Android (Chrome) e no Chrome do computador.
  Ela conferia que:
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
  - uma aberta por vez, na ordem G3, A6, R1, H3, H4, H7, H10, H16, H11, H12, H13 e H15;
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
  (MIT), `mp4box` (BSD-3-Clause) e `docx` (MIT). O aval do Roberto veio em 15/11: a
  `mp4box` e a `docx` estão aprovadas, e também qualquer outra biblioteca segura (licença
  aberta, mantida e versão publicada há pelo menos duas semanas), o que cobre as das
  passkeys. Só entra dependência quando a plataforma não resolve bem.

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
  - já: se veta a proposta da gravação contínua com o envio em partes interno (ver as
    decisões de 10/11); sem veto, ela fica;
  - na Onda 1, depois da G2: rodar o script da G2 com a chave de produção do Gemini, ou
    confirmar que a chave de desenvolvimento é do mesmo projeto, para saber que modelos
    a chave enxerga;
  - antes da Onda 2:
    - o destino da #134, com o Nicolas, e a validação e o merge da #149 (ver "PRs
      abertas no caminho");
    - pôr no Render `WEBAUTHN_RP_ID` e `WEBAUTHN_ORIGENS`, com os valores decididos em
      15/11 (ver os contratos das passkeys). Até lá, a A6 e a A7 ficam invisíveis em
      produção;
    - se existe app ou outro cliente fora do repositório chamando
      `meetings.submitRecording` (o `shared/const.ts` cita "o app Expo"), porque a G14
      só entra sem cliente externo;
    - se "o chat" que a administração consulta inclui as perguntas feitas à IA sobre a
      reunião (H6), porque isso muda a H6 e o aviso de gravação (G4);
  - antes da Onda 3:
    - o faturamento da chave do Gemini, com alerta de orçamento, ainda sem resposta em
      15/11. A H4c (#208, aberta) passa a gerar o resumo de toda reunião pronta, e a G13b
      libera gravações de horas para todas. Sem faturamento, a cota grátis pode travar
      também a transcrição;
    - o plano do Render em vigor;
    - a cota de download do B2 e um bucket de desenvolvimento;
    - o aval ao teto de 3 gravações abertas por conta, que é contra abuso e não um teto
      de minutos;
  - antes da H16b (o desenho detalhado da H16 está no plano de 15/11):
    - no Google Cloud: ativar a Calendar API; o branding (nome WRW, e-mail de suporte e
      domínio verificado); o público "Externo", em modo Teste, com as contas da Glenda e
      do time como usuárias de teste; os escopos `openid`, `email` e `calendar.events`; e
      um cliente "Aplicativo da Web" com o retorno
      `https://wrwglobal.org/api/google-agenda/retorno`, mais outro para o localhost. No
      modo Teste, o token vence em 7 dias; para sair dele, a Google exige uma Política de
      Privacidade real e um vídeo;
    - no Render: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` e
      `VAULT_ENCRYPTION_KEY` (só os nomes vão ao código). Se a `VAULT_ENCRYPTION_KEY`
      ainda não existir lá, criá-la torna ilegível o `encryptedSensitiveData` antigo de
      `server/matching.ts`, que hoje ninguém lê.
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
  - o link aberto (12/11): a caixa que a dona marca ao ligar o link, o aviso de
    privacidade do detalhe (`meetings.privacyNotice`) e o aviso do gravador
    (`meetings.consentNotice`), que agora falam do link, e o que o aviso de gravação e o
    termo de gravação dizem dele. A caixa mudou em 16/11 (H3b) para falar dos nomes das
    vozes: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram que quem
    receber o link ouça a gravação e leia a transcrição, com os nomes que eu der às
    vozes." (a de 12/11 dizia "autorizaram compartilhar a gravação e a transcrição com
    quem receber o link"). A prova guarda a frase, o idioma e a versão que a dona viu. Na
    versão nova do aviso de gravação, que vem com a H6b, o ponto 4 do rascunho passa a
    dizer que os nomes dados às vozes aparecem também pelo link;
  - o texto das passkeys para a próxima versão do Termo Geral de Uso (cláusulas 7.3 e
    9.3). Ele espera a próxima versão porque republicar o Termo só por isso revogaria os
    aceites;
  - a Política de Privacidade, que ainda não existe. A Google também a exige para a H16b
    sair do modo Teste;
  - o aviso do "Baixar PDF" (H8, chave `meetings.export.notice`, nos 10 idiomas): "O PDF
    leva a transcrição desta reunião, com os nomes que você deu às vozes, e só os itens do
    resumo que você confirmou. Depois de baixado, o arquivo fica fora da WRW: guarde-o com
    cuidado e compartilhe só com quem participou da reunião ou autorizou."
  - o aviso do "Baixar o áudio" (H8c, chave `meetings.audioDownload.notice`, nos 10
    idiomas): "O arquivo leva a gravação inteira desta reunião, com a voz de todas as
    pessoas que falaram. Depois de baixado, ele fica fora da WRW e não é apagado aos 30
    dias: guarde-o com cuidado e compartilhe só com quem participou da reunião ou
    autorizou." Como no PDF, o arquivo baixado também não some quando uma das pessoas
    pede a exclusão dos dados: se o termo de gravação precisa dizer isso, é com ela.

## Fora do escopo

- Bots que entram no Zoom, no Meet e no Teams: serviço pago por hora, ou software que
  não cabe no servidor de hoje. A agenda entra pela H16, sem robô.
- Transcrição ao vivo e app de relógio.
- Integrações com Notion, Google Docs e OneNote.
- Espaços de equipe: a reunião compartilhada cobre o caso.
- Link público com senha. O link aberto, sem senha, entrou em 12/11, por enquanto (ver
  as decisões de 12/11): o áudio dele é a única exceção à regra de servir arquivo só pelo
  proxy, com sessão e posse.
