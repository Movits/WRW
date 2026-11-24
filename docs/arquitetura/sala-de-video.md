# Sala de vídeo dentro do MarquesaMatch: estudo para decisão

Estudo de 24/11/2026, para o Roberto decidir. Vem do cartão do Notion "Sala de vídeo
própria dentro do WRW: estudar e implementar (reuniões online no próprio app)", com o
Nicolas, passado pelo Roberto no grupo em 16/11 e hoje em "Em andamento". O cartão ainda
diz WRW; desde 23/11 o nome na tela é MarquesaMatch, e o WRW segue no domínio
(`wrwglobal.org`) e na infraestrutura. **Nada daqui está implementado, e nada entra no
código antes da decisão.** Enquanto isso, a gravação da aba (H14) e o robô nas reuniões
(H21) ficam parados, esperando a mesma decisão.

Os preços e as regiões foram vistos nas páginas oficiais dos fornecedores em 24/11/2026,
em dólar, sem impostos nem câmbio, e mudam sem aviso: confira de novo antes de contratar.
O que não deu para confirmar numa página oficial vem marcado como "não conferido".

## Resumo para decidir

- **Por que a sala:** a Glenda quer manter as pessoas dentro do app, por causa da taxa da
  plataforma em cada negócio fechado (registro da "Próxima ação" do cartão, lida em
  24/11). Uma sala que mande para fora (link do Zoom ou do Meet, app de terceiros) não
  atende.
- **O que seria:** a dona de uma reunião abre a sala, e as participantes da reunião
  entram pelo site ou pelo app das lojas, com a conta delas. A conversa acontece dentro
  do MarquesaMatch, e a gravação entra na mesma fila de partes do gravador, com a mesma
  transcrição, o mesmo resumo e o mesmo mapa mental das reuniões presenciais.
- **Recomendação:** serviço pronto, com a tela feita por nós sobre o SDK dele: o **Daily**,
  com o vídeo passando pelo servidor dele em **São Paulo**. A gravação acontece no
  aparelho da dona, pelo gravador em partes de hoje, que já aceita um fluxo de áudio de
  fora.
- **Custo por hora de reunião, com vídeo:** US$ 0,24 por pessoa no Daily (US$ 0,96 numa
  reunião de 4 pessoas, US$ 1,44 numa de 6), depois dos 10 mil minutos-pessoa grátis do
  mês, que cobrem umas 40 reuniões de 1 hora com 4 pessoas. Só com áudio, um quarto
  disso. A transcrição e o resumo custam o mesmo que uma hora de gravação de hoje. Ver
  "Quanto custa".
- **O que muda no Render:** duas variáveis, a câmera liberada no cabeçalho de
  permissões, uma migração e uma chamada do servidor à API do Daily para criar a sala.
  Nada de porta nova, plano novo nem máquina nova: o vídeo vai do aparelho direto ao
  Daily, sem passar pelo Render. Ver "O que muda no Render".
- **Alternativa:** o **LiveKit Cloud**, de código aberto (a mesma tela passa depois a um
  servidor próprio) e mais barato nos minutos, mas sem servidor de vídeo publicado na
  América do Sul: o vídeo de duas pessoas no Brasil iria e voltaria dos Estados Unidos, e
  a banda acima da franquia é cobrada à parte.
- **Por que não um servidor de vídeo próprio agora:** o Render não aceita o tráfego que o
  vídeo usa (UDP), então seria outra máquina, a partir de uns US$ 190 por mês em São
  Paulo, com manutenção e plantão por conta do time.
- **Tamanho:** 5 PRs de código (V1 a V5) e 1 na casca das lojas, depois da R1b (o acesso
  por participante, no Notion).
- **O que precisa de resposta antes da primeira PR** está em "Perguntas para o Roberto e
  a Glenda", no fim.

## Os requisitos do cartão e onde cada um está

A "Próxima ação" do cartão, lida em 24/11, pede o seguinte. Cada linha diz onde o estudo
responde.

| Requisito | Onde |
|---|---|
| 1. Manter as pessoas dentro do app (a taxa da plataforma em cada negócio); sala que manda para fora não atende | "As três opções" (critério "fica dentro do app") e "No app das lojas" |
| 2. Escolher o caminho (servidor de mídia próprio ou serviço por minuto: LiveKit, Daily, Twilio) e levar ao Roberto o custo por hora de reunião e o que muda no Render | "As três opções", "Quanto custa" e "O que muda no Render" |
| 3. A gravação entra na mesma fila de partes (`POST /api/reunioes/{id}/partes/{seq}`), com transcrição, resumo e mapa iguais aos das reuniões presenciais | "Como a gravação entra no gravador" |
| 4. Quem entra são as participantes da reunião, pela R1b (acesso por participante) | "Quem entra na sala" |
| 5. Aviso de gravação e consentimento como no gravador, com o texto para a Cris | "Aviso e consentimento" |
| 6. Testar com duas contas, no computador e no celular, antes do teste do time | "O tamanho, em PRs" (testes) |

## O que já existe e o que a sala muda

O gravador (desenho em [gravador-de-reunioes.md](./gravador-de-reunioes.md)) já faz quase
tudo o que a sala precisa depois que o áudio existe:

