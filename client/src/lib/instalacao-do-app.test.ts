import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ambienteAtual,
  CHAVE_DA_DICA,
  dicaDispensadaNoAparelho,
  escutarPedidoDeInstalacao,
  marcarDicaNoAparelho,
  pedirInstalacao,
  plataformaDeInstalacao,
  useInstalacaoDoApp,
  type Plataforma,
} from "./instalacao-do-app";

/**
 * A dica de instalação do /gravar (decisão 8 do plano do gravador): o caminho
 * de instalação de cada aparelho, o pedido de instalação do Chromium e a marca
 * da dica no aparelho.
 */

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.77 Mobile/15E148 Safari/604.1",
  // A WebView de um app no iPhone (WKWebView) não leva "Safari/".
  iphoneWebView: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  // O iPad no modo computador (o padrão desde o iPadOS 13) se apresenta como Mac.
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  instagramIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0.0 (iPhone15,2; iOS 18_6; pt_BR)",
  // Estes dois levam "Safari/" no userAgent: só o token os separa do Safari.
  snapchatIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.60.0.43 (like Safari/8621.3.11.10.3, panda)",
  googleAppIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/392.0.833133432 Mobile/15E148 Safari/604.1",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
  // O iPad no site para celular leva "iPad" no userAgent.
  ipadCelular: "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  // A WebView de um app no Mac: sem Version/ nem Safari/.
  macWebView: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  // HarmonyOS NEXT: sem Android, com "Chrome/" no userAgent, mas sem o Chrome.
  harmonyCelular: "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile",
  harmonyTablet: "Mozilla/5.0 (Tablet; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile",
  navegadorHuawei: "Mozilla/5.0 (Phone; HarmonyOS 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.4.300",
  // O GNOME Web (WebKit) no Linux leva Version/ e Safari/, mas não é o Safari do Mac.
  gnomeWeb: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  facebookAndroid: "Mozilla/5.0 (Linux; Android 15; SM-S921B Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/500.0.0.0;]",
  androidWebView: "Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36",
  wechat: "Mozilla/5.0 (Linux; Android 15; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 15; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
  androidOpera: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 OPR/90.0.0.0",
  androidEdge: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 EdgA/142.0.0.0",
  androidYandex: "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 YaBrowser/25.8.0.0 Mobile Safari/537.36",
  // O Chrome de tablet Android no modo computador se apresenta como Linux.
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 16267.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  windowsOpera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
  jsdom: "Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/29.1.1",
  cascaDasLojas: "Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36 WRWApp/1.0",
};

