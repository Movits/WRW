# Colocar a WRW no ar

> **Hoje:** o site roda em https://wrwglobal.org, no Render (o serviço técnico ainda se
> chama `mmm-gud5`), com banco MySQL no Aiven e arquivos no Backblaze B2.

## Por que não dá para usar o GitHub Pages

O GitHub Pages serve **arquivos estáticos**. Ele entrega HTML, CSS, JavaScript
e imagens, e não executa nada do lado do servidor.

A WRW não é um site estático. É um processo Node único que faz as duas coisas
ao mesmo tempo:

| O que | Onde |
|---|---|
| Front-end compilado | `dist/public`, servido pelo Express |
| API tRPC | `/api/trpc`, no mesmo processo (`server/_core/index.ts`) |

O cliente chama a API na mesma origem, em `client/src/main.tsx:49`:

```ts
httpBatchLink({ url: "/api/trpc" })
```

Publicado no Pages, esse endereço não existe. O resultado seria a tela inicial
carregando com os números zerados e o login falhando em toda tentativa, porque
não há servidor para responder. Pior que não ter link.

Além disso, três coisas nunca podem ir para o navegador e por isso exigem
servidor: a conexão com o MySQL, o `JWT_SECRET` que assina as sessões e a chave
do LLM. Publicá-las no bundle seria entregá-las a qualquer visitante.

**Onde funciona:** Railway, Render, Fly.io, Cloud Run ou um VPS. A decisão
[D6](./arquitetura/decisoes-em-aberto.md) recomendava Railway, porque sobe o
código como está, com MySQL gerenciado no mesmo lugar e sem hibernação. O caminho
adotado foi Render + Aiven, na seção seguinte.

---

## Render + Aiven: o caminho em uso

Caminho escolhido em 29/08/2026 para a versão de teste, nos planos gratuitos, que não
pedem cartão. O serviço do Render passou depois a um plano pago. O plano em vigor se
confere no painel do Render.

O banco fica no **Aiven** porque o plano gratuito do Render oferece PostgreSQL, e
a aplicação fala MySQL pelo driver `mysql2`.

1. **Banco.** aiven.io → *Create service* → **MySQL** → plano **Free**. Leva uns
   dois minutos para ficar de pé. Copie a *Service URI* do painel.

2. **Ajustar a URI.** O Aiven entrega algo terminando em `?ssl-mode=REQUIRED`,
   que é sintaxe do cliente de linha de comando. O `mysql2` ignora esse
   parâmetro e tenta conectar sem TLS, que o Aiven recusa, com um erro que não
   explica a causa. Troque o final por:
   ```
   ?ssl={"rejectUnauthorized":false}
   ```
   Isso criptografa a conexão mas não valida o certificado. Serve para o
   ambiente de teste. Para produção, use a CA que o Aiven disponibiliza.

3. **Criar as tabelas**, com a URI já ajustada:
   ```bash
   DATABASE_URL='mysql://...' node scripts/criar-banco.mjs
   ```

4. **Aplicação.** render.com → *New* → *Web Service* → conectar este repositório →
   runtime **Docker**. Ele acha o `Dockerfile` sozinho e injeta a `PORT`, que o
   servidor respeita em produção (`server/_core/index.ts`).

5. **Variáveis**, na tabela da próxima seção. A `DATABASE_URL` é a mesma do
   passo 2.

6. Depois do primeiro deploy, copiar o endereço `*.onrender.com` e voltar em
   *Environment* para apontar `FRONTEND_URL` para ele.

**Plano gratuito × pago:** no plano gratuito do Render, o serviço dorme depois de um
tempo sem acesso, e a primeira visita seguinte demora de 30 a 60 segundos. O serviço
de produção está hoje num plano pago. Antes de prometer tempo de resposta a alguém,
confira no painel qual plano está em vigor.

## Subir no Railway (histórico)

> **Histórico.** O Railway foi a recomendação da D6 em 25/08, mas o caminho adotado em
> 29/08 foi Render + Aiven (acima). O passo 5 (criar as tabelas e como as migrações
> rodam) vale para qualquer hospedagem.

O repositório já tem `Dockerfile`, então o Railway não precisa adivinhar nada.

1. **Criar a conta** em railway.app e conectar o GitHub. Pede cartão, mesmo no
   plano Hobby.
2. **New Project → Deploy from GitHub repo → este repositório.** Ele detecta o
   `Dockerfile` sozinho.
3. **Add MySQL** no mesmo projeto. O Railway cria a variável `DATABASE_URL` e
   já a injeta no serviço do app.
