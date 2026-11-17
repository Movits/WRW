import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cortarMp3, type CorteDoMp3 } from "@/lib/corte-do-mp3";
import type { OpcoesDoCorteNoWorker } from "@/lib/corte-do-mp3-no-worker";
import { juntar, leitorDe, leitorDeQuadrosRepetidos, MPEG1_128K, MPEG25_8K, quadroDeEtiqueta, quadros } from "@/test/mp3-sintetico";
import { useImportacaoEmPartes, type ResultadoDaImportacao } from "./useImportacaoEmPartes";
import type { ParteParaEnviar } from "./useGravacaoEmPartes";

/**
 * A importação do MP3 em partes (H9a): o corte vem antes da reunião, as partes
 * seguem uma a uma pelo caminho da gravação em partes (aqui, um dublê com a
 * fila de verdade: cada parte espera a anterior) e o Cancelar exclui a reunião.
 */

const INICIO = { title: "Reunião da Glenda", language: "pt-BR", consentNoticeVersion: "2026-11-14" } as const;

/** O caminho da gravação em partes, com uma fila que o teste solta parte a parte. */
function gravacaoFalsa() {
  const recebidas: ParteParaEnviar[] = [];
  const soltar: Array<() => void> = [];
  let fila: Promise<void> = Promise.resolve();
  const partes = {
    iniciar: vi.fn(async () => "reuniao-1"),
    cancelar: vi.fn(async () => "descartada" as const),
    receberParte: vi.fn((parte: ParteParaEnviar) => {
      recebidas.push(parte);
      fila = fila.then(() => new Promise<void>(pronto => soltar.push(pronto)));
    }),
    esperarFila: vi.fn(() => fila),
  };
  /** Sobe a parte que está na vez. */
  const subir = async () => {
    await waitFor(() => expect(soltar.length).toBeGreaterThan(0));
    await act(async () => { soltar.shift()!(); });
  };
  return { partes, recebidas, subir };
}

/** Um corte de verdade, de um MP3 sintético, em partes de 1 s. */
async function corteDe(bytes: Uint8Array): Promise<CorteDoMp3> {
  return cortarMp3(leitorDe(bytes), bytes.length, { segundosPorParte: 1 });
}

let gravacao: ReturnType<typeof gravacaoFalsa>;
beforeEach(() => {
  gravacao = gravacaoFalsa();
});

function montar(cortar: (arquivo: Blob, opcoes: OpcoesDoCorteNoWorker) => Promise<CorteDoMp3>, temSessao = () => true) {
  return renderHook(() => useImportacaoEmPartes({ partes: gravacao.partes, temSessao, cortar }));
}

