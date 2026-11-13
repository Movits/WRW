import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { LANGUAGES } from "@/i18n";
import { escutarPedidoDeInstalacao, type AmbienteDoNavegador } from "@/lib/instalacao-do-app";
import { DicaDeInstalacao } from "./DicaDeInstalacao";

/**
 * A dica de instalação do app no /gravar (decisão 8 do plano do gravador): o
 * caminho de cada aparelho, o botão do pedido do Chromium, o aviso do login
 * separado no iPhone, e a dica fechada que não volta neste aparelho.
 */

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0.0 (iPhone15,2; iOS 18_6; pt_BR)",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
  cascaDasLojas: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WRWApp/1.0",
};

const CHAVE_DA_DICA_FECHADA = "mmm:dica-de-instalacao-fechada";
const TITULO = "Instale o WRW como app";

function ambiente(userAgent: string, extra: Partial<AmbienteDoNavegador> = {}): AmbienteDoNavegador {
  return { userAgent, maxTouchPoints: 0, abertoComoApp: false, ...extra };
}

/** Como no gravador: um bloco de botões e, logo depois, a dica. */
function montar(amb: AmbienteDoNavegador) {
  return render(
    <div>
      <div>
        <button type="button">Iniciar gravação</button>
        <button type="button">Enviar arquivo de áudio</button>
      </div>
      <DicaDeInstalacao ambiente={amb} />
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
  // O setup limpa só o sessionStorage: a dica fechada num teste ficaria fechada nos seguintes.
  localStorage.clear();
  pararEscuta = escutarPedidoDeInstalacao(window);
});

afterEach(async () => {
  cleanup();
  pararEscuta();
  vi.restoreAllMocks();
  await i18n.changeLanguage("pt-BR");
});

describe("Dica de instalação — o caminho de cada aparelho", () => {
  it("no iPhone, mostra os três passos do Compartilhar e avisa que o app pede um login separado do Safari", () => {
    montar(ambiente(UA.iphone, { maxTouchPoints: 5 }));
    expect(dica()).toBeInTheDocument();
    expect(passos()).toEqual([
      "Toque em “Compartilhar”. Se ele não estiver à vista, toque antes em •••.",
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
    expect(screen.getByText("No Safari, escolha Arquivo > “Adicionar ao Dock”.")).toBeInTheDocument();
    expect(passos()).toEqual([]);
  });

  it("dentro do Instagram ou do Facebook, pede para abrir a página no navegador", () => {
    montar(ambiente(UA.instagram, { maxTouchPoints: 5 }));
    expect(screen.getByText("Daqui não dá para instalar: abra esta página no Safari ou no Chrome.")).toBeInTheDocument();
  });

  it("no Firefox do computador, indica um navegador que instala", () => {
    montar(ambiente(UA.windowsFirefox));
    expect(screen.getByText("Este navegador não instala apps. Abra o WRW no Chrome, no Edge ou no Safari.")).toBeInTheDocument();
  });

  it("aberta como app, ou dentro da casca das lojas, a dica não aparece", () => {
    const { container } = render(<DicaDeInstalacao ambiente={ambiente(UA.android, { abertoComoApp: true })} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const casca = render(<DicaDeInstalacao ambiente={ambiente(UA.cascaDasLojas, { maxTouchPoints: 5 })} />);
    expect(casca.container).toBeEmptyDOMElement();
  });

  it("não é alerta: é uma região com título, e o ícone não é lido", () => {
    montar(ambiente(UA.android));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const titulo = screen.getByRole("heading", { level: 2, name: TITULO });
    expect(titulo.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
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

  it("instalado nesta visita por outro caminho (o menu do navegador), a dica some", () => {
    montar(ambiente(UA.windowsEdge));
    expect(dica()).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(dica()).not.toBeInTheDocument();
  });
});

describe("Dica de instalação — fechar", () => {
  it("fechada, some, não volta neste aparelho e o foco vai ao botão de antes", () => {
    montar(ambiente(UA.iphone, { maxTouchPoints: 5 }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar a dica de instalação" }));
    expect(dica()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar arquivo de áudio" })).toHaveFocus();
    expect(localStorage.getItem(CHAVE_DA_DICA_FECHADA)).toBe("1");
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