4. **Preencher as variáveis** da tabela abaixo em Variables.
5. **Criar as tabelas uma vez**, da sua máquina, apontando para o banco novo:
   ```bash
   DATABASE_URL="<a URL do MySQL>" node scripts/criar-banco.mjs
   ```
   O script aplica as migrações de `drizzle/` e anota o que rodou na tabela
   `_migracoes`. Dá para rodar de novo sem perigo: o que já foi aplicado não
   roda outra vez.

   **Banco que já existia antes do sistema de migração:** o `migrar.mjs` confere
   coluna a coluna antes de adotar. Se o banco estiver desviado, ele recusa e
   lista cada desvio; `node scripts/nivelar-banco.mjs --aplicar` gera os ALTERs
   a partir do próprio baseline (nunca apaga nada) e aí a adoção passa.

   **Para mudar o schema daqui em diante:** edite `drizzle/schema.ts`, rode
   `pnpm db:generate` (nasce a migração em `drizzle/`) e `pnpm db:migrate`
   (aplica). Nunca edite SQL de migração à mão — foi mantendo um SQL à mão que
   um banco novo passou a nascer sem as tabelas do consentimento. O CI cria um
   banco do zero e confere que schema e migrações concordam.

   **Em produção as migrações rodam sozinhas no boot.** O servidor (em
   `NODE_ENV=production`, com `DATABASE_URL` definida) executa
   `scripts/migrar.mjs` antes de aceitar tráfego: pendência é aplicada,
   falha aborta a subida — e a plataforma mantém a versão anterior no ar.
   Nasceu porque o deploy automático publicava código novo contra banco
   velho e ninguém rodava o comando manual: uma coluna nova no schema
   derrubaria todas as consultas da tabela até alguém migrar. O comando
   manual continua valendo para banco novo e para desenvolvimento.
6. **Generate Domain** em Settings → Networking. Sai um endereço
   `*.up.railway.app`. Esse é o link da Glenda.
7. **Voltar em Variables** e apontar `FRONTEND_URL` para esse domínio, senão os
   links dos e-mails transacionais saem quebrados.

## Variáveis de ambiente

### Sem estas o servidor não inicia

| Variável | De onde vem |
|---|---|
| `DATABASE_URL` | a URI do banco, com o `ssl` já ajustado |
| `JWT_SECRET` | você gera: `openssl rand -base64 48` |

`VAULT_ENCRYPTION_KEY` **não** impede o servidor de iniciar: sem ela,
`server/matching.ts:12` cai para o `JWT_SECRET`. Ainda assim, defina-a. Se o
cofre for cifrado com o `JWT_SECRET` e um dia esse segredo for rotacionado por
motivo de segurança, o conteúdo do cofre se torna ilegível.

A recusa é proposital, em `server/_core/env.ts`. A versão do Manus caía para
um valor padrão embutido no código, o que significa que qualquer pessoa com o
código conseguia assinar uma sessão válida.

### Sem estas o app sobe e falha em uso

