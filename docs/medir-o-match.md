# Medir o match: a rede de teste com armadilhas (N8)

Uma rede FICTÍCIA (66 contatos, 39 pares, nenhum dado real) para medir os motores de match
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

## A medida em 25/11/2026 (origin/main abf0f89)

| Motor | Precisão | Cobertura | Proibidas violadas |
| --- | --- | --- | --- |
| Privado (`match-service.ts`) | 92% (12/13) | 60% (12/20) | 1: C06 |
| Perfis (`matching.ts`) | 69% (9/13) | 45% (9/20) | 4: C01, C02, C03, C05 |

- **C06 no privado:** "Exportamos frutas" × "Exportar frutas". O verbo conjugado não é lido
  como direção, a oferta fica neutra e a categoria em comum casa as duas exportadoras.
- **Concorrentes no de perfis:** esse motor não aplica a regra dos concorrentes
  (`server/CLAUDE.md`). Uniformizar é decisão de produto.
- **Não cobertos nos dois:** paráfrase (P08, P19), sinônimo (P09), erro de digitação e de
  português (P11, P12, P13), termos diferentes (P14) e outro idioma (P15). O de perfis
  também não casa P07, P10 e P20, porque não lê a categoria.

## Para acrescentar um par

Um item em `pares` (id novo, contatos de `contatos`, oferta e procura de contatos
diferentes). Nomes e empresas sempre inventados e com cara de inventados: o repositório é
público.
