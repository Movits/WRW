import { Link } from "wouter";

// A Política de Privacidade da Marquesa Global Match, em documento próprio.
//
// Texto provisório nosso, publicado por decisão do Roberto em 25/11/2026 até a
// Cris (assessoria jurídica) mandar o definitivo; ela foi consultada no mesmo
// dia. O motivo da pressa: o Google exige a política publicada para verificar o
// app (login com Google e Google Agenda).
//
// É só a página. NÃO é versão de termo em `document_versions`: publicar uma
// versão nova de termo pelo scripts/publicar-documento.mjs revoga aceites, e a
// política não tem aceite próprio (o cadastro só aponta para ela).
//
// Cada frase daqui foi conferida no código ou nos docs em 25/11/2026. Mudou o
// que o código faz com um dado (prazo, fornecedor, escopo da Google, quem vê o
// quê)? Mude a frase daqui na mesma PR. Fica em pt-BR fixo, como o resto da
// LegalPage: o documento jurídico só existe em português (client/CLAUDE.md).

export const VERSAO_DA_POLITICA = "Versão provisória de 25/11/2026, em revisão pela assessoria jurídica.";

const LINK = "text-[#c98f70] underline";

function Secao({ id, titulo, children }: { id: string; titulo: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="space-y-3 pt-6">
      <h2 id={`${id}-titulo`} className="text-lg font-bold text-white">{titulo}</h2>
      {children}
    </section>
  );
}

function Item({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <li>
      <strong className="text-white/80">{titulo}</strong> {children}
    </li>
  );
}

