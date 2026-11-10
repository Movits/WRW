# Documentação

O índice de `docs/` e o glossário do projeto. O que o produto faz está no
[README da raiz](../README.md). As regras de trabalho, para pessoas e para o Claude,
estão no [CLAUDE.md](../CLAUDE.md). Cada pasta de código (`client/`, `server/`,
`shared/`, `drizzle/` e `scripts/`) tem o seu `CLAUDE.md`, com o detalhe daquela área.

## Comece aqui

- [guia-de-entrada.md](./guia-de-entrada.md): como trabalhamos, acessos, preparar a
  máquina, banco local, `.env`, o Claude neste repositório e os erros comuns.

## Desenho do sistema

`arquitetura/` é a referência de projeto, não o retrato do código: descreve para onde o
sistema vai, e nem tudo o que está desenhado existe. O código roda MySQL. Onde o desenho
diverge do código, vale o código.

- [arquitetura/README.md](./arquitetura/README.md): os princípios (privacidade é
  estrutura, match sobre lista controlada, direção oposta, demanda expressa, nada da IA
  entra sozinho), as camadas e onde cada etapa encosta no modelo.
- [arquitetura/fluxos.md](./arquitetura/fluxos.md): o assistente de reunião e o Smart
  Match até o corretor.
- [arquitetura/privacidade.md](./arquitetura/privacidade.md): os três níveis de acesso
  como regra de consulta.
- [arquitetura/decisoes-em-aberto.md](./arquitetura/decisoes-em-aberto.md): as
  decisões de produto (D1, D2…) que travam ou mudam a implementação.
- [arquitetura/decisoes-tomadas.md](./arquitetura/decisoes-tomadas.md): as decisões
  datadas que já valem no código (quando, quem decidiu e onde está).
- [arquitetura/modelo-de-dados.md](./arquitetura/modelo-de-dados.md): é **projeto em
  Postgres**. A fonte do banco real é `drizzle/schema.ts`, com as migrações de `drizzle/`.
- [arquitetura/gravador-de-reunioes.md](./arquitetura/gravador-de-reunioes.md): o
  gravador sem teto de tempo, o link `/gravar`, as passkeys, as funções de resumo e a
  agenda, em ondas de PRs, com os contratos entre elas (plano de 30/10/2026, atualizado
  em 10/11).

## Operação

- [deploy.md](./deploy.md): como o site sobe (Render + Aiven + B2), a tabela de
  variáveis, a publicação do Termo Geral e as conferências depois do deploy.
- [../scripts/README.md](../scripts/README.md): o mapa das ferramentas de linha de
  comando, com quais gravam no banco e quais tocam produção.
- [../vitrine/README.md](../vitrine/README.md): a página estática do GitHub Pages
  (não é a aplicação).

## Jurídico

Os textos ficam em [termos/](./termos/). Mudar um texto publicado exige publicar uma
versão nova (`scripts/publicar-documento.mjs`), e isso pede aceite de novo. Não edite
estes arquivos sem o jurídico e o Roberto.

- `termo-geral-de-uso.md`: o Termo Geral de Uso, Proteção de Dados e Intermediação
  Digital, que o cadastro exige.
