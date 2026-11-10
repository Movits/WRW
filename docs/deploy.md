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
| `RESEND_API_KEY` | e-mail de recuperação de senha | resend.com |
| `EMAIL_FROM` | remetente | `nao-responda@seudominio` (o nome WRW é posto pelo código) |
| `LLM_AUDIO_MODEL` | opcional: modelo da transcrição | padrão `gemini-3.5-flash`; só id do Gemini, no formato `gemini-<versão>`, nunca alias: `-latest`, id sem versão (`gemini-pro`) ou de outro provedor é recusado, avisa no log e cai no padrão |
| `LLM_AUDIO_MODEL_RESERVA` | opcional: modelo reserva da transcrição (assume no 503/cota) | padrão `gemini-3.5-flash-lite`; a mesma guarda do `LLM_AUDIO_MODEL` |
| `LLM_MODEL` | opcional: modelo das chamadas de texto (extração, tradução, FAQ, Memória), que vão ao `LLM_API_URL` | padrão `gemini-3.5-flash`; id concreto, nunca alias: `latest` ou id sem número de versão (`gemini-pro`) é recusado, avisa no log e cai no padrão; id de outro provedor compatível com a OpenAI passa (`gpt-4o-2024-08-06`) |

A transcrição e os embeddings (`server/gemini.ts`) não usam o `LLM_API_URL`:
vão sempre à API do Gemini, com o id na URL e a mesma chave (`LLM_API_KEY` ou,
sem ela, `GOOGLE_API_KEY`). Por isso o modelo do áudio só aceita o formato
`gemini-<versão>`. Pôr o texto em outro provedor deixaria a transcrição e os
embeddings com a chave errada: chaves separadas ainda não existem no código.

No boot, o log mostra `[IA] áudio … · reserva … · texto …` com os modelos
que valem depois da guarda, sem a chave (id de outro provedor no texto aparece
como "fora do log"). Os ids que a chave do Gemini enxerga saem de
`node scripts/listar-modelos-gemini.mjs --conferir id1,id2` (ver
`scripts/README.md`); existir na lista não prova que o id é concreto.

`PORT` a hospedagem injeta sozinha (o Render e o Railway fazem isso). Não defina na mão.

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
ela redirecionava qualquer requisição anônima para a URL assinada.

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
