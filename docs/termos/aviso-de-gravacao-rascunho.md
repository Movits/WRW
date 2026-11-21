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