- `termo-acesso-ouro-provisorio.md`: a autorização do acervo Ouro (provisória).
- `contrato-comissao-provisorio.md`: o contrato de comissão provisório. A retirada dele do
  cadastro foi decidida em 14/09 e está no ar desde 16/09/2026 (PR #135): o cadastro não o
  mostra mais, e a comissão passou às cláusulas 12 a 15 do Termo Geral.
- Smart Match, em **três versões**: `termo-smart-match-provisorio.md` (espelho do texto
  embutido no script), `termo-smart-match.md` (pendente de revisão jurídica) e
  `termo-smart-match-cris-2026-09-05.md` (a redação da Cris). Qual delas está vigente em
  produção fica **a confirmar com o Roberto e o jurídico**.

## Marca

- [identidade-visual/wrw/](./identidade-visual/wrw/README.md): a marca WRW, em uso desde
  15/09/2026.
- [identidade-visual/](./identidade-visual/README.md): as logos da marca anterior,
  guardadas como histórico.

## Histórico

Ficam para consulta e não descrevem o sistema de hoje. Os arquivos em Markdown trazem
uma faixa no topo que diz isso.

- `spec-*.md` e `spec-strategic-profile-etapa2.pdf`: as especificações por etapa escritas
  pelo Manus AI em agosto de 2026, quase todas com outra stack (NestJS, Postgres, Expo; a
  `spec-private-network.md` já parte do Drizzle sobre MySQL/TiDB do Manus). A
  `spec-enrichment-etapa4.md` (v1) foi superada pela `spec-enrichment-etapa4-v2.md`.
- [recuperacao-do-manus.md](./recuperacao-do-manus.md): como o código saiu da plataforma
  Manus e o que mudou na extração.
- `password-reset-system.md` e `password-reset-validation.md`: a recuperação de senha
  como era no Manus.
- A seção "Subir no Railway" de [deploy.md](./deploy.md).
- [../CHANGELOG.md](../CHANGELOG.md): vai até 02/09/2026. Depois disso, o histórico são
  as PRs.

## Glossário

**Marca e origem**

- **WRW (Women Rocking the World):** a marca, desde 15/09/2026, em toda tela e nos 10 idiomas.
- **MMM (Mulheres que Movem o Mundo):** o nome anterior. Continua como nome técnico em
  alguns nomes de infraestrutura e em dados gravados que não se renomeiam.
- **Manus:** a plataforma de IA onde o código nasceu, extraído em agosto de 2026. O
  `server/_core/` é herança dela.

**Níveis e papéis**

- **Bronze, Prata e Ouro:** os níveis da conta (`bronze`, `silver`, `gold`). Bronze entrou,
  Prata completou o perfil e Ouro é o grupo restrito, com o painel de governança.
- **Presidência e admin:** os papéis `president` e `admin`. Para quase tudo valem o mesmo
  que Ouro, com quatro exceções descritas em `server/CLAUDE.md`.
- **Distribuidor:** um poder, não um nível (`users.isDistributor`). A pessoa confere cada
  pedido de interesse antes de encaminhá-lo.
- **Pedido de interesse:** quando uma membra quer conhecer outra a partir de um match
  (`connections.status`). Nasce `in_review` (espera o distribuidor), passa a `pending`
  (espera a destinatária) e termina em `accepted` ou `declined`, ou em `not_forwarded`
  (não encaminhado).

**Match**

- **Smart Match (Cruzamento Inteligente):** o cruzamento automático do que um lado possui
  com o que o outro procura. A usuária o liga aceitando o termo do Smart Match.
- **Motor privado:** cruza os contatos da mesma dona (`server/match-service.ts`).
- **Motor de perfis:** cruza perfis de usuárias em seis dimensões com nota mínima 40
  (`server/matching.ts`), e o resultado aparece no Dashboard.
- **Possui × procura:** as duas listas de cada contato e de cada perfil, o que oferece e o
  que busca. No motor privado, o match é sempre uma ponta que possui contra outra que
  procura. No de perfis, a nota soma seis dimensões, e um par pode virar match sem
  nenhum termo cruzado (ver a D9 em
  [decisoes-em-aberto.md](./arquitetura/decisoes-em-aberto.md)).
- **Demanda expressa:** a regra de 12/09/2026. Uma oferta de SERVIÇO só casa com uma
  necessidade declarada em "o que preciso", nunca com quem "poderia precisar".
- **Concorrentes:** duas pontas que querem a mesma coisa ("exportar" × "exportar"). O motor
  privado zera o par; o de perfis ainda não aplica a regra.

**Rede e contatos**

- **Rede particular:** a agenda privada de contatos de cada usuária (`/network`). Ninguém
  mais a vê.
- **Contexto:** onde e como a usuária conheceu um contato: evento, indicação, viagem
  (`/contexts`, etapa 5).
- **Enriquecimento:** o chat que completa o cadastro de um contato. O que a IA extrai vira
  sugestão e só entra com a confirmação da usuária.
- **Assistente de reunião:** grava, transcreve e sugere contatos e assuntos a partir de uma
  reunião (etapa 3).

**As duas "vitrines"**

- **Vitrine coletiva:** a função do produto (etapa 8). Mostra, na tela de Oportunidades, o
  que possuem e procuram os contatos marcados como públicos, só com cidade, país e uma
  referência opaca, nunca dados pessoais.
- **`vitrine/`:** a página estática de apresentação, no GitHub Pages. Não é a aplicação.

**Negócio**

- **Acervo Ouro:** os contatos que as donas marcaram para membras Ouro, liberados só com o
  termo aceito pela dona e com registro de auditoria (etapa 10).
- **Oportunidade:** um negócio publicado por uma membra, que uma conta Ouro ou a
  presidência valida antes de ir ao ar. O **destaque** de oportunidade (ajuste A12) ainda
  não está no ar e depende da D4 (pago ou gratuito).
- **Sala de Negociação (Deal Room):** a sala privada das duas partes. Só destrava depois
  de as duas aceitarem o acordo de confidencialidade (NDA).
- **SIVC:** o Sistema Inteligente de Verificação e Classificação de Usuários, que verifica
  documentos da usuária (`server/routers/sivc.ts`).
- **Termo Geral de Uso:** o termo único que o cadastro exige (decidido em 14/09; no ar
  desde 16/09/2026, PR #135), com uso, dados, gravação e intermediação. Ele não se revoga
  à parte.

**Códigos de trabalho**

- **Etapas 1 a 13:** as 13 seções do escopo que a Dra. Glenda enviou em 06/08/2026.
- **A1 a A14:** os ajustes da reunião de 05/08/2026 (por exemplo, A11 comissão, A12
  destaque, A13 bloqueio de contato direto, A14 pagamento pelo site).
- **F1 a F12:** tarefas avulsas abertas no quadro na reta final da entrega (por exemplo,
  F1: traduzir as três telas em português fixo).
- **D1, D2…:** as decisões de produto em
  [decisoes-em-aberto.md](./arquitetura/decisoes-em-aberto.md).
- **Códigos do gravador:** os códigos de PR do plano do gravador de reuniões, em
  [gravador-de-reunioes.md](./arquitetura/gravador-de-reunioes.md): A1 a A8 (acesso e
  navegação); G1a, G1b, G2 a G10, G13 e G14 (o gravador e a transcrição de reuniões
  longas); H1r, H3 a H16 e H9b (resumo, perguntas, agenda e as outras funções em volta
  da reunião); R1 (reunião compartilhada); D1 (detalhe da reunião); S (sessão ocupada);
  e DOC-0 (o próprio desenho). A numeração tem lacunas: a G1 virou G1a e G1b, da H1
  sobrou a H1r, a H2 e a G11 foram absorvidas pela D1, e a G12 saiu do plano. Valem só
  dentro desse plano e não são os ajustes A1 a A14 nem as decisões D1, D2… acima.

**Processo e operação**

- **Carimbo:** o registro da conferência (GitHub, Notion e grupo) que destrava commit,
  push e merge para o Claude (`.claude/hooks/carimbo.mjs`). Vale 6 h, ou até a `main` mudar.
- **Exame de produção:** `scripts/checar-producao.mjs`, rodado depois do deploy por quem tem
  o `.env.producao`. PULADO não quer dizer "passou".
- **"Feito (a validar)":** o status do cartão com a PR aberta e o CI verde, esperando a
  validação. "Concluído" só vem com a PR validada, na `main` e com o exame de produção sem
  falha. Com falha no exame, o cartão volta a "Em andamento". Tarefa sem código:
  "Concluído" quando já está em vigor e foi conferida por outra pessoa.
- **Validar:** outro LLM revisar a PR, o Claude de outra pessoa ou outro modelo (o Codex,
  por exemplo), nunca o que a fez; o que ele conferiu fica registrado na PR. Revisão
  humana só para mudança visual no app ou no site.
- **Render:** onde o site roda (deploy automático a cada merge na `main`).
- **Aiven:** o MySQL de produção.
- **B2 (Backblaze):** os arquivos (áudio, documentos, fotos).
- **Resend:** o envio de e-mail.
