# E-mail do resumo da reunião — RASCUNHO para a Cris revisar

**Situação:** rascunho, junto com a H22 (o resumo por e-mail; HN-54 do HiNoter e R-33 da
reunião de 11/11/2026). O texto já está na tela e no código, nas chaves `emailDoResumo.*`
(o e-mail) e `resumoPorEmail.*` (o painel) dos 10 idiomas de `client/src/i18n/locales/`.
O português é o texto de referência; os outros 9 idiomas são tradução e precisam de
revisão de tradução. Mudar o texto é mudar essas chaves, nos 10 idiomas
(`/texto-de-tela`); não há versão gravada do texto do e-mail, como há do aviso de
gravação.

## O que a função faz

- No detalhe de uma reunião com o resumo pronto, a dona escolhe quem recebe: ela mesma,
  participantes da agenda da reunião (o nome e o e-mail que ela mesma cadastrou ao marcar)
  e até 10 e-mails digitados. A WRW manda um e-mail a cada pessoa, sem cópia para as
  outras, com o **link aberto** da reunião (o mesmo do "Compartilhar por link").
- Quem recebe abre, sem conta na WRW, o que o link aberto já abria: o resumo, a
  transcrição, a gravação enquanto ela existir (30 dias) e o Pergunte à IA, com os nomes
  que a dona deu às vozes.
- **Com a senha e o áudio do link (H23, no Pacote 4d):** a dona pode tirar o áudio do
  link e pôr nele uma senha de 6 dígitos. O e-mail segue o link como ele está na hora do
  envio: sem o áudio, não fala da gravação; com a senha, diz que ela não vai no e-mail e
  a quem pedi-la. A senha nunca vai no e-mail (o banco só guarda o hash dela). O link que
  o envio liga, quando estava desligado, é o de antes da H23: sem senha e com o áudio.
- Se o link estiver desligado, a dona marca a mesma caixa do "Compartilhar por link"
  (*"Confirmo que todas as pessoas que falaram nesta reunião autorizaram…"*), e o link liga
  junto com o envio. A frase marcada, o idioma, o IP e o navegador vão para a auditoria.
- O e-mail não leva nada da reunião além do título e do nome da conta da dona. Não há
  campo de texto livre. Endereço web e endereço de e-mail no título ou no nome viram "…"
  (inclusive o domínio sem "http", como "bit.ly/x"): o único link do e-mail é o da WRW.
- **Envio automático** (desligado por padrão): a dona pode ligar, para a conta dela, o
  e-mail "o resumo ficou pronto" no fim de cada reunião. Ele vai **só para ela**, com o
  link da reunião dentro da conta (pede entrar), e não liga o link aberto.
- Tetos: 20 pessoas por envio, 30 e-mails por reunião e 50 por conta a cada 24 horas.
- Guardado: para quem foi cada e-mail, quando e se saiu (tabela `resumo_por_email`).
  Excluir a reunião apaga os endereços; excluir a conta apaga as linhas. A auditoria
  guarda quantos e-mails, de que origem e um hash de cada endereço, nunca o endereço.

## Perguntas para a Cris

1. **Base legal** do envio a terceiros (as participantes e os e-mails digitados): o
   legítimo interesse da dona? A WRW é operadora, e a dona, controladora desses dados?
   O texto do e-mail precisa dizer isso, ou citar a Política de Privacidade (que ainda
   não está publicada)?
2. O e-mail leva o **nome da dona** (do cadastro) no assunto e no corpo, para quem recebe
   saber de quem é. O link aberto, de propósito, não mostra o nome dela. Pode?
3. Falta um **"não quero mais receber"**? Hoje não há descadastro: quem recebe não tem
   conta, e cada e-mail sai de um pedido da dona, sem lista.
4. A confirmação de que "as pessoas autorizaram" vale para mandar o link a quem a dona
   digitar, que pode não ter estado na reunião?
