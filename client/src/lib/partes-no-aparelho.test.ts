import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexedDBEmMemoria } from "@/test/indexeddb-em-memoria";
import {
  aoMudarAsPartes, apagarParte, apagarPartesDaReuniao, apagarTodasAsPartes, contarPartesDa, guardarParte, parteNoAparelho, partesGuardadas, type ParteNoAparelho,
} from "./partes-no-aparelho";

// Quantas vezes o getAll trouxe as partes inteiras (com o áudio) para a memória.
let leiturasComOAudio = 0;

const parte = (meetingId: string, seq: number, dona = "dona-1"): ParteNoAparelho => ({
  meetingId, seq, dona, blob: new Blob(["som"]), mimeType: "audio/mp4", duracaoMs: 600_000, guardadaEm: 1,
});

beforeEach(() => {
  leiturasComOAudio = 0;
  vi.stubGlobal("indexedDB", indexedDBEmMemoria({ aoLerComOAudio: () => { leiturasComOAudio++; } }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("partes-no-aparelho (G9)", () => {
  it("guarda, lista só as da conta em ordem de reunião e de parte, e apaga uma", async () => {
    await guardarParte(parte("r-2", 1));
    await guardarParte(parte("r-2", 0));
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-9", 0, "outra-conta"));
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-1#0", "r-2#0", "r-2#1"]);
    await apagarParte("r-2", 0);
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-1#0", "r-2#1"]);
  });

  it("a mesma parte guardada de novo substitui a anterior (chave reunião + parte)", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte({ ...parte("r-1", 0), duracaoMs: 5 });
    const partes = await partesGuardadas("dona-1");
    expect(partes).toHaveLength(1);
    expect(partes[0].duracaoMs).toBe(5);
  });

  it("apagarTodasAsPartes (Sair, excluir a conta) não deixa voz de ninguém no aparelho", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-9", 0, "outra-conta"));
    await apagarTodasAsPartes();
    expect(await partesGuardadas("dona-1")).toEqual([]);
    expect(await partesGuardadas("outra-conta")).toEqual([]);
  });

  it("sem IndexedDB, falha (quem chama segue da memória)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(guardarParte(parte("r-1", 0))).rejects.toThrow("Sem IndexedDB");
  });

  it("a gravação descartada (G13b): saem do aparelho só as partes dela, de qualquer conta, e as outras ficam", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-1", 1));
    await guardarParte(parte("r-2", 0));
    await guardarParte(parte("r-9", 0, "outra-conta"));
    await apagarPartesDaReuniao("r-1");
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-2#0"]);
    expect(await partesGuardadas("outra-conta")).toHaveLength(1);
  });

  it("apagar a gravação descartada lê só as chaves: o áudio das partes guardadas não vem para a memória (revisão da G13b)", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-1", 1));
    await guardarParte(parte("r-2", 0));
    await apagarPartesDaReuniao("r-1");
    expect(leiturasComOAudio).toBe(0);
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-2#0"]);
  });

  it("sem IndexedDB nada foi guardado: apagar a gravação descartada não tem o que apagar e não falha", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(apagarPartesDaReuniao("r-1")).resolves.toBeUndefined();
  });
});

/**
 * G13c: a retomada de toda tela logada precisa saber quando a tela que grava
 * deixa uma parte no aparelho (o IndexedDB não avisa sozinho), e quem envia
 * confere, já com a trava, se a parte ainda está aqui.
 */
describe("partes-no-aparelho — o aviso de mudança e a conferência (G13c)", () => {
  it("avisa quem ouve a cada parte guardada, apagada ou limpa, e para de avisar quando pedem", async () => {
    const ouvinte = vi.fn();
    const pararDeOuvir = aoMudarAsPartes(ouvinte);
    await guardarParte(parte("r-1", 0));
    expect(ouvinte).toHaveBeenCalledTimes(1);
    await guardarParte(parte("r-1", 1));
    await apagarParte("r-1", 0);
    expect(ouvinte).toHaveBeenCalledTimes(3);
    await apagarPartesDaReuniao("r-1");
    expect(ouvinte).toHaveBeenCalledTimes(4);
    await apagarTodasAsPartes();
    expect(ouvinte).toHaveBeenCalledTimes(5);
    pararDeOuvir();
    await guardarParte(parte("r-2", 0));
    expect(ouvinte).toHaveBeenCalledTimes(5);
  });

  it("o que falhou não avisa: nada mudou", async () => {
    const ouvinte = vi.fn();
    const pararDeOuvir = aoMudarAsPartes(ouvinte);
    vi.stubGlobal("indexedDB", undefined);
    await expect(guardarParte(parte("r-1", 0))).rejects.toThrow("Sem IndexedDB");
    expect(ouvinte).not.toHaveBeenCalled();
    pararDeOuvir();
  });

  it("parteNoAparelho conta só a chave, sem trazer o áudio para a memória", async () => {
    await guardarParte(parte("r-1", 0));
    expect(await parteNoAparelho("r-1", 0)).toBe(true);
    expect(await parteNoAparelho("r-1", 1)).toBe(false);
    await apagarParte("r-1", 0);
    expect(await parteNoAparelho("r-1", 0)).toBe(false);
    expect(leiturasComOAudio).toBe(0);
  });
});

describe("partes-no-aparelho — a conta das partes sem o áudio de todas (revisão da G13c)", () => {
  it("contarPartesDa conta as da conta pelas chaves, lendo uma parte por reunião, e pula as reuniões pedidas sem ler nada delas", async () => {
    // Quantas partes inteiras (com o áudio) cada leitura trouxe, e quantas leituras foram só de chaves.
    const lidasComOAudio: number[] = [];
    let leiturasDeChaves = 0;
    vi.stubGlobal("indexedDB", indexedDBEmMemoria({ aoLerComOAudio: partes => { lidasComOAudio.push(partes); }, aoLerAsChaves: () => { leiturasDeChaves++; } }));
    for (const seq of [0, 1, 2]) await guardarParte(parte("r-1", seq));
    await guardarParte(parte("r-2", 0, "outra-conta"));
    await guardarParte(parte("r-3", 0));
    await guardarParte(parte("r-3", 1));
    expect(await contarPartesDa("dona-1")).toBe(5);
    expect(await contarPartesDa("outra-conta")).toBe(1);
    expect(await contarPartesDa("dona-1", meetingId => meetingId === "r-3")).toBe(3);
    // Nenhuma leitura de todas as partes: uma parte por reunião contada (3, 3 e 2).
    expect(lidasComOAudio).toEqual(Array(8).fill(1));
    expect(leiturasDeChaves).toBe(3);
  });
});
