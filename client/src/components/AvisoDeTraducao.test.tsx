import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n, { LANGUAGES } from "@/i18n";
import { AvisoDeTraducao } from "./AvisoDeTraducao";

/**
 * O aviso de tradução da aba Transcrição (T25): diz para que idioma a IA
 * traduziu, com o nome do idioma no idioma da tela, e o "Ver original" devolve
 * a tela ao idioma da reunião e leva o foco ao elemento indicado. O uso nas
 * duas telas está em pages/Meetings.test.tsx e pages/ReuniaoAberta.test.tsx.
 */

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("AvisoDeTraducao", () => {
  it("diz para que idioma a IA traduziu, e 'Ver original' chama a volta ao original", () => {
    const aoVerOriginal = vi.fn();
    render(<AvisoDeTraducao idioma="en" aoVerOriginal={aoVerOriginal} focoDepois={createRef()}/>);
    expect(screen.getByText("Tradução automática para o inglês.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver original" }));
    expect(aoVerOriginal).toHaveBeenCalledTimes(1);
  });

  it("'Ver original' leva o foco ao elemento indicado: o botão some com o aviso, e o foco não pode cair no <body>", () => {
    const seletor = createRef<HTMLSelectElement>();
    render(<><select ref={seletor} aria-label="Idioma de destino"/><AvisoDeTraducao idioma="en" aoVerOriginal={vi.fn()} focoDepois={seletor}/></>);
    const verOriginal = screen.getByRole("button", { name: "Ver original" });
    verOriginal.focus();
    fireEvent.click(verOriginal);
    expect(seletor.current).toHaveFocus();
  });

  it("o nome do idioma sai no idioma da tela", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    render(<AvisoDeTraducao idioma="pt-BR" aoVerOriginal={vi.fn()} focoDepois={createRef()}/>);
    expect(screen.getByText("Automatic translation into Portuguese.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View original" })).toBeInTheDocument();
  });

  it("em alemão, o nome do idioma entra sem pedir declinação ('Übersetzung auf Portugiesisch' soava mal)", async () => {
    await act(async () => { await i18n.changeLanguage("de"); });
    render(<AvisoDeTraducao idioma="pt-BR" aoVerOriginal={vi.fn()} focoDepois={createRef()}/>);
    expect(screen.getByText("Automatisch übersetzt. Zielsprache: Portugiesisch.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Original anzeigen" })).toBeInTheDocument();
  });

  it("nos 10 idiomas da tela, o nome do idioma entra no aviso, sem sobrar o marcador do modelo", async () => {
    for (const { code } of LANGUAGES) {
      await act(async () => { await i18n.changeLanguage(code); });
      const { container, unmount } = render(<AvisoDeTraducao idioma="pt-BR" aoVerOriginal={vi.fn()} focoDepois={createRef()}/>);
      const aviso = container.textContent ?? "";
      expect(aviso, code).toContain(new Intl.DisplayNames([code], { type: "language" }).of("pt"));
      expect(aviso, code).not.toContain("{{");
      unmount();
    }
  });

  it("sem o Intl.DisplayNames no navegador, o nome é o do seletor de idiomas", () => {
    const original = Intl.DisplayNames;
    Object.defineProperty(Intl, "DisplayNames", { value: undefined, configurable: true, writable: true });
    try {
      render(<AvisoDeTraducao idioma="es" aoVerOriginal={vi.fn()} focoDepois={createRef()}/>);
      expect(screen.getByText("Tradução automática para o Español.")).toBeInTheDocument();
    } finally {
      Object.defineProperty(Intl, "DisplayNames", { value: original, configurable: true, writable: true });
    }
  });
});
