/**
 * Entrar com a conta Google (A8 da auditoria; HN-80 do HiNoter): os caminhos
 * das duas rotas do servidor (server/rotas-de-entrar-com-google.ts) e o
 * resultado que a volta da Google traz à tela em `?conta-google=`, que a tela
 * traduz. Nada aqui lê o ambiente: o mesmo código roda no navegador.
 *
 * A ida e a volta são navegação de página inteira (um `<a href>`, nunca o Link
 * do wouter nem um popup), como na Google Agenda (shared/google-agenda.ts).
 */

/** O botão leva aqui, com `?modo=` e, no login, o `?voltar=` da tela. */
export const ROTA_IR_ENTRAR_COM_GOOGLE = "/api/entrar-com-google/ir";
/** A Google volta aqui (o URI de retorno que precisa estar cadastrado no Google Cloud). */
export const ROTA_RETORNO_ENTRAR_COM_GOOGLE = "/api/entrar-com-google/retorno";
/** O caminho do cookie da ida: só as duas rotas o recebem. */
export const CAMINHO_DAS_ROTAS_DE_ENTRAR_COM_GOOGLE = "/api/entrar-com-google";

/**
 * - `entrar`: o botão do login. Só entra numa conta que já tem esta conta
 *   Google ligada; não cria conta (a tela de cadastro cria).
 * - `cadastrar`: o botão do cadastro. Entra, se a conta Google já está ligada;
 *   cria a conta, se o e-mail dela não existe na WRW.
 * - `ligar`: o Perfil, com sessão. Liga a conta Google à conta logada.
 */
export const MODOS_DE_ENTRAR_COM_GOOGLE = ["entrar", "cadastrar", "ligar"] as const;
export type ModoDeEntrarComGoogle = (typeof MODOS_DE_ENTRAR_COM_GOOGLE)[number];

export const PARAMETRO_DA_CONTA_GOOGLE = "conta-google";

/**
 * O que a volta deixa na tela (login, cadastro ou Perfil):
 * - `negada`: a pessoa não autorizou na tela da Google;
 * - `expirou`: passou do prazo da ida (10 min) ou o cookie da ida sumiu;
 * - `erro`: qualquer outra falha (cookie adulterado, Google ou banco fora do ar);
 * - `email-nao-verificado`: a Google não garante o e-mail da conta;
 * - `sem-conta`: no login, nenhuma conta da WRW tem esta conta Google ligada
 *   e nenhuma tem o e-mail dela (a tela de cadastro cria);
 * - `conta-existe`: já há conta da WRW com o e-mail desta conta Google, sem
 *   ela ligada. A WRW não liga sozinha: a pessoa entra com a senha e liga no
 *   Perfil;
 * - `desativada`: a conta da WRW foi desativada;
 * - `muitas-tentativas`: o teto de tentativas desta rede ou o bloqueio do login;
 * - `ligada`: no Perfil, a conta Google foi ligada;
 * - `em-outra-conta`: no Perfil, esta conta Google já entra em outra conta da WRW;
 * - `outra-ligada`: no Perfil, esta conta da WRW já tem outra conta Google ligada;
 * - `entre-de-novo`: no Perfil, ligar pede um login dos últimos 10 minutos;
 * - `endereco`: no Perfil, a pessoa começou por um endereço que não é o do
 *   FRONTEND_URL, e a volta cairia em outro host, sem o cookie da ida.
 */
export const RESULTADOS_DA_CONTA_GOOGLE = [
  "negada",
  "expirou",
  "erro",
  "email-nao-verificado",
  "sem-conta",
  "conta-existe",
  "desativada",
  "muitas-tentativas",
  "ligada",
  "em-outra-conta",
  "outra-ligada",
  "entre-de-novo",
  "endereco",
] as const;
export type ResultadoDaContaGoogle = (typeof RESULTADOS_DA_CONTA_GOOGLE)[number];

/** A tela de cada modo: o login, o cadastro ou o Perfil. */
export function telaDoModo(modo: ModoDeEntrarComGoogle): "/login" | "/register" | "/profile" {
  return modo === "entrar" ? "/login" : modo === "cadastrar" ? "/register" : "/profile";
}

export function rotaDoResultadoDaContaGoogle(tela: "/login" | "/register" | "/profile", resultado: ResultadoDaContaGoogle): string {
  return `${tela}?${PARAMETRO_DA_CONTA_GOOGLE}=${resultado}`;
}

/** O resultado da busca da URL (com ou sem o "?"), ou null se não há ou é desconhecido. */
export function lerResultadoDaContaGoogle(busca: string): ResultadoDaContaGoogle | null {
  const valor = new URLSearchParams(busca).get(PARAMETRO_DA_CONTA_GOOGLE);
  return valor && (RESULTADOS_DA_CONTA_GOOGLE as readonly string[]).includes(valor) ? valor as ResultadoDaContaGoogle : null;
}

/** O endereço do botão: absoluto, na origem do FRONTEND_URL, para a volta achar o cookie da ida. */
export function enderecoDoBotaoDoGoogle(origem: string, modo: ModoDeEntrarComGoogle, voltar?: string | null): string {
  const parametros = new URLSearchParams({ modo });
  if (voltar) parametros.set("voltar", voltar);
  return `${origem}${ROTA_IR_ENTRAR_COM_GOOGLE}?${parametros.toString()}`;
}

/** Os códigos das recusas do tRPC (a tela escolhe a frase no idioma de quem lê). */
export const ERRO_DA_CONTA_GOOGLE = {
  /** A função está desligada (faltam variáveis). */
  indisponivel: "CONTA_GOOGLE_INDISPONIVEL",
  /** Não há conta Google ligada para desligar. */
  naoLigada: "CONTA_GOOGLE_NAO_LIGADA",
  /** Desligar deixaria a conta sem senha: a pessoa cria uma antes ("Esqueci minha senha"). */
  semSenha: "CONTA_GOOGLE_SEM_SENHA",
} as const;
