import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => { vi.restoreAllMocks(); });

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

  it("o aviso aparece embaixo do player, como status; sem aviso, o status fica montado e vazio", () => {
    const { rerender } = render(<BarraDoPlayer partes={PARTES}/>);
    expect(screen.getByRole("status")).toHaveTextContent(/^$/);
    rerender(<BarraDoPlayer partes={PARTES} aviso="O áudio não carregou."/>);
    expect(screen.getByRole("status")).toHaveTextContent("O áudio não carregou.");
  });

  it("o áudio leva o rótulo da gravação, e o pulo dentro da mesma parte toca dali", () => {
    const tocar = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const controle = createRef<ControleDoPlayer>();
    render(<BarraDoPlayer ref={controle} partes={PARTES}/>);
    const audio = screen.getByLabelText("Gravação", { selector: "audio" }) as HTMLAudioElement;
    act(() => controle.current!.irPara(30));
    expect(audio.getAttribute("src")).toBe("/a/0.m4a");
    expect(tocar).toHaveBeenCalledTimes(1);
  });

  // D2: ouvindo só uma voz, a barra diz qual, em qualquer aba, e volta a todas num toque.
  it("ouvindo só uma voz, a barra diz qual e o Ouvir todas as vozes avisa a página", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const aoMudar = vi.fn();
    const falas = [{ inicio: 1, fim: 5, falante: "F2", texto: "Oi." }];
    const { rerender } = render(<BarraDoPlayer partes={PARTES} falas={falas} soAVoz={null} aoMudarSoAVoz={aoMudar}/>);
    expect(screen.queryByText(/Ouvindo só/)).not.toBeInTheDocument();
    rerender(<BarraDoPlayer partes={PARTES} falas={falas} soAVoz="F2" rotuloDaVoz="Bruno" aoMudarSoAVoz={aoMudar}/>);
    expect(screen.getByText("Ouvindo só: Bruno")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ouvir todas as vozes" }));
    expect(aoMudar).toHaveBeenCalledWith(null);
  });
});
