# Aviso de gravação de reuniões — RASCUNHO para a Cris revisar

**Situação:** rascunho, no ar desde a versão `2026-11-14` (decisão do Roberto de
30/10/2026: liberar com o aviso em rascunho e a Cris revisar depois). Não é o Termo de
Gravação de Reuniões (`termo_gravacao` em `document_versions`), que é o texto jurídico
completo, ainda a redigir pela Cris e a publicar pelo Roberto com
`scripts/publicar-documento.mjs`.

**Como funciona a versão:** a tela mostra o aviso curto (chave `meetings.consentNotice`,
nos 10 idiomas) e grava em cada reunião a versão que mostrou
(`meetings.consent_notice_version`). As versões ficam em `shared/aviso-de-gravacao.ts`.
Mudou o que o aviso diz sobre o áudio? Versão nova no fim da lista, e esta página ganha
a seção dela. As versões anteriores continuam aceitas: quem estava com a aba aberta na
troca não perde a gravação, e a reunião guarda a versão que de fato viu. Reuniões
anteriores a 14/11/2026 ficam com a versão nula.

O português é o texto de referência. Os outros 9 idiomas são tradução e precisam de
revisão de tradução.

## Versão 2026-11-23 (frase da Cris sobre o acesso da administração)

A Cris mandou em 23/11/2026 o texto da revisão das gravações pela administração, e o
Roberto decidiu no mesmo dia que entra como está, como compromisso: o registro do motivo
antes de cada acesso é da administração. A frase dela vai ao fim do aviso curto de
`meetings.consentNotice`, nos 10 idiomas; o resto do aviso é o da versão 2026-11-14,
abaixo, que segue aceita para a aba aberta antes do deploy.

> Somente grave com o consentimento de todas as pessoas. O áudio é transcrito pela IA do
> Google (Gemini), que pode processá-lo fora do Brasil e separar as falas por pessoa. O
> áudio fica na sua conta por 30 dias, e a transcrição até você excluir a reunião. Só
> você acessa, a menos que ligue o link de compartilhamento da reunião (o que pede nova
> autorização de quem falou). A administração da MarquesaMatch só acessa gravações por
> motivo justificado, registrado antes do acesso, e a organizadora é informada da data de
> cada consulta.

### Para a Cris e o Roberto

- "Só você acessa" e a frase nova convivem: a frase nova é a exceção da administração.
  Se a Cris preferir, a frase anterior pode passar a "Fora a administração (abaixo), só
  você acessa".
- Desde a R1a, a administração (admin e presidência; nunca Ouro sem cargo) consulta pelo app
  a reunião gravada com esta versão do aviso: escolhe o motivo (apuração de denúncia,
  segurança, suporte pedido pela usuária, obrigação legal ou ordem judicial) e escreve o
  porquê, e o registro é gravado antes de qualquer leitura. A organizadora vê no detalhe da
  reunião a data de cada consulta, sem o motivo nem quem consultou. A reunião gravada com a
  versão 2026-11-14, que dizia "Só você acessa", fica fechada à administração.
