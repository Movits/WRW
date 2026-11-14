import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { LANGUAGES } from "@/i18n";
import { CHAVE_DA_DICA, escutarPedidoDeInstalacao, type AmbienteDoNavegador } from "@/lib/instalacao-do-app";
import { DicaDeInstalacao } from "./DicaDeInstalacao";

/**
 * A dica de instalação do app no /gravar (decisão 8 do plano do gravador): o
 * caminho de cada aparelho, o botão do pedido do Chromium, o aviso do login
 * separado no iPhone, e a dica fechada (ou o app instalado) que não volta.
 */

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0.0 (iPhone15,2; iOS 18_6; pt_BR)",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
  samsung: "Mozilla/5.0 (Linux; Android 15; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  cascaDasLojas: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WRWApp/1.0",
};

const TITULO = "Instale a WRW como app";

function ambiente(userAgent: string, extra: Partial<AmbienteDoNavegador> = {}): AmbienteDoNavegador {
  return { userAgent, maxTouchPoints: 0, abertoComoApp: false, ...extra };
}

/** Como no gravador: um bloco de botões e, logo depois, a dica. */
function montar(amb: AmbienteDoNavegador, { oculta = false } = {}) {
  return render(
    <div>
      <div>
        <button type="button">Iniciar gravação</button>
        <button type="button">Enviar arquivo de áudio</button>
      </div>
      <DicaDeInstalacao ambiente={amb} oculta={oculta} />
    </div>
  );
}

const dica = () => screen.queryByRole("region", { name: TITULO });
const passos = () => screen.queryAllByRole("listitem").map(item => item.textContent);

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

let pararEscuta: () => void;

beforeEach(() => {
  // O setup limpa só o sessionStorage: a marca de um teste esconderia a dica nos seguintes.
  localStorage.clear();
  pararEscuta = escutarPedidoDeInstalacao();
});

afterEach(async () => {
  cleanup();
  pararEscuta();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("pt-BR");
});

