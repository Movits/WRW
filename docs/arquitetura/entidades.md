# A base das associações: entidades, associados e convênio (DOC-4)

Desenho da base das associações (federações, associações, confederações e sindicatos que
mandam ao app os cadastros das empresas associadas), com as decisões do Roberto de 22/11/2026.
Vem da reunião de 11/11 (linhas R-37 a R-49 e R-58 da auditoria) e do rascunho de 16/11. A
primeira PR de código é a N1 (`feat/assoc-n1`), que já segue este desenho; as seções dizem o
que está no código e o que fica para a N2, a N3 e a N4b.

Nada aqui é parecer jurídico: o que depende do Dr. Ronei e da Cris está na seção 10.

## 1. Decisões tomadas

| # | Decisão | Quem, quando | Onde está |
|---|---|---|---|
| 1 | "Quem eu sou" é a ENTIDADE: uma conta por entidade, com a senha administrada pela associação | Roberto, 22/11 (era a decisão 9 do rascunho) | N1 |
| 2 | Cada associado tem um ID interno aleatório (`NW-7F29A4`), sem pedaço do CNPJ | Roberto, 22/11 | N1 |
| 3 | O painel da entidade lista os associados com código, nome e CNPJ, com busca | Roberto, 22/11 | N1 |
| 4 | Todos os associados entram DISPONÍVEIS para a rede por padrão | Roberto, 22/11 (era a decisão 5) | N1 (`entidades.disponivel_por_padrao`, padrão sim) |
| 5 | O que a entidade manda (o que tem e o que precisa) vira o perfil da empresa e entra no match | Roberto, 22/11 (era a decisão 4) | N1 |
| 6 | A entidade entrega uma base de dados (planilha), sem links; mas há um lugar para mandar o link de convite ao app | Roberto, 22/11 (era a decisão 8) | N1 |
| 7 | Moçambique (CTA) e ACDF podem chegar a qualquer momento depois de 28/11: o desenho serve a várias entidades e países | Roberto, 22/11 (era a decisão 10) | N1 (país e documento por entidade) |
| 8 | A oferta pela CNAE usa a tabela do IBGE, revisada; a CNAE só preenche o "o que tem", nunca vira necessidade | Roberto, 22/11 (era a decisão 11) | N1 guarda os códigos; a N4 faz as ofertas pela CNAE 2.3 (a versão vigente do IBGE), com o texto oficial; os termos simples revisados ficam para depois (seção 4) |

Decisões que seguiam abertas no rascunho e foram fechadas pelo caminho mais seguro, VETÁVEIS
pelo Roberto (cada uma diz o que muda se ele vetar):

- **V1. A entidade importa pelo próprio painel**, e não por um script que o Roberto roda (como
  dizia o rascunho). Motivo: a decisão 6 ("a entidade entrega uma base") e a decisão 1 (a
  conta é da entidade). A carga só roda com o convênio ATIVO, que só a equipe da WRW liga, e
  sempre em dois passos: o ensaio (nada é gravado) e depois a importação. Vetar: a equipe
  desliga o convênio até a hora da carga e a faz entrando na conta da entidade com ela.
- **V2. O nome da entidade NÃO aparece no match** ("membro da Associação X") até o convênio
  autorizar (`mostrar_nome_no_match`, desligado por padrão). A N1 só guarda a escolha; quem
  a mostra é a N2.
- **V3. O telefone e o e-mail da empresa ficam no app, cifrados**, e só a entidade os decifra,
  um associado por vez, com auditoria (era a decisão 6 do rascunho). Ninguém mais os vê na
  tela; o limite do acesso técnico está na seção 6.
- **V4. A necessidade sem data** (a planilha sem a coluna `data_da_declaracao`) entra com o
  dia da carga como data da declaração e um aviso no relatório. Vetar: a linha sem data
  passa a entrar sem o "o que precisa".
- **V5. O NUIT de Moçambique** é aceito com 9 dígitos, sem conferir o dígito de controle (o
  algoritmo não foi achado em fonte oficial). A CNAE vale só no Brasil.
