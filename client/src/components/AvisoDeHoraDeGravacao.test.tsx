import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
  delete (navigator as { vibrate?: unknown }).vibrate;
});

function aviso(estado: EstadoDoGravador, segundos: number) {
  return <AvisoDeHoraDeGravacao estado={estado} segundos={segundos} retomar={retomar} encerrar={encerrar}/>;
}

/** Grava até a hora cheia: o aviso abre. */
function abrirNaPrimeiraHora() {
  const tela = render(aviso("gravando", HORA - 1));
  tela.rerender(aviso("gravando", HORA));
  return tela;
}

const andar = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("AvisoDeHoraDeGravacao (G13a)", () => {
  it("fechado não desenha nada; na hora cheia é um alertdialog com nome e descrição, e o foco vai ao OK", () => {
    const tela = render(aviso("gravando", HORA - 1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    tela.rerender(aviso("gravando", HORA));
    const cartao = screen.getByRole("alertdialog", { name: "1 h de gravação" });
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
    expect(screen.getByRole("alertdialog", { name: "1 h de gravação" })).toBeInTheDocument();
  });

  it("sem o OK em 10 min: encerra pelo caminho do Encerrar, uma vez, e avisa até ser fechado que parou sozinha", () => {
    abrirNaPrimeiraHora();
    andar(PRAZO_DO_AVISO_DE_HORA_MS - 1);
    expect(encerrar).not.toHaveBeenCalled();
    andar(1);
    expect(encerrar).toHaveBeenCalledTimes(1);
    expect(retomar).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(PAROU_SOZINHA, { id: "gravacao-parou-sem-confirmacao", duration: Infinity });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.title).toBe(TITULO_ORIGINAL);
    andar(3 * PRAZO_DO_AVISO_DE_HORA_MS);
    expect(encerrar).toHaveBeenCalledTimes(1);
  });
});