| Variável | Para quê | Valor |
|---|---|---|
| `NODE_ENV` | modo produção | `production` |
| `FRONTEND_URL` | links de e-mail e redirects | o endereço público do site |
| `LLM_API_URL` | as chamadas de texto: matches, enriquecimento, extração, tradução | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `LLM_API_KEY` | a chave do endpoint acima | Google AI Studio |
| `RESEND_API_KEY` | e-mail de recuperação de senha e o resumo por e-mail (H22, até 50 e-mails por conta a cada 24 h); no plano grátis da Resend (100 por dia para a plataforma inteira), o resumo pode esgotar a cota do "Esqueci a senha" | resend.com |
| `EMAIL_FROM` | remetente | `nao-responda@seudominio` (o nome WRW é posto pelo código) |
| `LLM_AUDIO_MODEL` | opcional: modelo da transcrição | padrão `gemini-3.5-flash`; só id do Gemini, no formato `gemini-<versão>`, nunca alias: `-latest`, id sem versão (`gemini-pro`) ou de outro provedor é recusado, avisa no log e cai no padrão |
| `LLM_AUDIO_MODEL_RESERVA` | opcional: modelo reserva da transcrição (assume no 503/cota) | padrão `gemini-3.5-flash-lite`; a mesma guarda do `LLM_AUDIO_MODEL` |
| `LLM_TTS_MODEL` | opcional: a voz do Gemini do "Baixar o áudio do resumo" (H19b) | padrão `gemini-3.8-flash-lite-tts`; a mesma guarda do `LLM_AUDIO_MODEL` |
| `LLM_MODEL_BUSCA` | opcional: o modelo da busca na web do complemento de um item (H4i, ferramenta `google_search`) | padrão `gemini-3.5-flash`; a mesma guarda do `LLM_AUDIO_MODEL` |
| `LLM_MODEL` | opcional: modelo das chamadas de texto sem função (tradução, FAQ, Memória, recomendações, complementos de contato, mapa mental, tradução do resumo guardado e e-mail de retorno), que vão ao `LLM_API_URL`; é também o da extração, o do resumo e o do Pergunte, quando a variável deles está vazia | padrão `gemini-3.5-flash`; id concreto, nunca alias: `latest` ou id sem número de versão (`gemini-pro`) é recusado, avisa no log e cai no padrão; id de outro provedor compatível com a OpenAI passa (`gpt-4o-2024-08-06`) |
| `LLM_MODEL_EXTRACAO` | opcional: modelo da extração da reunião (Tenho/Preciso e contatos) | sem padrão próprio: segue o `LLM_MODEL`; a mesma guarda; recusado, cai no `LLM_MODEL`. Antes de pôr o `gemini-3.5-flash-lite` aqui, leia o parágrafo abaixo da tabela: ele não devolve todas as entidades da reunião |
| `LLM_MODEL_RESUMO` | opcional: modelo do resumo guardado da reunião. O mapa mental, que sai da mesma fila logo depois do resumo, e a tradução do resumo não seguem esta variável: ficam no `LLM_MODEL` | sem padrão próprio: segue o `LLM_MODEL`; a mesma guarda; recusado, cai no `LLM_MODEL` |
| `LLM_MODEL_PERGUNTA` | opcional: modelo do Pergunte à reunião | sem padrão próprio: segue o `LLM_MODEL`; a mesma guarda; recusado, cai no `LLM_MODEL` |
| `LLM_MODEL_ESCOLHA_DO_MODELO` | opcional: modelo do "a IA escolhe o modelo" do resumo (H4e), uma classificação curta | padrão próprio `gemini-3.5-flash-lite` quando o `LLM_API_URL` é a API do Gemini; fora dela, o `LLM_MODEL`; a mesma guarda; recusado, cai no degrau seguinte. `LLM_RACIOCINIO_ESCOLHA_DO_MODELO` é a variável do raciocínio dela, como as abaixo |
| `LLM_RACIOCINIO_EXTRACAO`, `LLM_RACIOCINIO_RESUMO` e `LLM_RACIOCINIO_PERGUNTA` | opcionais: quanto o modelo raciocina na extração da reunião, no resumo guardado e no Pergunte à reunião, cada função com a sua | sem valor (o padrão), o pedido sai sem o campo e o modelo raciocina no padrão dele, como sempre; `minimal`, `low`, `medium` ou `high` sobem como `reasoning_effort`; outro valor (inclusive `none`, que só desliga o raciocínio no Gemini 2.5) é recusado, avisa no log e não manda nada. Defina só depois de a bancada rodar o braço b, e só na função que usa o Flash: o Flash-Lite não raciocinou na bancada, e `low` pode fazê-lo raciocinar (não medido) |

A transcrição e os embeddings (`server/gemini.ts`) não usam o `LLM_API_URL`:
vão sempre à API do Gemini, com o id na URL e a mesma chave (`LLM_API_KEY` ou,
sem ela, `GOOGLE_API_KEY`). Por isso o modelo do áudio só aceita o formato
`gemini-<versão>`. Pôr o texto em outro provedor deixaria a transcrição e os
embeddings com a chave errada: chaves separadas ainda não existem no código.

O texto tem um modelo por função, na ordem: a variável da função
(`LLM_MODEL_EXTRACAO`, `LLM_MODEL_RESUMO`, `LLM_MODEL_PERGUNTA` ou
`LLM_MODEL_ESCOLHA_DO_MODELO`) > o padrão
da função no código, quando houver e o `LLM_API_URL` for a API do Gemini
(`generativelanguage.googleapis.com`) > `LLM_MODEL` > o padrão. Variável
recusada cai no degrau seguinte. Das três funções que a bancada mediu, nenhuma
tem padrão no código: sem variável, as três seguem o `LLM_MODEL`, e o deploy
não troca o modelo de nenhuma. A escolha do modelo do resumo (H4e) tem o Lite
como padrão. Ficam no `LLM_MODEL` as chamadas sem função: a tradução, o FAQ, a
Memória, as recomendações e os complementos de contato, que não passam função
nenhuma, e o mapa mental, a tradução do resumo guardado e o e-mail de retorno,
que passam `funcao: null`. Quem chama sem função não lê nenhuma variável de
função, nem `LLM_MODEL_<FUNÇÃO>` nem `LLM_RACIOCINIO_<FUNÇÃO>`: trocar o
`LLM_MODEL` troca o modelo de todos eles, e o `LLM_MODEL_RESUMO` não leva junto
o mapa mental, embora ele saia da mesma fila, logo depois do resumo.

