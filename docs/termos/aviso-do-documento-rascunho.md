# Aviso do documento (resumo de PDF e de fotos de um texto) — RASCUNHO para a Cris revisar

**Situação:** rascunho, versão `documento-2026-11-19`, escrito com a H12 e a H12b (o
resumo de um PDF e de fotos de um texto, como no HiNoter). A Cris ainda não revisou. Se
ele pode entrar no ar antes da revisão, como o aviso de gravação entrou (decisão do Roberto
de 30/10/2026 para a gravação), é decisão do Roberto.

**Como funciona a versão:** a tela mostra o aviso curto (chave `meetings.document.notice`,
nos 10 idiomas) e a caixa de autorização (`meetings.document.consentLabel`) antes de enviar
o documento, e grava em cada reunião a versão que mostrou, na mesma coluna do aviso de
gravação (`meetings.consent_notice_version`), com o prefixo `documento-` para as duas
listas nunca se confundirem. As versões ficam em `shared/aviso-do-documento.ts`. Mudou o
que o aviso diz sobre o arquivo? Versão nova no fim da lista, e esta página ganha a seção
dela. As versões anteriores continuam aceitas.

O português é o texto de referência. Os outros 9 idiomas são tradução e precisam de
revisão de tradução.

## Versão documento-2026-11-26 (o arquivo fica até a exclusão)

Decisão do Roberto de 26/11/2026, seguindo a Política de Privacidade revisada pela Cris: o
arquivo e o texto lido ficam até a organizadora apagar a reunião ou encerrar a conta; o
arquivo deixou de ser apagado sozinho aos 30 dias. A única mudança no aviso curto é a frase
da retenção; a caixa é a mesma, e a versão documento-2026-11-19, abaixo, segue aceita.

> Envie só documentos que você pode compartilhar. O arquivo é lido pela IA do Google
> (Gemini), que pode processá-lo fora do Brasil. O arquivo e o texto lido ficam na sua conta
> até você excluir a reunião ou encerrar a conta. Só você acessa, a menos que ligue o link
> de compartilhamento, que mostra o texto e o resumo, mas nunca o arquivo.

## Versão documento-2026-11-19

### O aviso curto, como aparece na tela (pt-BR)

> Envie só documentos que você pode compartilhar. O arquivo é lido pela IA do Google
> (Gemini), que pode processá-lo fora do Brasil. O arquivo fica na sua conta por 30 dias, e
> o texto lido, até você excluir a reunião. Só você acessa, a menos que ligue o link de
> compartilhamento, que mostra o texto e o resumo, mas nunca o arquivo.

A caixa que a dona marca antes de enviar: "Confirmo que posso usar este documento e
autorizo o tratamento privado dele pela IA para gerar o resumo."

Ao ligar o link aberto de um documento, a caixa é outra que a da reunião gravada (que fala
das pessoas que falaram e dos nomes das vozes), e a frase que a dona viu vai para a prova
do link, na auditoria, como hoje (chave `meetings.document.shareAuthorization`): "Confirmo
que posso compartilhar este documento e autorizo que quem receber o link leia o texto lido
dele e o resumo, sem o arquivo."

### O que o aviso cobre, ponto a ponto

1. **Direito sobre o documento.** Quem envia declara que pode usar o documento (direito
   autoral, sigilo de contrato, dados de outras pessoas). A WRW não confere isso; a
   declaração fica gravada na reunião, com a data e a versão do aviso.
2. **Quem processa o arquivo.** A leitura do texto (inclusive o OCR do documento escaneado
   e das fotos), o resumo, o mapa mental, as perguntas e a tradução são feitos pela IA do
   Google (Gemini), por API. O arquivo inteiro e o texto lido vão ao Google para isso.
3. **Transferência internacional.** O Google pode processar o arquivo e o texto fora do
   Brasil (LGPD, arts. 33 a 36).
4. **Dados de outras pessoas no documento.** Um contrato ou uma proposta trazem nomes,
   e-mails e telefones. A IA sugere os contatos que acha, e nenhum entra na rede da dona sem
   ela confirmar.
5. **As fotos.** As fotos do texto são reduzidas e juntadas num PDF no próprio aparelho,
   antes do envio. A foto original, com a localização e os outros dados que a câmera grava
   nela (EXIF), não sai do aparelho.
6. **Retenção.**
   - o arquivo (o PDF enviado, ou o PDF das fotos) fica guardado por 30 dias a partir do
     envio e depois é apagado sozinho, como o áudio da reunião;
   - o texto lido, as traduções, o resumo e o que a dona confirmou ficam até ela excluir a
     reunião ou a conta;
   - excluir a reunião ou a conta apaga tudo, inclusive o arquivo antes dos 30 dias.
7. **Quem acessa.**
   - só a dona da conta que enviou, que vê o texto, o resumo e as páginas do arquivo;
   - o link aberto: se a dona ligar, qualquer pessoa com o endereço `/r/{token}` lê o texto
     lido, o resumo e o mapa mental, traduz e faz perguntas à IA, sem conta na WRW. O
     arquivo nunca sai pelo link. Desligar o link corta o acesso.

### O que NÃO está no aviso, de propósito

- Que o conteúdo não é usado para treinar a IA: fica fora, como no aviso de gravação. Se
  entrar, entra numa versão nova dos dois avisos.

### Para a Cris decidir

- se a declaração sobre o direito de usar o documento basta, ou se o aviso precisa falar
  de documento com dados sensíveis de terceiros (saúde, documentos de identidade) e de
  sigilo contratual;
- a redação final do aviso, das duas caixas (a do envio e a do link) e a revisão das
  traduções nos outros 9 idiomas.
