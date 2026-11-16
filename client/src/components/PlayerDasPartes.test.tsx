import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerDasPartes, type ControleDoPlayer } from "./PlayerDasPartes";

const PARTES = [
  { seq: 0, url: "/a/0.m4a", mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 },
  { seq: 1, url: "/a/1.m4a", mimeType: "audio/mp4", inicioSegundos: 600, duracaoSegundos: 600 },
  { seq: 2, url: "/a/2.m4a", mimeType: "audio/mp4", inicioSegundos: 1200, duracaoSegundos: 300 },
];

const audio = () => document.querySelector("audio")!;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

describe("PlayerDasPartes (D1)", () => {
  it("começa na primeira parte e, ao terminar, passa à seguinte tocando", () => {
    render(<PlayerDasPartes partes={PARTES} />);
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/1.m4a");
    fireEvent.loadedMetadata(audio());
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("na última parte, terminar não dá volta", () => {
    render(<PlayerDasPartes partes={[PARTES[0]]} />);
    fireEvent.ended(audio());
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
  });

  it("irPara acha a parte do segundo (absoluto) e começa dali", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    act(() => controle.current!.irPara(1250));
    expect(audio().getAttribute("src")).toBe("/a/2.m4a");
    fireEvent.loadedMetadata(audio());
    expect(audio().currentTime).toBe(50);
  });

  it("irPara na parte atual só muda o ponto", () => {
    const controle = createRef<ControleDoPlayer>();
    render(<PlayerDasPartes ref={controle} partes={PARTES} />);
    act(() => controle.current!.irPara(30));
    expect(audio().getAttribute("src")).toBe("/a/0.m4a");
    expect(audio().currentTime).toBe(30);
  });

  it("falha do áudio avisa a tela (sem isso, o player falha mudo)", () => {
    const aoFalhar = vi.fn();
    render(<PlayerDasPartes partes={PARTES} aoFalhar={aoFalhar} />);
    fireEvent.error(audio());
    expect(aoFalhar).toHaveBeenCalled();
  });

  it("sem partes, não desenha nada", () => {
    const { container } = render(<PlayerDasPartes partes={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