- **V6. O convite ao app é UM link por entidade**, trocável e desligável, e não um link por
  associado. O link individual de uso único, que ativa o cadastro importado, é a N3.
- **V7. Reimportar a planilha substitui o "o que tem" e o "o que precisa"** do associado ainda
  não ativado (a planilha é a fonte); o associado que já ativou a conta não é tocado.

## 2. A entidade e o associado

A entidade é uma conta comum que a equipe transforma em entidade (aba Entidades do painel
administrativo, `entidades.admin.criar`). Isso grava, numa transação, a linha em `entidades`
e `users.isEntidade = true`, o PODER que abre o painel da entidade (`entidadeProcedure`,
no molde do distribuidor). Conta da equipe (admin, presidência, Ouro) não vira entidade.

Cada associado é um contato da rede da entidade (`private_contacts`, com `contact_assets`
e `contact_needs`) e herda do Meu Network Inteligente o código anônimo, o SIM da rede, o
cruzamento e o registro de conexões, com a entidade como dona. O que só a entidade vê fica
numa linha de `entidade_membros`.

| Tabela (migração `0030_pacote-associacoes`) | O que guarda |
|---|---|
| `entidades` | nome, tipo, país (decide o documento), a conta (`owner_id`, única), o convênio (estado, início, fim, referência), `mostrar_nome_no_match`, `disponivel_por_padrao`, o convite (hash para achar, cifrado para mostrar de novo) |
| `entidade_membros` (1:1 com o contato) | país e tipo do documento, `documento_hmac`, `documento_cifrado`, `contato_cifrado` (telefone e e-mail), CNAE principal e secundárias, referência na entidade, a origem e a data do "preciso", o lote, o estado (`importado`, `ativado`, `removido`) |
| `importacoes_de_entidade` | cada carga: SHA-256 do arquivo (o arquivo nunca chega ao servidor), modo (ensaio ou aplicar), contagens e as contagens por código de recusa e aviso |
| `importacao_documentos_vistos` | os HMACs já vistos numa carga em andamento, para recusar a linha repetida em outro bloco; apagados ao concluir |

Índices: `entidade_membros` (contato único; entidade + HMAC único; HMAC; entidade + estado;
dona); `importacoes_de_entidade` (entidade + início); a lista de vistos (carga + HMAC único).

O contato de entidade nunca vai a "ouro" nem a "publico", que expõem nome, cidade e cartão:
`network.create` e `network.update` recusam com `ENTIDADE_SO_PRIVADO`.

## 3. O ID interno e o documento

- **O ID é o código aleatório do Network Inteligente** (`server/network-codigo-anonimo.ts`),
  dado na carga. Nenhuma parte do CNPJ serve: a raiz (8 dígitos) é única, mas a base aberta
  da Receita diz de quem é; o resto (`0001` e verificadores) se repete. Com dezenas de
  milhares de contatos os 6 dígitos hexadecimais colidem de vez em quando: a carga troca os
  candidatos já usados antes do INSERT, e a corrida que sobrar refaz o bloco.
- **O documento é genérico (país + tipo):** o Brasil usa o CNPJ, inclusive o alfanumérico
  que a Receita passou a emitir em 2026 (IN RFB 2.229/2024: letras nas 12 primeiras posições,
  verificadores em módulo 11 com o valor ASCII − 48); Moçambique, o NUIT (V5). País novo
  entra em `DOCUMENTO_DO_PAIS` (`shared/entidades.ts`), com teste.
- **Dentro do banco, o documento nunca fica em claro:** HMAC-SHA256 com chave própria
  (`ENTIDADES_HMAC_KEY`) para achar o repetido (hash sem chave não protege uma lista pública)
  e AES-256-GCM com a `VAULT_ENCRYPTION_KEY` para a entidade vê-lo. As duas chaves são
  obrigatórias, com 32 caracteres ou mais, sem derivar do `JWT_SECRET`
  (`server/entidades-cofre.ts`); sem elas o app sobe e a função recusa com código.
