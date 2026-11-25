import { ROTA_GRAVAR } from "@shared/rotas";

const TAMANHO_MAXIMO = 512;

// Voltar a uma tela de entrada depois do login daria laço ou reabriria o
// formulário que a pessoa acabou de preencher. Comparadas sem a barra final e
// sem caixa, porque o wouter casa "/login/" e "/LOGIN" com a rota /login.
const TELAS_DE_ENTRADA = new Set(["/", "/login", "/register", "/forgot-password", "/reset-password", "/onboarding", "/404"]);

// Só serve para resolver o caminho e conferir que ele não saiu do site.
const ORIGEM_FICTICIA = "https://wrw.invalid";

/**
 * O `?voltar=` do login só aceita caminho do próprio site, senão o link de
 * entrada vira trampolim para outro endereço. O caminho começa com uma barra e
 * nunca com duas (`//exemplo.com` é outra origem), não tem barra invertida (o
 * navegador lê `/\exemplo.com` como `//exemplo.com`) nem espaço ou caractere de
 * controle (tab e quebra de linha somem da URL e juntariam as barras), e,
 * resolvido contra uma origem fictícia, continua nela. A regra das duas barras
 * vale também DEPOIS da normalização: os segmentos "." e ".." somem e podem
 * deixar `//` no começo (`/..//exemplo.com` vira `//exemplo.com`). Devolve o
 * caminho normalizado (pathname, search e hash) ou null.
 */
export function caminhoDeVoltaSeguro(valor: unknown): string | null {
  if (typeof valor !== "string" || valor.length === 0 || valor.length > TAMANHO_MAXIMO) return null;
  if (!valor.startsWith("/") || valor.startsWith("//")) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(valor)) return null;
  let url: URL;
  try {
    url = new URL(valor, ORIGEM_FICTICIA);
  } catch {
    return null;
  }
  if (url.origin !== ORIGEM_FICTICIA) return null;
  if (url.pathname.startsWith("//")) return null;
  // O wouter casa a rota com o caminho decodificado (decodeURI): "/%6Cogin" abre
  // o /login. A comparação com as telas de entrada usa o mesmo caminho.
  let decodificado = url.pathname;
  try {
    decodificado = decodeURI(url.pathname);
  } catch {
    // Como o wouter: o que não decodifica é comparado como veio.
  }
  const tela = (decodificado.replace(/\/+$/, "") || "/").toLowerCase();
  if (TELAS_DE_ENTRADA.has(tela)) return null;
  return url.pathname + url.search + url.hash;
}

/**
 * `?entrar` no /login pede o formulário mesmo com uma sessão viva no aparelho
 * (sem ele, quem já está logada segue direto para o app: pages/Login.tsx).
 */
export const PARAMETRO_ENTRAR = "entrar";

/**
 * O login com o formulário garantido: para onde o cadastro e a redefinição de
 * senha mandam ("agora faça login"). Num aparelho com outra conta logada, o
 * /login simples levaria a pessoa para dentro da conta alheia.
 */
export const LOGIN_COM_FORMULARIO = `/login?${PARAMETRO_ENTRAR}=1`;

/** O endereço do login, levando o caminho de volta quando ele é seguro. */
export function urlDoLogin(caminhoDeVolta?: string | null) {
  const caminho = caminhoDeVoltaSeguro(caminhoDeVolta);
  return caminho ? `/login?voltar=${encodeURIComponent(caminho)}` : "/login";
}

/**
 * Para onde o login manda. Cadastro por concluir vai ao /onboarding e ignora o
 * voltar, porque é lá que o cadastro termina (o fim do cadastro segue levando
 * ao Dashboard). Senão, vale o `?voltar=` seguro ou o gravador.
 */
export function destinoDepoisDoLogin(cadastroConcluido: boolean, search?: string | null) {
  if (!cadastroConcluido) return "/onboarding";
  const voltar = new URLSearchParams(search ?? "").get("voltar");
  return caminhoDeVoltaSeguro(voltar) ?? ROTA_GRAVAR;
}