- **Para a Cris revisar** (textos que dizem à usuária quem vê o quê): a frase nova do aviso de
  privacidade no detalhe da reunião (`meetings.privacyNotice`, "A administração da Marquesa
  Global Match só consulta uma reunião por motivo justificado, registrado antes do acesso, e
  você vê aqui a data de cada consulta") e a linha "A administração da Marquesa Global Match
  consultou esta reunião em: …" (`meetings.adminReads.notice`), nos 10 idiomas.

## Versão 2026-11-14

### O aviso curto, como aparece na tela (pt-BR)

> Somente grave com o consentimento de todas as pessoas. O áudio é transcrito pela IA do
> Google (Gemini), que pode processá-lo fora do Brasil e separar as falas por pessoa. O
> áudio fica na sua conta por 30 dias, e a transcrição até você excluir a reunião. Só
> você acessa, a menos que ligue o link de compartilhamento da reunião (o que pede nova
> autorização de quem falou).

A caixa que a dona marca antes de gravar continua a de antes
(`meetings.consentCheckboxLabel`): "Confirmo que todas as pessoas participantes
autorizaram a gravação e o tratamento privado deste áudio para esta reunião."

### O que o aviso cobre, ponto a ponto (para o Termo de Gravação)

1. **Consentimento.** Quem grava declara que todas as pessoas que falam autorizaram a
   gravação. A WRW não confere isso; a declaração fica gravada na reunião, com a data e
   a versão do aviso.
2. **Quem processa o áudio.** A transcrição, o resumo, as perguntas à reunião e a
   tradução são feitos pela IA do Google (Gemini), por API. O áudio e o texto vão ao
   Google para isso.
3. **Transferência internacional.** O Google pode processar o áudio e o texto fora do
   Brasil (LGPD, arts. 33 a 36).
4. **Separação das falas por pessoa.** A IA separa o que cada voz disse ("Falante 1",
   "Falante 2"...), sem saber de quem é cada voz. Quando houver nomes, quem gravou os
   confirma.
5. **Retenção.**
   - o áudio fica guardado por 30 dias a partir do envio e depois é apagado sozinho;
   - a transcrição, as traduções, o resumo e o que a dona confirmou ficam até ela
     excluir a reunião ou a conta;
   - excluir a reunião ou a conta apaga tudo, inclusive o áudio antes dos 30 dias.
   A retenção do áudio pode mudar (24 h ou 30 dias, pergunta em aberto com a cliente);
   se mudar, o aviso ganha versão nova.
6. **Quem acessa.**
   - hoje: só a dona da conta que gravou;
   - o link aberto (12/11/2026): se a dona ligar, qualquer pessoa com o endereço
     `/r/{token}` ouve, lê, traduz e faz perguntas à IA, sem conta na WRW. Ligar pede de
     novo a confirmação de que as pessoas que falaram autorizaram compartilhar, e fica na
     auditoria; desligar corta o acesso;
   - planejado, ainda não no ar (reunião compartilhada): as participantes que a dona
     adicionar e, para consulta, a presidência e a administração da WRW, com registro de
     cada abertura, para conferir o cumprimento do Termo Geral de Uso. Quando entrar, o
     aviso ganha versão nova que diga isso.
7. **Cópia no aparelho (planejado).** Na gravação longa, o áudio fica guardado no
   próprio aparelho até chegar ao servidor, para não se perder se a internet cair. Sair
   da conta ou excluí-la apaga essa cópia.
8. **Importação e reunião online (planejado).** Os mesmos pontos valem para um arquivo de
   áudio ou vídeo importado (do vídeo, só o áudio sai do aparelho) e para a gravação da
   aba de uma reunião online.

### O que NÃO está no aviso, de propósito

- "O áudio não é usado para treinar a IA": só entra com o faturamento da chave do Gemini
  confirmado (no plano gratuito, o Google pode usar o conteúdo para melhorar os
  produtos). Quando entrar, a versão sobe.

### Para a Cris decidir

- se o aviso curto basta antes de cada gravação ou se a tela mostra o texto inteiro na
  primeira vez de cada versão (pergunta em aberto com a cliente);
- a redação do Termo de Gravação de Reuniões a partir dos pontos acima.

## Aviso do resumo de vídeo do YouTube — versão `youtube-2026-11-20`

A H13 resume um vídeo público do YouTube: a dona cola o link, e a IA do Google lê o
vídeo pelo próprio link. É outro aviso, com versão própria em `shared/youtube.ts`
(`VERSOES_DO_AVISO_DO_YOUTUBE`), gravada na reunião (`meetings.consent_notice_version`) e
na auditoria do pedido (`MEETING_YOUTUBE_REQUESTED`, com IP e navegador). A mesma regra
das versões vale aqui: mudou o que o aviso diz, versão nova no fim da lista.

### O aviso curto, como aparece na tela (pt-BR, `meetings.youtube.notice`)

> O vídeo é lido pela IA do Google (Gemini) direto do YouTube, pelo link, e pode ser
> processado fora do Brasil. Só vídeos públicos funcionam, e só os primeiros 60 minutos
> são transcritos. A WRW não guarda o vídeo: guarda o link, a transcrição e o resumo na
> sua conta até você excluir a reunião. Só você acessa, a menos que ligue o link de
> compartilhamento. Limite: 5 vídeos a cada 24 horas.

A caixa que a dona marca antes de enviar (`meetings.youtube.consentLabel`): "Li o aviso e quero que a IA do Google leia este vídeo para transcrevê-lo e resumi-lo."

### O que o aviso cobre, ponto a ponto

1. **Quem processa o vídeo.** A IA do Google (Gemini) lê o vídeo direto do YouTube, pelo
   link; a WRW não baixa nem guarda o vídeo. Daí vêm a transcrição, o resumo, o mapa
   mental e as respostas sobre o vídeo.
2. **Transferência internacional.** O Google pode processar o vídeo fora do Brasil.
3. **Só vídeo público, só a primeira hora.** Vídeo privado, não listado ou restrito não
   funciona; de um vídeo mais longo, só os primeiros 60 minutos são transcritos.
4. **Retenção.** Ficam na conta da dona o link do vídeo (o endereço canônico, sem os
   parâmetros do link colado), a transcrição e o resumo, até ela excluir a reunião ou a
   conta.
5. **Quem acessa.** Só a dona, a menos que ela ligue o link aberto da reunião, que mostra
   o resumo e a transcrição, e o ▶ de cada fala abre o vídeo no YouTube. Ao ligar o link
   de uma reunião feita de vídeo, a caixa é outra que a da reunião gravada (que fala das
   pessoas que falaram e da gravação, que aqui não existe), e a frase que a dona viu vai
   para a prova do link, na auditoria (`MEETING_OPEN_LINK_ON`; chave
   `meetings.youtube.shareAuthorization`): "Confirmo que posso compartilhar a transcrição
   deste vídeo e autorizo que quem receber o link a leia, com o resumo e os nomes que eu
   der às vozes."
6. **Teto.** Até 5 vídeos por dona a cada 24 horas, contando o "Tentar de novo".

### Para a Cris decidir

- se o aviso deve dizer algo sobre o direito de uso do conteúdo do vídeo (a dona resume
  vídeo público de terceiros para uso próprio);
- se a caixa do link aberto de uma reunião feita de vídeo (a frase do item 5, desde a
  conferência de tela de 20/11/2026) pede alguma ressalva além dessa.

## Aviso da legenda ao vivo — versão `legenda-2026-11-23` (texto da Cris)

A Cris mandou o texto da legenda em 23/11/2026, já com o nome MarquesaMatch. A chave
`meetings.caption.noticeBrowser` passou a ser o texto dela, e a primeira frase de
`meetings.caption.noticeNotSaved` saiu, porque o texto dela já diz que a legenda não fica
guardada. O botão de confirmar passou a "Ativar legenda" (o "Agora não" já existia). A
caixa de concordância das pessoas e a frase de que a legenda não separa quem fala
continuam. A versão anterior, abaixo, segue aceita para a aba aberta antes do deploy.

> **Ligar a legenda ao vivo?**
>
> A legenda ao vivo usa o reconhecimento de voz do navegador. No Google Chrome, o áudio
> pode ser enviado aos servidores do Google para ser convertido em texto. A legenda não é
> guardada pela MarquesaMatch e desaparece ao fim da reunião.
>
> A legenda não separa quem fala e pode errar palavras.
>
> A transcrição da reunião continua sendo a da IA, que chega por partes.

Botões: [Ativar legenda] [Agora não].

## Aviso da legenda ao vivo — versão `legenda-2026-11-22`

A G15b mostra, durante a gravação, a legenda do que está sendo dito, com segundos de
atraso, pelo reconhecimento de voz do PRÓPRIO navegador (a Web Speech API), sem custo. A
legenda não separa quem fala, não fica guardada e não substitui a transcrição da reunião,
que continua sendo a da IA, por partes. Decisão do Roberto de 16/11/2026: no Chrome, o
reconhecimento costuma mandar o áudio a um servidor do Google, e a tela diz isso antes de
ligar, com o texto para a Cris revisar.

É outro aviso, com versão própria em `shared/legenda-ao-vivo.ts`
(`VERSOES_DO_AVISO_DA_LEGENDA`). Ele aparece na primeira vez que a dona liga a legenda em
cada gravação; desligar e ligar de novo na mesma gravação não pergunta outra vez. A mesma
regra das versões vale aqui: mudou o que o aviso diz, versão nova no fim da lista.

### O aviso, como aparece na tela (pt-BR, chaves `meetings.caption.notice*` e `meetings.caption.consentLabel`)

> **Ligar a legenda ao vivo?**
>
> A legenda usa o reconhecimento de voz deste navegador, sem custo. No Chrome, ele costuma
> mandar o áudio a um servidor do Google para virar texto; em outros navegadores, o áudio
> pode ir ao servidor da empresa do navegador. Esse envio é feito pelo navegador, fora da
> WRW, e segue as regras de privacidade dessa empresa.
>
> A legenda não separa quem fala e pode errar palavras.
>
> Ela não fica guardada: some ao desligar ou ao encerrar a gravação. A transcrição da
> reunião continua sendo a da IA, que chega por partes.

A caixa que a dona marca antes de ligar: "As pessoas desta reunião sabem que, com a
legenda ligada, o áudio pode ir ao serviço de voz do navegador, e concordam."

### O que o aviso cobre, ponto a ponto

1. **Quem processa o áudio.** O reconhecimento é do navegador: no Chrome, o áudio vai a um
   servidor do Google; no Edge, em geral, ao da Microsoft; no Safari, ao da Apple ou ao
   próprio aparelho. A WRW não recebe esse áudio nem o texto da legenda, e não escolhe nem
   contrata esse serviço: ele segue a política de privacidade da empresa do navegador. É
   diferente do aviso de gravação, em que o áudio vai ao Gemini por API, pela WRW.
2. **A concordância das pessoas.** A dona declara que as pessoas da reunião sabem do envio
   ao serviço de voz do navegador e concordam. A declaração vai à auditoria
   (`audit_logs`, ação `MEETING_LIVE_CAPTION_ON`) antes de a legenda ligar, com a versão do
   aviso, o texto que ela viu, o idioma da tela, o hash do texto, o IP e o navegador. Sem
   essa linha, a legenda não liga.
3. **Sem guarda.** O texto da legenda fica só na tela, enquanto a gravação dura: some ao
   desligar ou ao encerrar, e não vai ao servidor nem à reunião. Pausar a gravação para a
   legenda (o áudio deixa de ir ao serviço do navegador) e continuar a religa.
4. **Sem separar quem fala.** A legenda é um texto corrido, sem "Falante 1" nem nomes.
5. **Onde aparece.** Só onde o navegador tem o reconhecimento de voz (no Firefox, o botão
   não aparece). Até o teste num aparelho de verdade, também não aparece no celular nem no
   tablet: no Android e no iPhone o reconhecimento pode disputar o microfone com a gravação.

### Para a Cris decidir

- se o aviso basta como está ou se deve citar a empresa de cada navegador pelo nome;
- se a caixa da concordância das pessoas é necessária (ela é o caminho mais seguro; o
  Roberto pode vetar) e se a frase serve;
- se o aviso de gravação (`meetings.consentNotice`) deve mencionar a legenda opcional.
