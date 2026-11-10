import { TRPCClientError } from "@trpc/client";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { urlDoLogin } from "./caminho-de-volta";

// Não redirecionar se já está em páginas públicas (evita loop de login duplo).
const PAGINAS_PUBLICAS = ["/login", "/register", "/forgot-password", "/reset-password", "/"];

/**
 * Para onde mandar a pessoa quando uma consulta descobre que a sessão venceu,
 * ou null para não redirecionar. A sessão que vence no meio do uso volta à
 * mesma tela depois do login (o caminho vai pelo ?voltar=). Sai do main.tsx
 * para ser testável sem montar o app.
 */
export function destinoPorSessaoVencida(erro: unknown, local: { pathname: string; search: string }): string | null {
  if (!(erro instanceof TRPCClientError)) return null;
  if (erro.message !== UNAUTHED_ERR_MSG) return null;
  const ehPublica = PAGINAS_PUBLICAS.some(p => local.pathname === p || local.pathname.startsWith(p + "?"));
  if (ehPublica) return null;
  return urlDoLogin(local.pathname + local.search);
}
