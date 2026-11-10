# scripts/

Ferramentas de linha de comando do MMM. Rodam a partir da raiz do repositório,
com `node` (os `.mjs`) ou `npx tsx` (os `.ts`), e leem a conexão de
`DATABASE_URL` quando precisam de banco. O cabeçalho de cada arquivo tem o
detalhe de uso; esta página é só o mapa.

**Nunca rode script contra o banco de produção (Aiven) sem autorização explícita
do Roberto.** Poucos têm modo de ensaio: `migrar.mjs` e `publicar-documento.mjs`
aceitam `--simular`, e `nivelar-banco.mjs` e `importar-participantes.mjs` só
alteram com `--aplicar`. Os outros gravam na chamada simples:
`migrar-rotulos-para-chaves.mjs` faz UPDATE em todos os perfis,
`semear-rede-de-teste.mjs` insere contatos (e `--limpar` apaga),
`definir-senha-local.mjs` grava a senha (recusa banco que não seja local),
`corrigir-colunas-json.mjs` altera colunas. Leia o cabeçalho antes de rodar.
`importar-participantes.mjs` é a carga da base de participantes — cria contas
em lote, sem volta por aqui (desfazer é pela exclusão de conta, uma a uma).
Três rotinas tocam a produção por desenho: `migrar.mjs` no boot do servidor,
`checar-producao.mjs` depois de todo deploy (passo obrigatório do CLAUDE.md; cria
e apaga duas contas QA e roda só com a `DATABASE_URL` de um `.env.producao`, via
`--env`) e `publicar-documento.mjs` quando o jurídico entrega texto novo, com
`--confirmo-producao`.