A bancada A de texto (16/11/2026) indicou o `gemini-3.5-flash-lite` para a
extração: nota melhor, 5 vezes mais rápido e 78% mais barato por chamada. Mas,
nas 3 rodadas (uma reunião sintética só, em pt-BR), ele só devolveu entidades
de pessoa e de empresa. As de cargo, ativo, necessidade e oportunidade
alimentam a linha "Assuntos" do perfil do contato, os chips da reunião e os
destaques da transcrição: com o Lite, elas tendem a sumir das reuniões novas e
das reprocessadas, sem erro na tela. Por isso o Lite não é o padrão da
extração: a troca espera essa decisão, ou uma extração que não dependa do
modelo para esses tipos.

Antes de definir uma variável de função no Render, confira o id com a chave
de produção, pela receita do cabeçalho de `scripts/listar-modelos-gemini.mjs`
(`--conferir <id>`): se a chave não servir o id, toda chamada da função falha
(na extração, toda reunião nova) até a variável sair. Na extração, com a
variável no ar, confira numa reunião nova que os chips Cargo, Oferece, Procura
e Oportunidade aparecem: se sumirem, é falha.

No boot, o log mostra `[IA] áudio … · reserva … · texto … · extração … ·
resumo … · pergunta …` com os modelos que valem depois da guarda, sem a chave
(id de outro provedor no texto aparece como "fora do log"). Os ids que a chave
do Gemini enxerga saem de
`node scripts/listar-modelos-gemini.mjs --conferir id1,id2` (ver
`scripts/README.md`); existir na lista não prova que o id é concreto.

Logo abaixo, `[IA] raciocínio · extração … · resumo … · pergunta …` mostra o
nível que cada função pede, depois da guarda das variáveis `LLM_RACIOCINIO_*`
("padrão do modelo" quando a variável está vazia ou foi recusada).

`PORT` a hospedagem injeta sozinha (o Render e o Railway fazem isso). Não defina na mão.

### Para entrar com Face ID ou digital (chaves de acesso)

Sem estas duas, o app sobe e a função fica desligada: o `chavesDeAcesso.estado`
responde `disponivel: false` (é por ele que a tela da A7, ainda por fazer, vai
decidir se mostra o botão), e os outros procedimentos `chavesDeAcesso.*`
respondem `CHAVE_INDISPONIVEL` (`server/chaves-de-acesso.ts`).

| Variável | Para quê | Valor em produção |
|---|---|---|
| `WEBAUTHN_RP_ID` | o domínio a que cada chave de acesso fica presa | `wrwglobal.org` |
| `WEBAUTHN_ORIGENS` | os endereços que podem usar as chaves, separados por vírgula | `https://wrwglobal.org,https://www.wrwglobal.org` |

- **Decidido pelo Roberto em 15/11/2026.** A chave presa a `wrwglobal.org` vale
  com e sem www. Quem põe as duas no painel do Render é o Roberto; até lá, a
  função fica invisível em produção.
- **No `.onrender.com` a função não aparece:** a chave presa a `wrwglobal.org`
  não vale lá, e o pedido que vem de uma origem fora da lista recebe
  `disponivel: false`.
- **O RP ID não muda depois da primeira chave cadastrada:** trocá-lo invalida
  todas as chaves de todas as contas, e cada pessoa volta a entrar com e-mail e
  senha.
- **Valor errado desliga a função**, e o log avisa uma vez, no primeiro pedido
  (`[Chaves de acesso] ...`): o RP ID é só o domínio, sem `https://`; cada origem é
  `https://` (http só em `localhost`), sem caminho, e o domínio dela é o RP ID ou
  um subdomínio dele. No desenvolvimento: `WEBAUTHN_RP_ID=localhost` e
  `WEBAUTHN_ORIGENS=http://localhost:3000`.
- **Como conferir que ligou**, depois de pôr as duas e de o deploy subir: abra
  `https://wrwglobal.org/api/trpc/chavesDeAcesso.estado` no navegador. A resposta
  é `{"result":{"data":{"json":{"disponivel":true}}}}`. Com `false`, a função
  segue desligada: ou as variáveis não chegaram ao serviço, ou uma delas tem um
  valor errado, e aí o log do Render traz o aviso `[Chaves de acesso]` (o
  primeiro pedido depois do deploy o escreve). O mesmo endereço em
  `https://www.wrwglobal.org` também dá `true`, e em
  `https://mmm-gud5.onrender.com` dá `false`, como deve.

