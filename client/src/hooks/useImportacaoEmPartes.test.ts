import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CorteDoArquivo } from "@/lib/corte-comum";
import { cortarArquivo } from "@/lib/corte-do-arquivo";
import type { OpcoesDoCorteNoWorker } from "@/lib/corte-do-arquivo-no-worker";
import { juntar, leitorDe, leitorDeQuadrosRepetidos, MPEG1_128K, MPEG25_8K, quadroDeEtiqueta, quadros } from "@/test/mp3-sintetico";
import { oggOpus } from "@/test/audio-sintetico";
import { montar as montarParaConferir } from "@/test/conferir-partes";
import { _reiniciarParaTestes, ESPERA_MAXIMA_MS, PRIMEIRA_ESPERA_MS, useImportacaoEmPartes, type ResultadoDaImportacao } from "./useImportacaoEmPartes";
import type { DesfechoDaParte, FimDoArquivo, ParteDoArquivo } from "./useGravacaoEmPartes";

/**
 * A importação do MP3 em partes (H9a): o corte vem antes da reunião, as partes
 * seguem uma a uma pelo caminho da gravação em partes (aqui, um dublê em que
 * cada envio fica no ar até o teste responder o que houve com ele), a parte
 * que não sobe vai de novo antes da seguinte, e o Cancelar exclui a reunião.
 */

const INICIO = { title: "Reunião da Glenda", language: "pt-BR", consentNoticeVersion: "2026-11-14" } as const;

/** O caminho da gravação em partes, com envios que o teste responde um a um. */
function gravacaoFalsa() {
  const recebidas: ParteDoArquivo[] = [];
  const respostas: Array<(desfecho: DesfechoDaParte) => void> = [];
  const partes = {
    iniciar: vi.fn(async () => "reuniao-1"),
    cancelar: vi.fn(async () => "descartada" as const),
    subirParteDoArquivo: vi.fn((_id: string, parte: ParteDoArquivo) => {
      recebidas.push(parte);
      return new Promise<DesfechoDaParte>(responder => respostas.push(responder));
    }),
    encerrarArquivo: vi.fn(async (): Promise<FimDoArquivo> => "declarado"),
  };
  /** O envio que está no ar termina com `desfecho` (por padrão, recebido). */
  const responder = async (desfecho: DesfechoDaParte = { tipo: "recebida" }) => {
    await waitFor(() => expect(respostas.length).toBeGreaterThan(0));
    await act(async () => { respostas.shift()!(desfecho); });
  };
  return { partes, recebidas, subir: () => responder(), responder, noAr: () => respostas.length };
}

/** Um corte de verdade, de um MP3 sintético, em partes de 1 s. */
async function corteDe(bytes: Uint8Array): Promise<CorteDoArquivo> {
  return cortarArquivo(leitorDe(bytes), bytes.length, { segundosPorParte: 1 });
}

const bytesDe = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

let gravacao: ReturnType<typeof gravacaoFalsa>;
beforeEach(() => {
  // A importação em curso mora fora da tela: a de um teste anterior não vale aqui.
  _reiniciarParaTestes();
  gravacao = gravacaoFalsa();
});

function montar(cortar: (arquivo: Blob, opcoes: OpcoesDoCorteNoWorker) => Promise<CorteDoArquivo>, temSessao = () => true) {
  return renderHook(() => useImportacaoEmPartes({ partes: gravacao.partes, temSessao, cortar }));
}

