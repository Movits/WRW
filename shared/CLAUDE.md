# shared/

<!-- Carregado quando o Claude lê ou edita um arquivo de shared/. Curto de propósito:
a regra de match mora em server/CLAUDE.md. -->

Constantes, tipos e funções puras usados pelo client e pelo servidor. Nada aqui acessa
banco, rede ou `process.env`: o mesmo código roda no navegador.

- `types.ts` reexporta os tipos do schema (`drizzle/schema.ts`); importe os tipos por ele.
- `direcao-do-termo.ts`: direção oferta/demanda de um termo (verbo no infinitivo e, desde o
  N7, conjugado) e `saoConcorrentes` (duas pontas que querem a mesma coisa zeram o par no
  motor privado e, desde o N6, não se atendem no motor de perfis); `mesmoTermoEmOutraGrafia`
  (N7: o termo inteiro sem acento, no singular ou com um erro de digitação) e
  `palavrasDeConteudo` (a guarda da palavra em comum do critério semântico estreito).
- `tipo-da-oferta.ts`: classifica o item como SERVIÇO, produto, ativo etc. e guarda as
  regras de equivalência de serviço (`mesmaFamiliaEEspecialidade`,
  `necessidadeGenericaNomeiaOServico`, `necessidadeDeclaraOAssuntoDoServico`,
  `necessidadeEhOferta` (N7: "Ofereço contabilidade" no campo de necessidade não pede nada),
  `DESTINATARIOS_COMUNS`, `regraNaoLeOPar`).
- `chaves-de-cruzamento.ts`: as chaves do índice de cruzamento (N4b). Não decidem match, só
  acham candidatos; regra nova que faça `scoreMatch` aceitar um par precisa de chave aqui (ou em
  `substanciasDoTermo` e `chavesDeServico`), e `server/chaves-de-cruzamento.test.ts` acusa.
- `o-que-busca.ts`: as 12 opções de "O que você busca?" (nenhuma libera serviço sozinha).
- `qualificacao-do-perfil.ts`: a régua que separa Prata de Bronze.

**Antes de mexer em `direcao-do-termo.ts`, `tipo-da-oferta.ts` ou `o-que-busca.ts`, leia
a seção "Os três motores de match" de `server/CLAUDE.md`**: essas funções decidem nota e
e-mail de match nos três motores e na tela, e a regra da demanda expressa vale nelas.
Entrada nova no vocabulário de assunto entra com o teste negativo dela
(`server/demanda-expressa-exemplos-da-spec.test.ts`).
