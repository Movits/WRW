/**
 * As telas que o app das lojas (a casca Expo em mobile/) já mostra na barra de
 * abas de baixo. O app grava a lista em `window.__wrwRotasDaBarraDoApp` antes de
 * o site montar (mobile/abas.ts), e o Menu do site deixa de repetir essas telas:
 * no celular, o menu com as 9 telas tomava a tela e escondia o Sair.
 *
 * No navegador, e nas versões do app sem a barra, a lista não existe e o menu
 * fica inteiro. É só arrumação da tela: quem chega a cada página continua sendo
 * decidido pelas rotas (ProtectedRoute) e pelo servidor.
 */
export function rotasNaBarraDoApp(): string[] {
  if (typeof window === "undefined") return [];
  const lista: unknown = (window as { __wrwRotasDaBarraDoApp?: unknown }).__wrwRotasDaBarraDoApp;
  if (!Array.isArray(lista)) return [];
  return lista.filter((rota): rota is string => typeof rota === "string" && rota.startsWith("/"));
}