describe("useImportacaoEmPartes (H9a)", () => {
  it("corta, cria a reunião com a origem arquivo, manda as partes em ordem, uma por vez, como audio/mpeg, e pede o fim com o total", async () => {
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
    // Uma parte por vez: a segunda só entra depois de a primeira chegar.
    expect(gravacao.recebidas).toHaveLength(1);
    await gravacao.subir();
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(2));
    expect(result.current.andamento).toEqual({ fase: "enviando", enviadas: 1, total: corte.partes.length });
    for (let i = 1; i < corte.partes.length; i++) await gravacao.subir();

    expect(await importacao).toEqual({ tipo: "enviada", meetingId: "reuniao-1", fim: "declarado" });
    expect(gravacao.partes.encerrarArquivo).toHaveBeenCalledWith("reuniao-1", corte.partes.length);
    expect(result.current.andamento).toEqual({ fase: "parada" });
    expect(gravacao.recebidas.map(p => [p.seq, p.mimeType])).toEqual(corte.partes.map((_p, i) => [i, "audio/mpeg"]));
    // Cada parte é o File.slice das faixas dela: o Xing ficou de fora, e as partes juntas são o áudio.
    expect(await bytesDe(new Blob(gravacao.recebidas.map(p => p.blob)))).toEqual(audio);
    expect(gravacao.recebidas.map(p => p.duracaoMs)).toEqual(corte.partes.map(p => p.duracaoMs));
    expect(gravacao.recebidas.every(p => p.blob.type === "audio/mpeg")).toBe(true);
  });

  it("mostra o andamento da leitura enquanto corta", async () => {
    let soltarCorte: (corte: CorteDoArquivo) => void = () => {};
    const { result } = montar((_arquivo, opcoes) => {
      opcoes.aoLer?.(25, 100);
      return new Promise(resolver => { soltarCorte = resolver; });
    });
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await waitFor(() => expect(result.current.andamento).toEqual({ fase: "lendo", lidos: 25, total: 100 }));
    await act(async () => { soltarCorte({ ok: false, codigo: "DANIFICADO", formato: "mp3" }); });
    expect(await importacao).toEqual({ tipo: "recusada", motivo: "DANIFICADO" });
  });

  it("acima de 12 h, recusa antes de criar a reunião (o corte de verdade, num arquivo de 12 h e um quadro)", async () => {
    const { ler, tamanho } = leitorDeQuadrosRepetidos(MPEG25_8K, 600_001);
    const { result } = montar(() => cortarArquivo(ler, tamanho));
    let resultado: ResultadoDaImportacao | undefined;
    await act(async () => { resultado = await result.current.importar(new File(["x"], "longa.mp3"), INICIO); });
    expect(resultado).toEqual({ tipo: "recusada", motivo: "LONGO_DEMAIS" });
    expect(gravacao.partes.iniciar).not.toHaveBeenCalled();
    expect(gravacao.partes.subirParteDoArquivo).not.toHaveBeenCalled();
    expect(result.current.andamento).toEqual({ fase: "parada" });
  }, 30_000);

  it("o arquivo que não pôde ser lido é recusado como ilegível, sem reunião; o motivo vai ao console", async () => {
    const falha = new TypeError("o arquivo sumiu");
    const consoleDeErro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result } = montar(async () => { throw falha; });
      let resultado: ResultadoDaImportacao | undefined;
      await act(async () => { resultado = await result.current.importar(new File(["x"], "a.mp3"), INICIO); });
      expect(resultado).toEqual({ tipo: "recusada", motivo: "ILEGIVEL" });
      expect(gravacao.partes.iniciar).not.toHaveBeenCalled();
      // Para a dona, o mesmo aviso do arquivo estragado; no console, o que houve.
      expect(consoleDeErro).toHaveBeenCalledWith(expect.stringContaining("[Importação]"), falha);
    } finally {
      consoleDeErro.mockRestore();
    }
  });

  it("Cancelar durante a leitura para o corte, e nenhuma reunião nasce (sem nada no console: cancelar não é falha)", async () => {
    const consoleDeErro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
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
      expect(consoleDeErro).not.toHaveBeenCalled();
    } finally {
      consoleDeErro.mockRestore();
    }
  });

  it("os outros formatos (H9b e H9c): cada parte sobe no tipo que o corte diz, montada com os bytes novos e os trechos do arquivo", async () => {
    // Um Ogg de verdade (o áudio do WhatsApp), cortado em partes de 2 s: as páginas refeitas são bytes novos.
    const { bytes } = oggOpus({ pacotes: 300 });
    const corte = await cortarArquivo(leitorDe(bytes), bytes.length, { segundosPorParte: 2 });
    if (!corte.ok) throw new Error("corte");
    expect(corte.mimeType).toBe("audio/ogg");
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File([bytes], "audio-do-whatsapp.ogg", { type: "audio/ogg" }), INICIO); });
    for (let i = 0; i < corte.partes.length; i++) await gravacao.subir();
    expect(await importacao).toEqual({ tipo: "enviada", meetingId: "reuniao-1", fim: "declarado" });
    expect(gravacao.recebidas.map(p => [p.seq, p.mimeType, p.blob.type, p.duracaoMs])).toEqual(corte.partes.map((p, i) => [i, "audio/ogg", "audio/ogg", p.duracaoMs]));
    for (let i = 0; i < corte.partes.length; i++) {
      expect(Array.from(await bytesDe(gravacao.recebidas[i].blob))).toEqual(Array.from(montarParaConferir(bytes, corte.partes[i])));
    }
  });

  it("a recusa do formato sem suporte leva o nome dele (para o aviso), sem reunião", async () => {
    const { result } = montar(async () => ({ ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe: "ALAC" }));
    let resultado: ResultadoDaImportacao | undefined;
    await act(async () => { resultado = await result.current.importar(new File(["x"], "memo.m4a"), INICIO); });
    expect(resultado).toEqual({ tipo: "recusada", motivo: "SEM_SUPORTE", detalhe: "ALAC" });
    expect(gravacao.partes.iniciar).not.toHaveBeenCalled();
  });

  // G14, parte 2: o recuo do corte vai pelas partes, sem o envio único.
  it("o recuo do corte: o arquivo que o corte não lê vai inteiro, como a parte 0, no tipo que o recuo diz, e o fim pede 1 parte", async () => {
    const recusa = { ok: false, codigo: "SEM_SUPORTE", formato: "mp4", detalhe: "ALAC" } as const;
    const recuo = vi.fn(async () => ({ mimeType: "audio/mp4" as const, duracaoMs: 30_000 }));
    const { result } = montar(async () => recusa);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["som do alac"], "memo.m4a", { type: "audio/x-m4a" }), INICIO, undefined, recuo); });
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(1));
    expect(recuo).toHaveBeenCalledWith(recusa);
    expect(gravacao.partes.iniciar).toHaveBeenCalledWith({ ...INICIO, origem: "arquivo" });
    expect(gravacao.recebidas[0]).toMatchObject({ seq: 0, mimeType: "audio/mp4", duracaoMs: 30_000 });
    expect(new TextDecoder().decode(await bytesDe(gravacao.recebidas[0].blob))).toBe("som do alac");
    await gravacao.subir();
    await expect(importacao).resolves.toEqual({ tipo: "enviada", meetingId: "reuniao-1", fim: "declarado" });
    expect(gravacao.partes.encerrarArquivo).toHaveBeenCalledWith("reuniao-1", 1);
  });

  it.each([
    ["o recuo diz que não cabe", async () => null],
    ["o recuo falha", async () => { throw new Error("o navegador não leu"); }],
  ] as const)("%s: a recusa do corte, sem reunião", async (_caso, recuo) => {
    const { result } = montar(async () => ({ ok: false, codigo: "SEM_SUPORTE", formato: "webm", detalhe: "Vorbis (WebM)" }));
    let resultado: ResultadoDaImportacao | undefined;
    await act(async () => { resultado = await result.current.importar(new File(["x"], "r.webm"), INICIO, undefined, recuo); });
    expect(resultado).toEqual({ tipo: "recusada", motivo: "SEM_SUPORTE", detalhe: "Vorbis (WebM)" });
    expect(gravacao.partes.iniciar).not.toHaveBeenCalled();
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
    expect(gravacao.partes.encerrarArquivo).not.toHaveBeenCalled();
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
    expect(gravacao.partes.subirParteDoArquivo).not.toHaveBeenCalled();
    expect(aoCriar).not.toHaveBeenCalled();
  });

  it("Cancelar enquanto o fim está no ar: o fim volta 'descartada', e a importação é a cancelada", async () => {
    let fimNoAr: (fim: FimDoArquivo) => void = () => {};
    gravacao.partes.encerrarArquivo.mockImplementation(() => new Promise<FimDoArquivo>(resolver => { fimNoAr = resolver; }));
    const corte = await corteDe(quadros(MPEG1_128K, 30));
    if (!corte.ok) throw new Error("corte");
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    for (let i = 0; i < corte.partes.length; i++) await gravacao.subir();
    await waitFor(() => expect(gravacao.partes.encerrarArquivo).toHaveBeenCalled());
    act(() => result.current.cancelar());
    await act(async () => { fimNoAr("descartada"); });
    expect(await importacao).toEqual({ tipo: "cancelada", exclusao: "descartada" });
  });

  it("o fim que fica para a retomada (a confirmação falhou) volta como 'enviada' com o fim pendente", async () => {
    gravacao.partes.encerrarArquivo.mockResolvedValue("pendente");
    const corte = await corteDe(quadros(MPEG1_128K, 30));
    if (!corte.ok) throw new Error("corte");
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    for (let i = 0; i < corte.partes.length; i++) await gravacao.subir();
    expect(await importacao).toEqual({ tipo: "enviada", meetingId: "reuniao-1", fim: "pendente" });
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
    expect(gravacao.partes.encerrarArquivo).not.toHaveBeenCalled();
  });

  it("o servidor que recusa criar a reunião: o erro sobe para a tela, e o andamento volta a parado", async () => {
    gravacao.partes.iniciar.mockRejectedValue(new Error("Banco de dados indisponível."));
    const corte = await corteDe(quadros(MPEG1_128K, 60));
    const { result } = montar(async () => corte);
    await act(async () => {
      await expect(result.current.importar(new File(["x"], "a.mp3"), INICIO)).rejects.toThrow("Banco de dados indisponível.");
    });
    expect(result.current.andamento).toEqual({ fase: "parada" });
    expect(gravacao.partes.subirParteDoArquivo).not.toHaveBeenCalled();
  });

  it("um envio por vez", async () => {
    const { result } = montar((_arquivo, opcoes) => new Promise((_resolver, rejeitar) => opcoes.sinal?.addEventListener("abort", () => rejeitar(new DOMException("x", "AbortError")))));
    let primeira!: Promise<ResultadoDaImportacao>;
    act(() => { primeira = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await expect(result.current.importar(new File(["x"], "b.mp3"), INICIO)).rejects.toThrow();
    act(() => result.current.cancelar());
    expect(await primeira).toEqual({ tipo: "cancelada", exclusao: null });
  });
});

