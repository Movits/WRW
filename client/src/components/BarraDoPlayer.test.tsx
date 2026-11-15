import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BarraDoPlayer } from "./BarraDoPlayer";
import type { ControleDoPlayer } from "./PlayerDasPartes";

/**
 * A barra do player no rodapé (H4b): só aparece com áudio, leva o rótulo da
 * gravação no idioma da tela, repassa o "ir para" ao player das partes e mostra
 * o aviso de áudio que não carregou.
 */
const PARTES = [
  { seq: 0, url: "/a/0.m4a", mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
  { seq: 1, url: "/a/1.m4a", mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 120 },
];

describe("BarraDoPlayer", () => {
  it("sem partes, não desenha nada", () => {
    const { container } = render(<BarraDoPlayer partes={[]}/>);
    expect(container).toBeEmptyDOMElement();
  });

  it("fica fixa no rodapé, com o rótulo traduzido, e o ref leva o player à parte do segundo", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const controle = createRef<ControleDoPlayer>();
    render(<BarraDoPlayer ref={controle} partes={PARTES}/>);
    const barra = screen.getByRole("region", { name: "Gravação" });
    expect(barra.className).toContain("fixed");
    expect(barra.querySelector("audio")).toHaveAttribute("src", "/a/0.m4a");
    act(() => controle.current!.irPara(650));
    expect(barra.querySelector("audio")).toHaveAttribute("src", "/a/1.m4a");
  });

  it("o aviso aparece embaixo do player, como status", () => {
    render(<BarraDoPlayer partes={PARTES} aviso="O áudio não carregou."/>);
    expect(screen.getByRole("status")).toHaveTextContent("O áudio não carregou.");
  });
});
