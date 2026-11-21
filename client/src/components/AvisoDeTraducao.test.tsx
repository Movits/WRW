import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AvisoDeTraducao } from "./AvisoDeTraducao";

/**
 * O aviso de tradução da aba Transcrição (T25): diz para que idioma a IA
 * traduziu, com o nome do idioma no idioma da tela, e o "Ver original" devolve
 * a tela ao idioma da reunião. O uso nas duas telas está em
 * pages/Meetings.test.tsx e pages/ReuniaoAberta.test.tsx.
 */

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("AvisoDeTraducao", () => {
  it("diz para que idioma a IA traduziu, e 'Ver original' chama a volta ao original", () => {
    const aoVerOriginal = vi.fn();
    render(<AvisoDeTraducao idioma="en" aoVerOriginal={aoVerOriginal}/>);
    expect(screen.getByText("Tradução automática para o inglês.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver original" }));
    expect(aoVerOriginal).toHaveBeenCalledTimes(1);
  });

  it("o nome do idioma sai no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    render(<AvisoDeTraducao idioma="pt-BR" aoVerOriginal={vi.fn()}/>);
    expect(screen.getByText("Automatic translation into Portuguese.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View original" })).toBeInTheDocument();
  });

  it("sem o Intl.DisplayNames no navegador, o nome é o do seletor de idiomas", () => {
    const original = Intl.DisplayNames;
    Object.defineProperty(Intl, "DisplayNames", { value: undefined, configurable: true, writable: true });
    try {
      render(<AvisoDeTraducao idioma="es" aoVerOriginal={vi.fn()}/>);
      expect(screen.getByText("Tradução automática para o Español.")).toBeInTheDocument();
    } finally {
      Object.defineProperty(Intl, "DisplayNames", { value: original, configurable: true, writable: true });
    }
  });
});
