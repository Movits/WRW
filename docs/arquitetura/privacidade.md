# Privacidade e níveis de acesso

Cobre as etapas 8, 10 e 11 do escopo, e o ajuste A13.

## Regra geral

A tela nunca é a última linha de defesa. Se o servidor devolve um dado e o
front-end apenas não o desenha, o dado está exposto: qualquer pessoa vê abrindo as
ferramentas do navegador. Toda regra de privacidade descrita aqui precisa existir no
banco e na consulta, não no componente de tela.

---

## Os três níveis

O escopo (etapas 8 e 10) define:

| Nível | Quem vê | O que vê |
|---|---|---|
| **Privado** | só o dono | tudo |
| **Ouro** | dono + Usuários Ouro autorizados | tudo que o dono liberou, incluindo dados pessoais |
| **Público no ecossistema** | todos os membros da WRW | só as oportunidades, nunca os dados pessoais do contato |

O padrão de um contato novo é **privado**. Nada vira público por omissão.

Duas definições de produto seguem em aberto e mudam as políticas abaixo (ver
decisoes-em-aberto.md): se a autorização Ouro vale para o programa como um todo ou
por pessoa, e se os níveis são cumulativos (um contato `publico` também visível ao
Ouro autorizado).

### O nível público é uma consulta diferente

O escopo é explícito:

> nesta hipótese não pode aparecer os dados pessoais do contato, só as oportunidades.

Não basta filtrar linhas; é preciso não selecionar as colunas:

```sql
-- Projeção pública: as colunas pessoais nem são lidas.
CREATE VIEW oportunidade_publica AS
SELECT
  c.id            AS contato_ref,
  c.pais,
  c.cidade,
  ti.nome         AS item,          -- o que possui ou procura
  ca.direcao                        -- distingue oferta de demanda
FROM contato c
JOIN contato_atributo ca ON ca.contato_id = c.id
JOIN taxonomia_item   ti ON ti.id = ca.item_id
WHERE c.nivel_visibilidade = 'publico';
-- nome, empresa, cargo, telefone, whatsapp, email, linkedin, instagram,
-- foto e cartão de visita NÃO aparecem nesta view.
```

Duas notas sobre esta view:

- **O mecanismo que a faz funcionar precisa ser fixado, não presumido.** Uma view
  roda, por padrão, com as permissões do dono dela; é por isso que ela enxerga
  linhas que o RLS esconderia da role da aplicação. Esse comportamento muda se
  alguém criar a view com `security_invoker = true` (Postgres 15+) ou aplicar
  `FORCE ROW LEVEL SECURITY` na tabela: o nível público passaria a voltar vazio em
  silêncio. O desenho correto: dono da view = dono das tabelas, `REVOKE ALL ON
  contato` para a role da aplicação, `GRANT SELECT` só na view.
- `contato_ref` é a chave real do contato, estável entre respostas e, portanto,
  correlacionável. Aceitável para o MVP; numa versão futura, trocar por um token
  por exibição.

---

## Roles de conexão

RLS só funciona se a aplicação não conectar como dona das tabelas: o dono ignora
RLS, a menos que a tabela tenha `FORCE ROW LEVEL SECURITY`. Um setup que conecta
com o mesmo usuário que rodou o DDL anula todas as políticas em silêncio.

Três roles:

| Role | Uso | Permissões |
|---|---|---|
| `mmm_owner` | migrations, dona das tabelas e views | tudo |
| `mmm_app` | a aplicação | `GRANT` mínimos por tabela; sem ownership; **sem** `INSERT` em `match` |
| `mmm_match` | o motor de Match | leitura ampla de `contato_atributo` e escrita em `match`; só o job usa |

A identidade do usuário chega ao banco por variável de sessão, definida **por
transação** (obrigatório por causa de pool de conexões):

```sql
-- na aplicação, a cada transação:
SET LOCAL app.usuario_id = '<uuid do usuário autenticado>';

-- a função usada pelas políticas:
CREATE FUNCTION current_usuario_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.usuario_id', true)::uuid $$;
```

## Regras de linha no banco

Mesmo que a aplicação tenha um bug e esqueça um `WHERE`, o banco não devolve o que
não pode.