describe("Dica de instalação — o caminho de cada aparelho", () => {
  it("no iPhone, mostra os três passos do Compartilhar e avisa que o app pede um login separado do Safari", () => {
    montar(ambiente(UA.iphone, { maxTouchPoints: 5 }));
    expect(dica()).toBeInTheDocument();
    expect(passos()).toEqual([
      // iOS 27: o ≡ (Menu da Página) na barra de endereço; iOS 26 e Chrome do iPhone: o •••.
      "Toque em “Compartilhar”. Se ele não estiver à vista, toque antes em ≡ (Menu da Página, na barra de endereço) ou em •••.",
      "Role a lista e toque em “Adicionar à Tela de Início”.",
      "Se aparecer “Abrir como App da Web”, deixe ligado. Toque em “Adicionar”.",
    ]);
    expect(screen.getByText(/o app guarda o login à parte do Safari/)).toBeInTheDocument();
  });

  it("no iPhone não há botão de instalar, mesmo se um pedido chegasse", () => {
    montar(ambiente(UA.iphone, { maxTouchPoints: 5 }));
    act(() => {
      window.dispatchEvent(pedidoDoNavegador("accepted").evento);
    });
    expect(screen.queryByRole("button", { name: "Instalar o app" })).not.toBeInTheDocument();
    expect(passos()).toHaveLength(3);
  });

  it("no Android sem pedido do navegador, mostra o caminho pelo menu do Chrome, sem o aviso do iPhone", () => {
    montar(ambiente(UA.android, { maxTouchPoints: 5 }));
    expect(passos()).toEqual([
      "No Chrome, toque em ⋮ (Mais), à direita da barra de endereço.",
      "Toque em “Instalar e criar atalho” e depois em “Instalar”.",
    ]);
    expect(screen.queryByText(/à parte do Safari/)).not.toBeInTheDocument();
  });

  it("no computador com Chrome ou Edge, mostra o Instalar da barra de endereço e o caminho pelo menu", () => {
    montar(ambiente(UA.windowsEdge));
    expect(passos()).toEqual([
      "Clique em “Instalar”, à direita da barra de endereço.",
      "Se ele não aparecer, no Chrome vá em ⋮ > “Transmitir, salvar e compartilhar” > “Instalar esta página como um app…”.",
    ]);
  });

  it("no Safari do Mac, Arquivo > Adicionar ao Dock", () => {
    montar(ambiente(UA.macSafari));
    expect(
      screen.getByText("No Safari do macOS Sonoma (14) ou mais novo, escolha Arquivo > “Adicionar ao Dock”. Nas versões anteriores do macOS, abra esta página no Chrome ou no Edge."),
    ).toBeInTheDocument();
    expect(passos()).toEqual([]);
  });

  it("dentro do Instagram ou do Facebook, pede para abrir a página no navegador", () => {
    montar(ambiente(UA.instagram, { maxTouchPoints: 5 }));
    expect(screen.getByText("Daqui não dá para instalar: abra esta página no Safari ou no Chrome.")).toBeInTheDocument();
  });

  it("no Samsung Internet (ou outro navegador do Android), manda abrir no Chrome; com o pedido, o botão vale", () => {
    montar(ambiente(UA.samsung, { maxTouchPoints: 5 }));
    expect(screen.getByText("Para instalar a WRW como app, abra esta página no Chrome.")).toBeInTheDocument();
    expect(passos()).toEqual([]);
    act(() => {
      window.dispatchEvent(pedidoDoNavegador("accepted").evento);
    });
    expect(screen.getByRole("button", { name: "Instalar o app" })).toBeInTheDocument();
  });

  it("no Firefox do computador, indica um navegador que instala, sem dizer que ele não instala", () => {
    montar(ambiente(UA.windowsFirefox));
    expect(screen.getByText("Para instalar a WRW como app, abra esta página no Chrome, no Edge ou no Safari.")).toBeInTheDocument();
  });

  it("sem o ambiente dado (como no gravador), aberta como app pelo display-mode, a dica não aparece e marca o aparelho", () => {
    // Função comum, não vi.fn com retorno: o mockReset da suíte zeraria o retorno.
    vi.stubGlobal("matchMedia", (consulta: string) => ({
      matches: consulta === "(display-mode: standalone)",
      media: consulta,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { container } = render(<DicaDeInstalacao />);
    expect(container).toBeEmptyDOMElement();
    expect(localStorage.getItem(CHAVE_DA_DICA)).toBe("instalado");
  });

  it("aberta como app, ou dentro da casca das lojas, a dica não aparece e o aparelho fica marcado", () => {
    const { container } = render(<DicaDeInstalacao ambiente={ambiente(UA.android, { abertoComoApp: true })} />);
    expect(container).toBeEmptyDOMElement();
    // No Chromium, a aba do navegador lê a mesma marca e para de oferecer a instalação.
    expect(localStorage.getItem(CHAVE_DA_DICA)).toBe("instalado");
    cleanup();
    localStorage.clear();
    const casca = render(<DicaDeInstalacao ambiente={ambiente(UA.cascaDasLojas, { maxTouchPoints: 5 })} />);
    expect(casca.container).toBeEmptyDOMElement();
  });

  it("não é alerta: é uma região com título, e o ícone não é lido", () => {
    montar(ambiente(UA.android));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const titulo = screen.getByRole("heading", { level: 2, name: TITULO });
    expect(titulo.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("oculta (gravando ou enviando), fica fora do leitor de tela e do teclado, mas no mesmo lugar", () => {
    const { rerender } = montar(ambiente(UA.android), { oculta: true });
    expect(dica()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fechar a dica de instalação" })).not.toBeInTheDocument();
    const secao = document.querySelector("section[aria-labelledby]");
    expect(secao).toHaveStyle({ visibility: "hidden" });
    rerender(
      <div>
        <div>
          <button type="button">Iniciar gravação</button>
          <button type="button">Enviar arquivo de áudio</button>
        </div>
        <DicaDeInstalacao ambiente={ambiente(UA.android)} />
      </div>
    );
    expect(dica()).toBeInTheDocument();
  });
});

describe("Dica de instalação — o pedido do navegador (Chrome, Edge, Samsung Internet)", () => {
  it("com o pedido guardado, o botão abre o pedido; instalado, a dica some e o foco vai ao botão de antes", async () => {
    montar(ambiente(UA.android, { maxTouchPoints: 5 }));
    const { evento, prompt } = pedidoDoNavegador("accepted");
    // O pedido chega depois de a dica montar (o Chrome espera um toque e 30 s na página).
    act(() => {
      window.dispatchEvent(evento);
    });
    expect(passos()).toEqual([]);
    const botao = screen.getByRole("button", { name: "Instalar o app" });
    await act(async () => {
      fireEvent.click(botao);
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dica()).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Enviar arquivo de áudio" })).toHaveFocus();
  });

  it("enquanto o pedido do navegador está aberto, o botão fica, desabilitado, sem voltar aos passos", async () => {
    let responder: (escolha: { outcome: "accepted" | "dismissed"; platform: string }) => void = () => undefined;
    const prompt = vi.fn(async () => undefined);
    const evento = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: new Promise<{ outcome: "accepted" | "dismissed"; platform: string }>(resolver => {
        responder = resolver;
      }),
    });
    montar(ambiente(UA.android, { maxTouchPoints: 5 }));
    act(() => {
      window.dispatchEvent(evento);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Instalar o app" }));
    });
    // O pedido saiu da guarda, mas a escolha ainda não veio: o botão segue, sem abrir outro pedido.
    const botao = screen.getByRole("button", { name: "Instalar o app" });
    expect(botao).toBeDisabled();
    expect(passos()).toEqual([]);
    fireEvent.click(botao);
    expect(prompt).toHaveBeenCalledTimes(1);
    await act(async () => {
      responder({ outcome: "dismissed", platform: "web" });
    });
    await waitFor(() => expect(passos()).toHaveLength(2));
    expect(screen.getByRole("heading", { name: TITULO })).toHaveFocus();
  });

  it("no computador (Chrome ou Edge), com o pedido guardado, o botão também toma o lugar dos passos", () => {
    montar(ambiente(UA.windowsEdge));
    expect(passos()).toHaveLength(2);
    act(() => {
      window.dispatchEvent(pedidoDoNavegador("accepted").evento);
    });
    expect(screen.getByRole("button", { name: "Instalar o app" })).toBeInTheDocument();
    expect(passos()).toEqual([]);
  });

  it("o pedido que chegou antes de a dica montar (na carga, pelo main.tsx) já mostra o botão", () => {
    act(() => {
      window.dispatchEvent(pedidoDoNavegador("accepted").evento);
    });
    montar(ambiente(UA.android, { maxTouchPoints: 5 }));
    expect(screen.getByRole("button", { name: "Instalar o app" })).toBeInTheDocument();
    expect(passos()).toEqual([]);
  });

  it("recusado o pedido, os passos tomam o lugar do botão e o foco vai ao título da dica", async () => {
    montar(ambiente(UA.android, { maxTouchPoints: 5 }));
    act(() => {
      window.dispatchEvent(pedidoDoNavegador("dismissed").evento);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Instalar o app" }));
    });
    await waitFor(() => expect(passos()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Instalar o app" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: TITULO })).toHaveFocus();
    expect(dica()).toBeInTheDocument();
  });

  it("se o navegador não abre o pedido, os passos aparecem e o erro vai ao console", async () => {
    const erroNoConsole = vi.spyOn(console, "error").mockImplementation(() => undefined);
    montar(ambiente(UA.android, { maxTouchPoints: 5 }));
    act(() => {
      window.dispatchEvent(pedidoDoNavegador("accepted", { falha: true }).evento);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Instalar o app" }));
    });
    await waitFor(() => expect(passos()).toHaveLength(2));
    expect(erroNoConsole).toHaveBeenCalledWith("[Instalação] o navegador não abriu o pedido de instalação", expect.any(DOMException));
    expect(screen.getByRole("heading", { name: TITULO })).toHaveFocus();
  });

  it("instalado nesta visita por outro caminho (o menu do navegador), a dica some e não volta na próxima visita", () => {
    montar(ambiente(UA.windowsEdge));
    expect(dica()).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(dica()).not.toBeInTheDocument();
    // Uma carga nova: a escuta recomeça do zero, e a marca no aparelho segura a dica.
    cleanup();
    pararEscuta();
    pararEscuta = escutarPedidoDeInstalacao();
    montar(ambiente(UA.windowsEdge));
    expect(dica()).not.toBeInTheDocument();
  });

  it("o app instalado antes de a dica montar também a esconde", () => {
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    montar(ambiente(UA.windowsEdge));
    expect(dica()).not.toBeInTheDocument();
  });
});

describe("Dica de instalação — fechar", () => {
  it("fechada, some, não volta neste aparelho e o foco vai ao botão de antes", () => {
    montar(ambiente(UA.iphone, { maxTouchPoints: 5 }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar a dica de instalação" }));
    expect(dica()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar arquivo de áudio" })).toHaveFocus();
    expect(localStorage.getItem(CHAVE_DA_DICA)).toBe("fechada");
    cleanup();
    montar(ambiente(UA.iphone, { maxTouchPoints: 5 }));
    expect(dica()).not.toBeInTheDocument();
  });

  it("com o armazenamento bloqueado (modo privado), a dica aparece e fecha do mesmo jeito", () => {
    const bloqueado = () => {
      throw new DOMException("O armazenamento está bloqueado.", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(bloqueado);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(bloqueado);
    montar(ambiente(UA.android));
    expect(dica()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fechar a dica de instalação" }));
    expect(dica()).not.toBeInTheDocument();
  });
});

describe("Dica de instalação — os 10 idiomas", () => {
  it("as 16 chaves estão traduzidas em cada idioma, com os símbolos dos botões do sistema", async () => {
    const pt = i18n.getResource("pt-BR", "translation", "meetings.install") as Record<string, string>;
    expect(Object.keys(pt)).toHaveLength(16);
    for (const { code } of LANGUAGES) {
      await act(async () => {
        await i18n.changeLanguage(code);
      });
      const textos = i18n.getResource(code, "translation", "meetings.install") as Record<string, string>;
      expect(Object.keys(textos).sort(), code).toEqual(Object.keys(pt).sort());
      for (const [chave, texto] of Object.entries(textos)) {
        expect(texto.trim().length, `${code}.${chave}`).toBeGreaterThan(3);
        if (code !== "pt-BR") expect(texto, `${code}.${chave} ficou em português`).not.toBe(pt[chave]);
      }
      // iOS 27 (≡, Menu da Página) e iOS 26 (•••); o menu do Chrome é o ⋮.
      expect(textos.iosStep1, code).toContain("≡");
      expect(textos.iosStep1, code).toContain("•••");
      expect(textos.androidStep1, code).toContain("⋮");
      expect(textos.desktopStep2, code).toContain("⋮");
      // Cada conselho aponta os navegadores do caminho dele, para uma troca de
      // textos entre chaves não passar despercebida (o árabe escreve Safari como سفاري).
      expect(textos.androidOtherBrowser, code).toContain("Chrome");
      expect(textos.androidOtherBrowser, code).not.toMatch(/Edge|Safari|سفاري/);
      expect(textos.unsupportedBrowser, code).toContain("Edge");
      expect(textos.inAppBrowser, code).not.toContain("Edge");
      // O "Adicionar ao Dock" só existe do macOS Sonoma (14) em diante; antes, Chrome ou Edge.
      expect(textos.macSafari, code).toMatch(/Sonoma[ （(]+14/);
      expect(textos.macSafari, code).toContain("Chrome");
      expect(textos.macSafari, code).toContain("Edge");
    }
  });

  it("cada idioma tem o título e os passos traduzidos, e o árabe vira a página da direita para a esquerda", async () => {
    for (const { code } of LANGUAGES) {
      await act(async () => {
        await i18n.changeLanguage(code);
      });
      montar(ambiente(UA.iphone, { maxTouchPoints: 5 }));
      const titulo = screen.getByRole("heading", { level: 2 }).textContent ?? "";
      expect(titulo, code).not.toMatch(/meetings\.install/);
      expect(titulo.length, code).toBeGreaterThan(3);
      for (const passo of passos()) expect(passo, code).not.toMatch(/meetings\.install/);
      if (code !== "pt-BR") expect(titulo, code).not.toBe(TITULO);
      if (code === "ar") expect(document.documentElement.dir).toBe("rtl");
      cleanup();
    }
  });
});
