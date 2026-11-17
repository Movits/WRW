import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTO_DA_TRAVA, TravaDoApp } from "./TravaDoApp";

/**
 * A trava do app no Perfil: só aparece dentro da casca das lojas e só quando o
 * app responde. Ligar e desligar pedem ao app, que guarda a escolha e confere a
 * pessoa; a seção mostra o que o app contar de volta.
 */

const UA_DA_CASCA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 WRWApp/1.0";
const postMessage = vi.fn();

function dentroDoApp() {
  Object.defineProperty(window.navigator, "userAgent", { value: UA_DA_CASCA, configurable: true });
  (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage };
}

function oAppResponde(detalhe: { disponivel: boolean; ligada: boolean }) {
  act(() => {
    window.dispatchEvent(new CustomEvent(EVENTO_DA_TRAVA, { detail: detalhe }));
  });
}

const pedidos = () => postMessage.mock.calls.map(([mensagem]) => JSON.parse(mensagem as string));

beforeEach(() => {
  postMessage.mockReset();
});

afterEach(() => {
  delete (window.navigator as unknown as { userAgent?: string }).userAgent;
  delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

describe("onde a seção aparece", () => {
  it("fora do app não aparece e não fala com ninguém", () => {
    render(<TravaDoApp />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("dentro do app, pergunta o estado e espera a resposta antes de aparecer", () => {
    dentroDoApp();
    render(<TravaDoApp />);
    expect(pedidos()).toEqual([{ tipo: "wrw:trava", acao: "estado" }]);
    // App antigo, sem a trava, não responde: a seção não aparece.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    oAppResponde({ disponivel: true, ligada: false });
    expect(screen.getByRole("heading", { name: "Abrir o app com Face ID ou digital" })).toBeInTheDocument();
  });

  it("celular sem biometria nem bloqueio de tela: explica, sem o botão", () => {
    dentroDoApp();
    render(<TravaDoApp />);
    oAppResponde({ disponivel: false, ligada: false });
    expect(screen.getByText(/não tem Face ID, digital nem bloqueio de tela/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});

describe("ligar e desligar", () => {
  it("o botão mostra o estado que o app contou", () => {
    dentroDoApp();
    render(<TravaDoApp />);
    oAppResponde({ disponivel: true, ligada: true });
    expect(screen.getByRole("switch", { name: "Pedir Face ID ou digital ao abrir o app" })).toHaveAttribute("aria-checked", "true");
  });

  it("ligar pede ao app e espera a resposta; o app conta o novo estado", () => {
    dentroDoApp();
    render(<TravaDoApp />);
    oAppResponde({ disponivel: true, ligada: false });
    const botao = screen.getByRole("switch");
    fireEvent.click(botao);
    expect(pedidos().at(-1)).toEqual({ tipo: "wrw:trava", acao: "ligar" });
    expect(botao).toBeDisabled();
    // Enquanto espera, um segundo toque não manda outro pedido.
    fireEvent.click(botao);
    expect(pedidos().filter(p => p.acao === "ligar")).toHaveLength(1);
    oAppResponde({ disponivel: true, ligada: true });
    expect(botao).toBeEnabled();
    expect(botao).toHaveAttribute("aria-checked", "true");
  });

  it("a pessoa cancela o Face ID ao ligar: o app conta que segue desligada", () => {
    dentroDoApp();
    render(<TravaDoApp />);
    oAppResponde({ disponivel: true, ligada: false });
    fireEvent.click(screen.getByRole("switch"));
    oAppResponde({ disponivel: true, ligada: false });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("desligar pede ao app", () => {
    dentroDoApp();
    render(<TravaDoApp />);
    oAppResponde({ disponivel: true, ligada: true });
    fireEvent.click(screen.getByRole("switch"));
    expect(pedidos().at(-1)).toEqual({ tipo: "wrw:trava", acao: "desligar" });
  });
});
