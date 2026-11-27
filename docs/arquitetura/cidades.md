# País, estado e cidade

Como a usuária escreve a cidade dela, em qualquer país e em qualquer idioma, e o
que o site grava por causa disso.

## O que mudou, e por quê

Antes: o campo de cidade do cadastro sugeria município brasileiro num
`<datalist>`, e só quando o país escolhido era o Brasil — quem marcava outro país
digitava no escuro e o silêncio parecia defeito. O perfil não sugeria nada, nem no
Brasil. E o campo do cadastro aplicava `v.replace(/\s\([A-Z]{2}\)$/, "")` a **cada
tecla**, para tirar a UF que a própria lista mostrava: além de impedir que se
soubesse se a pessoa escolheu da lista ou digitou, isso comia um "(SP)" que ela
tivesse escrito de propósito.

Agora: uma **cascata**, como os apps fazem (decisão do Roberto de 26/11, no lugar
do campo único de cidade da #142). Um componente só
(`client/src/components/PaisEstadoCidade.tsx`), usado pelo cadastro e pelo perfil:

1. **País**: combobox com busca nos 250 países, com o nome no idioma da tela
   (`Intl.DisplayNames`); acha também pelo nome em inglês e pelo código.
2. **Estado / província**: só quando o país tem divisões e mais de 40 cidades na
   lista (`MINIMO_DE_CIDADES_PARA_PEDIR_ESTADO` em
   `client/src/lib/cascata-de-local.ts`). Mônaco, Malta ou Catar vão direto à
   cidade. No Brasil são as 27 UFs pelo nome ("São Paulo", "Bahia").
3. **Cidade**: só as cidades daquele estado, com busca sem acento e em qualquer
   um dos 10 idiomas; o campo vazio já mostra as primeiras do estado.

Trocar o país limpa o estado e a cidade; trocar o estado limpa a cidade. Digitar
livre na cidade continua valendo, sempre: quem mora em distrito ou vila fora da
lista digita o nome e segue. País sem lista (Antártida, alguns territórios) vai
direto a uma cidade em texto livre.

**O que está versionado hoje:** 230 países e 70.221 cidades — os 5.571 municípios
do IBGE no Brasil, mais 64.650 cidades com população ≥ 5.000 do GeoNames nos
outros 229 países. São 3,8 MB de JSON no repositório, mas **o navegador baixa um
país por vez**
(o `import.meta.glob` do Vite gera um pedaço com hash por arquivo): o maior é o
`US.json`, com 512 KB crus e 196 KB no gzip que o servidor envia; o `BR.json`
pesa 201 KB crus e 52 KB no gzip; a mediana dos países fica em 4 KB.

## As peças

| Arquivo                                   | Papel                                                              |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `scripts/gerar-cidades.mjs`               | Comando manual que escreve as listas. Não roda no CI.              |
| `scripts/cidades/montagem.mjs`            | Regras puras de montagem (chave, filtros, ordem). Testado sem I/O. |
| `client/src/data/cidades/<CC>.json`       | Uma lista por país, versionada no repositório.                     |
| `shared/normalizar-cidade.ts`             | A normalização que as duas pontas usam.                            |
| `shared/cidade.ts`                        | Formato do arquivo e das sugestões.                                |
| `client/src/lib/busca-de-cidades.ts`      | Carrega o país e decide o que casa.                                |
| `client/src/lib/cascata-de-local.ts`      | A regra da cascata: quando pedir estado, recorte, dedução.         |
| `client/src/components/CampoComBusca.tsx` | O combobox acessível de cada nível.                                |
| `client/src/components/PaisEstadoCidade.tsx` | Os três níveis juntos, no cadastro e no perfil.                 |
| `shared/paises.ts`, `shared/paises-gerados.ts` | Os 250 países e o nome no idioma da tela.                    |

## O truque: a chave de busca

Cada cidade é uma tupla de três campos — `[nome, admin, chave]`. A `chave` é o
nome canônico e os apelidos em outros idiomas, **já normalizados** e separados por
`|`:

```json
["Köln", "05", "koln|cologne|colonia|кельн|ケルン"]
```

O navegador normaliza o que a usuária digita com a **mesma** função e compara
contra essa chave. É só isso: acento, caixa e idioma deixam de importar sem
nenhuma tabela de exceção escrita à mão, e "Munich", "München", "Munique" e
"ミュンヘン" chegam todos à mesma cidade.

### Os dois jeitos de digitar a pontuação

A normalização troca hífen, apóstrofo e ponto por **espaço**, e nunca os remove.
Sozinha, ela cobre só metade de como as pessoas escrevem: quem digita
"Sant'Ana", "Sant Ana" ou "Sant-Ana" acha, e quem digita **"Santana"** — que é
como se fala — não achava nada. O mesmo valia para "xiquexique" e "embuguacu".

Por isso cada nome entra na chave nas **duas** formas
(`formasDeDigitar`, em `scripts/cidades/montagem.mjs`): a pontuação virada em
espaço e a pontuação apagada.

```json
["Sant'Ana do Livramento", "RS", "sant ana do livramento|santana do livramento"]
["Xique-Xique",            "BA", "xique xique|xiquexique"]
["Embu-Guaçu",             "SP", "embu guacu|embuguacu"]
```

As duas continuam sendo texto que o navegador reproduz a partir do que foi
digitado — nenhuma regra nova na busca, só mais um trecho na chave. Nome sem
pontuação, que é a imensa maioria, continua com um trecho só. O que vai para o
banco não muda: é sempre o nome oficial, com a pontuação.

O teto de 12 apelidos conta **nomes**, não trechos: a segunda forma é o mesmo
nome escrito de outro jeito e não ocupa a vaga de um idioma.

A ordem do resultado, do melhor acerto para o pior: o nome canônico começa com o
texto → algum apelido começa com o texto → a chave contém o texto em qualquer
posição. Dentro de cada grupo vale a ordem do arquivo, que o gerador já deixou
por população decrescente (ou alfabética, no Brasil, onde a fonte não tem
população). No máximo 50 sugestões.

### Três armadilhas de Unicode que o teste já pegou

- **`ё` russo é `е` + trema.** "Кёльн" normaliza para "кельн", e a consulta
  "кёльн" também — é por isso que casa. Quem escrever a chave à mão erra.
- **`ド` japonês se decompõe** em `ト` + dakuten, e essa marca **não** está na
  faixa dos diacríticos latinos. Por isso a normalização recompõe com `NFC` no
  fim: sem isso o arquivo gerado guardaria texto em pedaços.
- **`Ħ` maltês não é `ħ`.** A tabela de letras que o NFD não decompõe repetia
  cada letra nas duas caixas (`ø` e `Ø`, `æ` e `Æ`...) e esquecia três: `Ħ`, `Ŋ`
  e `Ŧ` só estavam em minúscula. O `Ħ` de **Ħamrun** (Malta) escapava da tabela,
  virava `ħ` no `toLowerCase()` seguinte e ficava na chave gravada — que assim
  deixava de ser idempotente e de bater com o que o navegador calcula: quem
  digitasse "hamrun" não achava a cidade, **sem erro nenhum na tela**. Isso só
  apareceu quando o mundo inteiro foi gerado (o Brasil não tem essas letras), e
  foi o teste do conjunto que pegou. Hoje a tabela é consultada com a letra já
  em minúscula, e um teste de **idempotência** ("normalizar de novo não muda
  mais nada") guarda a regra para a próxima letra.

`server/cidades-geradas.test.ts` recalcula a chave de **todas as 70.221 cidades**
dos 230 arquivos versionados e compara com a que está lá; e roda a busca de
verdade sobre os arquivos de verdade ("Munich", "München", "Munique" e
"ミュンヘン" chegam à mesma cidade da Baviera; "Londres" e "London" à mesma
cidade inglesa; "santana do livramento" a Sant'Ana do Livramento). É o que impede
um arquivo gerado por versão antiga do script, ou editado à mão, de quebrar a
busca em silêncio.

## A cópia da normalização, e o teste que a segura

`shared/normalizar-cidade.ts` (TypeScript, usado pelo navegador) e
`scripts/cidades/montagem.mjs` (JavaScript, usado pelo gerador) têm a **mesma**
função escrita duas vezes. Não é descuido:

- o gerador é `.mjs`, como os outros scripts do repositório, e o CI roda
  `node --check` neles; `.mjs` não importa `.ts` sem `tsx`;
- se as duas divergirem, a chave gravada deixa de bater com a consulta e a busca
  para de achar cidade **sem erro nenhum** — nada quebra de forma visível.

`server/cidades-montagem.test.ts` importa as duas e prova, numa tabela de casos,
que continuam idênticas. **Mudou uma, muda a outra.**

## Gerar as listas

```bash
# Brasil, a partir do arquivo que já está no repositório. Não baixa nada.
node scripts/gerar-cidades.mjs --ibge

# Resto do mundo, a partir do dump do GeoNames já baixado e descompactado.
# "Resto" ao pé da letra: a rodada mundial PULA o Brasil (ver abaixo).
node scripts/gerar-cidades.mjs --entrada ~/geonames
node scripts/gerar-cidades.mjs --entrada ~/geonames --paises DE,GB,PT --minimo 15000
node scripts/gerar-cidades.mjs --entrada ~/geonames --simular   # só relata o peso
```

A rodada mundial leva cerca de 30 s (a maior parte é atravessar os 748 MB do
`alternateNamesV2.txt`, lido linha a linha, nunca inteiro na memória) e escreve
229 arquivos. O corte de população é o padrão, **5.000 habitantes**: com ele o
conjunto fica em 3,8 MB, e não houve motivo para subir o corte — `--minimo`
existe para quando houver. O que o corte custa é cidade pequena, não país:
**todos os 16 países do seletor do cadastro** têm lista, e os 229 cobrem
praticamente todo país com cidade de 5.000 habitantes.

Para o resto do mundo, baixe e descompacte antes, na mesma pasta:

- <https://download.geonames.org/export/dump/cities5000.zip> (5,4 MB)
- <https://download.geonames.org/export/dump/alternateNamesV2.zip> (195 MB)
- <https://download.geonames.org/export/dump/admin1CodesASCII.txt> (148 KB)

O script não baixa sozinho porque os arquivos são `.zip` (o Node não lê zip sem
dependência nova) e um deles tem 195 MB. O resultado é estável por meses e fica
versionado no repositório, como a lista do IBGE já ficava — baixar 200 MB por PR
no CI seria desperdício.

### Rodar de novo dá o mesmo arquivo

O cabeçalho guarda a **origem** do dado (`fonte`, `fonteUrl`) e **nenhuma data**.
Havia um campo `gerado` com a data de hoje: com ele, rodar o gerador duas vezes
sobre a mesma fonte dava dois arquivos diferentes, o diff de uma regeração mentia
e não havia como distinguir "a lista mudou" de "alguém rodou o script".

Sem a data, a promessa passa a ser conferível, e é isto que
`server/cidades-geradas.test.ts` confere: ele remonta o Brasil inteiro com
`montarArquivoDoBrasil` a partir de `client/src/data/municipios-br.json` e exige
que o resultado seja **idêntico** ao `BR.json` versionado. O teste pega de uma vez
arquivo editado à mão, arquivo gerado por versão antiga do script e regeração que
não bate.

### Por que o Brasil continua no IBGE — e como o script garante isso

O IBGE tem os **5.571 municípios**, que é a unidade que a brasileira espera
escrever. O GeoNames tem 4.422 registros brasileiros com população ≥ 5.000, e os
5.881 com população ≥ 1.000 misturam distrito e bairro. A própria página de
fontes do GeoNames diz que o dado brasileiro **vem do IBGE**: trocar seria pegar a
mesma origem com perda.

Só que a rodada mundial passava por cima do `BR.json` sem dizer nada: ela gera
"todos os países que aparecerem", e o Brasil aparece. O arquivo caía de 5.571
para 4.422 e ninguém precisava ter pedido isso. Agora `paisSaiDoGeoNames`
(em `scripts/cidades/montagem.mjs`) deixa o **BR de fora da rodada sem
`--paises`**, e o script diz isso na saída:

```
BR ficou de fora: a lista brasileira vem do IBGE (node scripts/gerar-cidades.mjs --ibge).
```

Quem quiser mesmo a versão do GeoNames escreve `--paises BR` — escolha
explícita, não efeito colateral.

Fase futura, se alguém quiser que a japonesa ache São Paulo digitando サンパウロ:
cruzar IBGE × GeoNames por nome + UF e acrescentar os apelidos ao `BR.json`, sem
trocar a espinha da lista.

## Crédito obrigatório (já está em tela)

Os dados do GeoNames são **CC BY 4.0**: uso comercial liberado, **crédito visível
obrigatório**, com link.

O crédito aparece **embaixo do campo de cidade**, nas duas telas que usam a lista
(cadastro e perfil), e sai do cabeçalho do próprio arquivo do país:

| Campo do `<CC>.json` | Serve para                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `fonte`              | O texto do crédito: "GeoNames cities5000 (CC BY 4.0)", "IBGE — municípios brasileiros (dado público)". |
| `fonteUrl`           | O endereço, que transforma o crédito em link.                                                          |

`PaisEstadoCidade` monta a linha com a chave traduzida `local.creditoCidades` ("Dados de
cidades:", nos 10 idiomas; o seletor de país credita com `local.creditoPaises`) seguida da `fonte` como link para a `fonteUrl`. O nome
da fonte e o código da licença **não** se traduzem: são nome próprio e
identificador de licença.

Três consequências que valem mais que o código:

1. **Cada país credita quem forneceu a lista dele.** O Brasil credita o IBGE; a
   Alemanha creditará o GeoNames. País novo chega já creditado, sem ninguém
   lembrar de mexer no componente.
2. **País sem lista não credita ninguém**, porque nenhum dado de terceiro foi
   usado ali.
3. **Gerar um país sem `fonte`/`fonteUrl` é um arquivo que aparece na tela sem
   creditar ninguém.** `server/cidades-geradas.test.ts` exige os dois campos em
   todo arquivo versionado.

Hoje são **229 arquivos creditando o GeoNames** ("GeoNames cities5000
(CC BY 4.0)", com link para <https://www.geonames.org>) e **um creditando o
IBGE** (dado público, sem exigência de atribuição — creditado assim mesmo). O
teste do conjunto exige, em cada arquivo que não é o do Brasil, o nome da fonte,
**o código da licença** e o endereço: "GeoNames" sozinho não diz sob que
condição o dado pode ser usado.

## O que vai para o banco

`user_profiles.city` continua `varchar(100)` de texto livre. Não houve mudança de
schema, de propósito:

- escolheu da lista → grava o **nome canônico** ("São Paulo", "Köln"), sem a UF e
  sem o parêntese;
- digitou livre → grava exatamente o que foi digitado.

**O gerador respeita o `varchar(100)`.** Nome com mais de 100 caracteres é
descartado e **relatado** (`LIMITE_DO_NOME` em `scripts/cidades/montagem.mjs`; o
`z.string().max(100)` de `server/routers/profile.ts` repete o limite do banco).
Sugerir um nome que o próprio servidor recusaria seria entregar um erro de
gravação a quem fez tudo certo e escolheu da lista.

Medido no dump inteiro: **nenhuma das 70.221 cidades foi descartada** — o maior
nome do mundo tem 97 caracteres ("United Townships of Dysart, Dudley, Harcourt,
Guilford, Harburn, Bruton, Havelock, Eyre and Clyde", no Canadá) e está na lista;
o maior município brasileiro tem 32. A guarda continua valendo para o dia em que
a fonte trouxer um nome maior, e o descarte aparece no relatório em vez de a
cidade sumir em silêncio.

**O estado não é gravado.** Ele é o filtro que leva à cidade. Ao reabrir o
perfil, `deduzirEstado` acha o estado pela cidade gravada, **só quando a resposta
é única**: "Bom Jesus" existe em mais de uma UF, e aí o estado fica em branco, a
cidade gravada continua no campo e a busca vale para o país inteiro, com a
divisão no rótulo ("Bom Jesus (PI)"). Cidade em texto livre antigo continua
aparecendo do mesmo jeito. Se um dia o estado precisar valer para match ou
filtro, aí sim é coluna nova (`user_profiles.state`), com migração.

Linhas antigas ficam como estão. Nenhum `UPDATE` em massa.

### O que ficou de fora, e vale discutir

- **O nome canônico do GeoNames é muitas vezes o nome em INGLÊS**, e é ele que
  aparece na lista e vai para o banco: `Lisbon` (não Lisboa), `Munich` (não
  München), `Rome`, `Milan`, `Moscow`, `Mexico City`, `Geneva`. O rótulo da
  divisão administrativa vem do `admin1CodesASCII.txt` e também é inglês
  ("Bavaria", não "Bayern"). A busca acha por qualquer grafia — "Lisboa" e
  "Munique" estão na chave —, mas quem escolhe da lista grava a inglesa. O dado
  para corrigir **já está no dump**: 1.509 das 64.650 cidades têm nome em
  português diferente do canônico, e o de Lisboa vem até marcado como preferido
  (`isPreferredName`). Trocar o canônico é decisão de produto, não de código:
  muda o que a lista mostra e o que fica gravado em `user_profiles.city`, e
  precisa de uma regra clara (o nome no idioma oficial do país? o nome em
  português, já que o site é em português e o idioma da usuária varia?).
  Enquanto não houver decisão, o arquivo guarda o que a fonte diz.
- **411 linhas repetidas** (0,6% de 70.221): mesmo nome, mesma divisão
  administrativa, lugares diferentes no GeoNames — "Dondo (Cuanza Norte)"
  aparece duas vezes em Angola. Como as duas linhas gravam exatamente o mesmo
  texto no banco, o efeito é só uma sugestão duplicada na lista. Juntar as
  repetidas (ficando com a mais populosa) é uma linha no gerador; não foi feito
  para não mexer no critério de seleção sem decisão.
- **Coluna de referência** (`cityRef`, algo como `geonames:2886242`). Permitiria
  traduzir o rótulo da cidade para o idioma de quem lê, e casar cidade sem depender
  de texto. Custa uma migração; não entrou.
- **`server/matching.ts:362`** compara `a.city === b.city`, literal. Hoje
  "São Paulo" e "Sao Paulo" no mesmo país tiram 75 em vez de 100. Passar a comparar
  por `normalizarCidade` conserta isso de graça, mas muda nota de match e merece
  entrar como tarefa própria.
- **A Nova Oportunidade** (`NewOpportunity.tsx`) ainda tem a lista de 18 países
  escrita à mão. O cadastro e o perfil já usam os 250 de `shared/paises.ts`;
  trocar a da oportunidade é uma linha de `listarPaises` e ficou para outra PR,
  para esta não mexer em três telas.
