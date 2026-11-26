import { describe, expect, it, vi } from "vitest";
import type { OpcoesDoCorte } from "./corte-comum";
import { cortarNasPausas, DetectorDePausas, MapaDasPausas, PlanoDasPausas, SEM_PAUSAS, type PausasDoArquivo, type PausasDoCorte } from "./pausas-do-corte";

/**
 * A emenda das partes na pausa da fala (conferência de tela do pacote 4b): o
 * detector acha as pausas num fluxo de níveis, o plano fecha cada parte na
 * última pausa que cabe nela, e cortarNasPausas lê duas vezes. Os cortes de
 * cada formato com arquivos de codificador de verdade estão em
 * server/corte-na-pausa-com-codificadores.test.ts.
 */

const FALA = 100;
const PAUSA = 1;

/** Itens de 20 ms (cada um uma unidade) com o nível de `nivelEm(ms)`. */
function detectar(duracaoMs: number, nivelEm: (ms: number) => number, permitida: (ms: number) => boolean = () => true) {
  const detector = new DetectorDePausas();
  for (let ms = 0, k = 0; ms < duracaoMs; ms += 20, k++) detector.acrescentar({ duracaoMs: 20, nivel: nivelEm(ms), fronteira: { indice: k, bytes: k * 10, permitida: permitida(ms) } });
  return detector.terminar();
}

describe("DetectorDePausas", () => {
  it("a pausa de 500 ms no meio da fala vira um ponto, na fronteira do meio dela, com o tempo e os bytes até ali", () => {
    const pontos = detectar(6000, ms => (ms >= 3000 && ms < 3500 ? PAUSA : FALA));
    expect(pontos).toEqual([{ indice: 162, tempoMs: 3240, bytes: 1620 }]);
  });

  it("a pausa mais curta que 300 ms não conta: é a respiração no meio da frase", () => {
    expect(detectar(6000, ms => (ms >= 3000 && ms < 3260 ? PAUSA : FALA))).toEqual([]);
  });

  it("o nível conta em relação à fala do trecho: a pausa com ruído de sala a −30 dB da fala é pausa; a fala mais baixa (−6 dB), não", () => {
    expect(detectar(6000, ms => (ms >= 3000 && ms < 3500 ? FALA / 30 : FALA))).toHaveLength(1);
    expect(detectar(6000, ms => (ms >= 3000 && ms < 3500 ? FALA / 2 : FALA))).toEqual([]);
  });

  it("com unidades grossas, a pausa precisa de uma fronteira com 100 ms de calma de cada lado", () => {
    // Fronteiras só a cada 400 ms (as páginas do Ogg, por exemplo). A pausa de
    // 3.380 a 3.760 ms tem a de 3.600 dentro, a 220 ms do começo e a 160 do fim.
    const comFronteira = detectar(6000, ms => (ms >= 3380 && ms < 3760 ? PAUSA : FALA), ms => ms % 400 === 0);
    expect(comFronteira.map(p => p.tempoMs)).toEqual([3600]);
    // A de 3.560 a 3.900 também tem a de 3.600, mas a 40 ms do começo: o corte ali levaria o fim da palavra.
    expect(detectar(6000, ms => (ms >= 3560 && ms < 3900 ? PAUSA : FALA), ms => ms % 400 === 0)).toEqual([]);
  });

  it("a fronteira que não é permitida (no WAV, a que passa do teto) não vira ponto: vale a melhor das permitidas", () => {
    const pontos = detectar(6000, ms => (ms >= 3000 && ms < 3600 ? PAUSA : FALA), ms => ms <= 3200);
    expect(pontos.map(p => p.tempoMs)).toEqual([3200]);
  });

  it("o quadro que não se leu (Infinity) nunca é pausa e não entra na referência", () => {
    // Um quinto da fala ilegível: na referência, ele a levaria a Infinity, e toda a fala viraria "pausa".
    const fala = (ms: number) => (ms % 100 === 0 ? Infinity : FALA);
    expect(detectar(6000, ms => (ms >= 3000 && ms < 3500 ? PAUSA : fala(ms))).map(p => p.tempoMs)).toEqual([3240]);
    // O quadro ilegível no meio da pausa a parte em duas de menos de 300 ms.
    expect(detectar(6000, ms => (ms >= 3000 && ms < 3500 ? (ms === 3240 ? Infinity : PAUSA) : fala(ms)))).toEqual([]);
  });

  it("o trecho todo em silêncio digital (nível 0) é pausa pelo piso", () => {
    expect(detectar(6000, ms => (ms >= 3000 && ms < 3500 ? 0 : FALA))).toHaveLength(1);
  });
});

/** O plano com os pontos `pontos` (tempo em ms e bytes = tempo, um ponto por unidade de 20 ms). */
function plano(pontos: number[], totalMs: number, limiteMs: number, limiteBytes = Infinity) {
  const pausas: PausasDoArquivo = { pontos: pontos.map(ms => ({ indice: ms / 20, tempoMs: ms, bytes: ms })), tempoMs: totalMs, bytes: totalMs };
  return new PlanoDasPausas(pausas, limiteMs, limiteBytes);
}