/**
 * A parte que não chega (revisão do pacote 4a): antes, a importação cortava e
 * mandava a seguinte mesmo com a anterior perdida na rede, e em segundos o
 * resto do arquivo ia para o IndexedDB, ou se perdia sem ele.
 */
describe("useImportacaoEmPartes — a parte que não chega vai de novo antes da seguinte", () => {
  async function importarEmTresPartes() {
    const corte = await corteDe(quadros(MPEG1_128K, 100));
    if (!corte.ok || corte.partes.length !== 3) throw new Error("corte");
    const { result } = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = result.current.importar(new File([quadros(MPEG1_128K, 100)], "a.mp3", { type: "audio/mpeg" }), INICIO); });
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(1));
    return { result, importacao: () => importacao, corte };
  }

  it.each([
    ["passageira (rede, 429, 5xx)", { tipo: "passageira" } as DesfechoDaParte],
    ["ocupada (outra aba enviava a mesma gravação)", { tipo: "ocupada" } as DesfechoDaParte],
  ])("%s: a seguinte não entra; a mesma parte vai de novo, lida do arquivo, quando a conexão volta", async (_caso, desfecho) => {
    const { result, importacao } = await importarEmTresPartes();
    await gravacao.responder(desfecho);
    await waitFor(() => expect(result.current.andamento).toEqual({ fase: "enviando", enviadas: 0, total: 3, tentandoDeNovo: true }));
    // Nada da parte 2 enquanto a 1 não chegou.
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(gravacao.recebidas.map(p => p.seq)).toEqual([0]);
    // A conexão voltou: a mesma parte, com os mesmos bytes, vai de novo, sem esperar o resto da espera.
    act(() => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(gravacao.recebidas.map(p => p.seq)).toEqual([0, 0]));
    expect(gravacao.recebidas[1].blob).not.toBe(gravacao.recebidas[0].blob);
    expect(await bytesDe(gravacao.recebidas[1].blob)).toEqual(await bytesDe(gravacao.recebidas[0].blob));
    expect(result.current.andamento).toEqual({ fase: "enviando", enviadas: 0, total: 3 });
    await gravacao.subir();
    await gravacao.subir();
    await gravacao.subir();
    expect(await importacao()).toEqual({ tipo: "enviada", meetingId: "reuniao-1", fim: "declarado" });
    expect(gravacao.recebidas.map(p => p.seq)).toEqual([0, 0, 1, 2]);
    expect(gravacao.partes.encerrarArquivo).toHaveBeenCalledWith("reuniao-1", 3);
  });

  it("sem a conexão de volta, a espera dobra a cada falha, até 1 min", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const corte = await corteDe(quadros(MPEG1_128K, 100));
      gravacao.partes.subirParteDoArquivo.mockResolvedValue({ tipo: "passageira" });
      const { result } = montar(async () => corte);
      let importacao!: Promise<ResultadoDaImportacao>;
      act(() => { importacao = result.current.importar(new File(["x"], "a.mp3"), INICIO); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const envios = () => gravacao.partes.subirParteDoArquivo.mock.calls.length;
      expect(envios()).toBe(1);
      let esperado = PRIMEIRA_ESPERA_MS;
      for (let tentativa = 2; tentativa <= 9; tentativa++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(esperado - 1); });
        expect(envios(), `antes da tentativa ${tentativa}`).toBe(tentativa - 1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(envios(), `na tentativa ${tentativa}`).toBe(tentativa);
        esperado = Math.min(esperado * 2, ESPERA_MAXIMA_MS);
      }
      // 2, 4, 8, 16, 32 e então 60 s: o teto.
      expect(esperado).toBe(ESPERA_MAXIMA_MS);
      expect(gravacao.partes.subirParteDoArquivo.mock.calls.every(([, parte]) => parte.seq === 0)).toBe(true);
      // O Cancelar acorda a espera na hora.
      act(() => result.current.cancelar());
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(await importacao).toEqual({ tipo: "cancelada", exclusao: "descartada" });
      expect(envios()).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o servidor que responde sem sessão (401) para o envio: as outras partes não sobem", async () => {
    const { importacao } = await importarEmTresPartes();
    await gravacao.responder({ tipo: "sem-sessao" });
    expect(await importacao()).toEqual({ tipo: "sem-sessao", meetingId: "reuniao-1" });
    expect(gravacao.recebidas).toHaveLength(1);
    expect(gravacao.partes.encerrarArquivo).not.toHaveBeenCalled();
  });

  it.each(["SEM_REUNIAO", "FORA_DO_ESTADO"])("a reunião que não recebe mais áudio (%s, excluída em outro aparelho): o envio para, sem subir o resto", async codigo => {
    const { importacao } = await importarEmTresPartes();
    await gravacao.responder({ tipo: "recusada", codigo });
    expect(await importacao()).toEqual({ tipo: "sem-reuniao", meetingId: "reuniao-1" });
    expect(gravacao.recebidas).toHaveLength(1);
    expect(gravacao.partes.encerrarArquivo).not.toHaveBeenCalled();
  });

  it("a parte recusada só por ela (LONGA_DEMAIS) fica de fora, com o aviso, e o envio segue", async () => {
    const { importacao } = await importarEmTresPartes();
    await gravacao.responder({ tipo: "recusada", codigo: "LONGA_DEMAIS" });
    await gravacao.subir();
    await gravacao.subir();
    expect(await importacao()).toEqual({ tipo: "enviada", meetingId: "reuniao-1", fim: "declarado" });
    expect(gravacao.recebidas.map(p => p.seq)).toEqual([0, 1, 2]);
  });

  it("Cancelar enquanto espera para tentar de novo: acorda na hora, a reunião sai, e a parte não vai de novo", async () => {
    const { result, importacao } = await importarEmTresPartes();
    await gravacao.responder({ tipo: "passageira" });
    await waitFor(() => expect(result.current.andamento).toMatchObject({ tentandoDeNovo: true }));
    act(() => result.current.cancelar());
    expect(await importacao()).toEqual({ tipo: "cancelada", exclusao: "descartada" });
    expect(gravacao.partes.cancelar).toHaveBeenCalledWith("reuniao-1");
    expect(gravacao.recebidas).toHaveLength(1);
  });
});