describe("useImportacaoEmPartes (H9a)", () => {
  it("corta, cria a reunião com a origem arquivo e manda as partes em ordem, uma por vez, como audio/mpeg", async () => {
    const xing = quadroDeEtiqueta(MPEG1_128K, "Xing");
    const audio = quadros(MPEG1_128K, 100);
    const bytes = juntar(xing, audio);
    const corte = await corteDe(bytes);
    if (!corte.ok) throw new Error("corte");
    const aoCriar = vi.fn();
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File([bytes], "glenda.mp3", { type: "audio/mpeg" }), INICIO, aoCriar); });

    await waitFor(() => expect(gravacao.partes.iniciar).toHaveBeenCalledWith({ ...INICIO, origem: "arquivo" }));
    expect(aoCriar).toHaveBeenCalledWith("reuniao-1");
    await waitFor(() => expect(result.current.andamento).toEqual({ fase: "enviando", enviadas: 0, total: corte.partes.length }));
    // Uma parte por vez: a segunda só entra depois de a primeira sair da fila.
    expect(gravacao.recebidas).toHaveLength(1);
    await gravacao.subir();
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(2));
    expect(result.current.andamento).toEqual({ fase: "enviando", enviadas: 1, total: corte.partes.length });
    for (let i = 1; i < corte.partes.length; i++) await gravacao.subir();

    expect(await importacao).toEqual({ tipo: "enviada", meetingId: "reuniao-1" });
    expect(result.current.andamento).toEqual({ fase: "parada" });
    expect(gravacao.recebidas.map(p => [p.seq, p.ultima, p.mimeType])).toEqual(
      corte.partes.map((_p, i) => [i, i === corte.partes.length - 1, "audio/mpeg"]),
    );
    // Cada parte é o File.slice das faixas dela: o Xing ficou de fora, e as partes juntas são o áudio.
    const enviados = new Uint8Array(await new Blob(gravacao.recebidas.map(p => p.blob)).arrayBuffer());
    expect(enviados).toEqual(audio);
    expect(gravacao.recebidas.map(p => p.duracaoMs)).toEqual(corte.partes.map(p => p.duracaoMs));
    expect(gravacao.recebidas.every(p => p.blob.type === "audio/mpeg")).toBe(true);
  });

  it("mostra o andamento da leitura enquanto corta", async () => {
    let soltarCorte: (corte: CorteDoMp3) => void = () => {};
    const { result } = montar((_arquivo, opcoes) => {
      opcoes.aoLer?.(25, 100);
      return new Promise(resolver => { soltarCorte = resolver; });
    });
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await waitFor(() => expect(result.current.andamento).toEqual({ fase: "lendo", lidos: 25, total: 100 }));
    await act(async () => { soltarCorte({ ok: false, codigo: "NAO_E_MP3" }); });
    expect(await importacao).toEqual({ tipo: "recusada", motivo: "NAO_E_MP3" });
  });

  it("acima de 12 h, recusa antes de criar a reunião (o corte de verdade, num arquivo de 12 h e um quadro)", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG25_8K, 600_001);
    const { result } = montar(() => cortarMp3(ler, tamanho));
    let resultado: ResultadoDaImportacao | undefined;
    await act(async () => { resultado = await result.current.importar(new File(["x"], "longa.mp3"), INICIO); });
    expect(resultado).toEqual({ tipo: "recusada", motivo: "LONGO_DEMAIS" });
    expect(gravacao.partes.iniciar).not.toHaveBeenCalled();
    expect(gravacao.partes.receberParte).not.toHaveBeenCalled();
    expect(result.current.andamento).toEqual({ fase: "parada" });
  }, 30_000);

  it("o arquivo que não pôde ser lido é recusado como ilegível, sem reunião", async () => {
    const { result } = montar(async () => { throw new Error("o arquivo sumiu"); });
    let resultado: ResultadoDaImportacao | undefined;
    await act(async () => { resultado = await result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    expect(resultado).toEqual({ tipo: "recusada", motivo: "ILEGIVEL" });
    expect(gravacao.partes.iniciar).not.toHaveBeenCalled();
  });

  it("Cancelar durante a leitura para o corte, e nenhuma reunião nasce", async () => {
    let sinal: AbortSignal | undefined;
    const { result } = montar((_arquivo, opcoes) => {
      sinal = opcoes.sinal;
      return new Promise((_resolver, rejeitar) => opcoes.sinal?.addEventListener("abort", () => rejeitar(new DOMException("x", "AbortError"))));
    });
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await waitFor(() => expect(result.current.andamento.fase).toBe("lendo"));
    act(() => result.current.cancelar());
    expect(sinal?.aborted).toBe(true);
    expect(await importacao).toEqual({ tipo: "cancelada", exclusao: null });
    expect(gravacao.partes.iniciar).not.toHaveBeenCalled();
    expect(gravacao.partes.cancelar).not.toHaveBeenCalled();
  });

  it("Cancelar no envio: exclui a reunião na hora (a parte que sobe termina), e nenhuma outra parte entra", async () => {
    const corte = await corteDe(quadros(MPEG1_128K, 150));
    if (!corte.ok) throw new Error("corte");
    expect(corte.partes.length).toBeGreaterThan(2);
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(1));
    act(() => result.current.cancelar());
    expect(result.current.andamento).toEqual({ fase: "cancelando" });
    // A exclusão é pedida já no clique, com a reunião desta importação.
    expect(gravacao.partes.cancelar).toHaveBeenCalledWith("reuniao-1");
    await gravacao.subir();
    expect(await importacao).toEqual({ tipo: "cancelada", exclusao: "descartada" });
    expect(gravacao.recebidas).toHaveLength(1);
    expect(gravacao.partes.cancelar).toHaveBeenCalledTimes(1);
    expect(result.current.andamento).toEqual({ fase: "parada" });
  });

  it("a exclusão que falha no Cancelar volta como pendente (a retomada a repete)", async () => {
    gravacao.partes.cancelar.mockResolvedValue("pendente" as never);
    const corte = await corteDe(quadros(MPEG1_128K, 150));
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(1));
    act(() => result.current.cancelar());
    await gravacao.subir();
    expect(await importacao).toEqual({ tipo: "cancelada", exclusao: "pendente" });
  });

  it("Cancelar enquanto o servidor cria a reunião: a reunião que nascer sai, e nada sobe", async () => {
    let criar: (id: string) => void = () => {};
    gravacao.partes.iniciar.mockImplementation(() => new Promise<string>(resolver => { criar = resolver; }));
    const corte = await corteDe(quadros(MPEG1_128K, 60));
    const aoCriar = vi.fn();
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO, aoCriar); });
    await waitFor(() => expect(gravacao.partes.iniciar).toHaveBeenCalled());
    act(() => result.current.cancelar());
    expect(gravacao.partes.cancelar).not.toHaveBeenCalled();
    await act(async () => { criar("reuniao-tardia"); });
    expect(await importacao).toEqual({ tipo: "cancelada", exclusao: "descartada" });
    expect(gravacao.partes.cancelar).toHaveBeenCalledWith("reuniao-tardia");
    expect(gravacao.partes.receberParte).not.toHaveBeenCalled();
    expect(aoCriar).not.toHaveBeenCalled();
  });

  it("a sessão que acaba no meio (o Sair) para o envio", async () => {
    const corte = await corteDe(quadros(MPEG1_128K, 150));
    let logada = true;
    const { result } = montar(async () => corte, () => logada);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(1));
    logada = false;
    await gravacao.subir();
    expect(await importacao).toEqual({ tipo: "sem-sessao", meetingId: "reuniao-1" });
    expect(gravacao.recebidas).toHaveLength(1);
  });

  it("o servidor que recusa criar a reunião: o erro sobe para a tela, e o andamento volta a parado", async () => {
    gravacao.partes.iniciar.mockRejectedValue(new Error("Banco de dados indisponível."));
    const corte = await corteDe(quadros(MPEG1_128K, 60));
    const { result } = montar(async () => corte);
    await act(async () => {
      await expect(result.current.importar(new File(["x"], "a.mp3"), INICIO)).rejects.toThrow("Banco de dados indisponível.");
    });
    expect(result.current.andamento).toEqual({ fase: "parada" });
    expect(gravacao.partes.receberParte).not.toHaveBeenCalled();
  });

  it("um envio por vez", async () => {
    const { result } = montar(() => new Promise(() => {}));
    act(() => { void result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await expect(result.current.importar(new File(["x"], "b.mp3"), INICIO)).rejects.toThrow();
  });
});