/** Corta com o plano como um corte de verdade: unidades de 20 ms (20 bytes), fechando no teto ou quando o plano manda. */
function cortarComPlano(p: PausasDoCorte, totalMs: number, limiteMs: number, limiteBytes = Infinity): number[] {
  const emendas: number[] = [];
  let parte = 0;
  for (let ms = 0; ms < totalMs; ms += 20) {
    if (parte > 0 && (parte + 20 > limiteMs || parte + 20 > limiteBytes || p.antes(parte, parte))) {
      emendas.push(ms);
      parte = 0;
    }
    parte += 20;
    p.depois(20, 20, 0);
  }
  return emendas;
}

describe("PlanoDasPausas", () => {
  it("fecha cada parte na última pausa antes do teto", () => {
    // Partes de 10 s (janela de 2,5 s): pausas em 8, 9,5, 17 e 18,6 s.
    expect(cortarComPlano(plano([8000, 9500, 17000, 18600], 25_000, 10_000), 25_000, 10_000)).toEqual([9500, 18600]);
  });

  it("sem pausa na janela, corta no teto, como antes", () => {
    expect(cortarComPlano(plano([2000, 5000], 25_000, 10_000), 25_000, 10_000)).toEqual([10_000, 20_000]);
  });

  it("a pausa longe do teto (fora da janela) não fecha a parte cedo, mesmo sem outra pausa depois", () => {
    expect(cortarComPlano(plano([6000], 25_000, 10_000), 25_000, 10_000)).toEqual([10_000, 20_000]);
  });

  it("o resto do arquivo que cabe na parte não a fecha na última pausa", () => {
    expect(cortarComPlano(plano([9000], 9800, 10_000), 9800, 10_000)).toEqual([]);
    expect(cortarComPlano(plano([9000], 12_000, 10_000), 12_000, 10_000)).toEqual([9000]);
  });

  it("o teto de bytes conta como o de tempo: a parte fecha na pausa antes dele", () => {
    expect(cortarComPlano(plano([4500], 12_000, 60_000, 5000), 12_000, 60_000, 5000)).toEqual([4500, 9500]);
  });

  it("sem plano (SEM_PAUSAS), o corte de sempre", () => {
    expect(cortarComPlano(SEM_PAUSAS, 25_000, 10_000)).toEqual([10_000, 20_000]);
  });
});

describe("cortarNasPausas", () => {
  type Resultado = { ok: true; partes: unknown[] } | { ok: false };
  /** Um corte de mentira: N unidades de 20 ms, com pausa em `pausaEm`, e quantas partes ele devolve. */
  function corteFalso(partes: number, pausaEm: number[] = [], recusaNaSegunda = false) {
    const chamadas: Array<PausasDoCorte | undefined> = [];
    const cortar = vi.fn(async (opcoes: OpcoesDoCorte): Promise<Resultado> => {
      chamadas.push(opcoes.pausas);
      opcoes.aoLer?.(500, 1000);
      opcoes.aoLer?.(1000, 1000);
      for (let ms = 0; ms < 30_000; ms += 20) opcoes.pausas?.depois(20, 20, pausaEm.some(p => ms >= p && ms < p + 500) ? 0 : 100);
      if (recusaNaSegunda && chamadas.length === 2) return { ok: false };
      return { ok: true, partes: new Array(partes).fill(chamadas.length) };
    });
    return { cortar, chamadas };
  }
  const partes = (r: Resultado) => (r.ok ? r.partes.length : null);

  it("com pausa e mais de uma parte: lê duas vezes (a primeira acha as pausas) e vale a segunda; o andamento vai a 50% e depois a 100%", async () => {
    const { cortar, chamadas } = corteFalso(3, [9000]);
    const aoLer = vi.fn();
    const resultado = await cortarNasPausas(cortar, 1000, { aoLer }, partes);
    expect(chamadas[0]).toBeInstanceOf(MapaDasPausas);
    expect(chamadas[1]).toBeInstanceOf(PlanoDasPausas);
    expect(resultado).toEqual({ ok: true, partes: [2, 2, 2] });
    expect(aoLer.mock.calls).toEqual([[250, 1000], [500, 1000], [750, 1000], [1000, 1000]]);
  });

  it("sem pausa, ou com uma parte só, lê uma vez, e o andamento termina no arquivo inteiro", async () => {
    for (const [n, pausas] of [[3, []], [1, [9000]]] as const) {
      const { cortar } = corteFalso(n, [...pausas]);
      const aoLer = vi.fn();
      await cortarNasPausas(cortar, 1000, { aoLer }, partes);
      expect(cortar).toHaveBeenCalledTimes(1);
      expect(aoLer).toHaveBeenLastCalledWith(1000, 1000);
    }
  });

  it("a segunda leitura que recusa (as pausas encurtaram as partes além do teto da reunião): vale a primeira", async () => {
    const { cortar } = corteFalso(3, [9000], true);
    expect(await cortarNasPausas(cortar, 1000, {}, partes)).toEqual({ ok: true, partes: [1, 1, 1] });
  });

  it("a recusa na primeira leitura vale de vez", async () => {
    const cortar = vi.fn(async (): Promise<Resultado> => ({ ok: false }));
    expect(await cortarNasPausas(cortar, 1000, {}, partes)).toEqual({ ok: false });
    expect(cortar).toHaveBeenCalledTimes(1);
  });

  it("com as pausas já dadas (SEM_PAUSAS, o corte de sempre), corta uma vez com elas", async () => {
    const { cortar, chamadas } = corteFalso(3, [9000]);
    await cortarNasPausas(cortar, 1000, { pausas: SEM_PAUSAS }, partes);
    expect(chamadas).toEqual([SEM_PAUSAS]);
  });
});
