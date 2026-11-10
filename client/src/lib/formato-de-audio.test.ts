import { describe, expect, it } from "vitest";
import { escolherMimeDeGravacao, MIMES_DE_GRAVACAO, tipoParaOServidor } from "./formato-de-audio";

const gravaSo = (formatos: string[]) => (tipo: string) => formatos.includes(tipo);

describe("escolherMimeDeGravacao", () => {
  it("com tudo à escolha, pede o mp4 (AAC) antes do webm (#158)", () => {
    expect(escolherMimeDeGravacao(() => true)).toBe("audio/mp4;codecs=mp4a.40.2");
  });

  it("o navegador que só grava mp4 sem codec declarado fica no mp4", () => {
    expect(escolherMimeDeGravacao(gravaSo(["audio/mp4"]))).toBe("audio/mp4");
  });

  it("sem mp4, cai no webm/Opus e, sem webm, no ogg", () => {
    expect(escolherMimeDeGravacao(gravaSo(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]))).toBe("audio/webm;codecs=opus");
    expect(escolherMimeDeGravacao(gravaSo(["audio/ogg;codecs=opus"]))).toBe("audio/ogg;codecs=opus");
  });

  it("nada da lista: undefined, e o gravador usa o padrão do navegador", () => {
    expect(escolherMimeDeGravacao(() => false)).toBeUndefined();
  });

  it("todo formato da lista vira um tipo que o servidor aceita", () => {
    for (const tipo of MIMES_DE_GRAVACAO) expect(["audio/mp4", "audio/webm", "audio/ogg"]).toContain(tipoParaOServidor(tipo));
  });
});

describe("tipoParaOServidor", () => {
  it.each([
    ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"],
    ["audio/mp4", "audio/mp4"],
    ["audio/x-m4a", "audio/mp4"],
    ["audio/webm;codecs=opus", "audio/webm"],
    ["video/webm;codecs=vp8,opus", "audio/webm"],
    ["audio/ogg;codecs=opus", "audio/ogg"],
    ["audio/wav", "audio/wav"],
    ["", "audio/webm"],
  ])("%s vai como %s", (doNavegador, esperado) => {
    expect(tipoParaOServidor(doNavegador)).toBe(esperado);
  });
});