- `client/src/hooks/useGravadorDeAudio.ts`: o `comecar(fluxoDeFora?)` grava um
  `MediaStream` entregue pronto, no lugar do microfone, e foi feito para isso (a G1a o
  preparou para a aba da H14). O fluxo de fora é de quem o entregou: o hook não o fecha
  nem tenta reabri-lo. A troca de parte na pausa da fala (`lib/detector-de-pausa.ts`)
  funciona sobre qualquer fluxo;
- as partes de ~10 min, a cópia no aparelho até o servidor confirmar, a rota binária
  `POST /api/reunioes/{meetingId}/partes/{seq}` (`server/_core/rota-das-partes.ts`,
  `server/fatias-de-reuniao.ts`), a fila no MySQL, a transcrição no Gemini com falantes e
  tempos, o resumo guardado, o mapa mental, o Pergunte, o link aberto e o "Baixar o
  áudio";
- a reunião já tem a coluna `origem` (`gravacao`, `arquivo`, `aba`, `pdf`, `foto`,
  `youtube`), varchar com o enum só no TypeScript: a sala seria uma origem nova, `sala`,
  sem migração para isso;
- a agenda (H16) já cria a reunião com participantes e manda o convite por WhatsApp,
  e-mail e Google Agenda. A sala entraria como o lugar da reunião agendada.

O que bloqueia a sala hoje, de propósito, e muda em qualquer opção:

- **A câmera está proibida no site.** `server/_core/index.ts` manda
  `Permissions-Policy: camera=(), microphone=(self), ...`. Vira `camera=(self)`, com o
  comentário refeito.
- **A CSP proíbe frames de outros sites** (`frame-src 'none'` em `server/_core/csp.ts`,
  travada pelo `server/csp.test.ts`; o YouTube da H13 abre em aba nova por causa disso).
  A opção A, abaixo, exige abrir uma exceção; as opções B e C não. O `connect-src` já
  aceita `wss:` e `https:`, que é o que o SDK usa para falar com o servidor de vídeo.
- **A casca das lojas só pede o microfone no Android** (`mobile/app.json` tem
  `RECORD_AUDIO`, e não `CAMERA`), a ponte (`mobile/ponte.ts`) só trata o pedido de
  microfone, e toda carga fora de `wrwglobal.org` vai para o navegador do sistema
  (`aoPedirCarga` em `mobile/App.tsx`). Ver "No app das lojas".

## As três opções

| | A. Sala pronta embutida (iframe) | B. Serviço pronto, tela nossa (SDK) | C. Servidor de vídeo próprio |
|---|---|---|---|
| Exemplos | Daily Prebuilt, Whereby Embedded, Jitsi (JaaS) | Daily, LiveKit Cloud, 100ms | LiveKit aberto, mediasoup, Jitsi Meet |
| Fica dentro do app | no site, sim, mas com a tela e a marca do fornecedor; na casca, o quadro de outro domínio abre fora do app sem uma exceção na casca | **sim**: a página é do `wrwglobal.org`, e o SDK só abre conexões | **sim** |
| Tela | do fornecedor, dentro de um quadro | nossa, em React, nos 10 idiomas | nossa |
| Gravação na fila de partes | **não dá pelo aparelho**: a página não enxerga o áudio de um quadro de outro site. Só pela gravação do fornecedor, cortada em partes no servidor | pelo aparelho, direto na fila de partes | igual à B |
| Exige do Render | exceção na CSP e na Permissions-Policy | criar a sala e emitir a ficha de entrada | nada no Render, mas **uma máquina nova** com UDP aberto |
| Prazo até a primeira sala (estimativa) | o menor (dias) | 2 a 3 semanas, em PRs pequenas | o maior, e o servidor fica com o time |
| Custo | por minuto do fornecedor, mais a gravação dele | por minuto do fornecedor | a máquina, fixa por mês, a saída de dados e o tempo do time |
| Prende ao fornecedor | muito | médio no Daily, pouco no LiveKit (aberto) | nada |

**A. Sala pronta embutida.** É o caminho mais curto até "tem vídeo", mas é a que menos
atende ao motivo da Glenda: a tela, os textos e a marca são do fornecedor, e no app das
lojas o quadro de outro domínio cai na regra da casca que manda para o navegador (no
iPhone, o pedido de carga vale também para os quadros; o campo `isTopFrame` existe por
isso). Além disso, a CSP precisa de exceção para o domínio dele, e a gravação só sai pela
nuvem do fornecedor, paga à parte, chegando depois da reunião por um caminho novo. No
JaaS, a gravação mostra só a tela de quem gravou.

**B. Serviço pronto com SDK.** O vídeo passa pelos servidores do fornecedor, e o servidor
do MarquesaMatch só cria a sala e assina a ficha de entrada de cada pessoa (um token
curto, com a sala, o nome e o que ela pode fazer). A tela é nossa e fica no
`wrwglobal.org`, também dentro da casca. Como as trilhas de áudio chegam à página, o
aparelho da dona mistura as vozes e grava pelo gravador de hoje. Das opções, a que mais
reaproveita o que existe. Entre os fornecedores:

- **Daily:** servidor de vídeo em São Paulo (`sa-east-1`), fixado por sala ou pela conta;
  10 mil minutos-pessoa grátis por mês, sem mensalidade; funciona na WebView do iPhone
  desde o iOS 14.3, segundo o próprio Daily. Código fechado: trocar de fornecedor depois
  refaz a tela da sala, não o gravador nem as partes;
- **LiveKit Cloud:** código aberto (Apache-2.0), SDK de React e de React Native com plugin
  oficial do Expo, gravação no servidor direto para o B2. Mas não publica servidor de
  vídeo na América do Sul (São Paulo aparece só para telefonia), fixar a região só no
  plano de US$ 500 por mês, e a banda acima da franquia é cobrada;
- **100ms:** preço parecido com o do Daily, sem região no Brasil (só Índia, EUA e Europa);
- **Twilio Video**, citado no cartão (o fim anunciado foi desfeito em 21/10/2024): tem
  região no Brasil e o mesmo preço por minuto do Daily, mas **não funciona na WebView do
  Android**, segundo a documentação dele. Fica fora por causa da casca.

**C. Servidor próprio.** O único em que o vídeo nunca passa por terceiro, e o mais barato
por hora numa máquina com saída de dados grátis. Mas o Render não serve: ele encaminha a
cada serviço web só uma porta HTTP, sem UDP nem porta TCP avulsa, e não tem região em São
Paulo nem máquina virtual. Seria uma máquina em outro provedor, de preferência em São
Paulo, com domínio, certificado, servidor TURN (para quem está atrás de firewall),
monitoramento, atualização de segurança e plantão quando cair no meio de uma reunião.
Entre os três exemplos:

- **LiveKit aberto** (Apache-2.0): um programa só, com Redis quando houver mais de um nó;
  o mesmo SDK do LiveKit Cloud. Portas: 50000 a 60000/UDP (ou uma só, a 7882), 7881/TCP,
  TURN em 443 e 3478/UDP. É a saída natural se o volume justificar;
- **mediasoup** (ISC): é uma biblioteca, não um servidor. A sinalização, as salas, a
  reconexão e o TURN seriam montados por nós. Fora de proporção para o time;
- **Jitsi Meet**: um conjunto de serviços (web, Prosody, Jicofo, JVB), e a gravação
  (Jibri) pede uma máquina de 8 GB com Chrome para cada reunião gravada ao mesmo tempo.

## Quanto custa

### Por hora de reunião

Uma hora de reunião com vídeo ligado, já passada a franquia grátis do mês. A gravação é
feita pelo aparelho da dona, então não há custo de gravação no fornecedor.

| Pessoas na sala | Daily, vídeo | Daily, só áudio | LiveKit Cloud (minutos + banda estimada) | Servidor próprio na AWS (só a saída estimada) |
|---|---|---|---|---|
| 2 | US$ 0,48 | US$ 0,12 | US$ 0,09 a 0,17 | US$ 0,04 a 0,14 |
| 4 | US$ 0,96 | US$ 0,24 | US$ 0,31 a 0,77 | US$ 0,24 a 0,81 |
| 6 | US$ 1,44 | US$ 0,36 | US$ 0,67 a 1,80 | US$ 0,61 a 2,03 |
| 8 | US$ 1,92 | US$ 0,48 | US$ 1,15 a 3,26 | US$ 1,13 a 3,78 |

Como ler:

- **Daily:** US$ 0,004 por minuto-pessoa com vídeo (US$ 0,24 por pessoa por hora), que cai
  com o volume até US$ 0,0015; só com áudio, US$ 0,00099. Os primeiros 10 mil
  minutos-pessoa do mês são grátis (cerca de 166 pessoas-hora). A banda não aparece como
  item à parte na página de preços vista. O Twilio e o 100ms cobram o mesmo por minuto;
- **LiveKit Cloud:** o plano Ship custa US$ 50 por mês e inclui 150 mil minutos-pessoa
  (2.500 pessoas-hora) e 250 GB de banda; acima disso, US$ 0,0005 por minuto-pessoa e US$
  0,12 por GB. A banda é estimativa nossa, não número publicado: cada pessoa recebe o
  vídeo das outras, de 0,3 a 1 Mbit/s cada trilha, o que dá de 4 a 13 GB numa hora com 6
  pessoas. Dentro da franquia, a hora a mais sai de graça, mas os US$ 50 do mês são fixos;
- **servidor próprio:** a máquina custa o mês inteiro, ligada ou não (uns US$ 190 na AWS
  em São Paulo, com 4 núcleos e 8 GB, preço por hora visto em página de terceiro; de R$ 250
  a 340 na Magalu Cloud, com 4 núcleos e 16 GB). A tabela mostra só a saída de dados da
  AWS, a US$ 0,15 por GB, com a mesma estimativa de banda. Na Oracle, que tem região em São
  Paulo, os primeiros 10 TB de saída do mês são grátis, e a hora a mais sai perto de zero.
  Em qualquer caso, soma-se o tempo do time para manter.