describe("plataformaDeInstalacao", () => {
  it.each<[string, string, number, Plataforma]>([
    ["iPhone no Safari", UA.iphoneSafari, 5, "ios"],
    ["iPhone no Chrome (o Compartilhar também adiciona à tela de início)", UA.iphoneChrome, 5, "ios"],
    ["iPad, que se apresenta como Mac mas tem tela de toque", UA.macSafari, 5, "ios"],
    ["iPad no site para celular, com iPad no userAgent", UA.ipadCelular, 5, "ios"],
    ["a WebView de um app no iPhone, sem Safari no userAgent", UA.iphoneWebView, 5, "navegador-embutido"],
    ["Mac no Safari", UA.macSafari, 0, "mac-safari"],
    ["a WebView de um app no Mac, sem Version/ nem Safari/, não é o Safari", UA.macWebView, 0, "sem-instalacao"],
    ["o GNOME Web no Linux, com Version/ e Safari/, não é o Safari do Mac", UA.gnomeWeb, 0, "sem-instalacao"],
    ["Instagram no iPhone", UA.instagramIphone, 5, "navegador-embutido"],
    ["Snapchat no iPhone, que leva Safari/: só o token o pega, antes da regra do iPhone", UA.snapchatIphone, 5, "navegador-embutido"],
    ["app Google no iPhone (GSA), que leva Safari/ e não adiciona à tela de início", UA.googleAppIphone, 5, "navegador-embutido"],
    ["Facebook no Android", UA.facebookAndroid, 5, "navegador-embutido"],
    ["a WebView do Android, sem token de app conhecido", UA.androidWebView, 5, "navegador-embutido"],
    ["WeChat", UA.wechat, 5, "navegador-embutido"],
    ["Android no Chrome", UA.androidChrome, 5, "android"],
    ["Android no Samsung Internet, que não tem o ⋮ do Chrome", UA.samsung, 5, "android-outro-navegador"],
    ["Android no Firefox", UA.androidFirefox, 5, "android-outro-navegador"],
    ["Android no Opera", UA.androidOpera, 5, "android-outro-navegador"],
    ["Android no Edge", UA.androidEdge, 5, "android-outro-navegador"],
    ["Android no Yandex", UA.androidYandex, 5, "android-outro-navegador"],
    ["tablet Android com o Chrome no modo computador", UA.linuxChrome, 10, "android"],
    ["Linux no Chrome, sem tela de toque", UA.linuxChrome, 0, "computador"],
    ["Firefox no Linux com tela de toque não é tablet Android", UA.linuxFirefox, 10, "sem-instalacao"],
    ["Chromebook com tela de toque", UA.chromebook, 10, "computador"],
    ["Windows no Chrome", UA.windowsChrome, 0, "computador"],
    ["Windows no Edge", UA.windowsEdge, 0, "computador"],
    ["Windows no Opera, que não instala app da web", UA.windowsOpera, 0, "sem-instalacao"],
    ["celular com HarmonyOS NEXT, sem o Chrome nem os menus dele", UA.harmonyCelular, 5, "sem-instalacao"],
    ["tablet com HarmonyOS NEXT", UA.harmonyTablet, 10, "sem-instalacao"],
    ["navegador Huawei no HarmonyOS NEXT, só com ArkWeb", UA.navegadorHuawei, 5, "sem-instalacao"],
    ["Mac no Chrome", UA.macChrome, 0, "computador"],
    ["Mac no Firefox", UA.macFirefox, 0, "sem-instalacao"],
    ["Windows no Firefox", UA.windowsFirefox, 0, "sem-instalacao"],
    ["navegador desconhecido (o jsdom dos testes)", UA.jsdom, 0, "sem-instalacao"],
    ["a casca das lojas (PR #180), uma WebView", UA.cascaDasLojas, 5, "app-instalado"],
  ])("%s", (_caso, userAgent, maxTouchPoints, esperada) => {
    expect(plataformaDeInstalacao({ userAgent, maxTouchPoints, abertoComoApp: false })).toBe(esperada);
  });

  it("aberta como app é app-instalado em qualquer aparelho", () => {
    for (const userAgent of [UA.iphoneSafari, UA.androidChrome, UA.windowsChrome, UA.macSafari]) {
      expect(plataformaDeInstalacao({ userAgent, maxTouchPoints: 0, abertoComoApp: true })).toBe("app-instalado");
    }
  });
});

describe("ambienteAtual", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const propriedade of ["standalone", "userAgent", "maxTouchPoints"]) Reflect.deleteProperty(window.navigator, propriedade);
  });

  // Função comum, não vi.fn com retorno: o mockReset da suíte zeraria o retorno.
  function matchMediaQueAbre(modoAberto: string) {
    return (consulta: string) => ({ matches: consulta === `(display-mode: ${modoAberto})`, media: consulta });
  }

  function navegadorCom(valores: { userAgent?: string; maxTouchPoints?: number; standalone?: boolean }) {
    for (const [propriedade, value] of Object.entries(valores)) {
      Object.defineProperty(window.navigator, propriedade, { value, configurable: true });
    }
  }

  it("no iPad, lê o userAgent de Mac e a tela de toque, e a plataforma sai iPhone e iPad", () => {
    vi.stubGlobal("matchMedia", matchMediaQueAbre("browser"));
    navegadorCom({ userAgent: UA.macSafari, maxTouchPoints: 5, standalone: false });
    expect(ambienteAtual()).toEqual({ userAgent: UA.macSafari, maxTouchPoints: 5, abertoComoApp: false });
    expect(plataformaDeInstalacao(ambienteAtual())).toBe("ios");
  });

  it("sem maxTouchPoints, conta zero toques", () => {
    navegadorCom({ maxTouchPoints: undefined });
    expect(ambienteAtual().maxTouchPoints).toBe(0);
  });

  it("sem matchMedia (o jsdom) não está aberta como app", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(ambienteAtual().abertoComoApp).toBe(false);
  });

  it("display-mode standalone é o app aberto da tela de início ou do computador", () => {
    vi.stubGlobal("matchMedia", matchMediaQueAbre("standalone"));
    expect(ambienteAtual().abertoComoApp).toBe(true);
  });

  it("display-mode window-controls-overlay é o app no computador com a barra recolhida", () => {
    vi.stubGlobal("matchMedia", matchMediaQueAbre("window-controls-overlay"));
    expect(ambienteAtual().abertoComoApp).toBe(true);
  });

  it("a tela cheia do próprio navegador (fullscreen) não conta como app", () => {
    vi.stubGlobal("matchMedia", matchMediaQueAbre("fullscreen"));
    expect(ambienteAtual().abertoComoApp).toBe(false);
  });

  it("no iPhone, o app da tela de início tem navigator.standalone", () => {
    vi.stubGlobal("matchMedia", matchMediaQueAbre("browser"));
    navegadorCom({ standalone: true });
    expect(ambienteAtual().abertoComoApp).toBe(true);
  });
});

