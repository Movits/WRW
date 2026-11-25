import { describe, expect, it } from "vitest";
import { andamentoDasPartes, reuniaoEmAndamento } from "./transcricao-durante-a-gravacao";

/**
 * O andamento das partes durante a gravação (G15a), sem banco: o estado que a
 * tela mostra, o início de cada parte e o atraso da transcrita. O resto (a
 * leitura só da dona, o texto em lotes, a pergunta) está no teste de
 * integração ao lado.
 */
const AGORA = 1_000_000_000;
type Linha = Parameters<typeof andamentoDasPartes>[0][number];
const linha = (seq: number, campos: Partial<Linha> = {}): Linha => ({
  seq, status: "received", durationMs: 600_000, offsetMs: null, lockedUntil: null, createdAt: AGORA - 60_000, updatedAt: AGORA - 60_000, ...campos,
});

describe("andamentoDasPartes", () => {
  it("o estado de cada parte: subindo, na fila, sendo transcrita (reservada pela fila), transcrita e sem texto", () => {
    const partes = andamentoDasPartes([
      linha(0, { status: "transcribed", offsetMs: 0, updatedAt: AGORA - 15_000 }),
      linha(1, { status: "failed" }),
      linha(2, { lockedUntil: AGORA + 1 }),
      linha(3, { lockedUntil: AGORA - 1 }),
      linha(4, { status: "uploading" }),
    ], AGORA);
    expect(partes.map(p => p.estado)).toEqual(["transcrita", "falhou", "transcrevendo", "na_fila", "enviando"]);
  });

  it("o atraso é da chegada ao texto pronto, só na transcrita; e nunca negativo", () => {
    const [transcrita, naFila, relogioTorto] = andamentoDasPartes([
      linha(0, { status: "transcribed", offsetMs: 0, createdAt: AGORA - 100_000, updatedAt: AGORA - 10_400 }),
      linha(1),
      linha(2, { status: "transcribed", offsetMs: 1_200_000, createdAt: AGORA, updatedAt: AGORA - 5_000 }),
    ], AGORA);
    expect(transcrita).toMatchObject({ atrasoSegundos: 90, prontaEm: AGORA - 10_400, chegouEm: AGORA - 100_000 });
    expect(naFila).toMatchObject({ atrasoSegundos: null, prontaEm: null });
    expect(relogioTorto.atrasoSegundos).toBe(0);
  });

  it("o início: o que a transcrição gravou, ou a soma das anteriores; a parte que não chegou conta a duração padrão", () => {
    const partes = andamentoDasPartes([
      linha(0, { status: "transcribed", offsetMs: 0, durationMs: 590_000 }),
      linha(1, { durationMs: 610_000 }),
      linha(3, { durationMs: 120_000 }),
    ], AGORA);
    expect(partes.map(p => [p.seq, p.inicioSegundos, p.duracaoSegundos])).toEqual([[0, 0, 590], [1, 590, 610], [3, 1800, 120]]);
  });

  it("sem partes, nada", () => {
    expect(andamentoDasPartes([], AGORA)).toEqual([]);
  });
});

describe("reuniaoEmAndamento", () => {
  it("gravando, recebendo as últimas partes ou montando a transcrição; pronta, com falha ou excluída, não", () => {
    expect(["recording", "uploading", "processing"].every(reuniaoEmAndamento)).toBe(true);
    expect(["ready", "failed", "deleted"].some(reuniaoEmAndamento)).toBe(false);
  });
});