```sql
ALTER TABLE contato ENABLE ROW LEVEL SECURITY;

-- O dono vê e edita os seus.
CREATE POLICY contato_dono ON contato
  FOR ALL
  USING (dono_usuario_id = current_usuario_id());

-- Usuário Ouro vê os contatos marcados 'ouro' (ou 'publico', se ficar decidido
-- que os níveis são cumulativos) de quem autorizou o acesso Ouro.
CREATE POLICY contato_ouro ON contato
  FOR SELECT
  USING (
    nivel_visibilidade = 'ouro'   -- pendente D: IN ('ouro','publico') se cumulativo
    AND EXISTS (
      SELECT 1 FROM usuario_papel up
      WHERE up.usuario_id = current_usuario_id()
        AND up.papel = 'ouro'
        AND up.revogado_em IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM autorizacao_ouro ao
      WHERE ao.usuario_id = contato.dono_usuario_id
        AND ao.revogada_em IS NULL
    )
  );

-- Compartilhamento pontual.
CREATE POLICY contato_compartilhado ON contato
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM compartilhamento cp
      WHERE cp.contato_id = contato.id
        AND cp.usuario_id = current_usuario_id()
        AND cp.revogado_em IS NULL
    )
  );
```

O nível público não ganha política em `contato`, de propósito: ele é servido pela
view `oportunidade_publica`, que não expõe as colunas pessoais.

### Cobertura do RLS no MVP

Políticas nas tabelas com dono direto: `contato`, `contato_atributo` (herda o dono
via join com `contato`), `contexto`, `reuniao`, `reuniao_transcricao` e
`reuniao_extracao` (herdam via `reuniao`; a transcrição carrega fala de terceiros e
é o dado mais sensível do sistema). `match` e `oportunidade` têm políticas próprias:
as partes veem as suas, o corretor designado vê as dele. O motor de Match roda com a
role `mmm_match`, fora do RLS de usuário, porque precisa enxergar os dois lados do
cruzamento.

### Autorização Ouro e compartilhamento

```sql
-- id surrogate: revogar e conceder de novo gera linha nova, preservando o
-- histórico. O índice parcial impede duas concessões ativas.
CREATE TABLE autorizacao_ouro (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    uuid NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  concedida_em  timestamptz NOT NULL DEFAULT now(),
  revogada_em   timestamptz
);
CREATE UNIQUE INDEX autorizacao_ouro_ativa
  ON autorizacao_ouro (usuario_id) WHERE revogada_em IS NULL;

CREATE TABLE compartilhamento (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contato_id     uuid NOT NULL REFERENCES contato(id) ON DELETE CASCADE,
  usuario_id     uuid NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  concedido_em   timestamptz NOT NULL DEFAULT now(),
  revogado_em    timestamptz
);
CREATE UNIQUE INDEX compartilhamento_ativo
  ON compartilhamento (contato_id, usuario_id) WHERE revogado_em IS NULL;
```

Se ficar decidido que a autorização Ouro é por pessoa (e não para o programa como
um todo), `autorizacao_ouro` ganha uma coluna `ouro_usuario_id` e a política
`contato_ouro` passa a exigir `ao.ouro_usuario_id = current_usuario_id()`.

Revogar é preencher a data, nunca apagar a linha: o histórico precisa mostrar que
houve autorização no período em que os dados foram usados.

---

## A consulta de Match integrada

A consulta didática de modelo-de-dados.md, agora com os dois filtros que faltavam:
consentimento vigente dos dois donos (etapa 11) e visibilidade (etapa 10). Roda sob
a role `mmm_match`.

```sql
SELECT
  cp.contato_id AS contato_possui,
  cs.contato_id AS contato_procura,
  ti.nome       AS casou_em
FROM contato_atributo cp
JOIN contato cop ON cop.id = cp.contato_id
JOIN contato_atributo cs
  ON  cs.item_id  = cp.item_id
  AND cs.direcao  = 'procura'
  AND cp.direcao  = 'possui'
  AND cs.contato_id <> cp.contato_id
JOIN contato cos ON cos.id = cs.contato_id
JOIN taxonomia_item ti ON ti.id = cp.item_id
WHERE cp.item_id IS NOT NULL
  -- só participa quem não está no nível privado
  AND cop.nivel_visibilidade IN ('ouro','publico')
  AND cos.nivel_visibilidade IN ('ouro','publico')
  -- consentimento vigente do dono de cada lado
  AND EXISTS (
    SELECT 1
    FROM consentimento cons
    JOIN documento_versao dv ON dv.id = cons.documento_versao_id
    WHERE cons.usuario_id = cop.dono_usuario_id
      AND dv.tipo = 'termo_smart_match' AND dv.vigente
      AND cons.revogado_em IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM consentimento cons
    JOIN documento_versao dv ON dv.id = cons.documento_versao_id
    WHERE cons.usuario_id = cos.dono_usuario_id
      AND dv.tipo = 'termo_smart_match' AND dv.vigente
      AND cons.revogado_em IS NULL
  );
```

