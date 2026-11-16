import { act, fireEvent, render, screen, within, type RenderResult } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AVISO_DE_HORA_SEGUNDOS, PRAZO_DO_AVISO_DE_HORA_MS } from "@shared/const";
import type { EstadoDoGravador } from "@/hooks/useGravadorDeAudio";
import { AvisoDeHoraDeGravacao, PISCADA_DO_TITULO_MS, VIBRACAO_DO_AVISO_MS } from "./AvisoDeHoraDeGravacao";

/**
 * O cartão do aviso de hora da gravação em partes (G13a), com o hook de
 * verdade por baixo (hooks/useAvisoDeHora.ts). O gravador é o par estado +
 * segundos gravados, trocado à mão; `retomar` e `encerrar` são os dublês do
 * continuar e do Encerrar do gravador. Relógio de parede e setInterval falsos.
 */

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const HORA = AVISO_DE_HORA_SEGUNDOS;
const TITULO_ORIGINAL = "WRW — Women Rocking the World";
const PEDIDO_NA_ABA = "Confirme a gravação";
const PAROU_SOZINHA = "A gravação parou sozinha: ninguém confirmou o aviso de hora em 10 minutos. O que foi gravado segue para a transcrição.";

let retomar: ReturnType<typeof vi.fn>;
let encerrar: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ["setInterval", "clearInterval", "Date"] });
  retomar = vi.fn();
  encerrar = vi.fn();
  document.title = TITULO_ORIGINAL;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (navigator as { vibrate?: unknown }).vibrate;
});

function aviso(estado: EstadoDoGravador, segundos: number) {
  return <AvisoDeHoraDeGravacao estado={estado} segundos={segundos} retomar={retomar} encerrar={encerrar}/>;
}

/** O aviso com dois botões do gravador ao lado, como na tela de gravação. */
function naTela(estado: EstadoDoGravador, segundos: number) {
  return <><button type="button">Pausar</button><button type="button">Encerrar gravação</button>{aviso(estado, segundos)}</>;
}

/** Grava até a hora cheia: o aviso abre. */
function abrirNaPrimeiraHora() {
  const tela = render(aviso("gravando", HORA - 1));
  tela.rerender(aviso("gravando", HORA));
  return tela;
}

const andar = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

