import { useSyncExternalStore } from "react";

/**
 * A dica de instalação do app no /gravar (decisão 8 do plano do gravador; o
 * manifest é o da PR #172, que deixou a dica para uma PR seguinte). Aqui ficam
 * as peças que não são tela, para o teste:
 *
 * - plataformaDeInstalacao: o caminho de instalação deste aparelho, ou se a
 *   página já está aberta como app. Só lê o navegador; nada sai da página.
 * - o pedido de instalação do Chromium (o Chrome e o Edge; outros Chromium
 *   podem mandá-lo também), que deixa a dica oferecer o botão "Instalar o app". Ele chega uma vez por
 *   carga e às vezes antes de o gravador montar (a página de Reuniões é
 *   carregada sob demanda): por isso o main.tsx liga a escuta na carga e o
 *   pedido fica guardado aqui.
 * - a marca da dica no aparelho: fechada, ou o app já instalado. Sem dado de
 *   usuária, e o logout não a apaga, porque a dica é do aparelho.
 *
 * Não há service worker, de propósito (server/manifest-do-app.test.ts). O
 * Chrome instala pelo menu sem ele desde a versão 108 no Android e a 112 no
 * computador, e dispara o pedido só com o manifest, depois de um toque e de
 * 30 s na página (web.dev, "Installation criteria", 19/09/2024).
 */

/** O beforeinstallprompt do Chromium. Não está no lib.dom do TypeScript. */
export interface PedidoDeInstalacao extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

export type Plataforma =
  /** Aberta como app (da tela de início, do Dock ou da casca das lojas): a dica não aparece. */
  | "app-instalado"
  /** iPhone e iPad, no Safari ou em outro navegador: Compartilhar > Adicionar à Tela de Início. */
  | "ios"
  /** Navegador de dentro de outro app (Instagram, Facebook, WebView...): não instala. */
  | "navegador-embutido"
  /** O Chrome no Android, também no modo computador do tablet: ⋮ > Instalar e criar atalho. */
  | "android"
  /** Qualquer outro navegador no Android (Samsung Internet, Silk, Firefox, Opera, Edge...): o caminho é abrir no Chrome. */
  | "android-outro-navegador"
  /** Safari no Mac: Arquivo > Adicionar ao Dock, do macOS Sonoma (14) em diante. */
  | "mac-safari"
  /** O Chrome e o Edge no computador: Instalar, na barra de endereço. */
  | "computador"
  /** Qualquer outro navegador (Firefox, Opera, HarmonyOS...): o conselho de abrir num que instala. */
  | "sem-instalacao";

export interface AmbienteDoNavegador {
  userAgent: string;
  /** O iPad se apresenta como Mac desde o iPadOS 13: a tela de toque o denuncia. */
  maxTouchPoints: number;
  /** Aberta como app: display-mode standalone, ou navigator.standalone no iPhone. */
  abertoComoApp: boolean;
}

// Navegadores de dentro de outros apps (Facebook, Instagram, LinkedIn, Line,
// Snapchat, TikTok, WeChat e o app Google no iPhone, que leva "Safari/" no
// userAgent mas não oferece "Adicionar à Tela de Início") e a WebView do
// Android ("; wv)"): não instalam, e o caminho é abrir a página no navegador.
const NAVEGADOR_EMBUTIDO = /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|\bLine\/|Snapchat|TikTok|musical_ly|Bytedance|MicroMessenger|\bGSA\/|; wv\)/i;
// A casca das lojas (PR #180) se identifica assim, e é uma WebView: vem antes.
const CASCA_DAS_LOJAS = /\bWRWApp\//;
const CHROMIUM = /Chrome\/|Chromium\/|Edg\//;
// Lista branca: os passos de um menu só para o navegador que tem esse menu. No
// Chrome, logo depois de "(KHTML, like Gecko)" vem o próprio "Chrome/x", seguido
// só de "Safari/y" ("Mobile Safari/y" no celular); o Safari do Mac termina em
// "Version/x Safari/y". Os outros põem o nome deles antes do Chrome (Samsung
// Internet, Silk dos tablets Fire, WebView com "Version/4.0"), no meio (Yandex,
// UC, DuckDuckGo do Android) ou no fim (Opera, Edge, Mi, DuckDuckGo do Mac), e a
// regra não casa. O Brave e o Vivaldi se apresentam como o Chrome, e o caminho
// deles é parecido. Navegador que a lista não conhece recebe o conselho de abrir
// num que instala, em vez de passos de um menu que talvez não exista.
const CHROME = /\(KHTML, like Gecko\) Chrome\/[\d.]+ (?:Mobile )?Safari\/[\d.]+$/;
const SAFARI_DO_MAC = /Version\/[\d.]+ Safari\/[\d.]+$/;
const EDGE_NO_COMPUTADOR = /\bEdg\/[\d.]+$/;