### Só para a Google Agenda (opcional)

A conexão com a Google Agenda no Perfil (H16b) só existe com as cinco variáveis
abaixo. Sem qualquer uma, a seção some do Perfil e `/api/google-agenda/conectar` e
`/api/google-agenda/retorno` dão 404 (`configuracaoDaGoogleAgenda`, em
`server/google-oauth.ts`). Só os nomes ficam no código; os valores, no painel do
Render.

| Variável | Para quê | Valor |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | o cliente OAuth "Aplicativo da Web" do Google Cloud | o ID do cliente |
| `GOOGLE_OAUTH_CLIENT_SECRET` | o segredo do mesmo cliente | o segredo do cliente |
| `FRONTEND_URL` | vira o URI de retorno, `<FRONTEND_URL>/api/google-agenda/retorno`, que precisa estar cadastrado no cliente exatamente assim | https; http só em `localhost` |
| `VAULT_ENCRYPTION_KEY` | cifra o refresh token no banco | 32 caracteres ou mais; mais curta, a função some |
| `GOOGLE_AGENDA_LIBERADA_PARA` | quem vê a função | os ids das contas da WRW, separados por vírgula, enquanto o app do Google Cloud está em modo Teste; `todas` depois que a Google o verificar |

**Por que a lista (escolha de 16/11/2026).** Em modo Teste, a Google só deixa
autorizar as contas Google da lista de usuários de teste do Google Cloud (até 100). As
outras param numa página de erro da própria Google ("Acesso bloqueado", Erro 403:
access_denied), sem voltar à WRW. Então, até a Google verificar o app (o que pede a
Política de Privacidade e um vídeo), a seção aparece só para as contas da WRW cujas
contas Google estão naquela lista: ponha nas duas listas as mesmas pessoas (a Glenda e
quem do time vai validar o pacote). Fora da lista, a seção não aparece e as rotas dão
404. Sem a variável, ou sem nenhum id válido nela, a
função some para todas: esquecê-la esconde a função, em vez de pôr diante de todo
mundo um botão que não funciona. Depois da verificação, o valor vira `todas`.