Recusar o Smart Match não pode impedir o uso do resto do app: desliga o cruzamento,
e só. Revogar tem efeito imediato porque a condição é avaliada na consulta:
preencher `revogado_em` tira o contato do cruzamento na consulta seguinte, sem
rotina de limpeza. A exigência de `dv.vigente` deixa explícita uma decisão em
aberto: quando sai uma versão nova do termo, o consentimento dado na antiga vale ou
precisa ser recolhido de novo? (ver decisoes-em-aberto.md).

---

## Acesso após o aceite (etapa 13 e ajuste A13)

O escopo: o acesso às informações completas da oportunidade ocorre somente após a
aceitação do acordo eletrônico. "Somente após" precisa valer no servidor.

A política correlaciona o contato com a oportunidade específica e exige o aceite de
**todas** as partes (portão bilateral):

```sql
-- Libera o contato da outra parte de uma oportunidade, somente quando
-- o usuário atual é parte dela E todas as partes já aceitaram o acordo.
CREATE POLICY oportunidade_dados_completos ON contato
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM oportunidade o
      JOIN match m  ON m.id = o.match_id
      JOIN contato_atributo cap ON cap.id IN (m.atributo_possui_id, m.atributo_procura_id)
      JOIN oportunidade_parte eu
        ON eu.oportunidade_id = o.id
       AND eu.usuario_id = current_usuario_id()
       AND eu.aceito_em IS NOT NULL
      WHERE cap.contato_id = contato.id          -- este contato é parte DESTA oportunidade
        AND NOT EXISTS (                          -- e ninguém está sem aceitar
          SELECT 1 FROM oportunidade_parte p
          WHERE p.oportunidade_id = o.id AND p.aceito_em IS NULL
        )
    )
  );
```

Sem a correlação com `contato.id`, um único aceite liberaria a tabela inteira:
políticas permissivas se combinam por OR, então qualquer política frouxa vira a
porta de entrada.

Limite do bloqueio: nenhuma trava técnica impede duas pessoas determinadas de
trocarem contato por fora. O que o bloqueio faz é tornar o caminho oficial o mais
fácil e gerar o registro que sustenta a cláusula de non-circumvention da etapa 13.
Por isso a decisão técnica (D3) e a redação jurídica precisam sair da mesma
conversa.

---

## O portão da revelação mútua (match de perfis)

Decisão da cliente, 12/09/2026: no cruzamento de perfis o nome de uma membra não
aparece para outra antes do **interesse mútuo**. Vale para o nome e para a
inicial do avatar — a letra sozinha já estreita demais quem pode ser.

Como a regra é de consulta e não de tela, ela vive em dois lugares e em nenhum
componente:

- `getMatchesForUser` (`server/db.ts`) **não seleciona** `displayName`,
  `avatarUrl`, `bio`, `users.name`, `users.company`, `users.position`,
  `currentRole`, `currentCompany`. O nome só existe na consulta atrás de um
  `CASE WHEN connections.status = 'accepted'`.
- `getConnectionsForUser` usa o **mesmo predicado**. Enquanto está `pending`, as
  duas pontas recebem a mesma projeção anônima — quem pede não se expõe sozinha,
  e quem recebe decide pelo perfil, não por quem a pessoa é.

A simetria não depende de disciplina de quem escreve o código: é uma linha e uma
coluna `status`, lida pelo mesmo predicado dos dois lados. Não existe estado
"revelado para A e não para B".

O `matchedUserId` também não atravessa para o navegador. Ele serve às travas do
servidor (consentimento, demanda expressa, contagem de rede aguardando) e é
recortado no router. O motivo é concreto: **toda conta Ouro tem o painel
administrativo**, que lista usuárias por nome — id real na mão de uma Ouro é
deanonimização de um salto. A tela age pelo `matchId`, que é id de linha de
match, não de pessoa.