/** O sistema com "menos movimento" ligado: o dublê do MediaQueryList do navegador. */
function pedirMenosMovimento() {
  vi.stubGlobal("matchMedia", (consulta: string): MediaQueryList => ({
    matches: /prefers-reduced-motion:\s*reduce/.test(consulta),
    media: consulta, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

describe("AvisoDeHoraDeGravacao (G13a)", () => {
  it("fechado não desenha nada; na hora cheia é um alertdialog cujo nome pede a confirmação e traz as horas, e o foco vai ao OK", () => {
    const tela = render(aviso("gravando", HORA - 1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    tela.rerender(aviso("gravando", HORA));
    const cartao = screen.getByRole("alertdialog", { name: /Confirme a gravação/ });
    expect(cartao).toHaveAccessibleName("Confirme a gravação 1 h de gravação");
    expect(within(cartao).getByText("1 h de gravação")).toBeVisible();
    expect(cartao).toHaveAccessibleDescription("Para seguir gravando, confirme em até 10 minutos. Sem confirmação, a gravação para sozinha e o que já foi gravado segue para a transcrição.");
    expect(within(cartao).getByRole("button", { name: "Continuar gravando" })).toHaveFocus();
  });

  it("Continuar gravando fecha o aviso e retoma a gravação pausada, sem encerrar", () => {
    const tela = abrirNaPrimeiraHora();
    tela.rerender(aviso("pausado", HORA));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Continuar gravando" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(retomar).toHaveBeenCalledTimes(1);
    andar(2 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(encerrar).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("enquanto espera, o título da aba pisca; ao fechar, volta ao original e para de piscar", () => {
    abrirNaPrimeiraHora();
    expect(document.title).toBe(PEDIDO_NA_ABA);
    andar(PISCADA_DO_TITULO_MS);
    expect(document.title).toBe(TITULO_ORIGINAL);
    andar(PISCADA_DO_TITULO_MS);
    expect(document.title).toBe(PEDIDO_NA_ABA);
    fireEvent.click(screen.getByRole("button", { name: "Continuar gravando" }));
    expect(document.title).toBe(TITULO_ORIGINAL);
    andar(5 * PISCADA_DO_TITULO_MS);
    expect(document.title).toBe(TITULO_ORIGINAL);
  });

  it("com menos movimento pedido ao sistema, o título troca uma vez para o pedido e não pisca; ao fechar, volta ao original", () => {
    pedirMenosMovimento();
    abrirNaPrimeiraHora();
    expect(document.title).toBe(PEDIDO_NA_ABA);
    andar(PISCADA_DO_TITULO_MS);
    expect(document.title).toBe(PEDIDO_NA_ABA);
    andar(5 * PISCADA_DO_TITULO_MS);
    expect(document.title).toBe(PEDIDO_NA_ABA);
    fireEvent.click(screen.getByRole("button", { name: "Continuar gravando" }));
    expect(document.title).toBe(TITULO_ORIGINAL);
  });

  it("vibra uma vez ao abrir, e não de novo enquanto espera; sem vibração no navegador, abre do mesmo jeito", () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
    const tela = abrirNaPrimeiraHora();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(VIBRACAO_DO_AVISO_MS);
    andar(5 * 60_000);
    expect(vibrate).toHaveBeenCalledTimes(1);
    tela.unmount();
    delete (navigator as { vibrate?: unknown }).vibrate;
    abrirNaPrimeiraHora();
    expect(screen.getByRole("alertdialog", { name: /Confirme a gravação/ })).toBeInTheDocument();
  });

  it("o navegador que recusa a vibração (SecurityError, num iframe) não derruba a tela: o aviso abre e o foco vai ao OK", () => {
    const vibrate = vi.fn(() => { throw new DOMException("vibração recusada neste quadro", "SecurityError"); });
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
    abrirNaPrimeiraHora();
    expect(vibrate).toHaveBeenCalledTimes(1);
    const cartao = screen.getByRole("alertdialog", { name: /Confirme a gravação/ });
    expect(within(cartao).getByRole("button", { name: "Continuar gravando" })).toHaveFocus();
  });

  it("sem o OK em 10 min: encerra pelo caminho do Encerrar, uma vez, e avisa até ser fechado (com o X) que parou sozinha", () => {
    abrirNaPrimeiraHora();
    andar(PRAZO_DO_AVISO_DE_HORA_MS - 1);
    expect(encerrar).not.toHaveBeenCalled();
    andar(1);
    expect(encerrar).toHaveBeenCalledTimes(1);
    expect(retomar).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    // O id fixo é o que a gravação seguinte usa para fechar este aviso.
    expect(toast.info).toHaveBeenCalledWith(PAROU_SOZINHA, { id: "gravacao-parou-sem-confirmacao", duration: Infinity, closeButton: true });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.title).toBe(TITULO_ORIGINAL);
    andar(3 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(encerrar).toHaveBeenCalledTimes(1);
  });

  it("sair da tela com o aviso aberto: o título da aba volta, e o prazo não encerra nem avisa depois", () => {
    const tela = abrirNaPrimeiraHora();
    expect(document.title).toBe(PEDIDO_NA_ABA);
    tela.unmount();
    expect(document.title).toBe(TITULO_ORIGINAL);
    andar(PISCADA_DO_TITULO_MS);
    expect(document.title).toBe(TITULO_ORIGINAL);
    andar(PISCADA_DO_TITULO_MS);
    expect(document.title).toBe(TITULO_ORIGINAL);
    andar(2 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(encerrar).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe("AvisoDeHoraDeGravacao — o foco ao fechar", () => {
  const fechamentos: [string, (tela: RenderResult) => void][] = [
    ["pelo OK", () => fireEvent.click(screen.getByRole("button", { name: "Continuar gravando" }))],
    ["pelo prazo", () => andar(PRAZO_DO_AVISO_DE_HORA_MS)],
    ["pelo fim da gravação", tela => tela.rerender(naTela("parado", 0))],
  ];

  it.each(fechamentos)("fechado %s, o foco volta ao botão que o tinha antes do aviso, e não cai no body", (_, fechar) => {
    const tela = render(naTela("gravando", HORA - 1));
    const pausar = screen.getByRole("button", { name: "Pausar" });
    pausar.focus();
    tela.rerender(naTela("gravando", HORA));
    expect(screen.getByRole("button", { name: "Continuar gravando" })).toHaveFocus();
    fechar(tela);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(pausar).toHaveFocus();
  });

  it("a hora seguinte com o cartão ainda aberto (o relógio que saltou) não troca o foco guardado", () => {
    const tela = render(naTela("gravando", HORA - 1));
    const pausar = screen.getByRole("button", { name: "Pausar" });
    pausar.focus();
    tela.rerender(naTela("gravando", HORA));
    tela.rerender(naTela("gravando", 2 * HORA + 5));
    expect(screen.getByRole("alertdialog", { name: /2 h de gravação/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continuar gravando" }));
    expect(pausar).toHaveFocus();
  });

  it("quem levou o foco a outro lugar com o aviso aberto fica lá quando ele fecha", () => {
    const tela = render(naTela("gravando", HORA - 1));
    screen.getByRole("button", { name: "Pausar" }).focus();
    tela.rerender(naTela("gravando", HORA));
    const encerrarGravacao = screen.getByRole("button", { name: "Encerrar gravação" });
    encerrarGravacao.focus();
    andar(PRAZO_DO_AVISO_DE_HORA_MS);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(encerrarGravacao).toHaveFocus();
  });
});
