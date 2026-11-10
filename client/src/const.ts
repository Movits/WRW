import { urlDoLogin } from "@/lib/caminho-de-volta";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Auth próprio: /login em vez do Manus OAuth. O caminho de volta só vai junto
// quando é um caminho seguro do próprio site (lib/caminho-de-volta.ts).
export const getLoginUrl = (caminhoDeVolta?: string) => urlDoLogin(caminhoDeVolta);