describe("a marca da dica no aparelho", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("sem marca, a dica não foi dispensada; fechada ou instalado, foi", () => {
    expect(dicaDispensadaNoAparelho()).toBe(false);
    marcarDicaNoAparelho("fechada");
    expect(localStorage.getItem(CHAVE_DA_DICA)).toBe("fechada");
    expect(dicaDispensadaNoAparelho()).toBe(true);
    marcarDicaNoAparelho("instalado");
    expect(localStorage.getItem(CHAVE_DA_DICA)).toBe("instalado");
    expect(dicaDispensadaNoAparelho()).toBe(true);
  });

  it("com o armazenamento bloqueado (modo privado), não lança: a dica conta como não dispensada", () => {
    const bloqueado = () => {
      throw new DOMException("O armazenamento está bloqueado.", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(bloqueado);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(bloqueado);
    expect(() => marcarDicaNoAparelho("fechada")).not.toThrow();
    expect(dicaDispensadaNoAparelho()).toBe(false);
  });
});

describe("o pedido de instalação do Chromium", () => {
  let parar: (() => void) | undefined;
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    parar?.();
    parar = undefined;
    vi.unstubAllGlobals();
  });

  it("a aba levada para a janela do app (o 'Abrir no app'), sem appinstalled, também conta como instalado", () => {
    const ouvintes = new Map<string, (evento: { matches: boolean }) => void>();
    const removidos: string[] = [];
    // Função comum, não vi.fn com retorno: o mockReset da suíte zeraria o retorno.
    vi.stubGlobal("matchMedia", (consulta: string) => ({
      matches: false,
      media: consulta,
      addEventListener: (_tipo: string, ouvinte: (evento: { matches: boolean }) => void) => ouvintes.set(consulta, ouvinte),
      removeEventListener: () => removidos.push(consulta),
    }));
    parar = escutarPedidoDeInstalacao(new EventTarget());
    const { result } = renderHook(() => useInstalacaoDoApp());
    expect([...ouvintes.keys()]).toEqual(["(display-mode: standalone)", "(display-mode: window-controls-overlay)"]);
    act(() => ouvintes.get("(display-mode: standalone)")!({ matches: false }));
    expect(result.current.instaladoNestaVisita).toBe(false);
    act(() => ouvintes.get("(display-mode: standalone)")!({ matches: true }));
    expect(result.current.instaladoNestaVisita).toBe(true);
    expect(localStorage.getItem(CHAVE_DA_DICA)).toBe("instalado");
    act(() => parar!());
    parar = undefined;
    expect(removidos).toEqual(["(display-mode: standalone)", "(display-mode: window-controls-overlay)"]);
  });

  function pedidoDoNavegador(outcome: "accepted" | "dismissed", { falha = false } = {}) {
    const prompt = vi.fn(async () => {
      if (falha) throw new DOMException("O pedido já foi usado.", "InvalidStateError");
    });
    const evento = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome, platform: "web" }),
    });
    return { evento, prompt };
  }

  it("guarda o pedido sem cancelar a oferta do próprio navegador, e o usa uma vez só", async () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    const { result } = renderHook(() => useInstalacaoDoApp());
    expect(result.current).toEqual({ podePedir: false, instaladoNestaVisita: false });

    const { evento, prompt } = pedidoDoNavegador("accepted");
    act(() => {
      alvo.dispatchEvent(evento);
    });
    // Sem preventDefault: o Chrome segue mostrando a oferta dele em qualquer página do site.
    expect(evento.defaultPrevented).toBe(false);
    expect(result.current.podePedir).toBe(true);

    let resultado: string | undefined;
    await act(async () => {
      resultado = await pedirInstalacao();
    });
    expect(resultado).toBe("aceitou");
    expect(prompt).toHaveBeenCalledTimes(1);
    // O navegador recusa um segundo prompt() do mesmo evento: ele saiu da guarda.
    expect(result.current.podePedir).toBe(false);
    await expect(pedirInstalacao()).resolves.toBe("sem-pedido");
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("o pedido que chega antes de a tela montar fica guardado para ela (a razão da escuta na carga)", () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    alvo.dispatchEvent(pedidoDoNavegador("accepted").evento);
    const { result } = renderHook(() => useInstalacaoDoApp());
    expect(result.current.podePedir).toBe(true);
  });

  it("o app instalado antes de a tela montar também fica sabido", () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    alvo.dispatchEvent(new Event("appinstalled"));
    const { result } = renderHook(() => useInstalacaoDoApp());
    expect(result.current).toEqual({ podePedir: false, instaladoNestaVisita: true });
  });

  it("quem fecha o pedido do navegador sem instalar volta como recusou", async () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    alvo.dispatchEvent(pedidoDoNavegador("dismissed").evento);
    await expect(pedirInstalacao()).resolves.toBe("recusou");
  });

  it("se o navegador não abre o pedido, pedirInstalacao rejeita e o pedido não fica guardado", async () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    const { result } = renderHook(() => useInstalacaoDoApp());
    act(() => {
      alvo.dispatchEvent(pedidoDoNavegador("accepted", { falha: true }).evento);
    });
    await act(async () => {
      await expect(pedirInstalacao()).rejects.toThrow("O pedido já foi usado.");
    });
    expect(result.current.podePedir).toBe(false);
  });

  it("o app instalado nesta visita esquece o pedido, avisa a tela e marca o aparelho", () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    const { result } = renderHook(() => useInstalacaoDoApp());
    act(() => {
      alvo.dispatchEvent(pedidoDoNavegador("accepted").evento);
      alvo.dispatchEvent(new Event("appinstalled"));
    });
    expect(result.current).toEqual({ podePedir: false, instaladoNestaVisita: true });
    // Na próxima visita, numa aba do navegador, a dica lê a marca e não volta.
    expect(localStorage.getItem(CHAVE_DA_DICA)).toBe("instalado");
  });

  it("sem pedido guardado, pedirInstalacao devolve sem-pedido", async () => {
    parar = escutarPedidoDeInstalacao(new EventTarget());
    await expect(pedirInstalacao()).resolves.toBe("sem-pedido");
  });

  it("ligar a escuta de novo não liga outra; a função devolvida desliga e esquece", () => {
    const alvo = new EventTarget();
    const adicionar = vi.spyOn(alvo, "addEventListener");
    parar = escutarPedidoDeInstalacao(alvo);
    const deNovo = escutarPedidoDeInstalacao(alvo);
    expect(adicionar).toHaveBeenCalledTimes(2); // beforeinstallprompt e appinstalled, uma vez cada
    deNovo(); // a segunda não desliga a primeira
    const { result } = renderHook(() => useInstalacaoDoApp());
    act(() => {
      alvo.dispatchEvent(pedidoDoNavegador("accepted").evento);
    });
    expect(result.current.podePedir).toBe(true);

    act(() => parar!());
    parar = undefined;
    expect(result.current).toEqual({ podePedir: false, instaladoNestaVisita: false });
    act(() => {
      alvo.dispatchEvent(pedidoDoNavegador("accepted").evento);
    });
    expect(result.current.podePedir).toBe(false);
  });
});