- **CPF nunca entra** (pendência h): a coluna `cpf`, `senha` ou `data_de_nascimento` recusa o
  arquivo inteiro, e o número de 11 dígitos na coluna do CNPJ recusa a linha.

## 4. A CNAE só como "o que tem"

A CNAE é atividade, e atividade é oferta. Como necessidade seria inferência ("a padaria
precisa de farinha"), que a regra da demanda expressa proíbe nos três motores
(`server/CLAUDE.md`).

- **N1:** guarda os códigos (principal e secundárias, 7 dígitos) em `entidade_membros`, só a
  forma conferida. Nenhum item nasce da CNAE; o teste prova que ela não vira necessidade.
- **N4 (feito, `server/cnae.ts`):** a tabela da CNAE 2.3 por SUBCLASSE do IBGE (CONCLA), as
  1332, em `server/cnae/cnae-2-3.json` (código e texto oficial em frase comum, com a fonte e
  a data da consulta dentro), gerada por `scripts/cnae/gerar-tabela-cnae.mjs` a partir da API
  de Serviços de Dados do IBGE. Fica só no servidor: a tela confere a forma, o servidor confere
  se o código existe (aviso `CNAE_INEXISTENTE`, e o código sai).
  - Cada código válido vira item de `contact_assets` com `origem = 'cnae'` (coluna nova,
    migração 0030; o que a planilha escreveu leva `'entidade'`, o que a dona escreve fica
    nulo). `contact_needs` não tem a coluna: a CNAE não tem como entrar ali.
  - **O rótulo da oferta** é o texto oficial com dois cortes, ambos medidos contra o motor: a
    cláusula "exceto ..." sai ("Transporte rodoviário de carga, exceto produtos perigosos e
    mudanças" casava com quem procura "transporte de mudança", o que a subclasse exclui), e as
    105 subclasses residuais ("... não especificados anteriormente") não viram oferta (o
    código fica guardado). Sobram 1227 rótulos.
  - **Sem categoria:** "mesma categoria" vale 60 no motor privado; uma categoria por seção
    casaria cada necessidade com milhares de associados do mesmo ramo, que é setor, não
    necessidade.
  - **Teto:** as ofertas da CNAE entram depois do que a entidade escreveu, no mesmo teto de 20
    itens, sem repetir rótulo.
  - **Refazer (R-49):** `entidades.admin.refazerOfertasDaCnae` (equipe) troca só os itens
    `cnae` dos importados pelos códigos guardados, em blocos de 500 com auditoria
    (`ENTIDADE_OFERTAS_DA_CNAE_REFEITAS`); o ativado e o que a dona mudou à mão ficam.
  - **O que a N4 não fez (vetável):** os termos simples revisados ("Padaria e confeitaria" em
    vez de "Fabricação de produtos de panificação industrial"). O texto oficial casa pouco com
    o jeito de quem procura escrever: "Serviços advocatícios" casa com "Serviços advocatícios",
    mas não com "advogado". A IA (o Lite) poderia rascunhar os termos uma vez, para as 1227
    subclasses, e uma pessoa revisaria; só sob pedido do Roberto, com teto, e a N8 mede
    (estimativa da auditoria: ~US$ 15, uma vez, para 30 mil empresas, se reescrevesse por
    empresa; por subclasse sai bem menos). Revisada a tabela, o "refazer" aplica.
- O "preciso" só entra declarado: à entidade, com data (decisão 5 e V4), ou pela empresa no
  app depois de ativar a conta (N3).
- Segmento é a seção e a divisão da CNAE, tiradas do código (`segmentoDoCnae`, N4; para contar
  e filtrar, nunca para cruzar; ainda sem tela).

## 5. O convênio

| Estado | Efeito |
|---|---|
| `em_negociacao` (o padrão) | a entidade entra e vê a lista; não importa nem gera convite; os associados não cruzam |
| `ativo` (até o dia do `fim`, se houver) | importa, gera convite, os associados cruzam na rede |
| `encerrado` | como em negociação; nada é apagado |

O cruzamento global confere o convênio a cada leitura (`entidadesSemConvenio`, chamado por
`lerRedeGlobalAnonima`): encerrado, os associados saem da rede na leitura seguinte, sem
apagar nada. O termo do Smart Match da conta da entidade continua exigido, como para toda
dona. O que acontece com os dados no fim do convênio é a pendência e.

## 6. Quem vê o quê (regra de consulta)

| Quem | Vê | Nunca vê |
|---|---|---|
| Membra ou outra entidade, no cruzamento | o código e os itens que se encontraram (`lerRedeGlobalAnonima` lê de `private_contacts` só id, dona e código) | nome, documento, telefone, e-mail, UF, CNAE |
| A entidade | os próprios associados: código, nome, documento (decifrado na lista, com auditoria `ENTIDADE_MEMBROS_LISTADOS`), estado; o contato, um por vez, com `ENTIDADE_CONTATO_LIDO` | associados de outra entidade; o outro lado de um match antes do aceite (N2) |
| A equipe da WRW no app | as entidades, o convênio e as contagens por estado (`entidades.admin.listar`) | coluna pessoal de associado |
| O relatório de uma carga | os números de linha e os códigos | se a empresa já está em OUTRA entidade (cada entidade tem o seu registro; o relatório cala) |

- **R-47, o limite que precisa ser dito à Glenda:** o documento e os contatos estão cifrados e
  fora de toda tela, mas quem administra o servidor tem a chave. "O time não tem acesso" vale
  para o app, não para o acesso técnico.
- Excluir a conta da entidade apaga a entidade, os associados (contatos, itens, documento,
  contatos cifrados) e as cargas (`server/exclusao-de-conta.ts`); o exame de produção limpa as
  mesmas tabelas (`scripts/exame/limpeza.mjs`).

## 7. A importação

A planilha é lida NO APARELHO da entidade (`client/src/lib/ler-planilha.ts`): CSV (UTF-8 ou
Windows-1252, separador `;`, `,` ou tab) ou XLSX (primeira aba; o leitor é do próprio app,
sem biblioteca nova). O arquivo não sobe; vão as linhas já mapeadas e o SHA-256 dele.

- **Colunas** (cabeçalho por sinônimos, sem acento nem caixa): obrigatórias `cnpj` e `nome`;
  opcionais `cnae_principal`, `cnaes_secundarios`, `uf`, `telefone`, `email`,
  `referencia_da_entidade`, `o_que_tem` e `o_que_precisa` (itens separados por `;`) e
  `data_da_declaracao`. Coluna desconhecida é ignorada e não sai do aparelho.
- **Validação** (a mesma na tela e no servidor, `shared/entidades.ts`; o servidor não confia na
  tela): recusam a linha o documento ausente, inválido ou com cara de CPF e o nome ausente;
  avisam (e tiram só o pedaço) CNAE malformada ou que não existe na tabela do IBGE (N4), UF,
  telefone e e-mail inválidos, contato
  escrito no texto livre (mascarado), item que repete o nome da empresa (sai, para o
  cruzamento não identificá-la), mais de 20 itens por lado, data inválida, necessidade sem
  data e linha sem oferta, necessidade nem CNAE ("não conecta").
- **Repetidos:** no mesmo arquivo, a segunda linha é recusada com o número da primeira, mesmo
  em blocos diferentes. Na mesma entidade: `importado` é atualizado (V7), `ativado` não é
  tocado (aviso) e `removido` é recusado (lista de bloqueio só pelo HMAC, pendência e). Em
  outra entidade é outro registro, e o relatório cala.
- **Tirar um associado da base:** a entidade apaga o contato pela Rede (`network.delete`).
  `apagarRastroDoContato` leva o associado a `removido` e apaga o documento, o telefone e o
  e-mail cifrados, a CNAE, a referência e o link de ativação; fica só o HMAC do documento,
  que é a lista de bloqueio (a reimportação recusa com `MEMBRO_REMOVIDO`). O contato do
  associado só se lê com o contato vivo na rede da entidade. Desfazer a remoção ainda não
  tem caminho (pendência e).
- **Ensaio e aplicar:** o ensaio relata tudo sem gravar contato; a importação só libera na tela
  depois de um ensaio concluído do mesmo arquivo.

## 8. O volume de 30 mil

- **Carga:** blocos de 500 linhas, cada um uma chamada e uma TRANSAÇÃO (a carga trava a linha
  dela; o bloco fora de ordem ou repetido recusa com CONFLICT e a contagem não dobra). A tela
  mostra o progresso bloco a bloco. 30 mil linhas são 60 chamadas no ensaio e 60 na
  importação, dentro do limite de 300 pedidos por conta da API. Carga interrompida: escolher
  o arquivo de novo e importar outra vez; os já gravados são atualizados, não duplicados.
  Teto de 50 mil linhas por arquivo.
- **Painel:** 50 por página, busca pelo código, pelo documento inteiro (HMAC, índice) ou por
  parte do nome (LIKE parametrizado sobre os contatos da entidade).
- **Os motores, o que a N1 e a N4 NÃO resolvem (vai à N4b, que traz o índice invertido
  `chaves_de_cruzamento` e a fila):**
  1. A leitura global tem teto, sem ordem (`network-rede-global.ts`). Desde a revisão do
     pacote, a autorização (conta ativa, termo do Smart Match e convênio vigente) filtra no
     SQL, antes do teto, e os contatos das contas de entidade têm janela própria de 1000
     (`TETO_DE_CONTATOS_DE_ENTIDADES`): a entidade não tira mais da janela os contatos das
     outras donas, nem com o convênio encerrado. Mas, com 30 mil associados disponíveis
     (decisão 4), só 1000 seriam lidos. Por isso o servidor trava a base de cada entidade em
     1000 associados até a N4b (`ASSOCIADOS_MAX_ATE_N4B`; o aplicar recusa com
     `BASE_ACIMA_DO_TETO`, o ensaio lê o arquivo inteiro). **Não carregar base real antes da N4b.**
  2. O motor privado (`match-service.ts`) compara todos os "tenho" com todos os "preciso" da
     dona a cada item novo: na conta da entidade, isso é quadrático em 30 mil. A carga não o
     chama; mexer num contato pela Rede da entidade, sim.
  3. O painel do Meu Network Inteligente lê todos os contatos da dona sem teto
     (`network-inteligente.ts`); na conta da entidade, a lista própria do painel da entidade é
     o caminho.
  4. O motor de perfis já pagina todos os perfis por id (`matching.ts`, sem o antigo teto de
     50). O custo de escala é outro: cada regeneração percorre todas as contas, e as contas
     ativadas pela N3 passam a pesar nele.

## 9. O convite ao app

A entidade gera um link (`/convite-da-entidade/<token>`, 24 bytes aleatórios, guardado
como hash para achar e cifrado para mostrar de novo; `/convite/<token>` é o convite para uma
reunião, da R1b), copia o texto pronto ou o manda pelo WhatsApp ou por e-mail, abertos no
app dela. Trocar invalida o anterior na hora; desligar apaga. Quem abre vê
o nome da entidade e vai ao cadastro ou à entrada (`conviteDeEntidade.ver`, público, só com o
convênio vigente; token errado, trocado ou de convênio encerrado respondem igual). Ligar a
conta criada ao associado importado é a N3 (seção 9a).

## 9a. A ativação do cadastro importado (N3)

Linhas R-46 (o cadastro incompleto que a empresa completa ao entrar) e R-48 (a entidade
divulga o app com o link) da auditoria. Código em `server/entidades-ativacao.ts`, a mesma migração
`0030_pacote-associacoes` (só aditiva: as quatro colunas da ativação em `entidade_membros` e
dois índices).

- **O link é por associado, de uso único e com validade** (`/ativar/<token>`, 24 bytes
  aleatórios). Só o hash fica no banco (`ativacao_hash`, único), com o vencimento
  (`ativacao_expira_em`). Saber o CNPJ, que é público, não basta.
- **A entidade gera** no painel: o botão de cada empresa importada (gera, ou troca o que
  valia: o anterior para de abrir na hora) e "gerar os que faltam", que pede de 500 em 500
  os importados sem link valendo e monta a planilha (código, nome, referência na entidade,
  link e validade) NO APARELHO. O token só existe nessa resposta. Só com o convênio vigente;
  a auditoria `ENTIDADE_ATIVACAO_GERADA` vai na mesma transação.
- **Quem abre o link** (`ativacaoDeCadastro.ver`, público, com teto por rede) vê o nome da
  entidade, o da empresa e os itens que a entidade mandou; nunca o documento nem o contato.
  Link errado, vencido, usado, trocado, de associado removido ou de convênio encerrado
  respondem igual (`ATIVACAO_NAO_ENCONTRADA`).
- **Ativar** (`ativacaoDeCadastro.ativar`, com o teto do cadastro comum) cria a conta como
  qualquer cadastro (Bronze, cadastro por concluir) com o nome, o e-mail e a senha que a
  pessoa escolhe, e o perfil com o nome da empresa e SÓ os itens que ela deixou marcados
  (`itensConfirmados`: o texto idêntico ao importado; item novo entra depois, no cadastro).
  Numa transação, com o associado travado: o associado vira `ativado` (com a conta e a
  hora), o hash some (uso único; o segundo envio simultâneo cai em NOT_FOUND), o contato da
  entidade sai da rede global (a empresa agora cruza como membra, também fora da entidade,
  R-42) e a auditoria `ENTIDADE_CADASTRO_ATIVADO` vai junto. A cópia não volta: a entidade
  que tenta disponibilizá-la de novo recebe `ASSOCIADO_ATIVADO`, e a leitura global não lê
  contato de associado ativado. A sessão abre na hora e a tela
  segue para o cadastro, já preenchido, onde ficam o Termo Geral e a maioridade.
- **Excluir a conta ativada** anula `ativado_user_id`; o associado segue `ativado` na base da
  entidade (a reimportação não o recria).

Decisões fechadas pelo caminho mais seguro, VETÁVEIS pelo Roberto:

- **V16. O link vale 30 dias** (`VALIDADE_DA_ATIVACAO_MS`). Vetar: muda uma constante.
- **V17. O link individual aparece uma vez só**, ao gerar (só o hash fica guardado), ao
  contrário do convite da entidade, que fica cifrado para ser mostrado de novo. Perdeu: gera
  de novo, e o anterior para de abrir. Vetar: guardar também o cifrado, como o convite.
- **V18. O CNPJ não vai ao perfil** da conta nova: a pessoa o digita no cadastro, se quiser
  (o perfil tem regras de visibilidade próprias, e o documento só a entidade vê). Vetar:
  copiar o decifrado para `user_profiles.companyCnpj` na ativação.
- **V19. Só conta nova.** E-mail que já tem conta recusa (`ATIVACAO_EMAIL_JA_CADASTRADO`,
  sem gastar o link); ligar o associado a uma conta que já existe (entrar e confirmar) fica
  para depois.
- **V20. A WRW não manda o link por e-mail:** a entidade distribui pelo canal dela (R-48 e
  decisão 6). O contato cifrado do associado não é decifrado em lote para isso.
- **V21. A necessidade que a entidade declarou só entra no perfil se a pessoa a manter
  marcada**; desmarcada, não vai (vale como não declarada por ela).

Textos para a Cris: `entidade.ativacao.*` (o texto que a entidade manda à empresa) e
`ativarCadastro.*` (a página do link), nos 10 idiomas, de tradução nossa.

## 10. O papel de cada um na LGPD (para o Dr. Ronei) e os textos (para a Cris)

Leitura técnica do fluxo, para orientar as perguntas. Não é parecer.

- **A entidade** decide mandar a base dos associados e para quê: no desenho, ela é a
  controladora desses dados e a origem da cessão. **A WRW** guarda, cifra e cruza; para o
  armazenamento, age como operadora; no cruzamento com a rede inteira, decide os critérios
  do match e pode ser controladora (conjunta ou independente). O convênio precisa dizer qual.
- **Perguntas ao Dr. Ronei** (as pendências do rascunho):
  - a. o papel da entidade e o da WRW, a base legal da cessão e do cruzamento (legítimo
    interesse da entidade, execução do contrato associativo, consentimento?), e o que o
    convênio diz: finalidade, prazo, exclusão no fim e quem atende o titular;
  - b. o aviso aos associados ANTES da carga: quem avisa e com que texto (com a Cris);
  - c. MEI e empresário individual: o CNPJ e a razão social apontam para uma pessoa, e aí é
    dado pessoal (a N1 não distingue; a planilha pode trazer o nome da pessoa no nome);
  - d. a entidade pode registrar o "sim" do associado não ativado? Hoje a decisão 4 põe todos
    disponíveis pelo convênio;
  - e. a lista de bloqueio só com o HMAC (removido) e o prazo para apagar tudo no fim do
    convênio;
  - f. Moçambique: a LGPD vale para o tratamento feito no Brasil (art. 3º), e a exceção dos
    dados vindos de fora (art. 4º, IV) não vale quando são compartilhados com agente
    brasileiro; a lei de Moçambique não foi conferida;
  - g. o que prometer sobre "o time não ter acesso" (R-47, seção 6);
  - h. o CPF fora da carga (já recusado no código).
- **Textos para a Cris** (marcados no código; os 10 idiomas saíram de tradução nossa):
  o texto do convite que a entidade manda (`entidade.convite.texto` e `.assunto`), a página
  do convite (`conviteDaEntidade.*`), o aviso aos associados antes da carga (pendência b, sem
  texto ainda), o "membro da Associação X" e o aviso a quem pede contato (N2), e os textos da
  ativação (N3: `entidade.ativacao.*` e `ativarCadastro.*`, seção 9a).

## 11. Próximas PRs

1. **N8** `chore/rede-de-teste-com-armadilhas`: 30 mil empresas sintéticas com CNAE, só no
   banco local, para medir.
2. **N4** `feat/cnae-como-oferta`: a tabela da CNAE do IBGE e as ofertas com origem
   "cnae" (seção 4). **N4b** `feat/indice-de-cruzamento`: o índice invertido e a fila; troca
   o teto de 1000 da leitura global pelo índice. **Antes da primeira carga real.**
3. **N2** `feat/assoc-n2`: o pedido de contato pela entidade. Feita: seção 12. Os textos
   seguem marcados para a Cris, e as pendências a, d e g seguem com o Dr. Ronei.
4. ~~`fix/motor-de-perfis-sem-teto-de-50`~~: já estava feito na `main` (seção 8). A **N3** (`feat/assoc-n3`, a ativação do cadastro
   importado) já está desenhada e feita: seção 9a.

**A primeira carga real é operação, não PR:** depois da N4b, com o convênio assinado e as
pendências a, b e e respondidas. Ensaio, leitura do relatório, e só então a importação.

## 12. O pedido de contato pela entidade (N2)

Linhas N2, R-41 e R-47 da auditoria. A tabela `pedidos_pela_entidade` entra na mesma
migração `0030_pacote-associacoes`, só aditiva.

**O que quem está do outro lado vê.** Numa conexão da rede global (`NETWORK_NETWORK_MATCH`
ou `NETWORK_PLATFORM_MATCH`) cujo outro lado é associado de uma entidade, o cartão mostra,
além do código e dos itens que já mostrava, "membro da entidade X" (com
`mostrar_nome_no_match`) ou "membro de uma entidade parceira", e o botão "Pedir contato
pela entidade". A anotação é uma leitura à parte (`anotarConexoesComEntidade`, em
`server/pedidos-pela-entidade.ts`), feita em `networkInteligente.conexoes` e
`networkInteligente.contato`: lê de `entidade_membros` e `entidades` só ids, estado, o
nome da entidade e o convênio. Nome, documento, telefone e e-mail da empresa não são lidos.
Associado de entidade sem convênio vigente sai como a autorização retirada: sem os itens
e sem o pedido.

**O pedido.** Quem pede vê antes que o nome dela e o da empresa do perfil dela vão à
entidade e marca a ciência (`cienteDoNome: true`, exigido pelo servidor); a mensagem é
opcional (500 caracteres, telefone e e-mail escondidos). Tudo o que não serve (conexão
alheia, outro lado que não é associado, convênio encerrado, autorização retirada, a
própria entidade) responde igual: NOT_FOUND `PEDIDO_INDISPONIVEL`.

| Estado | Quem muda | Para |
|---|---|---|
| `na_entidade` | a entidade: "Levei à empresa" ou "Não encaminhar" | `encaminhado` (o prazo recomeça) ou `nao_encaminhado` |
| `encaminhado` | a entidade: "A empresa aceitou" (com o canal) ou "recusou" | `aceito` ou `recusado` |
| aberto e vencido | ninguém: vale como `expirado` (a leitura da entidade grava) | quem pediu pode pedir de novo |

Cada passo é um UPDATE com o estado anterior e o prazo no WHERE, na transação que trava a
linha e grava a auditoria (`ENTIDADE_PEDIDO_CRIADO`, `_ENCAMINHAR`, `_NAO_ENCAMINHAR`,
`_ACEITAR`, `_RECUSAR`, `ENTIDADE_PEDIDOS_LISTADOS`). No aceito, a entidade escolhe o
canal que a empresa quer (telefone, e-mail ou os dois) entre os que mandou na planilha:
o servidor decifra para conferir que existe, sem devolver. Quem pediu toca em "Ver o
contato" e recebe o nome da empresa e só o canal escolhido, decifrados na hora, com
`ENTIDADE_PEDIDO_CONTATO_REVELADO` na mesma transação (`networkInteligente.contatoPeloPedido`).

**R-47.** O telefone e o e-mail continuam cifrados e fora de toda tela e consulta: só a
entidade os lê (N1) e, no aceito, quem pediu, um pedido por vez. O limite do acesso
técnico da seção 6 continua valendo.

**Exclusão.** Excluir a conta de quem pediu apaga os pedidos dela (`userId`); a da entidade,
os que ela recebeu (`owner_id`). O exame de produção limpa as duas colunas.

Decisões fechadas pelo caminho mais seguro, VETÁVEIS pelo Roberto:

- **V8. Prazo de 30 dias** para a entidade responder, renovado quando ela encaminha à
  empresa. Vencido, quem pediu pode pedir de novo (a mesma linha volta a `na_entidade`).
- **V9. A recusa e o "não encaminhado" são resposta:** não se pede de novo a mesma conexão.
- **V10. Teto de 10 pedidos novos por conta em 24 horas**, contado no banco.
- **V11. O canal do aceito sai do que a entidade mandou na planilha;** a entidade não digita
  outro. Sem telefone nem e-mail na carga, não há aceito pelo app (a entidade recusa, ou a
  empresa procura quem pediu por fora).
- **V12. Com o convênio encerrado,** a entidade não decide e quem pediu não vê mais o contato
  aceito (nada é decifrado sem convênio vigente). Os pedidos ficam.
- **V13. O pedido passa só pela entidade:** ela vê o nome de quem pede e a empresa do
  perfil, nunca o contato dela;
  o distribuidor da WRW não entra (era a decisão 7 do rascunho; a equipe vê os pedidos
  pela auditoria).
- **V14. Sem aviso no sino** nesta PR: a entidade vê os pedidos abertos no painel, e quem
  pediu, no cartão da conexão. O aviso traduzido no sino fica para depois.
- **V15. Associado que ativou a conta (N3)** não recebe pedido pela entidade: decide sozinho,
  como membra. Até a N3, nenhum associado ativa.

Textos para a Cris: `pedidoPelaEntidade.*` (o aviso a quem pede e o "membro da entidade X")
e `entidade.pedidos.*`, nos 10 idiomas, de tradução nossa.