function Lista({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}

function Citacao({ children }: { children: React.ReactNode }) {
  return <blockquote className="border-l-2 border-white/15 pl-4 italic text-white/50">{children}</blockquote>;
}

const SUMARIO: Array<[string, string]> = [
  ["quem-somos", "1. Quem trata os seus dados"],
  ["encarregado", "2. Encarregado de dados e contato"],
  ["dados", "3. Que dados tratamos e para quê"],
  ["ia", "4. Inteligência artificial"],
  ["compartilhamento", "5. Com quem os dados são compartilhados"],
  ["transferencia", "6. Transferência internacional"],
  ["administracao", "7. Acesso da administração às gravações"],
  ["bases-legais", "8. Bases legais"],
  ["retencao", "9. Por quanto tempo guardamos"],
  ["seguranca", "10. Segurança"],
  ["direitos", "11. Seus direitos e como exercê-los"],
  ["exclusao", "12. Exclusão da conta"],
  ["cookies", "13. Cookies e armazenamento no navegador"],
  ["menores", "14. Menores de idade"],
  ["alteracoes", "15. Alterações desta política"],
];

export function PoliticaDePrivacidade() {
  return (
    <div lang="pt-BR" className="space-y-4">
      <p className="rounded-lg border border-[#c98f70]/30 bg-[#c98f70]/10 px-4 py-3 text-white/80">
        {VERSAO_DA_POLITICA}
      </p>

      <p>
        Esta política explica como a Marquesa Global Match trata os dados pessoais de quem usa a
        plataforma e das pessoas que aparecem nela. Ela detalha o que a cláusula 7 do{" "}
        <Link href="/termos"><span className={`${LINK} cursor-pointer`}>Termo Geral de Uso, Proteção de Dados e Intermediação Digital</span></Link>{" "}
        prevê, e o Termo continua valendo. A sua base de contatos é privada, nada vira público
        sem a sua escolha e nenhum dado é vendido.
      </p>

      <nav aria-label="Sumário">
        <ol className="space-y-1 text-white/50">
          {SUMARIO.map(([id, titulo]) => (
            <li key={id}><a href={`#${id}`} className="hover:text-white">{titulo}</a></li>
          ))}
        </ol>
      </nav>

      <Secao id="quem-somos" titulo="1. Quem trata os seus dados">
        <p>
          A plataforma Marquesa Global Match é da GK Gestão Administrativa e de Negócios LTDA, CNPJ
          62.982.808/0001-79, com sede em Brasília/DF. Ela é a controladora dos dados pessoais nos
          tratamentos em que decide as finalidades e os meios, e pode atuar como operadora quando
          trata dados em nome de outra pessoa ou empresa (Termo Geral, cláusula 1.1).
        </p>
      </Secao>

      <Secao id="encarregado" titulo="2. Encarregado de dados e contato">
        <p>
          O canal do Encarregado pelo tratamento de dados pessoais (DPO) é o e-mail{" "}
          <a href="mailto:wrw@wrwglobal.org" className={LINK}>wrw@wrwglobal.org</a> (Termo Geral,
          cláusula 7.1). A identidade do Encarregado será divulgada nesta página (cláusula 7.21).
          Para questões técnicas, cobranças ou a conta, o suporte é{" "}
          <a href="mailto:support@wrwglobal.org" className={LINK}>support@wrwglobal.org</a>.
        </p>
      </Secao>

      <Secao id="dados" titulo="3. Que dados tratamos e para quê">
        <Lista>
          <Item titulo="Cadastro e conta.">
            Nome, e-mail, senha, a declaração de que você é maior de idade e o registro do aceite
            do Termo Geral (versão e data). A senha nunca é guardada como texto: guardamos só um
            resumo criptográfico dela. Para quê: criar a conta, deixar você entrar e provar o que
            foi aceito.
          </Item>
          <Item titulo="Perfil.">
            Informações profissionais, o que você tem e o que você procura, foto e apresentação.
            Para quê: cruzar o seu perfil com o de outras membras e gerar oportunidades. No
            cruzamento de perfis, o seu nome só aparece para a outra pessoa depois do interesse
            mútuo; antes disso, uma pessoa da equipe (o distribuidor) pode ler os dois perfis para
            conferir se o encontro faz sentido, e essa leitura fica registrada.
          </Item>
          <Item titulo="Contatos da sua rede privada.">
            Os dados que você insere sobre pessoas que conhece: nome, empresa, cargo, telefone,
            e-mail, redes sociais, foto, cartão de visita e o que cada uma possui e procura. Para
            quê: organizar a sua rede e encontrar oportunidades entre os contatos. Todo contato
            nasce privado e só você o vê. Se você escolher o nível Ouro, os contatos marcados ficam
            visíveis às contas Ouro, com o seu consentimento ao termo do Smart Match e com o
            registro de cada leitura. No nível público vão só as oportunidades, sem nome, telefone,
            e-mail ou qualquer dado pessoal do contato. Você é responsável por ter fundamento para
            inserir dados de terceiros (Termo Geral, cláusula 7.5).
          </Item>
          <Item titulo="Reuniões gravadas.">
            O áudio que você grava ou importa fica na sua conta por 30 dias e é apagado
            automaticamente; a transcrição, o resumo e o que foi extraído deles ficam até você
            excluir a reunião. Também pode virar reunião um documento (PDF ou fotos de um texto:
            o arquivo fica 30 dias, o texto lido fica até a exclusão) ou um vídeo público do
            YouTube (guardamos o link, a transcrição e o resumo, nunca o vídeo). As fotos e os
            desenhos que você anexa ao resumo ficam 30 dias. Para quê: transcrever, resumir e
            ligar o que foi dito à sua rede. A reunião é sua: só você acessa, a menos que ligue o
            link de compartilhamento ou envie o resumo por e-mail a quem escolher.
          </Item>
          <Item titulo="Perfil de voz (opcional).">
            Uma amostra curta da sua voz, usada só para identificar você nas transcrições e nos
            resumos das suas reuniões. É um dado biométrico (dado pessoal sensível, art. 11 da
            LGPD) e só existe com um consentimento próprio, separado do aceite dos Termos, que
            fica registrado com data, hora e versão do texto. A cada parte de reunião transcrita
            (cerca de 10 minutos), a amostra vai junto ao Google Gemini, que pode processá-la fora
            do Brasil. Ninguém além de você ouve a amostra, nem a administração. Desligar o perfil,
            a qualquer momento, apaga a amostra de forma definitiva.
          </Item>
          <Item titulo="Login com Google.">
            Se você entra com a sua conta Google, recebemos só o identificador dessa conta e o seu
            e-mail verificado (escopos <code>openid</code> e <code>email</code>). Não recebemos a sua
            senha do Google, a sua foto nem os seus contatos.
          </Item>
          <Item titulo="Google Agenda (opcional).">
            Se você conecta a Google Agenda, a plataforma cria, altera e exclui, na sua agenda
            principal, os eventos das reuniões e dos lembretes que você marca aqui, com os
            convidados que você escolhe. Ela não lê os outros eventos da sua agenda. A
            autorização fica guardada cifrada e é revogada quando você desconecta ou exclui a conta.
          </Item>
          <Item titulo="Face ID e digital.">
            O reconhecimento do rosto ou da digital é feito pelo seu aparelho. A plataforma recebe
            só uma chave pública e o identificador da chave de acesso, nunca a imagem do rosto, a
            digital ou qualquer outro dado biométrico.
          </Item>
          <Item titulo="Verificação de identidade (SIVC).">
            Os documentos que você envia para verificar a identidade e os dados que você declara.
            O documento é lido pela IA (Google Gemini) para extrair os dados e compará-los com o
            que você declarou; o resultado define o seu nível de verificação.
          </Item>
          <Item titulo="Base das associações.">
            Dados de empresas associadas recebidos de entidades conveniadas (federações,
            associações e sindicatos), enquanto o convênio está vigente. O CNPJ, o telefone e o
            e-mail ficam guardados cifrados. Quem encontra um associado na rede vê só "membro da
            entidade" e pede o contato; o telefone e o e-mail só são revelados a quem pediu depois
            que a empresa autoriza, por meio da entidade, e cada revelação fica registrada. A
            pessoa associada só ganha uma conta se ativar o cadastro por um link próprio, e a conta
            nasce só com o que ela confirmar.
          </Item>
          <Item titulo="Dados técnicos e de segurança.">
            Endereço IP, navegador, sessões abertas e o registro de ações sensíveis. Para quê:
            manter a conta segura, detectar abuso e responder a quem pergunta quem acessou os seus
            dados.
          </Item>
          <Item titulo="E-mails.">
            Enviamos e-mail para recuperar a senha, avisar de mudanças de segurança e, quando você
            pede, enviar o resumo de uma reunião às pessoas que você escolher.
          </Item>
        </Lista>
      </Secao>

      <Secao id="ia" titulo="4. Inteligência artificial">
        <p>
          A IA da plataforma é o Google Gemini, usado pela API no plano pago, em que o Google não
          usa os dados enviados para treinar os modelos dele. Ele transcreve o áudio, lê
          documentos, vídeos do YouTube e documentos de identidade, escreve resumos, responde às
          suas perguntas sobre uma reunião, traduz e ajuda a completar os dados dos contatos. O
          Gemini pode processar os dados fora do Brasil.
        </p>
        <p>
          <strong className="text-white/80">Nada que a IA extrai entra sozinho.</strong> O que ela
          sugere (uma pessoa, uma empresa, algo que um contato possui ou procura) chega como
          sugestão, com a origem, e só entra no seu perfil ou na sua rede quando você confirma.
        </p>
        <p>Os avisos que a plataforma mostra antes de usar a IA com áudio dizem o seguinte:</p>
        <Citacao>
          Somente grave com o consentimento de todas as pessoas. O áudio é transcrito pela IA do
          Google (Gemini), que pode processá-lo fora do Brasil e separar as falas por pessoa. O
          áudio fica na sua conta por 30 dias, e a transcrição até você excluir a reunião. Só você
          acessa, a menos que ligue o link de compartilhamento da reunião (o que pede nova
          autorização de quem falou). A administração da Marquesa Global Match só acessa gravações
          por motivo justificado, registrado antes do acesso, e a organizadora é informada da data
          de cada consulta.
        </Citacao>
        <Citacao>
          Para gerar o áudio, o texto do resumo vai ao Gemini, da Google, que o lê com uma voz
          sintética. O áudio fica guardado na sua conta até a reunião ser excluída, e o mesmo resumo
          não é gerado de novo.
        </Citacao>
        <Citacao>
          A legenda ao vivo usa o reconhecimento de voz do navegador. No Google Chrome, o áudio pode
          ser enviado aos servidores do Google para ser convertido em texto. A legenda não é
          guardada pela Marquesa Global Match e desaparece ao fim da reunião.
        </Citacao>
      </Secao>

      <Secao id="compartilhamento" titulo="5. Com quem os dados são compartilhados">
        <p>
          Não vendemos dados pessoais. Para a plataforma funcionar, usamos estes fornecedores, que
          tratam os dados em nosso nome (operadores):
        </p>
        <Lista>
          <Item titulo="Render:">hospedagem da aplicação.</Item>
          <Item titulo="Aiven:">banco de dados.</Item>
          <Item titulo="Backblaze B2:">armazenamento de arquivos (áudios, documentos, fotos).</Item>
          <Item titulo="Resend:">envio de e-mails.</Item>
          <Item titulo="Google:">IA (Gemini), login com Google e Google Agenda. As fontes de letra
            da página também são carregadas dos servidores do Google, que recebem o endereço IP do
            seu navegador.</Item>
          <Item titulo="Daily:">sala de vídeo dentro da plataforma, quando esse recurso entrar no
            ar. Hoje ele ainda não existe.</Item>
        </Lista>
        <p>
          Dentro da plataforma, outras membras só veem o que está descrito na seção 3. Também
          podemos fornecer dados a autoridades quando a lei ou uma ordem judicial exigir.
        </p>
      </Secao>

      <Secao id="transferencia" titulo="6. Transferência internacional">
        <p>
          Alguns desses fornecedores podem tratar os dados em servidores fora do Brasil, e por isso
          pode haver transferência internacional de dados pessoais. Ela é feita nas hipóteses do
          art. 33 da LGPD, como as garantias contratuais oferecidas pelos fornecedores e a
          necessidade de executar o contrato com você.
        </p>
      </Secao>

      <Secao id="administracao" titulo="7. Acesso da administração às gravações">
        <p>
          As suas reuniões são suas. A administração da plataforma (administradoras e presidência,
          nunca uma conta Ouro sem cargo) só consulta uma reunião gravada por motivo justificado:
          apuração de denúncia, segurança, suporte pedido pela própria usuária, obrigação legal ou
          ordem judicial. O motivo é registrado antes de qualquer leitura, e você vê, no detalhe da
          reunião, a data de cada consulta. A administração nunca vê a sua rede particular de
          contatos por esse caminho, nem a amostra do seu perfil de voz.
        </p>
      </Secao>

      <Secao id="bases-legais" titulo="8. Bases legais">
        <p>
          Tratamos dados para executar o contrato com você (art. 7º, V, da LGPD; Termo Geral, cláusula 7.7), com o seu
          consentimento quando ele é pedido (gravação de reuniões, Smart Match, perfil de voz e
          Google Agenda; para o perfil de voz, art. 11, I), para cumprir obrigações legais (art.
          7º, II) e, na segurança da conta e na prevenção de fraudes, pelo legítimo interesse (art.
          7º, IX). O consentimento pode ser retirado a qualquer momento, sem afetar o que foi feito
          antes.
        </p>
      </Secao>

      <Secao id="retencao" titulo="9. Por quanto tempo guardamos">
        <Lista>
          <li>Áudio das reuniões, documentos de reunião e fotos e desenhos do resumo: 30 dias desde o envio.</li>
          <li>Transcrição, resumo, áudio do resumo e o que foi extraído da reunião: até você excluir a reunião.</li>
          <li>Reunião na lixeira: 30 dias; depois é apagada de vez.</li>
          <li>Perfil de voz: até você desligá-lo ou excluir a conta.</li>
          <li>Perfil, contatos e demais dados da conta: até você os excluir ou excluir a conta.</li>
          <li>Sessão de acesso: até 90 dias desde o último uso, ou até você sair.</li>
          <li>Registros de consentimento e de auditoria: o tempo necessário para provar o que foi
            autorizado e quem acessou os seus dados, inclusive depois da exclusão da conta (seção 12).</li>
        </Lista>
      </Secao>

      <Secao id="seguranca" titulo="10. Segurança">
        <p>
          A conexão é cifrada. Os dados sensíveis do cofre, os dados das associações e a
          autorização da Google Agenda ficam guardados com cifra (AES-256-GCM). Os arquivos só são
          entregues a quem está logado e é dono deles. As ações sensíveis ficam em registro de
          auditoria que não se altera: a leitura dos contatos Ouro, a consulta da administração às
          reuniões, a revelação de identidade no match e as mudanças de segurança da conta.
          Nenhum sistema é totalmente invulnerável; se houver incidente de segurança que possa
          causar risco ou dano relevante, comunicaremos as pessoas afetadas e a ANPD, como manda a
          LGPD (art. 48).
        </p>
      </Secao>

      <Secao id="direitos" titulo="11. Seus direitos e como exercê-los">
        <p>Pelo art. 18 da LGPD, você pode pedir:</p>
        <Lista>
          <li>a confirmação de que tratamos os seus dados e o acesso a eles;</li>
          <li>a correção de dados incompletos, inexatos ou desatualizados;</li>
          <li>a anonimização, o bloqueio ou a eliminação de dados desnecessários, excessivos ou tratados em desconformidade com a lei;</li>
          <li>a portabilidade dos dados a outro fornecedor;</li>
          <li>a eliminação dos dados tratados com o seu consentimento;</li>
          <li>a informação sobre com quem compartilhamos os seus dados;</li>
          <li>a informação sobre a possibilidade de não dar o consentimento e o que acontece se não der;</li>
          <li>a revogação do consentimento.</li>
        </Lista>
        <p>
          Muita coisa você faz na própria plataforma: editar o perfil, excluir contatos e
          reuniões, desligar o link de uma reunião, desligar o perfil de voz, desconectar a Google
          Agenda e excluir a conta. Para o resto, escreva ao Encarregado em{" "}
          <a href="mailto:wrw@wrwglobal.org" className={LINK}>wrw@wrwglobal.org</a>. Você também pode
          reclamar à Autoridade Nacional de Proteção de Dados (ANPD).
        </p>
      </Secao>

      <Secao id="exclusao" titulo="12. Exclusão da conta">
        <p>
          Você exclui a conta pela página do seu perfil. A exclusão apaga a conta e os dados
          ligados a ela, inclusive as reuniões, os áudios e o perfil de voz, e revoga a conexão
          com a Google Agenda. Ficam só os registros que provam o que aconteceu: a auditoria de
          quem acessou os seus dados, o registro dos consentimentos e das revogações (sem a voz) e
          as referências à sua conta em registros de outras pessoas, sem nome nem e-mail. Os
          arquivos que você baixou ou os resumos que enviou a outras pessoas ficam com quem os
          recebeu.
        </p>
      </Secao>

      <Secao id="cookies" titulo="13. Cookies e armazenamento no navegador">
        <p>A plataforma não usa cookies de publicidade nem de análise de audiência. Usa só:</p>
        <Lista>
          <li>o cookie de sessão, que mantém você conectada (inacessível a scripts da página);</li>
          <li>o cookie de quem acertou a senha de um link de reunião compartilhado;</li>
          <li>cookies de poucos minutos, cifrados, durante o login com Google e a conexão da Google Agenda.</li>
        </Lista>
        <p>
          O navegador também guarda preferências da tela (como o idioma), que ficam só no seu
          aparelho.
        </p>
      </Secao>

      <Secao id="menores" titulo="14. Menores de idade">
        <p>
          A plataforma é só para maiores de 18 anos (Termo Geral, cláusula 3.4), e o cadastro pede
          essa declaração.
        </p>
      </Secao>

      <Secao id="alteracoes" titulo="15. Alterações desta política">
        <p>
          Esta é uma versão provisória e vai ser substituída pela versão revisada pela assessoria
          jurídica. Sempre que a política mudar, a nova versão e a data ficam no topo desta página,
          e mudanças relevantes serão avisadas na plataforma ou por e-mail.
        </p>
      </Secao>
    </div>
  );
}