5. O aviso de encaminhamento ("Não o encaminhe a quem não deve ver o que foi dito") basta?
6. Com o link com senha (H23), o e-mail diz que a senha não vai nele e manda pedi-la à
   dona, pelo nome dela, e o painel avisa a dona de que a senha vai por ela, à parte.
   Basta, ou o e-mail deve dizer mais (por exemplo, não mandar a senha pelo mesmo canal)?

## O texto em português (referência)

### O e-mail às participantes e aos e-mails digitados

- **Assunto:** {nome da dona} compartilhou com você o resumo de uma reunião
  (sem nome na conta: "O resumo de uma reunião foi compartilhado com você")
- **Título:** Resumo da reunião
- {nome da dona} compartilhou com você o resumo da reunião "{título}", gravada na WRW.
  (sem nome: "Você recebeu o resumo da reunião "{título}", gravada na WRW.")
- Pelo link, você lê o resumo e a transcrição, ouve a gravação enquanto ela estiver
  guardada e pode fazer perguntas à IA sobre a reunião. Não precisa ter conta na WRW.
  (link sem o áudio, H23: "Pelo link, você lê o resumo e a transcrição e pode fazer
  perguntas à IA sobre a reunião. Não precisa ter conta na WRW.")
- (só no link com senha, H23) Este link pede uma senha de 6 dígitos, que não vai neste
  e-mail: peça a senha a {nome da dona}. (sem nome: "…peça a senha a quem gravou a
  reunião.")
- **Botão:** Abrir o resumo
- Se o botão não funcionar, copie este endereço no navegador: {link}
- Quem tiver este link abre a reunião. Não o encaminhe a quem não deve ver o que foi dito.
- Você recebeu este e-mail porque {nome da dona} o mandou a você pela WRW. Se não esperava
  por ele, pode ignorá-lo. (sem nome: "…porque quem gravou a reunião o mandou a você…")
- Este é um e-mail automático: não responda.
- WRW — Women Rocking the World

### O e-mail que a dona manda a si mesma

- **Assunto:** O link aberto da sua reunião "{título}"
- Aqui está o link aberto da sua reunião "{título}", para guardar ou encaminhar.
- (o mesmo parágrafo do que o link abre, o botão, o aviso de encaminhamento)
- (só no link com senha, H23) Este link pede a senha de 6 dígitos que você criou, e ela
  não vai neste e-mail. Ao encaminhar o link, mande a senha à parte.
- Você recebeu este e-mail porque pediu à WRW que o mandasse a você.

### O e-mail automático (só para a dona)

- **Assunto:** O resumo da reunião "{título}" está pronto
- O resumo da sua reunião "{título}" ficou pronto na WRW.
- O link abre a reunião na sua conta: é preciso entrar com o seu e-mail e a sua senha.
- **Botão:** Abrir a reunião
- Você recebeu este e-mail porque ligou o envio automático do resumo. Para desligar, abra
  uma reunião pronta na WRW e desmarque a opção em "Mandar o resumo por e-mail".

### No painel da dona

- Mandar o resumo por e-mail. A WRW manda o link aberto desta reunião, com o resumo, a
  quem você escolher. Quem recebe não precisa de conta.
- Com o link desligado: "O link aberto desta reunião está desligado. Para mandar o
  resumo, ele será ligado agora: qualquer pessoa com o link abre a reunião, até você
  desligá-lo." e a caixa da confirmação do "Compartilhar por link".
- Com o link com senha (H23): "O link desta reunião pede senha, e a senha não vai no
  e-mail: mande-a à parte a quem receber."
- O e-mail tem um texto fixo e vai em {idioma}, o idioma da reunião.
- Me mandar o resumo por e-mail quando cada reunião ficar pronta. Vale para as próximas
  reuniões. Vai só para você, com o link da reunião na sua conta. Para mandar às
  participantes, use este painel.