O que não muda em nenhuma opção: a transcrição, o resumo, o mapa mental e o Pergunte no
Gemini custam o mesmo que uma hora de gravação de hoje, e o áudio guardado no B2 também,
porque é um áudio só, o da mistura.

### Por mês

| Cenário por mês | Minutos-pessoa | Daily (vídeo) | Daily (só áudio) | LiveKit Cloud |
|---|---|---|---|---|
| Partida: 80 reuniões, 4 pessoas, 45 min | 14.400 | ~US$ 18 | ~US$ 4 | US$ 50 (passa dos 5 mil grátis do plano Build) |
| Médio: 100 reuniões, 6 pessoas, 60 min | 36.000 | ~US$ 104 | ~US$ 26 | US$ 50 + banda (estimativa: US$ 20 a 130) |
| Alto: 400 reuniões, 6 pessoas, 60 min | 144.000 | ~US$ 536, menos o desconto de volume | ~US$ 133 | US$ 50 + banda (estimativa: US$ 160 a 600) |

### Os fornecedores lado a lado

| Fornecedor | Minuto-pessoa | Grátis por mês | Servidor de vídeo no Brasil | Gravação pelo fornecedor (se um dia for usada) | WebView |
|---|---|---|---|---|---|
| **Daily** | vídeo US$ 0,004 (cai com volume até 0,0015); só áudio US$ 0,00099 | 10.000 min, sem mensalidade | **sim, São Paulo, fixável por sala** | só áudio US$ 0,005/min; bucket próprio só na AWS ou na Oracle (o B2 não serve) | iPhone desde iOS 14.3 (do próprio Daily) |
| **LiveKit Cloud** | plano Ship: US$ 50/mês com 150 mil min, depois US$ 0,0005; banda acima de 250 GB a US$ 0,12/GB | 5.000 min (plano Build) | **não publicado**; fixar região só no plano Scale (US$ 500/mês) | só áudio US$ 0,005/min, direto no B2 | SDK de React Native com plugin do Expo |
| 100ms | US$ 0,004; só áudio cerca de US$ 0,001 | 10.000 min | não (Índia, EUA, Europa) | US$ 0,0135/min | RN e Expo |
| Whereby Embedded | US$ 0,0042 acima do plano | 2.000 min, reunião de até 30 min | não publicado | US$ 0,01/min, bucket só AWS | guias para as duas WebViews |
| JaaS (Jitsi, 8x8) | por pessoa ativa no mês: US$ 99 por 300 | 25 pessoas | não conferido | US$ 0,01/min, só a tela de quem gravou | iframe |
| Twilio Video | US$ 0,004 | — | sim | US$ 0,004/min por trilha | **não funciona na WebView do Android** |
| Agora | vídeo HD US$ 3,99 por mil min; áudio US$ 0,99 | 10.000 min | não | áudio US$ 1,49 por mil min | depende da WebView |
| Vonage | US$ 0,0041 | só teste | zona no Brasil por US$ 1.100/mês | a partir de US$ 0,013/min | não conferido |
| Zoom Video SDK | US$ 0,0035 | 10.000 min | não conferido | não conferido | não conferido (página de preços antiga) |

## O que muda no Render

O servidor roda no Render pelo `Dockerfile` (Node 20, `EXPOSE 3000`, sem `render.yaml`,
variáveis no painel). Produção só com o Roberto, como sempre.

**Na opção B com o Daily (a recomendada):**

- **duas variáveis** no painel, só os nomes no código, como `DAILY_API_KEY` e
  `DAILY_DOMINIO`. Sem elas, a sala some da tela, como as passkeys sem `WEBAUTHN_RP_ID`;
- **o cabeçalho de permissões** passa a `camera=(self)`. A CSP não muda;
- **uma migração**: a tabela das salas (reunião ligada, dona, nome da sala no Daily,
  criada, encerrada) e a das presenças com o aceite do aviso. As duas têm coluna de pessoa
  e entram em `server/exclusao-de-conta.ts` e em `scripts/exame/limpeza.mjs`, com a
  contagem dos pares subindo, como manda a regra de trânsito do gravador;
- **o servidor chama a API do Daily** para criar cada sala: privada (só entra com ficha),
  na região de São Paulo, com prazo para expirar e teto de pessoas, contra gasto; e para
  emitir a ficha de cada pessoa, de validade curta, com o nome dela e, para a dona, o
  papel de dona da sala. É uma chamada HTTPS de saída, como as do Gemini;
- **no cliente**, a biblioteca do Daily (`@daily-co/daily-js`), dentro do aval de 15/11 às
  bibliotecas seguras: licença e data da versão conferidas na PR;
- **depois, se for preciso**, uma rota de webhook (o Daily avisa reunião encerrada,
  entrada e saída), montada antes do `express.json`, como a das partes, para conferir a
  assinatura sobre o corpo cru.

O que **não** muda: o plano do Render, a porta, o `Dockerfile` e a CPU. O vídeo vai de cada
aparelho direto ao servidor do Daily; o Render só recebe as partes de áudio da gravação,
como já recebe hoje.

Para a troca de fornecedor não exigir refazer tudo, o código que fala com o Daily fica num
módulo só no servidor (criar sala, emitir ficha) e num só no cliente (entrar, sair, as
trilhas). Trocar pelo LiveKit, na nuvem ou num servidor próprio, refaz esses dois módulos
e a tela da sala, não o gravador nem as partes.

