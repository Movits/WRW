/**
 * Quanto a sessão dura. Pedido do Roberto em 10/11/2026: quem já entrou não
 * deve ter de digitar e-mail e senha de novo. Antes eram 8 horas fixas desde o
 * login (no banco, no token e no cookie) e, no navegador, um corte aos 30
 * minutos sem mexer na tela.
 *
 * Agora a janela é DESLIZANTE e conta desde o último uso:
 *
 * - no banco, cada requisição autenticada empurra `sessions.expiresAt` para
 *   agora + DURACAO_DA_SESSAO_MS, no mesmo UPDATE que já gravava
 *   `lastActivityAt` (`validateSessionToken`, em server/security.ts);
 * - o token (JWT) e o cookie vencem junto com a janela e são reemitidos no
 *   máximo uma vez a cada RENOVAR_O_TOKEN_A_CADA_MS (`renovarCookieDaSessao`,
 *   em server/sessao.ts, chamado pelo createContext).
 *
 * Quem usa o app pelo menos uma vez a cada 90 dias nunca mais vê o login.
 * O que encerra a sessão antes disso continua igual: sair da conta, redefinir
 * a senha, excluir a conta e a desativação pela administração revogam a linha
 * no banco, e o sdk confere essa linha em toda requisição.
 *
 * Arquivo próprio, e não em auth.ts, porque security.ts também precisa do
 * número e auth.ts já importa security.ts.
 */
export const DURACAO_DA_SESSAO_MS = 90 * 24 * 60 * 60 * 1000;

/** De quanto em quanto tempo, no máximo, o token e o cookie são reemitidos. */
export const RENOVAR_O_TOKEN_A_CADA_MS = 24 * 60 * 60 * 1000;
