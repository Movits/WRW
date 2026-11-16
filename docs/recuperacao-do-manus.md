> **Histórico.** Registro de quando o código saiu do Manus (agosto e setembro de 2026). Explica o porquê
> de algumas escolhas; não descreve o sistema de hoje. O índice atual está em [docs/README.md](./README.md).

# Recuperação do código do Manus

Registro do que foi preciso fazer para tirar o MMM OS (hoje WRW) da plataforma onde ele nasceu
e colocá-lo neste repositório. Serve para quem for mexer no código entender por que
algumas coisas estão como estão.

## De onde veio

Do backup gerado pelo Manus em 18/08/2026, que trazia o código-fonte, um dump SQL
completo do banco e os objetos do S3.

O dump **não está aqui e não deve entrar**: ele contém e-mails e senhas de usuárias
reais. Fica só no repositório privado de backup.

## O que precisou ser adaptado

A aplicação dependia de serviços internos do Manus que deixaram de responder quando
o projeto saiu de lá.

**Chamadas de IA.** Passavam por um proxy do Manus (`forge.manus.im`) que injetava
as credenciais. Agora `server/_core/llm.ts` aceita qualquer endpoint compatível com
a API da OpenAI — por padrão o Google Gemini, configurado por `LLM_API_URL` e
`LLM_API_KEY` (ou `GOOGLE_API_KEY`). O modelo de cada chamada sai do `LLM_MODEL` e das
variáveis por função (`LLM_MODEL_EXTRACAO`, `LLM_MODEL_RESUMO` e `LLM_MODEL_PERGUNTA`),
que vencem o `LLM_MODEL` quando definidas: a ordem está na tabela de variáveis do
`docs/deploy.md`. Trocar só o `LLM_MODEL` não muda uma função que tenha a sua variável.

**Imagens da página inicial.** Estavam num CloudFront do Manus que hoje devolve 403,
e o backup não trouxe nenhuma cópia local. As referências mortas foram removidas.

**Login social.** O OAuth do Manus não existe mais fora da plataforma. O login por
e-mail e senha, que já existia, é o caminho padrão — as senhas das contas antigas
continuam válidas, porque os hashes foram preservados.

## Limpeza de dados

O banco tinha 83 contas, das quais **71 eram fictícias**, criadas por scripts de
seed durante o desenvolvimento (domínios `botmail.com`, `seed.frauen.com`,
`frauen-bot.com`, `mmm-demo.com`, `mmm-test.com`). Foram removidas junto com tudo
que dependia delas: oportunidades, matches, conexões, mensagens e notificações.
Os scripts que as geravam também saíram do repositório.

Como consequência, a página inicial deixou de exibir números fixos (`10.953 usuárias`,
`3.356 oportunidades`, `83% de satisfação`) e passou a consultar o banco pelo
endpoint público `stats.platform`. Os depoimentos foram removidos: as três autoras
eram inventadas.

## Correções de segurança

Aplicadas antes de o código entrar num repositório público.

**Injeção de SQL.** Havia 21 pontos montando SQL por concatenação de texto. O mais
grave estava em `sivc.ts`: o campo `ipAddress` vinha do navegador e entrava direto
num `INSERT`, sem escape — qualquer usuária autenticada conseguia executar comandos
arbitrários no banco. Havia casos semelhantes em `profile.ts` (permitia alterar o
perfil de todas as usuárias de uma vez), `president.ts` e `opportunities.ts`.
Tudo foi convertido para consulta parametrizada.

> Não resta nenhum `sql.raw` no projeto. Isso é intencional: um `sql.raw` num diff
> futuro é sinal de alerta, detectável com um grep.

**Segredos de reserva no código.** `JWT_SECRET` e `VAULT_ENCRYPTION_KEY` tinham
valor padrão escrito no fonte. Num repositório público, isso viraria chave-mestra
para qualquer ambiente onde a variável não estivesse definida. Agora
`requireSecret()`, em `server/_core/env.ts`, faz a inicialização falhar com uma
mensagem clara em vez de seguir com um valor conhecido.

**Conta desativada continuava entrando** (a V-01 do relatório de pentest, que estava
em aberto). A checagem de `isActive` faltava em `sdk.authenticateRequest` e no
callback OAuth, então bastava refazer o login. Fechado nos dois pontos.

**Bug encontrado no caminho.** `deleteOpportunity` nunca funcionou: gravava
`status='removed'`, valor ausente do enum da coluna, o que em modo estrito falha com
`Data truncated`. O valor foi acrescentado ao enum, no schema e no banco.

## Decisão em aberto

`presidentProcedure` permite que **qualquer conta Ouro conceda Ouro a outras**, sem
segunda aprovação. É regra de negócio deliberada — o código diz "Ouro = Presidente" —
e foi mantida a pedido. Vale registrar o efeito colateral: comprometer uma única
conta Ouro basta para criar Ouros ilimitados.

## O que ainda falta

- `RESEND_API_KEY` — sem ela a recuperação de senha não envia e-mail. O teste de
  credencial dela se auto-pula em `pnpm test` enquanto a chave não existir.
- Hospedagem. O projeto precisa de Node e MySQL; GitHub Pages não roda.
- 02/09/2026 — os resíduos do Manus foram removidos nesta limpeza: o login social
  (OAuth e a página `/oauth-error`), a cadeia `_core` que falava com o Forge (data
  API, geração de imagem, transcrição, mapa, heartbeat, notificação), os plugins
  do Manus no Vite e o coletor de logs `.manus-logs/`, o patch do wouter, os SDKs
  `openai` e `@anthropic-ai/sdk` (nada os importava; as chamadas de IA usam
  `fetch`), os scripts Python de i18n e as variáveis `OAUTH_SERVER_URL`,
  `OWNER_OPEN_ID`, `BUILT_IN_FORGE_API_KEY`, `ANTHROPIC_API_KEY` e
  `OPENAI_API_KEY`. Ficou de propósito o prefixo de rota `/manus-storage/*`: ele
  está gravado nas URLs de arquivo no banco de produção, e o proxy autenticado
  atrás dele é código nosso.