A conexão só começa pelo host do `FRONTEND_URL`, porque o cookie da ida é do host:
quem entra pelo endereço do Render vê no Perfil o caminho para o endereço certo. No
app das lojas (a casca da #180), a seção manda conectar pelo navegador: a WebView não
consegue terminar a ida e a volta da Google. O que configurar no Google Cloud
(Calendar API, branding, público em modo Teste, os escopos `openid`, `email` e
`calendar.events`) está em `docs/arquitetura/decisoes-tomadas.md`, na decisão de
15/11/2026. No modo Teste, o refresh token vence em 7 dias: na primeira vez que a WRW
tentar usá-lo depois disso, a conexão fica marcada e a seção pede "Reconectar".

**A Google revoga por conta Google e projeto, não por token.** Revogar qualquer token
tira a autorização inteira daquela conta Google no projeto do Google Cloud, com os
tokens de todos os clientes do projeto. Por isso a WRW guarda o `sub` da conta Google
(`google_agenda_conexoes.google_sub`) e decide por ele: reconectar com a mesma conta
Google não revoga nada, e desconectar ou excluir uma conta da WRW não revoga a conta
Google que outra conta da WRW ainda usa. Pela mesma regra, **o cliente OAuth do
localhost precisa de um projeto próprio do Google Cloud**: no mesmo projeto, desconectar
no computador de quem desenvolve derrubaria a conexão de produção da mesma conta
Google.

**Os eventos (H16c) não pedem variável nova.** Com a conexão de pé, marcar, mudar e
excluir uma reunião na agenda da WRW criam, mudam e tiram o evento na agenda principal
da conta Google da dona (`server/google-agenda-eventos.ts`): primeiro o banco, depois a
Google, e o estado fica em `agenda_reunioes.google`. Sem a Calendar API ligada no
projeto do Google Cloud, a Google recusa toda chamada de evento (403), e as reuniões
ficam "Ainda não está na sua Google Agenda", com "Tentar de novo". Desconectar e excluir
a conta da WRW não apagam os eventos que já estão na agenda da dona. O estado é da conta
Google conectada: desconectar, ou conectar outra conta Google, o zera, e as reuniões que
vão acontecer voltam a oferecer "Pôr na Google Agenda". A reunião que já acabou nunca é
criada lá: mudá-la só muda o evento que já existe, sem aviso aos convidados, e excluí-la
deixa o evento na Google como histórico.

**As próximas ações (H5c) também não pedem variável nova.** Com a mesma conexão, a ação
aberta com prazo vira um evento às 9h do dia do prazo, no fuso do aparelho de quem mexe
nela, de 30 minutos, livre na agenda e com aviso na hora
(`server/acoes-na-google.ts`), e o estado fica em `proximas_acoes.google`. Marcar feita,
tirar o prazo, apagar a ação e desconfirmar o item no resumo tiram o evento; reabrir e
mudar o texto ou o prazo o mudam. O id do evento é `acao` mais o id da ação, sem
coluna própria. Desconectar e excluir a conta da WRW não apagam os eventos que já estão
na agenda da dona, e a desconexão zera também este estado. Sem a Google Agenda
conectada, a lista oferece o link de criar evento e o `.ics`, feitos no navegador,
também livres na agenda. Dar nome a uma voz da reunião muda o texto das ações que a
citam: o evento delas na Google fica "falhou", com "Tentar de novo" na lista, e o
`.ics` baixado de novo sai com revisão maior. A nota de privacidade do Perfil diz que a
WRW só mexe nos eventos das reuniões da agenda e das próximas ações com prazo; a
Política de Privacidade (Cris) e a descrição do uso da agenda na verificação da Google
precisam dizer o mesmo.

### Só para "Continuar com Google" (opcional)

Entrar e se cadastrar com a conta Google, e ligar a conta Google a uma conta de e-mail
que já existe, no Perfil (A8; `server/entrar-com-google.ts` e
`server/rotas-de-entrar-com-google.ts`). Usa o MESMO cliente OAuth da Google Agenda,
com um URI de retorno próprio e só os escopos `openid` e `email` (nenhum token da
Google fica guardado). Só existe com as quatro variáveis abaixo; sem qualquer uma, o
botão some do login, do cadastro e do Perfil, e `/api/entrar-com-google/ir` e
`/api/entrar-com-google/retorno` dão 404. O Desligar do Perfil continua valendo para
quem já ligou.

| Variável | Para quê | Valor |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | o mesmo cliente da Google Agenda | o ID do cliente |
| `GOOGLE_OAUTH_CLIENT_SECRET` | o segredo do mesmo cliente | o segredo do cliente |
| `FRONTEND_URL` | vira o URI de retorno, `<FRONTEND_URL>/api/entrar-com-google/retorno` | https; http só em `localhost` |
| `ENTRAR_COM_GOOGLE` | liga a função | `ligado`; qualquer outro valor, ou nenhum, a desliga |

**Antes de pôr `ENTRAR_COM_GOOGLE=ligado`:**

1. Cadastre no cliente OAuth do Google Cloud (Credenciais, o cliente "Aplicativo da
   Web", "URIs de redirecionamento autorizados") o endereço
   `https://wrwglobal.org/api/entrar-com-google/retorno`, exatamente assim (o
   `FRONTEND_URL` de produção mais o caminho). Sem ele, a Google para numa página de
   erro (`redirect_uri_mismatch`).
2. **Enquanto o app do Google Cloud estiver em modo Teste, só os testadores entram.** As
   contas Google fora da lista de usuários de teste param na página "Acesso bloqueado"
   da própria Google, sem voltar à WRW. Diferente da Google Agenda, aqui não há lista
   de contas da WRW: o botão aparece antes de a pessoa entrar, para todo mundo. Por isso
   a chave fica desligada até a Google verificar o app, ou ligada só enquanto a Glenda e
   o time testam com as contas Google deles na lista de testadores.

**Como funciona:** state, PKCE (S256) e nonce na ida, num cookie cifrado de 10 min só no
caminho das rotas; na volta, o `id_token` vem do endpoint de token da Google (pelo
TLS) e são conferidos o destinatário, o emissor, o prazo, o nonce e o
`email_verified`. A conta decide pelo `sub` (`contas_google`), nunca pelo e-mail: a
conta da WRW que já tem o e-mail da conta Google NÃO é ligada sozinha; a pessoa entra
com a senha e liga no Perfil (ligar pede uma entrada dos últimos 10 minutos). O login
nunca cria conta: só o botão do cadastro cria (Bronze, sem senha, cadastro por concluir).
A sessão é a do login por senha (90 dias), com o mesmo bloqueio por tentativas, e há um
teto de 60 idas e voltas por rede a cada 15 min. Entrada, ligar e desligar vão à
auditoria (`LOGIN` com `metodo: "google"`, `GOOGLE_ACCOUNT_LINKED`,
`GOOGLE_ACCOUNT_UNLINKED`), na transação. A redefinição de senha tira a conta Google
ligada, como tira as chaves de acesso. No app das lojas e nos navegadores de dentro de
outros apps (Instagram, Facebook), o botão não aparece: a Google recusa entrar de
dentro de WebView.

### Só para o exame de produção

`scripts/checar-producao.mjs` roda na sua máquina, não no Render, e por isso não
lê as variáveis do painel. Ele lê um arquivo `.env.producao` (ignorado pelo git,
como todo `.env.*`), separado do `.env` de trabalho, com uma variável obrigatória
e uma opcional:

| Variável | Para quê | Valor |
|---|---|---|
| `DATABASE_URL` | criar e apagar as contas QA, ler auditoria e migrações | a URI do Aiven, com o `ssl` já ajustado |
| `EXAME_BASE_URL` | opcional: o site examinado | padrão `https://mmm-gud5.onrender.com`; `http://localhost:3000` examina o `pnpm dev` |

`EXAME_BASE_URL` também pode vir do ambiente (`EXAME_BASE_URL=... node ...`), e aí
vence o valor do arquivo. `JWT_SECRET` não é necessário: o exame faz login pela
API com as contas que ele mesmo cria.

## O que continua quebrado depois do deploy

**Upload de arquivo — RESOLVIDO no código, falta configurar.**
`server/storage.ts` foi reescrito sobre a API do S3, que AWS S3, Cloudflare R2,
Backblaze B2 e MinIO falam igualmente: a decisão D6 escolhe o provedor, o
código não muda. Preencher no ambiente:

```
STORAGE_BUCKET=            nome do bucket
STORAGE_ACCESS_KEY_ID=     credencial
STORAGE_SECRET_ACCESS_KEY= credencial
STORAGE_ENDPOINT=          só fora da AWS (ex.: https://<conta>.r2.cloudflarestorage.com)
```

Sem as variáveis, os quatro caminhos que dependem de arquivo (gravação de
reunião, documentos do deal room, documentos do SIVC, geração de imagem) falham
com mensagem que nomeia as variáveis certas.

A rota que serve os arquivos (`/manus-storage/*`) passou a exigir **sessão e
posse**: gravação só para a dona, SIVC só para a dona, deal room para as partes
(ou Ouro+, espelhando a política atual), e prefixo desconhecido é negado. Antes
ela redirecionava qualquer requisição anônima para a URL assinada. Exceção desde
12/11/2026: o áudio da reunião com link aberto sai por
`/reuniao-aberta/{token}/audio`, sem sessão, enquanto a dona mantém o link ligado
(`server/link-aberto-da-reuniao.ts`).

**Baixar o áudio da reunião (H8c, 20/11/2026).** A dona baixa o áudio inteiro em MP3 ou
M4A por `GET /api/reunioes/baixar-audio/{ficha}`: a ficha é de uso único, vale 2 minutos
e só para a sessão que a pediu (`meetings.baixarAudio`, que audita
`MEETING_AUDIO_DOWNLOADED` na mesma transação), e as partes vêm do bucket pelo servidor,
sem URL assinada para o navegador. Quem converte é o **ffmpeg que o `Dockerfile` instala**
(pacote da Debian bookworm, sem as recomendações): pela conta dos índices da Debian, são
200 pacotes e cerca de 480 MB a mais na imagem, porque o `libavdevice` do ffmpeg traz o
Mesa e o LLVM junto, e cerca de 134 MB de download no build. A conversão roda com
prioridade baixa (nice 10), no máximo 2 por vez, e cada dona baixa até 10 áudios por
hora. Sem o ffmpeg o servidor sobe do mesmo jeito, e só o "Baixar o áudio" responde
`AUDIO_INDISPONIVEL` (o log diz `[Áudio] o ffmpeg ... não subiu`). Com o Node como root (a
imagem não tem `USER`), o ffmpeg só roda como o usuário nobody: se o host negar a troca de
usuário (as capacidades SETUID e SETGID removidas do contêiner), ele não sobe como root, e o
mesmo `AUDIO_INDISPONIVEL` sai, com `[Áudio] o sistema não deixou o ffmpeg rodar como o
usuário nobody` no log.

**Gravação de reunião.** `server/routers/meetings.ts` recebe o áudio como base64
de até 15 MB em uma requisição e transcreve com LLM dentro dela. Um request pode
durar minutos. Confirmar o limite de tempo do host antes de contar essa etapa
como pronta.

## Termo Geral de Uso: publicar logo depois do deploy da 0013

**Passo obrigatório. Nenhuma migração, boot ou deploy grava o termo.** O
cadastro só conclui com o Termo Geral de Uso, Proteção de Dados e Intermediação
Digital aceito, e sem versão publicada `profile.completeOnboarding` recusa
(`server/termo-geral-de-uso.ts`). Então, sem o termo publicado, toda conta nova
fica presa na última etapa do `/onboarding` com "ainda não foi publicado".

Quem **já tem conta** não fica: "Editar perfil", no Dashboard, leva a `/profile`,
que salva sem passar pelo termo — antes ele apontava para `/onboarding` e
obrigava a refazer as oito etapas para esbarrar na mesma parede (janela B da
revisão da #135). A trava do Termo Geral é para quem ainda não concluiu o
cadastro.

A migração 0013 só acrescenta o valor `termo_geral_de_uso` ao enum de
`document_versions`. Antes dela aplicada, o banco recusa a publicação. Por isso a
ordem é esta:

1. Merge na `main`. O Render sobe e aplica a 0013 no boot.
2. Confirmar que a 0013 entrou. No exame, a linha "migrações pendentes: nenhuma"
   precisa sair OK.
3. Logo em seguida, com autorização do Roberto (é escrita no banco de produção).
   **O script não aceita `--env`**: ele lê `process.env.DATABASE_URL` e morre com
   "Defina DATABASE_URL." Use o preload do dotenv, que não passa a URL pelo shell
   (a do Aiven tem JSON no parâmetro de SSL e o shell a quebraria):
   ```bash
   DOTENV_CONFIG_PATH=.env.producao node -r dotenv/config scripts/publicar-documento.mjs termo_geral_de_uso docs/termos/termo-geral-de-uso.md --simular
   DOTENV_CONFIG_PATH=.env.producao node -r dotenv/config scripts/publicar-documento.mjs termo_geral_de_uso docs/termos/termo-geral-de-uso.md --confirmo-producao
   ```
   Na simulação, confira quatro coisas: `vigente: nenhuma`, `nova: versão 1`, o
   tamanho em caracteres e a linha do aviso suprimido.
   Só o cadastro pede este aceite, e o aviso no sino mandaria quem já tem conta a
   um `/dashboard` sem tela para aceitar. Para `termo_geral_de_uso` o script
   suprime o aviso sozinho (`TIPOS_SEM_AVISO` em `scripts/publicar-documento.mjs`),
   com ou sem `--sem-aviso`.
4. Rodar o exame. A linha "Termo Geral de Uso vigente" sai FALHA enquanto não
   houver exatamente uma versão vigente.

**Antes do passo 1, conte quantas contas o portão do cadastro tranca.** Toda conta
com `onboardingCompleted = 0` fica presa em `/onboarding` a partir deste deploy
(`server/cadastro-concluido.ts`), e a carga de participantes
(`scripts/importar-participantes.mjs`) grava exatamente isso. É leitura pura:

```bash
DOTENV_CONFIG_PATH=.env.producao node -r dotenv/config -e "const m=require('mysql2/promise');m.createConnection(process.env.DATABASE_URL).then(async c=>{const [r]=await c.query('SELECT COUNT(*) AS trancadas FROM users WHERE onboardingCompleted = 0');console.log(r[0]);await c.end();})"
```

Diferente de zero significa que essas pessoas terão de passar pelo cadastro para
aceitar o Termo. O formulário delas abre PREENCHIDO com o que a planilha trouxe
(nome, cidade, país, bio, empresa, cargo, setor, o que tem e o que precisa), então
é conferir e aceitar — mas ainda é uma etapa que elas não esperavam.

Entre os passos 1 e 3, o cadastro novo não conclui. Para zerar essa janela,
aplique a migração antes do merge (`node scripts/migrar.mjs` contra produção, com
autorização do Roberto) e publique o termo em seguida. Isso só é seguro se o SQL
da migração for aditivo, e isso precisa ser conferido. O código antigo ignora
tabela, coluna e valor de enum novos, e o `migrar.mjs` do boot não reclama de
migração já aplicada.

## Verificar antes de mandar o link

```bash
pnpm install
pnpm check    # tipos
pnpm test     # Vitest
pnpm build    # gera dist/
```

Depois de publicado, rode `node scripts/checar-producao.mjs --env .env.producao`.
Ele cria e apaga as próprias contas QA, então não é preciso criar conta real para
conferir o login. A saída lista cada checagem e termina com o veredito e o código
de saída: 0 só sem falha (ALERTA conta como falha), exceção, limite de requisições
ou erro de limpeza.