**Com o LiveKit Cloud no lugar:** o mesmo desenho, com `LIVEKIT_URL`, `LIVEKIT_API_KEY` e
`LIVEKIT_API_SECRET`, a ficha assinada no próprio servidor pelo `livekit-server-sdk`, sem
chamar a API para criar a sala, e `livekit-client` com `@livekit/components-react` no
cliente (todos Apache-2.0).

**Na opção A:** a exceção no `frame-src` e na Permissions-Policy para o domínio do
fornecedor (com o `allow="camera; microphone"` no quadro), a exceção na casca para o
quadro, a gravação na nuvem dele e um caminho novo de entrada do arquivo pronto (webhook,
baixar, cortar em partes com o `ffmpeg` que o `Dockerfile` já instala para a H8c, e pôr na
mesma fila).

**Na opção C:** nada muda no Render, além da ficha como na B. Muda tudo fora dele: uma
máquina com IP fixo, as portas UDP do servidor de vídeo e do TURN abertas, TLS no 443 para
quem está atrás de firewall corporativo, um subdomínio (por exemplo
`video.wrwglobal.org`) no DNS, e quem cuida disso no dia a dia.

## Como a gravação entra no gravador

### Pelo aparelho da dona, na mesma fila de partes (recomendado)

1. A dona toca em "Gravar" dentro da sala. A sala cria a reunião gravada como hoje
   (`meetings.iniciarGravacao`, com `origem: "sala"`, que entra no `z.enum` dela) ou liga
   a gravação à reunião agendada, e o toque libera o `AudioContext` também no iPhone.
2. Um misturador (Web Audio) junta numa saída só o microfone dela e o áudio de cada
   participante, e liga e desliga as entradas conforme as pessoas entram e saem (os
   avisos de trilha do SDK). A saída é um `MediaStream` que não acaba enquanto a sala
   está aberta.
3. Esse fluxo vai para `comecar(fluxoDeFora)`. Daí em diante é o gravador de sempre:
   partes de ~10 min trocadas na pausa da fala, cópia no aparelho, envio pelo
   `POST /api/reunioes/{meetingId}/partes/{seq}`, a mesma fila, a mesma transcrição com
   falantes e tempos, o mesmo resumo, o mesmo mapa mental, o Pergunte e o link aberto.
   Nada muda no servidor das partes, e a reunião da sala sai igual à presencial.
4. A gravação para no "Encerrar", no aviso de hora sem resposta (G13) ou quando a dona
   sai da sala.

O que isso dá: custo zero de gravação no fornecedor, nenhum caminho novo no servidor, e a
mesma retenção, o mesmo aviso e o mesmo link aberto de hoje. A voz de cada pessoa entra
na gravação direto da trilha, e não do alto-falante, então sem eco.

O que isso não resolve:

- **A gravação depende do aparelho da dona.** Se ela sai da sala, a gravação para. No
  iPhone, como já acontece com o gravador, trocar de app ou bloquear a tela corta o
  microfone e, na sala, também a chamada (ver "No app das lojas").
- **Grava o que chegou à dona.** Se a internet dela falhar, o trecho falha para a
  gravação também, como falharia para ela na reunião.
- **A IA ainda separa as vozes sem nomes**, como hoje. A sala, porém, sabe quem falava a
  cada momento (o SDK avisa quem está falando). Guardar essa linha do tempo para
  **sugerir** os nomes das vozes, com a dona confirmando, é uma PR posterior: nada que a
  IA ou a sala deduzem entra sozinho.
- **Pontos a provar na PR da gravação:** no Chrome, o áudio que chega pela rede pode não
  passar pelo Web Audio se não estiver ligado também a um elemento `<audio>` (o SDK já
  liga um para tocar, mas é preciso conferir); e o `AudioContext` do iPhone, que nasce
  suspenso, precisa do toque.

### Pelo servidor do fornecedor (depois, se fizer falta)

O fornecedor grava no servidor dele (só o áudio da sala misturado, ou uma trilha por
pessoa) e avisa por webhook quando o arquivo fica pronto. Para cumprir o requisito 3, o
arquivo também entraria na mesma fila: o servidor o baixa e o corta em partes de ~10 min
com o `ffmpeg`, como se tivessem chegado pela rota. Isso tira a dependência do aparelho da
dona, mas custa por minuto (US$ 0,005 só o áudio, no Daily e no LiveKit), exige esse
caminho novo de entrada e só entrega o arquivo no fim, sem a transcrição andando durante a
reunião. No Daily, o arquivo vai para um bucket da AWS ou da Oracle, ou é baixado pelo
link do webhook; no LiveKit, vai direto para o B2. Faz sentido se o uso mostrar muitas
gravações perdidas por aparelho, sobretudo no iPhone.

### Vídeo não se grava

A proposta grava só o áudio, como o gravador de hoje. Gravar o vídeo multiplicaria o
armazenamento, o risco (o rosto das pessoas guardado) e o texto jurídico, sem servir ao
resumo. Se a cliente quiser o vídeo gravado, é outra decisão, com custo e aviso próprios.

