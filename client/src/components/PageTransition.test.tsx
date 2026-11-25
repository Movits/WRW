import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTransition } from "./PageTransition";

/**
 * O véu preto da troca de tela cobre o app inteiro e bloqueia o toque enquanto
 * escurece. Se a URL volta à tela de antes no mesmo instante (o gravador faz
 * isso ao devolver a URL para /gravar durante a gravação), ele não pode ficar
 * preso: era uma tela preta que não respondia a nada.
 */

const veu = () => document.querySelector<HTMLDivElement>("div[aria-hidden='true']")!;

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("PageTransition", () => {
  it("numa troca de tela, escurece e depois volta a deixar o toque passar", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/a");
    render(<PageTransition><p>tela</p></PageTransition>);
    // Montar não escurece.
    expect(veu().style.pointerEvents).toBe("none");
    act(() => window.history.pushState(null, "", "/b"));
    expect(veu().style.pointerEvents).toBe("all");
    act(() => vi.advanceTimersByTime(700));
    expect(veu().style.pointerEvents).toBe("none");
    expect(veu().style.opacity).toBe("0");
  });

  it("a troca seguinte, durante o clarear da anterior, escurece inteira: o timer do clarear velho não a corta", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/a");
    render(<PageTransition><p>tela</p></PageTransition>);
    act(() => window.history.pushState(null, "", "/b"));
    act(() => vi.advanceTimersByTime(400));
    // Aos 400 ms a troca para /b está clareando (o timer do clarear venceria aos 630).
    act(() => window.history.pushState(null, "", "/c"));
    act(() => vi.advanceTimersByTime(231));
    // Aos 631 ms o escurecer de /c (até 680) continua, com o toque bloqueado.
    expect(veu().style.opacity).toBe("1");
    expect(veu().style.pointerEvents).toBe("all");
    act(() => vi.advanceTimersByTime(700));
    expect(veu().style.pointerEvents).toBe("none");
    expect(veu().style.opacity).toBe("0");
  });

  it("A → B → A antes de o escurecer terminar não deixa o véu preso", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/a");
    render(<PageTransition><p>tela</p></PageTransition>);
    act(() => window.history.pushState(null, "", "/b"));
    act(() => window.history.replaceState(null, "", "/a"));
    // A volta à tela anterior desfaz o escurecer na hora, sem esperar o ciclo.
    expect(veu().style.pointerEvents).toBe("none");
    expect(veu().style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(700));
    expect(veu().style.pointerEvents).toBe("none");
    expect(veu().style.opacity).toBe("0");
  });
});
