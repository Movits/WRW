# Medir o match: a rede de teste com armadilhas (N8)

Uma rede FICTÍCIA (70 contatos, 43 pares, nenhum dado real) para medir os motores de match
contra um gabarito. Serve de régua: o N7 (paráfrases e sinônimos) mede o antes e o depois
por ela.

- **Dados e gabarito:** `scripts/rede-de-teste/rede-com-armadilhas.json`. Cada par é uma
  oferta ("o que possui") diante de uma procura ("o que procura"), com `esperado`
  (`casa` ou `nao-casa`), o tipo de `armadilha` e o `porque`.
- **Medida, sem banco:** `server/rede-com-armadilhas.test.ts`, que chama as funções puras
  do motor privado (`scoreMatch`, corte 50) e do motor de perfis
  (`calculateCompatibilityScore` com perfis mínimos, corte 40). Roda no `pnpm test`.
- **Na tela, opcional:** `scripts/semear-rede-com-armadilhas.mjs` põe a rede na conta de
  uma usuária num banco LOCAL (recusa banco remoto) e `--limpar` tira.

## Como rodar

```bash
corepack pnpm vitest run server/rede-com-armadilhas.test.ts
```

Na tela (Git Bash, banco local):

```bash
DATABASE_URL='mysql://root:root@127.0.0.1:3307/wrw_dev' node scripts/semear-rede-com-armadilhas.mjs email@da.conta.de.teste
# "Matches Inteligentes" → "Atualizar matches"; depois:
DATABASE_URL='mysql://root:root@127.0.0.1:3307/wrw_dev' node scripts/semear-rede-com-armadilhas.mjs email@da.conta.de.teste --limpar
```

A tela também cruza contatos de pares diferentes do gabarito (todos contra todos), então
ela mostra mais pares do que o teste mede.

## Como ler a medida

O teste imprime, por motor:

```
Motor privado: precisão 92% (12/13), cobertura 60% (12/20), armadilhas proibidas violadas 1
  esperado, ainda não coberto: P08 [parafrase] "Vendo vinhos" × "Procuro fornecedor de bebidas"
  casou sem dever: C06 [concorrente] "Exportamos frutas" × "Exportar frutas"
```

- **Precisão:** dos pares que o motor casou, quantos o gabarito diz que casam.
- **Cobertura:** dos pares que o gabarito diz que casam, quantos o motor casou.
- **Esperado, ainda não coberto:** paráfrase, sinônimo, erro de digitação que o motor não
  casa. Não reprova: é o que falta (N7).
- **Casou sem dever:** falso positivo. Se a armadilha for uma das PROIBIDAS pela regra do
  projeto (`concorrente`, `palavra-solta`, `servico-sem-demanda`), o teste REPROVA, salvo
  se o par estiver em `LACUNAS_CONHECIDAS`, com o motivo. A lista também reprova quando uma
  lacuna deixa de acontecer, para ser atualizada.

## A medida (N7, 25/11/2026)

O N7 acrescentou ao gabarito S06, S07 e S08 (a prestadora que escreve a própria oferta no
campo de necessidade: "Ofereço contabilidade para MEI", "Contadora oferece serviços para
MEI", "Advogado disponível para empresas", achado da validação da #154) e P21 (o pedido com
"disponível" no meio, que continua casando). A linha "antes" é o código do N6 + N8 medido
com o gabarito de 43 pares.

| Motor | Antes do N7 | Depois do N7 |
| --- | --- | --- |
| Privado (`match-service.ts`) | precisão 76% (13/17), cobertura 62% (13/21), proibidas 4: C06, S06, S07, S08 | precisão 100% (16/16), cobertura 76% (16/21), proibidas 0 |
| Perfis (`matching.ts`) | precisão 77% (10/13), cobertura 48% (10/21), proibidas 3: S06, S07, S08 | precisão 100% (13/13), cobertura 62% (13/21), proibidas 0 |

No gabarito original do N8 (39 pares), o privado foi de 92% / 60% para 100% / 75%, e o de
perfis (já com o N6) de 100% / 45% para 100% / 60%.

- **O que o N7 cobriu:** C06 (o verbo conjugado é direção), P11, P12 e P13 (o mesmo termo
  em outra grafia: sem acento, plural, um erro de digitação em palavra longa,
  `mesmoTermoEmOutraGrafia` em `shared/direcao-do-termo.ts`) e S06 a S08
  (`necessidadeEhOferta` em `shared/tipo-da-oferta.ts`).
- **O critério semântico estreito** (só no motor privado) está DESLIGADO por padrão
  (`MATCH_SEMANTICO_ESTREITO=1` liga) e a medida acima é com ele desligado. As guardas já
  são medidas sem rede: com similaridade 1 para todo par, nenhuma armadilha proibida casa,
  e só chegam ao limiar P08, P09, P14, P15 (paráfrases sem palavra em comum), N01 e N02
  (sem relação, que o limiar tem de barrar). P19 fica de fora de propósito: repete "água".
- **A medida com os vetores** pede a fixture: `node --env-file=.env
  scripts/rede-de-teste/gerar-embeddings-da-rede.mjs` (manda só os rótulos fictícios ao
  Gemini, 1 requisição) e o teste imprime a "Calibração", com a similaridade de cada par
  elegível e o limiar seguro. Sem a fixture, esse caso do teste se pula.
- **Não cobertos:** P08, P09, P14, P15 e P19 nos dois motores (o privado depende do
  semântico ligado e calibrado); o de perfis também não casa P07, P10 e P20, porque não lê
  a categoria, e não tem critério semântico.

## Para acrescentar um par

Um item em `pares` (id novo, contatos de `contatos`, oferta e procura de contatos
diferentes). Nomes e empresas sempre inventados e com cara de inventados: o repositório é
público.