/**
 * A importação mora fora da tela (decisão 5 da H9a e revisão do pacote 4a):
 * a tela que volta a Reuniões no meio do envio mostra o andamento e cancela a
 * mesma importação, em vez de um formulário livre para mandar o arquivo de novo.
 */
describe("useImportacaoEmPartes — a importação em curso vale para toda tela da aba", () => {
  it("a tela que sai não para o envio; a que volta mostra o andamento, não deixa começar outro e cancela a mesma importação", async () => {
    const corte = await corteDe(quadros(MPEG1_128K, 150));
    if (!corte.ok) throw new Error("corte");
    const primeira = montar(async () => corte);
    let importacao!: Promise<ResultadoDaImportacao>;
    act(() => { importacao = primeira.result.current.importar(new File(["x"], "a.mp3"), INICIO); });
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(1));
    primeira.unmount();
    await gravacao.subir();
    await waitFor(() => expect(gravacao.recebidas).toHaveLength(2));

    // A tela de volta (outra instância do hook, com outra gravação em partes).
    const outraGravacao = gravacaoFalsa();
    const segunda = renderHook(() => useImportacaoEmPartes({ partes: outraGravacao.partes, temSessao: () => true, cortar: async () => corte }));
    expect(segunda.result.current.andamento).toEqual({ fase: "enviando", enviadas: 1, total: corte.partes.length });
    await expect(segunda.result.current.importar(new File(["x"], "b.mp3"), INICIO)).rejects.toThrow();
    act(() => segunda.result.current.cancelar());
    expect(segunda.result.current.andamento).toEqual({ fase: "cancelando" });
    // A exclusão vai pela gravação em partes que começou a importação: a mesma fila da parte que sobe.
    expect(gravacao.partes.cancelar).toHaveBeenCalledWith("reuniao-1");
    expect(outraGravacao.partes.cancelar).not.toHaveBeenCalled();
    await gravacao.subir();
    expect(await importacao).toEqual({ tipo: "cancelada", exclusao: "descartada" });
    expect(segunda.result.current.andamento).toEqual({ fase: "parada" });
  });
});
