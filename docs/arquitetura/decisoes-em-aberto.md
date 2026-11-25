# Decisões em aberto

Coisas que não são decisão técnica e que travam implementação. Cada uma tem um item
correspondente no quadro do projeto.

---

## D1: Percentual e regras da comissão

**Trava:** ajuste A11 (contrato de comissão no cadastro), etapa 13.
**Parado desde:** 12/08/2026.

**Respondida pela Glenda em 31/08/2026, no grupo "Projetos IA"** (registro do
Roberto; o grupo é o canal das decisões dela e nem tudo chega ao Notion): o
percentual é individualizado por negócio, definido manualmente por enquanto, com
teto de 50% do lucro declarado; a divisão entre duas indicadoras se resolve caso a
caso. Falta o texto contratual: em 05/09 a Cris pediu ao Roberto as orientações
originais da Glenda sobre comissão e remuneração para concluir o acordo de
intermediação e o contrato de comissão.

**Atualizada pela Glenda em 12/09/2026, por escrito:** o teto de 50% incide sobre o
valor dos **honorários da intermediação** do negócio, não sobre o lucro, e quem define
o percentual é a Diretoria Comercial, "por critérios que serão definidos em outra
ocasião". O texto de tela do contrato mudou na PR #107, mesclada em 14/09/2026, e,
segundo o registro da PR #132, a versão 2 do `contrato_comissao` foi publicada no mesmo
dia.

