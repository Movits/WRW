import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvisoSemMicrofone, VIBRACAO_SEM_MICROFONE_MS } from "./AvisoSemMicrofone";

/**
 * O aviso do microfone que caiu (G17): o leitor de tela o anuncia, o celular
 * vibra uma vez, e o "Tentar de novo" pede o microfone na hora. O hook que
 * espera e reabre o microfone tem os testes dele em
 * hooks/useGravadorDeAudio.test.ts.
 */
describe("AvisoSemMicrofone (G17)", () => {
  afterEach(() => {
    delete (navigator as { vibrate?: unknown }).vibrate;
  });

  it("anuncia a queda (role alert), diz que a gravação segue sozinha, vibra uma vez e oferece o Tentar de novo", () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
    const aoTentarDeNovo = vi.fn();
    const { rerender } = render(<AvisoSemMicrofone bloqueado={false} aoTentarDeNovo={aoTentarDeNovo}/>);
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent("O microfone desconectou");
    expect(aviso).toHaveTextContent("assim que houver um microfone, ela segue sozinha");
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(VIBRACAO_SEM_MICROFONE_MS);
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(aoTentarDeNovo).toHaveBeenCalledTimes(1);
    // A troca do texto (o navegador recusou) não vibra de novo.
    rerender(<AvisoSemMicrofone bloqueado aoTentarDeNovo={aoTentarDeNovo}/>);
    expect(screen.getByRole("alert")).toHaveTextContent("Libere o microfone para este site");
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("o navegador que recusa vibrar (SecurityError) não derruba o aviso", () => {
    Object.defineProperty(navigator, "vibrate", { configurable: true, value: () => { throw new DOMException("bloqueado", "SecurityError"); } });
    render(<AvisoSemMicrofone bloqueado={false} aoTentarDeNovo={vi.fn()}/>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