## Quem entra na sala

Pelo cartão, entram as participantes da reunião, com o acesso por participante da **R1b**
(cartão do Notion; ainda não está no repositório, e a R1 do desenho do gravador foi adiada
em 12/11). A sala não inventa uma lista própria:

- a sala pertence a uma reunião; quem entra é a dona e as participantes que a R1b ligar a
  ela, cada uma com a própria conta. O servidor só emite a ficha para essas contas;
- o convite sai como o da agenda (WhatsApp, e-mail, Google Agenda) e leva ao login; quem
  ainda não tem conta cria uma e passa a ver a sala quando a dona a adicionar. Isso também
  serve ao motivo da Glenda: a conversa e a pessoa ficam no app;
- entrar sem conta (como no link aberto) fica de fora, salvo decisão contrária do
  Roberto (pergunta 4);
- **a sala mostra só o nome da conta.** E-mail e telefone nunca vão à tela nem ao
  fornecedor, como manda a D3 ([decisoes-em-aberto.md](./decisoes-em-aberto.md): os
  contatos das partes não aparecem entre elas). O que as pessoas falam em voz alta não
  tem filtro. Se um dia a sala ganhar chat de texto, ele passa pelo mesmo bloqueio de
  e-mail e telefone em texto livre da A13 (PR #48). O primeiro corte não tem chat.

A V1 depende da R1b. Se a R1b demorar, a V1 pode começar só com a dona e entrar com as
participantes quando a R1b chegar, mas aí a sala não serve a ninguém além dela.

## Aviso e consentimento

Como no gravador: o aviso de gravação é o mesmo, versionado em
`shared/aviso-de-gravacao.ts`, com a versão gravada em `consent_notice_version` da
reunião, e a dona confirma, ao gravar, que as pessoas que falam autorizaram (ponto 1 do
[aviso de gravação](../termos/aviso-de-gravacao-rascunho.md)). Na sala dá para ir além,
porque todas as pessoas passam pela tela do MarquesaMatch:

- **antes de entrar**, cada participante vê que a sala pode ser gravada e transcrita pela
  IA do Google, com o áudio processado fora do Brasil;
- **quando a gravação começa**, todas veem um aviso fixo de "gravando". O estado vem do
  servidor, e não de uma mensagem entre aparelhos, que qualquer participante poderia
  forjar;
- **quem entra com a gravação em curso** aceita antes de o microfone e a câmera ligarem;
  quem não aceita sai;
- **o aceite fica guardado** por pessoa: a conta, a versão do aviso e a hora. É dado
  pessoal: entra na exclusão de conta e na retenção.

O aviso ganha versão nova, e o ponto 8 do rascunho, que hoje fala da "gravação da aba de
uma reunião online (planejado)", passa a falar da sala. O texto vai para a Cris revisar,
como os outros.

## Privacidade e LGPD

- **Quem passa a tratar dado.** Na opção B, o fornecedor da sala vira operador (LGPD,
  art. 39): o vídeo e o áudio passam pelos servidores dele, cifrados no caminho, mas
  abertos dentro do servidor de vídeo, que repassa as trilhas. É preciso o contrato de
  tratamento de dados (DPA) dele, e a Política de Privacidade, que ainda não existe, tem
  de citá-lo. O Daily e o LiveKit publicam DPA, que cita o GDPR; nenhum dos que a pesquisa
  achou cita a LGPD (não conferido). Na opção C, o operador é o provedor da máquina, que
  não vê o conteúdo.
- **Fora do Brasil.** Dois trechos:
  - o vídeo ao vivo: com o Daily fixado em São Paulo, a mídia passa por servidor no
    Brasil (a empresa e o painel continuam nos EUA); com o LiveKit Cloud, sem região
    publicada aqui, passa por fora;
  - a transcrição no Gemini, que já é assim hoje e já está no aviso (ponto 3, arts. 33 a
    36). Nenhuma opção de sala muda isso.
- **Cifra de ponta a ponta.** O LiveKit oferece cifra de ponta a ponta, em que nem o
  fornecedor ouve a sala, e a gravação pelo aparelho continua funcionando com ela, porque
  a dona recebe o áudio já decifrado. No Daily, não conferido. Fica fora do primeiro
  corte.
- **Rosto e voz.** A sala não identifica ninguém por rosto nem por voz, e o vídeo não é
  guardado: não há tratamento de biometria.
- **O que vai ao fornecedor fora a mídia:** o nome que aparece na sala e um identificador
  da pessoa na ficha. Nada do perfil, da rede particular, do e-mail ou do telefone.

## No app das lojas

A casca Expo (`mobile/`, PR #180, ainda aberta, com as correções da #238) é uma WebView que
abre `https://wrwglobal.org` e manda para o navegador do sistema toda carga de outro
domínio. Na opção B, a sala é uma página do próprio `wrwglobal.org`, e o SDK só abre
conexões com o servidor de vídeo, sem carregar página de fora: a pessoa fica dentro do
app. A sala roda na WebView sem tela nativa, com estes ajustes, numa PR da casca:

- **Android:** `android.permission.CAMERA` no `app.json`, e a ponte pedindo a câmera ao
  sistema antes do `getUserMedia` com vídeo, como já pede o microfone desde a T41. Sem
  isso, a trilha de vídeo nasce encerrada, como acontecia com o microfone;
- **iPhone:** a WebView pede câmera e microfone sozinha
  (`mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"` já está na casca). O
  texto do `NSCameraUsageDescription` hoje fala só de fotos, e a Apple o lê na revisão:
  passa a citar as chamadas de vídeo;
- **segundo plano:** no iPhone, trocar de app ou bloquear a tela corta a câmera e o
  microfone da WebView. Na sala, isso tira a pessoa da conversa (e, se for a dona, a
  gravação). A casca já avisa isso na gravação (T41); a sala precisa do mesmo aviso. Só
  uma tela nativa, com o SDK de React Native do fornecedor e o CallKit, mantém a chamada
  em segundo plano: é desenvolvimento nativo, com build de desenvolvimento (o Expo Go não
  serve) e revisão da Apple, e reforçaria o argumento contra a regra 4.2 (site
  embrulhado). O LiveKit tem plugin oficial do Expo para isso; o SDK de React Native do
  Daily não foi conferido. Fica para depois, se o uso pedir;
- **testes:** o Expo Go não entrega o microfone à WebView no Android; num APK de verdade,
  sim (teste do Nicolas). A sala se testa com o APK do perfil `preview` e com o build de
  desenvolvimento no iPhone.

## A sala, a gravação da aba (H14) e o robô (H21)

- **A sala não substitui a H14.** A gravação da aba serve às reuniões que acontecem no
  Zoom, no Meet ou no Teams de outras pessoas, no Chrome e no Edge do computador. Ela é
  pequena (o gravador já aceita o fluxo da aba, e o servidor já aceita a origem `aba`) e
  não depende da sala. Sugestão: a H14 volta à fila, sem esperar a sala. Pelo motivo da
  Glenda, porém, a sala é que deve ser o caminho oferecido primeiro.
- **A sala substitui o robô (H21) nas reuniões que a dona marca.** Para as reuniões
  marcadas por outras pessoas em outras plataformas, o robô continua sendo o único jeito
  sem a aba, e segue fora do escopo pelo motivo do desenho do gravador: serviço pago por
  hora, ou software que não cabe no servidor de hoje. Sugestão: o robô continua parado.

## O tamanho, em PRs

Pela opção B com o Daily e a gravação pelo aparelho. P é pequena, M é média.

| PR | O que faz | Depende de |
|---|---|---|
| V0 (docs) | Este estudo e, depois da decisão, a entrada em `decisoes-tomadas.md`. | — |
| V1 (M, migração) | Servidor da sala: as tabelas das salas e das presenças, a criação da sala no Daily (privada, em São Paulo, com prazo e teto de pessoas), a ficha só para a dona e as participantes da reunião, as variáveis (sem elas a função some), a exclusão de conta e os testes. | a R1b; conta no Daily, com o Roberto |
| V2 (M) | Tela da sala em `/sala/:id`: a antessala (testar câmera e microfone, escolher o aparelho), a grade, ligar e desligar câmera e microfone, sair; a Permissions-Policy com `camera=(self)`; os textos nos 10 idiomas. | V1 |
| V3 (M) | Convite e entrada: o "Abrir sala" na reunião, o convite por WhatsApp, e-mail e Google Agenda, o link que leva ao login e depois à sala, o aviso antes de entrar. | V2 |
| V4 (M) | Gravar a sala: o misturador, o `comecar(fluxoDeFora)` na mesma fila de partes, a origem `sala`, o estado "gravando" pelo servidor, o aceite de quem está e de quem entra, a versão nova do aviso (texto da Cris). | V3 |
| V5 (P) | Agenda: a reunião agendada (H16) ganha a sala como lugar, e o link vai no evento da Google Agenda e no `.ics`. | V3 |
| M-sala (P, `mobile/`) | Casca: a câmera no Android e na ponte, o texto da câmera no iPhone, o aviso do segundo plano na sala. | V2; a #180 |

Depois, só se o uso pedir: a gravação pelo servidor, as sugestões de nome pela linha do
tempo de quem fala, o compartilhar tela no computador e a tela nativa no app.

**Textos de tela:** seguem a `/texto-de-tela`. A marca é a que estiver no código (hoje,
MarquesaMatch, escrita assim nos 10 idiomas), e há testes que barram o nome antigo.

**Testes, em cada PR:**

- as regras de sempre: `pnpm check`, `pnpm test` e `pnpm build` verdes, validação por outro
  LLM antes do merge, e a tela aberta em cada nível de conta;
- a suíte nunca chama o Daily de verdade: a API dele entra dublada;
- a prova de ponta a ponta pode usar o Chrome com câmera e microfone falsos
  (`--use-fake-device-for-media-stream`);
- **antes do teste do time**, quem fez a PR testa com **duas contas** (a dona e uma
  participante), **no computador e no celular**: o Chrome do computador com o Android (o
  APK do perfil `preview`) e com o iPhone, a sala aberta dos dois lados, a gravação, e a
  reunião pronta com transcrição, resumo e mapa. O resultado vai no "Como verifiquei" da
  PR. O que precisar de mais gente ou de rede ruim vira cartão de teste no Notion, como na
  G13.

## Riscos e o que este estudo não conferiu

- **A R1b** não está no repositório: o desenho de "quem entra" depende do que ela fizer.
- **Os preços e as regiões** mudam; os números daqui não são proposta comercial. A banda
  do LiveKit, a saída de dados do servidor próprio e o preço por hora da máquina da AWS
  são estimativas.
- **Nada foi testado em aparelho:** o misturador, a WebView do iPhone com câmera e a do
  Android com a câmera pela ponte são as provas da V2, da V4 e da M-sala.
- **Não conferido:** DPA que cite a LGPD em qualquer fornecedor; servidor de vídeo no
  Brasil do LiveKit, do Whereby, do JaaS e do Zoom; o SDK de React Native do Daily; a
  cifra de ponta a ponta no Daily; se o Daily cobra banda à parte.
- **O plano do Render em vigor** e a cota de saída do B2 não mudam na opção B, mas não
  foram conferidos no painel.
- **O Notion e o grupo:** este estudo leu o cartão (com a "Próxima ação", repassada em
  24/11), e não a aba Decisões nem o grupo. Decisões que só estejam lá podem mudar a
  recomendação.

## Perguntas para o Roberto e a Glenda

1. **Qual caminho:** B com o Daily em São Paulo (recomendada), B com o LiveKit Cloud (mais
   barato nos minutos e com saída para servidor próprio, mas com o vídeo passando pelos
   EUA e a banda à parte), A (mais rápida, tela e marca do fornecedor, e fora do app na
   casca sem exceção) ou C (servidor próprio)?
2. **Antes ou depois:** a sala entra antes ou depois do que está na fila do gravador? E a
   R1b vem antes dela?
3. **Tetos contra gasto:** quantas pessoas e quanto tempo por sala? Todos os níveis de
   conta abrem sala, ou só alguns?
4. **Quem não tem conta:** precisa criar uma para entrar, como proposto, ou entra só com o
   nome, como no link aberto?
5. **Gravar:** só a dona aperta "Gravar", com o aviso a todas, como proposto? Só o áudio,
   sem o vídeo?
6. **Dado no Brasil:** há exigência de que o vídeo ao vivo passe só por servidor no Brasil?
   Ela decide entre o Daily e o LiveKit Cloud.
7. **Orçamento:** qual o teto mensal para a sala, e em qual cartão fica a conta do
   fornecedor?
8. **H14 e H21:** a gravação da aba volta à fila já, sem esperar a sala, e o robô segue
   parado?

## Fontes (vistas em 24/11/2026)

- Daily: [preços](https://www.daily.co/pricing/video-sdk/),
  [região por sala](https://docs.daily.co/reference/rest-api/your-domain/config),
  [bucket da gravação](https://docs.daily.co/reference/rest-api/your-domain/set-domain-config),
  [WebView do iPhone](https://www.daily.co/blog/how-to-load-an-external-html-file-in-an-ios-app),
  [DPA](https://www.daily.co/legal/data-processing-addendum/).
- LiveKit: [preços](https://livekit.com/pricing),
  [regiões](https://docs.livekit.io/deploy/admin/regions/endpoints/),
  [saídas da gravação](https://docs.livekit.io/home/egress/outputs/),
  [Expo](https://docs.livekit.io/transport/sdk-platforms/expo/),
  [portas do servidor próprio](https://docs.livekit.io/home/self-hosting/ports-firewall/),
  [DPA](https://livekit.com/legal/data-processing-addendum).
- 100ms: [preços](https://www.100ms.live/pricing),
  [regiões](https://www.100ms.live/docs/server-side/v2/Rooms/create-via-api).
- Whereby: [preços](https://whereby.com/information/embedded/pricing).
- JaaS: [preços](https://cpaas.8x8.com/en/pricing/jitsi-as-a-service-pricing/),
  [gravação](https://developer.8x8.com/jaas/docs/jaas-prefs-recording).
- Twilio: [preços](https://www.twilio.com/en-us/video/pricing),
  [regiões](https://www.twilio.com/docs/video/tutorials/video-regions-and-global-low-latency),
  [navegadores e WebViews](https://www.twilio.com/docs/video/javascript).
- Agora: [preços](https://www.agora.io/en/pricing/agora-rtc/). Vonage:
  [preços](https://www.vonage.co.uk/communications-apis/video/pricing),
  [zonas regionais](https://developer.vonage.com/en/video/guides/regional-media-zones).
  Zoom: [preços](https://explore.zoom.us/docs/en-us/video-sdk-rates.html).
- Render: [serviços web](https://render.com/docs/web-services),
  [serviços privados](https://render.com/docs/private-services),
  [regiões](https://render.com/docs/regions).
- Máquinas no Brasil: [Magalu Cloud](https://docs.magalu.cloud/docs/computing/virtual-machine/instance-types-and-pricing/pricing),
  [Oracle, rede](https://www.oracle.com/cloud/networking/pricing/).
- Jitsi Meet: [requisitos](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-requirements/).