| Script | O que faz | Quando rodar |
| --- | --- | --- |
| `baseline.mjs` | Biblioteca, não comando: lê o baseline `0000_fundacao` de `drizzle/` e devolve tabelas, colunas e índices como dados. | Nunca direto; `migrar.mjs` e `nivelar-banco.mjs` importam dela. |
| `checar-producao.mjs` | Exame de saúde do site no ar: cria duas contas QA (presidente e Prata), faz login de verdade com elas e prova site, cache, migrações, isolamento com controle positivo, storage B2 de ponta a ponta, consentimento do Smart Match, conceder e revogar Ouro com auditoria, vitrine e acervo Ouro por nível; apaga tudo ao final pelo plano de `exame/limpeza.mjs`. `--com-ia` inclui FAQ e Memória; `--somente-faxina` só apaga resíduos de execução interrompida. Sai com 0 só sem falha (ALERTA conta como falha), exceção, limite de requisições ou erro de limpeza; em `--somente-faxina` só erro de limpeza ou exceção reprovam. | Depois de todo deploy na `main`, antes de marcar a tarefa como concluída no Notion. Precisa só da `DATABASE_URL` da produção, num `.env.producao` separado do `.env` de trabalho (`--env .env.producao`); `EXAME_BASE_URL` opcional. |
| `conferir-locales.mjs` | Confere que os 10 JSONs de `client/src/i18n/locales/` têm o mesmo conjunto de chaves; sai com 1 e lista o que falta ou sobra. | Sempre que tocar em texto de tela; o CI também roda. Não precisa de banco. |
| `corrigir-colunas-json.mjs` | Converte para `json` as colunas que o dump do Manus trouxe como `longtext`; sem `--aplicar` só relata. | Só em banco restaurado do dump antigo; banco criado por `criar-banco.mjs` já nasce certo. |
| `criar-banco.mjs` | Cria todas as tabelas num banco vazio aplicando as migrações de `drizzle/` (atalho para `migrar.mjs`). Seguro repetir. | Banco novo do zero: desenvolvimento, CI, primeira subida. |
| `definir-senha-local.mjs` | Grava a senha de uma conta com o mesmo bcrypt do registro; recusa qualquer host que não seja local. | Conta de teste inacessível em desenvolvimento, onde não há Resend para recuperar senha. |
| `demonstrar-etapa-11.ts` | Demonstração ao vivo da autorização do Cruzamento Inteligente: chama as mesmas funções do servidor e mostra o que respondem; `--exercitar` revoga e reaceita de verdade e devolve o estado ao final. | Para provar a etapa 11 a alguém, contra banco de desenvolvimento (`npx tsx`). |
| `exame/` | Biblioteca do exame de produção, não comando: `relatorio.mjs` (linhas OK/FALHA/PULADO, veredito, código de saída e ritmo das requisições) e `limpeza.mjs` (plano de limpeza declarado como dados, um par tabela/coluna por vez). Módulos puros, sem banco nem `process.env`; `server/exame-de-producao.test.ts` confere o plano contra `drizzle/schema.ts`. | Nunca direto; `checar-producao.mjs` importa deles. |
| `importacao/` | Biblioteca da carga de participantes, não comando: `planilha.mjs` lê e valida o CSV (separador, colunas, vocabulário do cruzamento, completude) e devolve os dados prontos para inserir. | Nunca direto; `importar-participantes.mjs` importa dela. |
| `importar-participantes.mjs` | Carga da base de participantes: lê a planilha (`--modelo` imprime um exemplo), valida linha por linha, confere quem já existe pelo e-mail e cria o resto sem senha — cada uma define a dela em "Esqueci minha senha". Idempotente pelo e-mail; nunca manda e-mail. Sem `--aplicar` só relata. `--log=arquivo.json` grava os ids criados, para desfazer pela exclusão de conta. | Carga inicial ou de novas participantes, contra `--env .env.producao` ou a `DATABASE_URL` do ambiente. |
| `listar-modelos-gemini.mjs` | Lista os modelos do Gemini que a chave enxerga: nome, `generateContent` sim/não e os limites de tokens de entrada e saída. `--conferir a,b,c` diz se cada id existe e aceita `generateContent`, e sai com 1 se faltar algum ou se algum não aceitar; existir não prova que o id é concreto, porque aliases como `gemini-flash-latest` também aparecem. Não toca banco, não lê o `.env` e nunca imprime a chave, que vem do ambiente (`LLM_API_KEY` ou `GOOGLE_API_KEY`) e vai no cabeçalho. | Antes de pôr um id em `LLM_AUDIO_MODEL`, `LLM_AUDIO_MODEL_RESERVA` ou `LLM_MODEL` (este, quando o texto vai ao Gemini), com a chave do ambiente de destino. Use a receita do cabeçalho do script, que lê a chave sem eco e a passa só ao comando: exportada, ela fica no terminal, e o `pnpm dev` e o `pnpm test` dali passam a usá-la no lugar da do `.env`, a de produção inclusive. |
| `migrar-rotulos-para-chaves.mjs` | Migra as listas de `user_profiles` do rótulo pt-BR para a chave canônica e recalcula o `profileCompleteness`; seguro repetir. | Uma vez, em banco com perfis gravados antes de 31/08/2026 (o front já grava chaves). |
| `migrar.mjs` | Aplica as migrações pendentes de `drizzle/` e anota em `_migracoes`: banco vazio recebe tudo, banco antigo em dia adota o baseline, banco desviado é recusado com a lista dos desvios. `--simular` só relata. | É o `pnpm db:migrate`; depois de `pnpm db:generate`. Em produção roda sozinho no boot. |
| `nivelar-banco.mjs` | Põe um banco da era anterior às migrações em dia com o baseline: cria tabela, coluna, índice e restrição que faltam e alarga enum; nunca apaga nada. Sem `--aplicar` só relata. | Quando `migrar.mjs` recusar o banco por desvio. O CI exige "Nada a nivelar" num banco recém-criado. |
| `publicar-documento.mjs` | Publica uma versão nova de documento (termo, acordo, contrato) e a torna vigente; conta quem perde o consentimento e pede confirmação. `--simular` só mostra; `--texto-provisorio` publica o rascunho embutido. | Quando o jurídico entregar redação nova. Fora do banco local exige `--confirmo-producao`. |
| `reavaliar-prata-antiga.ts` | Reavaliação única da Prata que o cadastro gravava para todas antes da governança de 14/09: aplica a régua de `shared/qualificacao-do-perfil.ts` às contas Prata sem origem registrada (sem Ouro concedido nem mudança de nível auditada) e rebaixa a Bronze quem não atende, com auditoria; sem `--executar --confirmar-banco=...` só relata. | Uma vez, depois do deploy da governança, e só com decisão do Roberto (`npx tsx`). |
| `recuperar-enriquecimento.ts` | Reaplica ao contato as respostas do chat de enriquecimento (possui, procura, como se conheceram, tipo de relacionamento) que um defeito antigo confirmava e descartava; sem `--aplicar` só relata. | Uma vez, em banco com sugestões `applied` anteriores ao conserto (`npx tsx`). |
| `semear-rede-de-teste.mjs` | Cria contatos fictícios na rede particular de UMA usuária para dar o que cruzar ao Smart Match; `--limpar` desfaz. Ninguém além da dona enxerga. | Testar o cruzamento em desenvolvimento. |
