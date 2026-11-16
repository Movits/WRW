/**
 * As chaves de acesso (passkeys, WebAuthn): entrar com Face ID, digital ou o
 * bloqueio de tela do aparelho, no lugar do e-mail e da senha (A6 do desenho do
 * gravador, docs/arquitetura/gravador-de-reunioes.md). O servidor mora em
 * server/chaves-de-acesso.ts; aqui fica o que os dois lados leem.
 *
 * Os erros saem como CÓDIGO, nunca como frase pronta em pt-BR: o servidor não
 * sabe o idioma de quem lê, e a tela (A7) traduz cada código nos 10 idiomas. É
 * o mesmo princípio do CODIGO_ERRO_INTERROMPIDO (shared/const.ts). O código vai
 * na `message` do TRPCError; o `code` do tRPC diz só a família do erro.
 */
export const ERRO_DA_CHAVE_DE_ACESSO = {
  /**
   * A função está desligada: faltam WEBAUTHN_RP_ID e WEBAUTHN_ORIGENS, elas
   * estão erradas, ou o pedido veio de uma origem fora da lista (o endereço
   * .onrender.com, por exemplo). A tela nem mostra o botão nesse caso
   * (`chavesDeAcesso.estado`).
   */
  indisponivel: "CHAVE_INDISPONIVEL",
  /** O desafio não existe, venceu, já foi usado, é de outra finalidade ou de outra conta. */
  desafioInvalido: "CHAVE_DESAFIO_INVALIDO",
  /** A resposta do aparelho veio sem o formato esperado. */
  respostaInvalida: "CHAVE_RESPOSTA_INVALIDA",
  /**
   * A conferência recusou a resposta: assinatura, origem, domínio, contador que
   * voltou, a pessoa não verificada pelo aparelho.
   */
  recusada: "CHAVE_RECUSADA",
  /**
   * A chave usada na entrada não está ligada a nenhuma conta: foi removida, a
   * senha foi redefinida ou a conta foi excluída. A tela pode avisar o aparelho
   * (PublicKeyCredential.signalUnknownCredential) e oferecer e-mail e senha.
   */
  desconhecida: "CHAVE_DESCONHECIDA",
  /** A conta da chave está desativada. */
  contaDesativada: "CHAVE_CONTA_DESATIVADA",
  /** Muitas tentativas a partir desta rede, ou a conta bloqueada por tentativas. */
  muitasTentativas: "CHAVE_MUITAS_TENTATIVAS",
  /** A chave deste aparelho já está cadastrada. */
  jaCadastrada: "CHAVE_JA_CADASTRADA",
  /** A conta chegou ao máximo de chaves (CHAVES_POR_CONTA_MAX). */
  limiteDaConta: "CHAVE_LIMITE_DA_CONTA",
  /** A chave não existe ou não é desta conta (renomear, remover). */
  naoEncontrada: "CHAVE_NAO_ENCONTRADA",
  /**
   * Cadastrar uma chave pede entrada recente: a sessão deste aparelho foi
   * aberta há mais de MINUTOS_PARA_CADASTRAR_CHAVE minutos. A tela pede a senha,
   * entra de novo por `auth.login` (o que abre uma sessão nova, com o bloqueio
   * por tentativas do login) e repete o pedido. Sem isso, quem estivesse com a
   * sessão de outra pessoa (o computador do evento esquecido aberto, o cookie
   * copiado) criaria uma credencial que sobrevive a "Sair" e à revogação das
   * sessões.
   */
  reautenticar: "CHAVE_REAUTENTICAR",
  /** A sessão da entrada com a chave não pôde ser aberta, por um erro que não é o banco fora do ar. */
  erroInterno: "CHAVE_ERRO_INTERNO",
} as const;

export type CodigoDeErroDaChaveDeAcesso =
  (typeof ERRO_DA_CHAVE_DE_ACESSO)[keyof typeof ERRO_DA_CHAVE_DE_ACESSO];

/** Quantas chaves uma conta pode ter: o bastante para os aparelhos de uma pessoa. */
export const CHAVES_POR_CONTA_MAX = 10;

/** O apelido que a dona dá à chave ("iPhone da Glenda"), depois do trim. */
export const APELIDO_DA_CHAVE_MAX = 60;

/**
 * Até quantos minutos depois de entrar (com a senha ou com uma chave) a sessão
 * cadastra uma chave nova. Cabe o convite logo depois do login, da A7; depois
 * disso, CHAVE_REAUTENTICAR.
 */
export const MINUTOS_PARA_CADASTRAR_CHAVE = 10;