/**
 * Aberta dentro da casca das lojas (PR #180)? É uma WebView: o que sai do
 * endereço da WRW abre no navegador do sistema, com outros cookies e sem a
 * sessão, e a Google recusa login dentro de WebView. Fluxo que depende disso
 * (a conexão com a Google Agenda) manda usar o navegador.
 */
export function abertoNaCascaDasLojas(userAgent: string): boolean {
  return CASCA_DAS_LOJAS.test(userAgent);
}

export function plataformaDeInstalacao({ userAgent, maxTouchPoints, abertoComoApp }: AmbienteDoNavegador): Plataforma {
  if (abertoComoApp || abertoNaCascaDasLojas(userAgent)) return "app-instalado";
  if (NAVEGADOR_EMBUTIDO.test(userAgent)) return "navegador-embutido";
  const mac = /Macintosh/.test(userAgent);
  if (/iPhone|iPad|iPod/.test(userAgent) || (mac && maxTouchPoints > 1)) {
    // No iPhone, o Chrome, o Edge e o Firefox também adicionam à tela de início
    // pelo Compartilhar (desde o iOS 16.4), e todos levam "Safari/" no
    // userAgent; a WebView de um app (WKWebView) não leva, nem instala.
    return /Safari\//.test(userAgent) ? "ios" : "navegador-embutido";
  }
  // O Android: o celular e o tablet, também no modo computador, em que o
  // tablet se apresenta como Linux e a tela de toque o denuncia, como no iPad
  // (o custo é um notebook Linux com tela de toque contar como Android; o
  // Chromebook se apresenta como "X11; CrOS" e não cai aqui). O Samsung
  // Internet só existe no Android, inclusive no DeX, sem tela de toque.
  const android =
    /Android/i.test(userAgent) ||
    /SamsungBrowser\//.test(userAgent) ||
    (/X11; Linux/.test(userAgent) && maxTouchPoints > 1 && CHROMIUM.test(userAgent));
  if (android) return CHROME.test(userAgent) ? "android" : "android-outro-navegador";
  if (CHROME.test(userAgent) || EDGE_NO_COMPUTADOR.test(userAgent)) return "computador";
  // O "Adicionar ao Dock" só existe do macOS Sonoma (14) em diante, e o
  // userAgent do Safari fixa o sistema em 10_15_7: o texto da dica avisa isso
  // e diz o que fazer nos anteriores.
  if (mac && SAFARI_DO_MAC.test(userAgent)) return "mac-safari";
  // Firefox (que no Windows, desde o 143, fixa o site na barra de tarefas, por
  // outro caminho), Opera, HarmonyOS NEXT e o resto: abrir num que instala.
  return "sem-instalacao";
}

// "standalone" é o display do manifest; "window-controls-overlay" é o mesmo
// app no computador com a barra de título recolhida. O "fullscreen" fica de
// fora: a tela cheia do próprio navegador (F11) também o satisfaz.
const MODOS_DE_APP = ["standalone", "window-controls-overlay"];

/** O ambiente deste navegador, lido na hora. */
export function ambienteAtual(): AmbienteDoNavegador {
  const navegador = window.navigator as Navigator & { standalone?: boolean };
  // O jsdom dos testes não tem matchMedia; navegador de verdade sem ele, também não abre como app.
  const consulta = typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null;
  return {
    userAgent: navegador.userAgent,
    maxTouchPoints: navegador.maxTouchPoints ?? 0,
    abertoComoApp:
      navegador.standalone === true ||
      (consulta !== null && MODOS_DE_APP.some(modo => consulta(`(display-mode: ${modo})`).matches)),
  };
}

/**
 * A marca da dica no aparelho: "fechada" (a pessoa fechou) ou "instalado" (o
 * app foi instalado, ou a página abriu como app). Qualquer uma esconde a dica.
 * No Chromium, a aba e o app instalado dividem o armazenamento: abrir o app uma
 * vez já tira a dica da aba. No iPhone, não: o app da tela de início guarda
 * tudo à parte do Safari, e só fechar a dica a tira de lá.
 */
export const CHAVE_DA_DICA = "mmm:dica-de-instalacao";