O bilhete de texto livre saiu do pedido de conexão: o detector A13 barra telefone
e e-mail, não **nome**, e uma linha de texto atravessaria o portão inteiro.

A revelação entra em `audit_logs` como `MATCH_IDENTITY_REVEALED`, duas linhas —
uma por parte —, pelo mesmo motivo do `GOLD_ACERVO_READ`: "quem passou a saber
quem eu sou?" precisa ter resposta.

**Limite conhecido**: revelação não se revoga. Aceitou, viu. Vale a mesma
ressalva da seção anterior sobre o que o aceite não desfaz.

## O passo do distribuidor (match de perfis)

Pedido do Nicolas, 13/09/2026: entre o clique em "Demonstrar Interesse" e a entrega
do pedido à outra pessoa entra o **distribuidor**, uma pessoa real que confere se o
match é compatível e apto. O poder mora em `users.isDistributor` e acumula com
qualquer nível; quem concede é Ouro, presidente ou admin (`distribuicao.conceder`).

O que muda na privacidade, em três frases:

- **A destinatária não sabe que foi pedida enquanto o pedido está em análise, nem
  se ele não for encaminhado.** As linhas `in_review` e `not_forwarded` com
  `recipientId = ela` e `reciprocatedAt IS NULL` não entram no join de
  `getMatchesForUser` nem no WHERE de `getConnectionsForUser` (`pedidoVisivelPara`,
  em `server/db.ts`). Para ela não existe pedido — o cartão continua em "Demonstrar
  Interesse". Regra de consulta, não de tela: não há estado nulo a esconder no
  componente.
- **O distribuidor lê os dois perfis com nome.** É a segunda leitura nominal que
  atravessa donas (a primeira é o acervo Ouro), e por isso `distribuicao.fila` e
  `distribuicao.historico` gravam `DISTRIBUTOR_VIEW_QUEUE` em `audit_logs`. O que a
  fila nunca traz: `userId` das partes, e-mail, telefone, cofre, LinkedIn, site, foto.
  A bio sai mascarada por `mascararContatosEmTexto`. Quem é parte do pedido não o vê
  na fila nem decide sobre ele.
- **A resposta de `connections.send` continua idêntica** em todos os desfechos
  (novo, em análise, repetido, recusado, não encaminhado): sem oráculo. A recusa do
  distribuidor chega à solicitante como "não encaminhado", sem o motivo; a nota é
  interna (`connections.moderationNote`).

Interesse recíproco durante a análise (`reciprocatedAt`): o pedido passa a ser das
duas, as duas veem "em análise", e a aprovação vira `accepted` de uma vez, com as
duas linhas de `MATCH_IDENTITY_REVEALED` (`via: "distribuidor"`).

**Limite conhecido**: o termo do Smart Match não diz, hoje, que uma pessoa lê os
dois perfis antes da entrega. Registrado em decisoes-em-aberto.md (D7).

## Checklist antes de qualquer publicação

- [ ] A aplicação conecta com `mmm_app`, nunca com a dona das tabelas
- [ ] Contato novo nasce privado
- [ ] Duas contas de teste: A não vê nada de B em nenhuma tela
- [ ] A busca em linguagem natural (etapas 6 e 9) respeita as mesmas regras
- [ ] O Match não cruza dado de quem não consentiu
- [ ] No nível público, nenhuma resposta do servidor contém nome, telefone, e-mail,
      WhatsApp, LinkedIn, Instagram, foto ou cartão de visita de contato
- [ ] No cruzamento de PERFIS, nenhuma resposta do servidor traz nome, nome civil,
      empresa, cargo, foto ou bio de uma membra antes do interesse mútuo
- [ ] E nenhuma traz o `userId` real de uma contraparte ainda não revelada
- [ ] A destinatária de um pedido em análise (ou não encaminhado) não recebe a linha
      em nenhuma consulta; a fila do distribuidor não traz id, e-mail, telefone nem
      cofre das partes
- [ ] Revogar autorização tira o acesso na consulta seguinte
- [ ] Áudio de reunião e cartões de visita ficam em storage cifrado, com URL
      temporária, não em link público permanente (exceção desde 12/11/2026: a reunião
      que a dona compartilha por link aberto, enquanto o link estiver ligado; ver
      decisoes-tomadas.md)
