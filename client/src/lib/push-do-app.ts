/**
 * O token do push no celular que o app das lojas manda à página (a casca Expo,
 * mobile/push.ts). O app grava `window.__wrwTokenDoPush` e dispara o evento
 * EVENTO_DO_TOKEN_DO_PUSH; o site o manda ao servidor com a sessão desta página
 * (components/RegistroDoPush.tsx, server/push-no-celular.ts).
 *
 * No navegador, e nas versões do app sem o push, nada disso existe e nada muda.
 */
export type TokenDoPush = { token: string; plataforma: "ios" | "android" };

export const EVENTO_DO_TOKEN_DO_PUSH = "wrw:token-do-push";

/** O token que o app deixou na página, conferido; fora da forma, null. */
export function tokenDoPushNaPagina(): TokenDoPush | null {
  if (typeof window === "undefined") return null;
  const bruto: unknown = (window as { __wrwTokenDoPush?: unknown }).__wrwTokenDoPush;
  if (!bruto || typeof bruto !== "object") return null;
  const { token, plataforma } = bruto as Record<string, unknown>;
  if (typeof token !== "string" || !token || token.length > 255) return null;
  if (plataforma !== "ios" && plataforma !== "android") return null;
  return { token, plataforma };
}
