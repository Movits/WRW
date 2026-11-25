# Perfil de voz — textos da tela e pontos para a Cris

**Situação:** textos da Cris (25/11/2026), usados como ela escreveu, só com o nome atual
da plataforma (Marquesa Global Match) no lugar do anterior. Não é texto publicado por
`scripts/publicar-documento.mjs`: é texto de tela (chaves `perfilDeVoz.consent` e
`perfilDeVoz.consentSupport`, nos 10 idiomas), e cada consentimento guarda a versão e o
texto que a dona viu (`voice_profile_consents`).

**Como funciona a versão:** as versões ficam em `shared/perfil-de-voz.ts`
(`VERSOES_DO_TEXTO_DO_PERFIL_DE_VOZ`). Mudou o que o texto diz? Versão nova no fim da
lista, a vigente troca, e esta página ganha a seção dela. O consentimento dado numa versão
anterior continua valendo até a dona desligar o perfil.

O português é o texto de referência. Os outros 9 idiomas são tradução e precisam de
revisão de tradução.

## Versão `perfil-de-voz-2026-11-25`

A caixa, **desmarcada** por padrão e **separada** do aceite dos Termos:

> Autorizo a Marquesa Global Match a criar um perfil da minha voz para me identificar nas
> transcrições e resumos das reuniões.

O texto de apoio, logo abaixo da caixa:

> O perfil de voz é um dado biométrico. É usado apenas para esse fim, não é obrigatório
> para usar a plataforma e pode ser desligado a qualquer momento. Ao desligar, o perfil é
> excluído.

## Os pontos técnicos da Cris, e onde estão

- **Registro de cada consentimento e de cada revogação** (data, hora e versão do texto):
  tabela `voice_profile_consents`, uma linha por evento, com o idioma, o texto exibido e o
  hash, o IP e o navegador, sem a voz. Sobrevive à exclusão do perfil e à da conta; a
  exclusão da conta grava antes a revogação, com a origem `exclusao_da_conta`.
- **Exclusão definitiva:** desligar apaga a amostra do armazenamento (Backblaze B2, com
  todas as versões que o B2 guarda) e a linha do perfil, na mesma operação que registra a
  revogação. Se o armazenamento não confirmar, nada muda e a dona tenta de novo. O mesmo
  vale para a exclusão da conta. O exame de produção não cria perfil de voz.

## Para a Cris decidir

1. **O Gemini recebe a amostra.** A cada parte de reunião transcrita (cerca de 10 minutos),
   a amostra vai junto ao Google (Gemini), que pode processá-la fora do Brasil, como o
   áudio da reunião (o aviso de gravação já diz isso do áudio). O texto da caixa não fala
   do Google nem da transferência internacional. Exemplo: a dona grava uma reunião de 1 hora
   e a amostra vai 6 vezes ao Gemini.
2. **O registro fica depois da exclusão da conta.** Escolha desta PR, como prova do
   consentimento e da revogação (sem a voz, com o identificador interno da conta). Se a Cris
   preferir que saia, é uma linha no plano de exclusão.
3. **O que já foi reconhecido fica.** Desligar o perfil apaga a amostra, mas as reuniões já
   transcritas continuam com a voz da dona ligada à conta dela (a dona pode desfazer em
   "Quem é cada voz"). Exemplo: a reunião de ontem segue mostrando "Ana" na fala dela.