export function dicaDispensadaNoAparelho(): boolean {
  try {
    return localStorage.getItem(CHAVE_DA_DICA) !== null;
  } catch {
    // Armazenamento bloqueado (modo privado): a dica aparece.
    return false;
  }
}

export function marcarDicaNoAparelho(motivo: "fechada" | "instalado") {
  try {
    localStorage.setItem(CHAVE_DA_DICA, motivo);
  } catch {
    // Sem armazenamento: quem chama esconde a dica nesta visita.
  }
}

export interface EstadoDaInstalacao {
  /** Há pedido do Chromium guardado: a dica pode oferecer o botão "Instalar o app". */
  podePedir: boolean;
  /** O app foi instalado nesta visita (o appinstalled do Chromium). */
  instaladoNestaVisita: boolean;
}

const INICIAL: EstadoDaInstalacao = { podePedir: false, instaladoNestaVisita: false };

let pedidoGuardado: PedidoDeInstalacao | null = null;
// O MESMO objeto enquanto nada muda: o useSyncExternalStore compara por referência.
let estado: EstadoDaInstalacao = INICIAL;
const ouvintes = new Set<() => void>();
let escutando = false;

function atualizar(proximo: EstadoDaInstalacao) {
  if (proximo.podePedir === estado.podePedir && proximo.instaladoNestaVisita === estado.instaladoNestaVisita) return;
  estado = proximo;
  for (const ouvinte of Array.from(ouvintes)) ouvinte();
}

type AlvoDeEventos = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * Liga, uma vez por página, a escuta do pedido de instalação e do aviso de app
 * instalado. Devolve a função que desliga a escuta e esquece o que ela guardou
 * (quem chama de novo com a escuta ligada recebe uma que não faz nada).
 *
 * O pedido NÃO é cancelado (sem preventDefault): o Chrome continua mostrando a
 * oferta dele em qualquer página do site, e a dica do /gravar usa o mesmo
 * pedido no botão dela.
 */
export function escutarPedidoDeInstalacao(alvo: AlvoDeEventos = window): () => void {
  if (escutando) return () => undefined;
  escutando = true;
  const aoPedir = (evento: Event) => {
    pedidoGuardado = evento as PedidoDeInstalacao;
    atualizar({ ...estado, podePedir: true });
  };
  const aoInstalar = () => {
    pedidoGuardado = null;
    // Pelo botão da dica ou pelo menu do navegador: a dica não volta na aba.
    marcarDicaNoAparelho("instalado");
    atualizar({ podePedir: false, instaladoNestaVisita: true });
  };
  alvo.addEventListener("beforeinstallprompt", aoPedir);
  alvo.addEventListener("appinstalled", aoInstalar);
  // O "Abrir no app" do Chrome e do Edge leva a aba para a janela do app já
  // instalado, sem recarregar e sem appinstalled: a página só vê o display-mode
  // mudar. Sem matchMedia (o jsdom), não há o que ouvir.
  const consultas = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? MODOS_DE_APP.map(modo => window.matchMedia(`(display-mode: ${modo})`))
    : [];
  const aoMudarDeModo = (evento: MediaQueryListEvent) => {
    if (evento.matches) aoInstalar();
  };
  for (const consulta of consultas) consulta.addEventListener?.("change", aoMudarDeModo);
  return () => {
    alvo.removeEventListener("beforeinstallprompt", aoPedir);
    alvo.removeEventListener("appinstalled", aoInstalar);
    for (const consulta of consultas) consulta.removeEventListener?.("change", aoMudarDeModo);
    escutando = false;
    pedidoGuardado = null;
    atualizar(INICIAL);
  };
}

/**
 * Abre o pedido de instalação do próprio navegador. O pedido vale uma vez:
 * o navegador recusa um segundo prompt() do mesmo evento, então ele sai da
 * guarda antes. Rejeita se o navegador não o abrir.
 */
export async function pedirInstalacao(): Promise<"aceitou" | "recusou" | "sem-pedido"> {
  const pedido = pedidoGuardado;
  if (!pedido) return "sem-pedido";
  pedidoGuardado = null;
  atualizar({ ...estado, podePedir: false });
  await pedido.prompt();
  const { outcome } = await pedido.userChoice;
  return outcome === "accepted" ? "aceitou" : "recusou";
}

function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

function ler(): EstadoDaInstalacao {
  return estado;
}

/** O pedido de instalação e o app instalado nesta visita, para a dica redesenhar quando mudam. */
export function useInstalacaoDoApp(): EstadoDaInstalacao {
  return useSyncExternalStore(assinar, ler, ler);
}