**O que a tela nunca mostrou.** As outras respostas de 12/09 (quem declara o valor é o
consultor de negócios; o rateio entre duas indicadoras; o bypass vedado; nenhum prazo
de decadência) entraram em `docs/termos/contrato-comissao-provisorio.md`, mas nunca no
texto que a usuária lia no cadastro. Na tela, a cláusula de comissão só trouxe o
percentual, o teto de 50% (sobre o lucro até a PR #107, sobre os honorários depois) e o
pagamento fora da plataforma. A retirada desse contrato do cadastro foi decidida em
14/09 e está no ar desde 16/09/2026 (PR #135): desde então o cadastro não mostra nem
registra mais esse contrato, e a comissão passou às cláusulas 12 a 15 do Termo Geral de
Uso. Quem concluiu o cadastro entre 14 e 16/09 ainda viu e aceitou o contrato. O que
cada usuária aceitou está no registro do aceite (`consents`, com o hash do texto), e
conferir esse registro é assunto do jurídico.

Perguntas:

1. Qual o percentual da comissão da WRW?
2. Incide sobre o quê: valor do negócio fechado, valor recebido, outra base?
3. Percentual único, ou varia por tipo de negócio, porte ou valor?

Dá para andar sem a resposta: a tela de aceite, o versionamento do documento e o
registro do consentimento se constroem tratando o percentual como configuração. Só o
texto final depende da decisão.

---

## D2: Como o dinheiro passa pela plataforma

**Trava:** ajuste A14. É a decisão de maior impacto no prazo, e a única com
componente regulatório.

A nota da reunião de 05/08 diz:

> o dinheiro do negócio que foi fechado fica no site para depois ser repassado, já
> descontada a comissão

Guardar dinheiro de terceiros e repassar depois é atividade regulada no Brasil.
Fazer isso na mão, com o valor passando por uma conta da WRW, cria risco jurídico e
tributário.

| Caminho | Como funciona | Cabe até 10/09? |
|---|---|---|
| **Não tocar no dinheiro** | A WRW registra o negócio e cobra a comissão por fora. | Sim |
| **Split via gateway** | Pagar.me, Asaas, Stripe Connect e similares dividem o valor entre as partes e a comissão. A licença é do gateway, não da WRW. | Apertado |
| **Conta escrow própria** | A WRW recebe, guarda e repassa. Exige estrutura de instituição de pagamento. | Não |

**Recomendação técnica:** o primeiro caminho para 10/09, o segundo como alvo da
versão seguinte. O terceiro não deveria entrar em discussão sem parecer jurídico.

**Respondida pela Glenda em 31/08/2026, no grupo:** o dinheiro não passa pela
plataforma na primeira versão; a WRW só registra o negócio fechado. É o primeiro
caminho da tabela. O A14 continua bloqueado para uma versão futura.

---

## D3: Até onde bloquear o contato direto

**Trava:** ajuste A13, e se conecta à cláusula de non-circumvention da etapa 13.

Perguntas:

1. Esconder e-mail e telefone até o acordo ser aceito, ou também filtrar contatos
   digitados dentro do chat?
2. Consequência de contornar: aviso, suspensão, cláusula contratual com penalidade?
3. Vale para todos os usuários ou só para oportunidades do Smart Match?

Ver a seção sobre o alcance real do bloqueio em
[privacidade.md](./privacidade.md#acesso-após-o-aceite-etapa-13-e-ajuste-a13).

**Respondida pela Glenda em 31/08/2026, no grupo, e endurecida no mesmo dia:** os
contatos das partes aparecem somente para o consultor de negócios, nunca entre as
partes, nem depois da aprovação (a spec previa revelação entre as partes; a regra
nova prevalece e a etapa 11/13 deve segui-la). O bloqueio de e-mail e telefone em
texto livre foi mantido como barreira extra e está no ar desde a PR #48 (A13).

---

## D4: Destaque de produto, pago ou gratuito?

**Trava:** ajuste A12. Decisão barata de tomar; muda o tamanho do item de um dia
para semanas.

| Se for | O item vira |
|---|---|
| Gratuito | Uma marcação e uma ordenação. Um dia de trabalho. |
| Pago | Meio de pagamento, cobrança, controle de validade do destaque. Semanas. |

**Parcialmente respondida pela Glenda em 31/08/2026, no grupo:** a vitrine foi
aprovada; se o destaque será pago ou gratuito continua em aberto. Enquanto não
houver resposta, o A12 (Lucas) deve seguir o caminho gratuito da tabela.

---

## D5: O recorte do prazo de 10/09

Em 25/08 restam 16 dias, e estão em aberto:

- Etapas **12** e **13**, as duas maiores e nenhuma iniciada
- Ajustes **A11 a A14**, todos travados por decisão
- O código saiu do Manus, mas ainda não está hospedado em lugar nenhum
- Nada foi verificado por ninguém além de quem fez

Só o A14, do jeito que está escrito, consome mais do que os 16 dias restantes.

**Proposta de recorte:**

- **Em 10/09**: etapas 1 a 11 verificadas de verdade, ajustes A1 a A10 conferidos,
  etapas 12 e 13 na mecânica (aceite, corretor, status, auditoria), com o texto
  jurídico entrando como versão de documento depois.
- **Data própria**: A14, e A12 se for pago.
- **Esta semana**: D1, D2, D3, D4 e D6 respondidos.

---

## D6: Qual banco de dados e onde hospedar

**Trava:** nada trava por falta de resposta de terceiros. Só depende de orçamento.
**Estava adiada até sabermos o que sobrou do Manus. Sobrou tudo, e roda.**

O código recuperado é um processo Express único que serve a API tRPC e o front-end
juntos, com Drizzle sobre MySQL. Não é protótipo: 42 tabelas em `mysqlTable`, mais
11 que existem no banco sem definição Drizzle nenhuma (o módulo SIVC inteiro,
`national_leaders`, `user_vault`), e 3 migrações aplicadas.

O conflito é conhecido: `modelo-de-dados.md` foi escrito assumindo Postgres. A
pergunta não é qual banco é melhor em abstrato, é quem cede, com 16 dias no
relógio e duas etapas grandes não iniciadas.

### MySQL x Postgres: o custo de migrar, medido no código

Não é trocar um import. Foi contado arquivo por arquivo:

| O que muda | Quantidade | Por quê |
|---|---|---|
| Tabelas reescritas para `pgTable` | 42 | dialeto |
| Tabelas sem Drizzle, DDL à mão | 11 | o `drizzle-kit` não gera o que não conhece; o SIVC não nasceria |
| `mysqlEnum` → `pgEnum` no topo | 21, sendo 11 com nome colidente | em Postgres o enum é tipo global, não inline |
| `.onUpdateNow()` | 7 colunas | não existe em Postgres, vira trigger |
| `insertId` / `$returningId()` | 8 | formato de resultado do mysql2 |
| `onDuplicateKeyUpdate` → `onConflictDoUpdate` | 4, um deles no login | `ON CONFLICT` exige nomear a chave, e `users` tem duas |
| `db.execute` devolvendo tupla `[rows]` | 22 | em Postgres devolve `{ rows }`; **compila igual e devolve outra coisa** |
| SQL cru com identificador camelCase | 19 statements | Postgres cria `"userId"` sensível a caixa; `WHERE userId` quebra em execução |
| `like()` sensível a acento | 9 buscas | hoje "sao paulo" acha "São Paulo"; em Postgres deixa de achar |

**Estimativa: 6 a 10 dias úteis, sem rede de proteção.** São 19 arquivos de teste
e só um encosta no banco. As três quebras mais caras (o `[rows]`, o upsert do login
e a busca sem acento) não são pegas pelo compilador: aparecem em produção.

Atualizar o documento custa **meio dia**, pode ser feito por quem não está codando,
e o DDL autoritativo já existe pronto em `drizzle/0000_clear_adam_destine.sql`.
A assimetria é de dez para um.

**E os cinco requisitos da lista?** Quatro não dependem do banco:

| Requisito | Depende do banco? |
|---|---|
| Busca em linguagem natural | **Não.** O cosseno roda em JavaScript (`server/memory-service.ts:42`), sobre no máximo 800 vetores de 768 dimensões por usuária, e `memory_documents` está vazia. O gargalo real é a reindexação disparada a cada busca, em laço serial contra o Gemini, e o pgvector não toca nisso. |
| Transcrição de áudio | **Não.** É chamada HTTP ao Gemini. |
| Histórico auditável | **Não.** `audit_logs` roda igual nos dois. |
| Funcionar no celular | **Não.** É trabalho de front-end. |
| Privacidade aplicada **no banco** | **Aqui sim.** RLS de verdade só existe em Postgres. |

Sobre o último, dois fatos mudam a conta. **Isso não está atendido hoje em banco
nenhum**: são cerca de 150 cláusulas `WHERE ownerId = ?` espalhadas pela aplicação,
e não existe uma linha de `CREATE POLICY`. E **migrar não entrega RLS, só torna
possível**: implementar de verdade exige cada requisição rodar sob identidade de
banco própria, o que soma 3 a 5 dias **depois** dos 6 a 10.

O que existe hoje filtra no `WHERE`, executado pelo banco: linha alheia não sai do
servidor. O que falta em relação a RLS é defesa contra alguém esquecer um `WHERE`,
e isso se compra por meio dia, com uma camada que exige `ownerId` na assinatura e um
teste que varre as queries. Sem trocar de banco.

### Onde hospedar o banco

Preços consultados em 25/08/2026 nas páginas oficiais.

| Opção | Protocolo | Plano gratuito | Região BR | Custo | Migração |
|---|---|---|---|---|---|
| **Railway MySQL** | MySQL | incluso no Hobby | Não | dentro dos US$ 5-12/mês do app | **nenhuma** |
| **Aiven MySQL** | MySQL | 1 GB, nó único | nos pagos; no grátis não confirmado | US$ 0 ou 5/mês | **nenhuma** |
| **TiDB Cloud Starter** | MySQL | 5 GiB + 50M RUs/mês | **não** | US$ 0 | **nenhuma** |
| PlanetScale | MySQL | **acabou em 04/2024** | não confirmado | US$ 39/mês | nenhuma |
| Neon | Postgres | 0,5 GB, dorme em 5 min | sim | US$ 0 | 6-10 dias |
| Supabase | Postgres | 500 MB, **pausa após 1 semana parado** | sim | US$ 25/mês; PITR custa +US$ 100 | 6-10 dias |

Duas pegadinhas que importam: o TiDB **recusa novas conexões** quando a cota estoura,
e o login para de funcionar até virar o mês. O Aiven no grátis pode desligar serviço
sem atividade, o que já justifica ir direto ao plano de US$ 5.

### Onde hospedar a aplicação

Duas restrições do próprio código eliminam metade da lista antes do preço.
`server/routers/meetings.ts` recebe o áudio como base64 de até 14 milhões de
caracteres em **uma** requisição, e transcreve com LLM **dentro dela**: um request
pode durar minutos. E é um processo único servindo API e front juntos.

| Opção | Deploy | Dorme? | MySQL junto | Custo real | Esforço |
|---|---|---|---|---|---|
| **Railway Hobby** | GitHub, automático | não | **sim, 1 clique** | US$ 7-12/mês | **~meio dia** |
| Render | GitHub, automático | o grátis hiberna e leva ~1 min para voltar | não, só Postgres | US$ 8-10/mês | meio dia + banco à parte |
| Fly.io | Dockerfile + CLI | opcional | não | US$ 7-12/mês | 1-2 dias |
| Cloud Run | container + IAM | escala a zero | não | ~US$ 87/mês se ficar quente | 2-4 dias |
| **Vercel** | — | — | — | — | **inviável:** corpo de requisição limitado a 4,5 MB, todo upload de reunião vira erro 413 |
| VPS (Hetzner, Lightsail) | manual | não | você instala | EUR 4,49 a US$ 7/mês | 1-3 dias + manutenção eterna |

O VPS é o melhor preço por recurso e o pior encaixe: ninguém no time é engenheiro de
infraestrutura, e uma noite depurando nginx é uma noite que não foi para a entrega.

Nenhum serviço gerenciado dessa lista tem região no Brasil, exceto Fly.io e Cloud
Run. Isso custa cerca de 130 ms por requisição a partir dos Estados Unidos,
invisível neste app.

### Armazenamento de arquivos

**O upload está quebrado hoje, e não é por causa da hospedagem.** `server/storage.ts`
falava com o Forge do Manus, que saiu do ar. Isso derruba quatro caminhos: gravação
de reunião, documentos de deal room, documentos do SIVC e geração de imagem. O
cliente precisa ser reescrito de qualquer forma, e o `@aws-sdk/client-s3` já está
instalado, sem ser usado em lugar nenhum.

| Opção | Preço | Egresso | Grátis |
|---|---|---|---|
| **Cloudflare R2** | US$ 0,015/GB/mês | **US$ 0** | 10 GB/mês |
| Backblaze B2 | ~US$ 0,007/GB/mês | grátis até 3x o armazenado | 10 GB |
| AWS S3 | a partir de US$ 0,023/GB | US$ 0,09/GB | — |

### "Funcionar no celular"

Até 10/11/2026 era site responsivo e nada além: sem manifest, sem service worker. Um
**PWA** atende o pedido de "app" dentro do prazo: ícone na tela inicial, tela cheia,
e a gravação já funciona por `MediaRecorder` no navegador. É trabalho de front-end,
algumas horas. App nativo só seria necessário para gravar em segundo plano ou push
confiável no iOS, e consumiria as duas etapas que ainda não começaram.

**Atualização de 10/11/2026:** o app ficou instalável. O
`client/public/manifest.webmanifest` põe a WRW na tela inicial e a abre direto no
gravador (`/gravar`), em janela própria. O service worker continua de fora, de
propósito, para o aparelho nunca guardar um `index.html` velho. As lojas (App Store
e Play Store) seguem em aberto: é a pergunta 2, logo abaixo.

### Perguntas que dependem de decisão de pessoa

1. **Qual o orçamento mensal para infraestrutura?** Tudo aqui cabe em US$ 10-20.
   Se o teto for zero, existe caminho (TiDB grátis + Render grátis), mas a demo
   abre com cerca de um minuto de tela branca depois de um período parado.
2. **A cliente aceita PWA como "app"?** Se exigir presença na App Store e na Play
   Store, isso não cabe até 10/09 e vira decisão separada, e precisa ser perguntado
   esta semana.
3. **Existe exigência contratual de dado hospedado no Brasil?** A LGPD não obriga,
   mas se a cliente pedir por escrito a resposta muda para Aiven São Paulo + Fly.io.
4. **Quem cria as contas, e em qual cartão?** Railway e Cloudflare pedem cadastro.
   Sem isso o deploy trava por um dia útil.

**O que dá para fazer sem resposta nenhuma:** subir Railway com MySQL gerenciado,
ligar o R2 e separar as variáveis de ambiente.
**O que trava de verdade:** só a pergunta 2, porque muda escopo, não infraestrutura.

### Dois itens que valem mais que este debate

- ~~**`pnpm db:push` não recria o banco do zero.**~~ **Resolvido em 31/08/2026:**
  as tabelas do SIVC ganharam definição Drizzle, o histórico de migrações foi
  refundado (baseline `0000_fundacao`, 50 tabelas) e `db:push` deixou de
  existir — o fluxo é `pnpm db:generate` + `pnpm db:migrate`, e o CI cria um
  banco do zero a cada PR para provar que continua funcionando.
- **A gravação de reunião só funciona em host que tolere requisição de minutos.**
  Confirmar o limite de tempo **antes** de contar essa etapa como pronta: o padrão
  de 30 ou 60 segundos de várias plataformas a inviabiliza sem erro revelador.

**Recomendação técnica:** manter MySQL e atualizar `modelo-de-dados.md` com o DDL que
já existe em `drizzle/`, porque migrar custa 6 a 10 dias e não entrega uma tela nova;
hospedar em **Railway Hobby com o MySQL gerenciado do próprio Railway e Cloudflare R2
para arquivos**, a única combinação que sobe o código como está, sem migração, sem
hibernação e em cerca de meio dia. Registrar que a decisão se revisita depois de
10/09 se a cliente exigir isolamento garantido pelo banco em auditoria; aí Postgres
com RLS custa 6 a 10 dias **mais** 3 a 5, e isso precisa estar escrito antes de
alguém prometer prazo.

---

## D7: O termo do Smart Match e o distribuidor

**Trava:** jurídico. Desde 13/09/2026 uma pessoa real (o distribuidor,
`users.isDistributor`) lê os DOIS perfis com nome antes de encaminhar um pedido de
interesse — e o termo do Smart Match vigente não diz isso. A implementação já
audita cada leitura (`DISTRIBUTOR_VIEW_QUEUE`), mas o texto do termo precisa de uma
versão nova citando o passo; versão nova de termo é `document_versions` + novo
aceite (etapa 11).

Perguntas:

1. O termo passa a dizer que "uma pessoa designada pela WRW confere a
   compatibilidade e lê os dois perfis antes de encaminhar"?
2. O distribuidor recebe e-mail além do sino? Hoje é só o sino, e um pedido pode
   esperar dias sem ninguém abrir o Painel Ouro.
3. Um pedido `not_forwarded` pode ser reconsiderado? Hoje não: a solicitante vê
   "não encaminhado" e o par fica fechado. Se a outra pessoa clicar depois, nada
   acontece (a resposta de `send` é a mesma de sempre) — limite conhecido.
4. Com mais de um distribuidor, a fila é uma só. Atribuir por região/setor?

Pendência técnica ligada: índice único no par de `connections` (exige colunas de
par ordenado e backfill; hoje a trava contra dupla revelação é o status no WHERE).

---

## D9: Corte do match de perfis, 40 ou 50?

**Trava:** nada. O corte segue em 40 até a decisão.
**Quem decide:** Dra. Glenda (o Roberto leva a pergunta).

O motor de perfis (`server/matching.ts`) soma seis dimensões e só grava o par como
match no Dashboard com nota 40 ou mais. A PR #105 (Gabriel, 13/09/2026) propôs subir
para 50 e atribuiu a mudança a uma decisão da Dra. Glenda que não tem registro: as
perguntas que o Roberto mandou a ela em 12/09 não tratavam do corte, e as respostas
também não. A PR não foi mesclada e foi fechada em 15/10/2026; o código fica guardado
nela. Os testes que ela chama de fronteira não medem o corte: os dois pares dão 34 e
73, passam iguais com 40 e com 50, e não há teste na faixa 40–49 (revisão do Nicolas,
13/09). Se a resposta for 50, o caminho é uma PR nova e pequena a partir da `main`, com
um par dentro dessa faixa no teste.

**Efeito medido** na `main` de 20/09, com `calculateCompatibilityScore`:

| Par | Nota | Com corte 40 | Com corte 50 |
|---|---|---|---|
| Dois perfis vazios, sem nada declarado | 41 | vira match | não vira |
| "Advocacia tributária" × quem declarou precisar de "consultoria", perfis rasos: o par-bandeira da regra da demanda expressa (PR #101, `server/matching-demanda-expressa.test.ts`) | 44 | vira match | não vira |

- **Os matches de 41 a 49 já gravados continuam na tela.** Com a nota abaixo do corte,
  o cálculo só pula o par: não atualiza nem apaga a linha. E a leitura
  (`getMatchesForUser`, em `server/db.ts`) não filtra por nota. Subir o corte vale só
  para pares novos, a não ser que a leitura passe a filtrar também.
- **O piso de 41 vem da nota neutra.** Perfil vazio já pontua em quase todas as
  dimensões (complementaridade 50, setor 30, investimento 60, valores 50, localização
  50). Mexer nesse neutro é outro jeito de tirar os pares fracos, e também muda a nota
  de todo mundo.

Perguntas:

1. A usuária deve ver mais pares, alguns de encaixe fraco (corte 40), ou menos pares,
   com mais cara de encaixe (50)?
2. Se for 50: os matches de 41 a 49 que já estão na tela somem ou ficam?
3. O par-bandeira da demanda expressa, que vale 44 com perfis rasos, deve continuar
   virando match?

---

## Decisões de produto do modelo de acesso

Três definições que a revisão técnica do modelo levantou. São regras de produto, não
de código, e mudam políticas de acesso já desenhadas:

1. **A autorização Ouro é para o programa ou por pessoa?** Hoje o modelo registra
   "autorizo o acesso Ouro" como um todo: qualquer Usuária Ouro ativa vê os contatos
   nível ouro de quem autorizou. Se a intenção do escopo ("Usuários Ouro
   autorizados") é autorizar pessoa a pessoa, a tabela e a política mudam.
2. **Os níveis são cumulativos?** Um contato marcado `publico` aparece na vitrine de
   oportunidades sem dados pessoais. A Usuária Ouro autorizada também deveria ver os
   dados completos dele, como vê os de nível `ouro`? Se sim, a política inclui os
   dois níveis; se não, registrar que público é menos visível que ouro para quem tem
   acesso Ouro.
3. ~~**Consentimento sobrevive à troca de versão do termo?**~~ **DECIDIDO em
   31/08/2026 (Nicolas): não sobrevive.** O cruzamento pausa até a pessoa aceitar a
   versão nova.

   A razão é que a alternativa enfraquece a prova. Quem aceitou a versão 1 não leu a
   versão 2, e registrar que aceitou um texto que nunca viu esvazia justamente o que
   o versionamento existe para garantir — "fulana aceitou" só vale como prova se
   disser o que ela aceitou.

   O custo é atrito: toda publicação faz todo mundo ver a tela de novo. Ele é
   mitigado, não eliminado — a tela passa a dizer "O termo foi atualizado", informa
   qual versão a pessoa tinha aceitado e garante que contatos e conexões já aceitas
   continuam onde estavam. Sem isso o retorno da tela pareceria falha do sistema.

   Fica em aberto, para quando houver volume: distinguir mudança de substância de
   correção de vírgula, para que a segunda não force novo aceite. Exige um campo no
   documento marcando qual é qual, e alguém decidindo na hora de publicar.

   Implementado em `server/routers/consent.ts` (o filtro por `documentVersionId`) e
   `client/src/components/SmartMatchConsent.tsx` (o aviso).

---

## Decisão técnica que estava adiada, agora é a D6

**A stack.** Não fazia sentido escolher antes de saber o que sobrou do código do
Manus. Sobrou, e roda: a escolha já está feita pelo que existe, e o que resta
decidir virou a **D6** acima.

O modelo de dados foi escrito assumindo Postgres, e o código recuperado é MySQL.
A D6 mede esse custo e recomenda qual dos dois cede.

O que a stack escolhida precisa entregar:

- Os três níveis de privacidade aplicados no banco, não na tela
- Busca em linguagem natural sobre a base do próprio usuário
- Transcrição e extração de áudio
- Histórico auditável de oportunidades
- Funcionar no celular: o escopo pede app, não só site
