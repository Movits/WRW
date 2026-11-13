import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ambienteAtual,
  escutarPedidoDeInstalacao,
  pedirInstalacao,
  plataformaDeInstalacao,
  useInstalacaoDoApp,
  type Plataforma,
} from "./instalacao-do-app";

/**
 * A dica de instalação do /gravar (decisão 8 do plano do gravador): o caminho
 * de instalação de cada aparelho e o pedido de instalação do Chromium.
 */

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.77 Mobile/15E148 Safari/604.1",
  // O iPad no modo computador (o padrão desde o iPadOS 13) se apresenta como Mac.
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  instagramIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0.0 (iPhone15,2; iOS 18_6; pt_BR)",
  facebookAndroid: "Mozilla/5.0 (Linux; Android 15; SM-S921B Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/500.0.0.0;]",
  wechat: "Mozilla/5.0 (Linux; Android 15; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 15; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
  jsdom: "Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/29.1.1",
  cascaDasLojas: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WRWApp/1.0",
};

describe("plataformaDeInstalacao", () => {
  it.each<[string, string, number, Plataforma]>([
    ["iPhone no Safari", UA.iphoneSafari, 5, "ios"],
    ["iPhone no Chrome (o Compartilhar também adiciona à tela de início)", UA.iphoneChrome, 5, "ios"],
    ["iPad, que se apresenta como Mac mas tem tela de toque", UA.macSafari, 5, "ios"],
    ["Mac no Safari", UA.macSafari, 0, "mac-safari"],
    ["Instagram no iPhone, antes do iPhone", UA.instagramIphone, 5, "navegador-embutido"],
    ["Facebook no Android, antes do Android", UA.facebookAndroid, 5, "navegador-embutido"],
    ["WeChat", UA.wechat, 5, "navegador-embutido"],
    ["Android no Chrome", UA.androidChrome, 5, "android"],
    ["Android no Samsung Internet", UA.samsung, 5, "android"],
    ["Android no Firefox", UA.androidFirefox, 5, "android"],
    ["Windows no Chrome", UA.windowsChrome, 0, "computador"],
    ["Windows no Edge", UA.windowsEdge, 0, "computador"],
    ["Mac no Chrome", UA.macChrome, 0, "computador"],
    ["Linux no Chrome", UA.linuxChrome, 0, "computador"],
    ["Mac no Firefox", UA.macFirefox, 0, "sem-instalacao"],
    ["Windows no Firefox", UA.windowsFirefox, 0, "sem-instalacao"],
    ["navegador desconhecido (o jsdom dos testes)", UA.jsdom, 0, "sem-instalacao"],
    ["a casca das lojas (PR #180)", UA.cascaDasLojas, 5, "app-instalado"],
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
    Reflect.deleteProperty(window.navigator, "standalone");
  });

  // Função comum, não vi.fn com retorno: o mockReset da suíte zeraria o retorno.
  function matchMediaQueAbre(modoAberto: string) {
    return (consulta: string) => ({ matches: consulta === `(display-mode: ${modoAberto})`, media: consulta });
  }

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
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
    expect(ambienteAtual().abertoComoApp).toBe(true);
  });

  it("lê o userAgent e o maxTouchPoints do navegador", () => {
    const ambiente = ambienteAtual();
    expect(ambiente.userAgent).toBe(window.navigator.userAgent);
    expect(ambiente.maxTouchPoints).toBe(window.navigator.maxTouchPoints ?? 0);
  });
});

describe("o pedido de instalação do Chromium", () => {
  let parar: (() => void) | undefined;
  afterEach(() => {
    parar?.();
    parar = undefined;
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

  it("guarda o pedido, cancela a faixa do navegador e o usa uma vez só", async () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    const { result } = renderHook(() => useInstalacaoDoApp());
    expect(result.current).toEqual({ podePedir: false, instaladoNestaVisita: false });

    const { evento, prompt } = pedidoDoNavegador("accepted");
    act(() => {
      alvo.dispatchEvent(evento);
    });
    expect(evento.defaultPrevented).toBe(true);
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

  it("o app instalado nesta visita esquece o pedido e avisa a tela", () => {
    const alvo = new EventTarget();
    parar = escutarPedidoDeInstalacao(alvo);
    const { result } = renderHook(() => useInstalacaoDoApp());
    act(() => {
      alvo.dispatchEvent(pedidoDoNavegador("accepted").evento);
      alvo.dispatchEvent(new Event("appinstalled"));
    });
    expect(result.current).toEqual({ podePedir: false, instaladoNestaVisita: true });
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
