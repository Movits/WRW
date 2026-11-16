import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexedDBEmMemoria } from "@/test/indexeddb-em-memoria";
import { CHAVE_DOS_DESCARTES, guardarDescarte } from "./descartes-pendentes";
import { rotaDaParte } from "./envio-das-partes";
import { guardarParte, parteNoAparelho, partesGuardadas, type ParteNoAparelho } from "./partes-no-aparelho";
import { CHAVE_DOS_FINS, finsDa, guardarFim, partesPorEnviar, retomarPartesEFins, type ServidorDaGravacao } from "./retomada-das-partes";

/**
 * A retomada das partes e dos fins (G13c), a mesma da tela de Reuniões e de
 * toda tela logada: só a conta logada, a gravação descartada fora, a trava do
 * navegador entre abas, o fim declarado uma vez e o fim que o servidor recusa
 * de vez fora da lista. O aparelho é o módulo de verdade sobre um IndexedDB em
 * memória; o servidor, dublês.
 */

const parte = (meetingId: string, seq: number, dona = "dona-1"): ParteNoAparelho => ({
  meetingId, seq, dona, blob: new Blob(["som"], { type: "audio/mp4" }), mimeType: "audio/mp4", duracaoMs: 600_000, guardadaEm: 1,
});
const recebida = () => new Response(JSON.stringify({ codigo: "RECEBIDA" }), { status: 201, headers: { "Content-Type": "application/json" } });
const fins = () => JSON.parse(localStorage.getItem(CHAVE_DOS_FINS) ?? "{}");
const erroDoServidor = (code: string) => ({ message: code, data: { code } });

let servidor: { encerrarGravacao: ReturnType<typeof vi.fn>; excluir: ReturnType<typeof vi.fn> };
let buscar: ReturnType<typeof vi.fn>;
const opcoes = () => ({ servidor: servidor as unknown as ServidorDaGravacao, buscar: buscar as unknown as typeof fetch });

/**
 * As travas do navegador (Web Locks) de mentira, como as do Chrome: uma por
 * nome para a origem inteira, e o `ifAvailable` responde null quando outra aba
 * a segura. `presas` são as que a "outra aba" segura.
 */
function travasDeMentira() {
  const presas = new Set<string>();
  return {
    presas,
    request: async (nome: string, _opcoes: { ifAvailable: boolean }, trabalho: (trava: unknown) => Promise<unknown>) => {
      if (presas.has(nome)) return trabalho(null);
      presas.add(nome);
      try {
        return await trabalho({ name: nome });
      } finally {
        presas.delete(nome);
      }
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("indexedDB", indexedDBEmMemoria());
  servidor = { encerrarGravacao: vi.fn(async () => ({ partes: 1 })), excluir: vi.fn(async () => ({ success: true })) };
  buscar = vi.fn(async () => recebida());
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as Navigator & { locks?: unknown }).locks;
  localStorage.clear();
});

describe("retomarPartesEFins — só a conta logada (G13c)", () => {
  it("as partes e os fins de outra conta não sobem nem são declarados, e ficam guardados para ela", async () => {
    await guardarParte(parte("r-1", 1));
    await guardarParte(parte("r-9", 0, "outra-conta"));
    guardarFim("r-1", 2, "dona-1");
    guardarFim("r-9", 1, "outra-conta");
    const r = await retomarPartesEFins("dona-1", opcoes());
    expect(buscar.mock.calls.map(([url]) => url)).toEqual([rotaDaParte("r-1", 1)]);
    expect(servidor.encerrarGravacao.mock.calls).toEqual([["r-1", 2]]);
    expect(await partesGuardadas("outra-conta")).toHaveLength(1);
    expect(fins()).toEqual({ "r-9": { partes: 1, dona: "outra-conta" } });
    expect(r).toEqual({ restantes: 0, semSessao: false });
  });

  it("a ordem de sempre: as partes da reunião sobem antes do fim dela", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-1", 1));
    guardarFim("r-1", 2, "dona-1");
    await retomarPartesEFins("dona-1", opcoes());
    expect(buscar).toHaveBeenCalledTimes(2);
    expect(buscar.mock.invocationCallOrder[1]).toBeLessThan(servidor.encerrarGravacao.mock.invocationCallOrder[0]);
  });

  it("o fim guardado antes da G13c (só o número, sem a conta) vale para a conta logada", async () => {
    localStorage.setItem(CHAVE_DOS_FINS, JSON.stringify({ "r-velha": 3 }));
    expect(finsDa("dona-1")).toEqual([{ id: "r-velha", partes: 3, semDona: true }]);
    await retomarPartesEFins("dona-1", opcoes());
    expect(servidor.encerrarGravacao).toHaveBeenCalledWith("r-velha", 3);
    expect(localStorage.getItem(CHAVE_DOS_FINS)).toBeNull();
  });

  it("o fim sem nenhuma parte com áudio exclui a reunião vazia, em vez de encerrá-la", async () => {
    guardarFim("r-vazia", 0, "dona-1");
    await retomarPartesEFins("dona-1", opcoes());
    expect(servidor.encerrarGravacao).not.toHaveBeenCalled();
    expect(servidor.excluir).toHaveBeenCalledWith("r-vazia");
    expect(localStorage.getItem(CHAVE_DOS_FINS)).toBeNull();
  });
});

describe("retomarPartesEFins — a gravação descartada não sobe (G13c)", () => {
  it("nem as partes que ficaram no aparelho, nem o fim; e elas não contam como áudio por enviar", async () => {
    // O servidor já excluiu a reunião, e a cópia não saiu (outra aba bloqueava o IndexedDB).
    localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify([{ id: "r-2", dona: "dona-1", soFaltaACopia: true }]));
    await guardarParte(parte("r-2", 0));
    await guardarParte(parte("r-2", 1));
    guardarFim("r-2", 2, "dona-1");
    const r = await retomarPartesEFins("dona-1", opcoes());
    expect(buscar).not.toHaveBeenCalled();
    expect(servidor.encerrarGravacao).not.toHaveBeenCalled();
    expect(r.restantes).toBe(0);
    expect(await partesPorEnviar("dona-1")).toBe(0);
  });

  it("a tela de Reuniões passa as que descartou ali (pular): também não sobem", async () => {
    await guardarParte(parte("r-3", 0));
    await retomarPartesEFins("dona-1", { ...opcoes(), pular: id => id === "r-3" });
    expect(buscar).not.toHaveBeenCalled();
  });
});

describe("retomarPartesEFins — o fim declarado uma vez, e o repetido que não quebra (G13c)", () => {
  it("duas voltas ao mesmo tempo na mesma aba (a de Reuniões e a de toda tela logada): o fim é declarado uma vez só", async () => {
    guardarFim("r-1", 2, "dona-1");
    let responder: (valor: unknown) => void = () => {};
    servidor.encerrarGravacao.mockImplementationOnce(() => new Promise(resolver => { responder = resolver; }));
    const primeira = retomarPartesEFins("dona-1", opcoes());
    await vi.waitFor(() => expect(servidor.encerrarGravacao).toHaveBeenCalledTimes(1));
    // A segunda chega com o fim ainda no ar, e tem tempo de chegar aos fins.
    const segunda = retomarPartesEFins("dona-1", opcoes());
    await new Promise(resolver => setTimeout(resolver, 30));
    expect(servidor.encerrarGravacao).toHaveBeenCalledTimes(1);
    responder({ partes: 2 });
    expect(await segunda).toEqual(await primeira);
    expect(servidor.encerrarGravacao).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CHAVE_DOS_FINS)).toBeNull();
    // A volta seguinte não tem mais o que declarar.
    await retomarPartesEFins("dona-1", opcoes());
    expect(servidor.encerrarGravacao).toHaveBeenCalledTimes(1);
  });

  it("entre abas: o fim que a outra aba declarou enquanto segurava a trava não é declarado de novo", async () => {
    guardarFim("r-1", 2, "dona-1");
    // A outra aba segurava a trava da reunião: declarou o fim e o tirou da lista antes de soltar.
    const travaDepoisDaOutraAba = async <T,>(_nome: string, trabalho: () => Promise<T>) => {
      localStorage.removeItem(CHAVE_DOS_FINS);
      return trabalho();
    };
    await retomarPartesEFins("dona-1", { ...opcoes(), trava: travaDepoisDaOutraAba });
    expect(servidor.encerrarGravacao).not.toHaveBeenCalled();
  });

  it("o fim que o servidor recusa de vez (já encerrada, excluída, total que não bate) sai da lista; o passageiro fica", async () => {
    const respostas: Record<string, unknown> = {
      "r-ja-na-fila": erroDoServidor("CONFLICT"),
      "r-excluida": erroDoServidor("NOT_FOUND"),
      "r-total-errado": erroDoServidor("BAD_REQUEST"),
      "r-sem-rede": new TypeError("Failed to fetch"),
      "r-banco-fora": erroDoServidor("INTERNAL_SERVER_ERROR"),
      "r-sessao-vencida": erroDoServidor("UNAUTHORIZED"),
    };
    for (const id of Object.keys(respostas)) guardarFim(id, 2, "dona-1");
    servidor.encerrarGravacao.mockImplementation(async (id: string) => { throw respostas[id]; });
    await retomarPartesEFins("dona-1", opcoes());
    expect(servidor.encerrarGravacao).toHaveBeenCalledTimes(6);
    expect(Object.keys(fins()).sort()).toEqual(["r-banco-fora", "r-sem-rede", "r-sessao-vencida"]);
    // A volta seguinte tenta só os que ficaram.
    servidor.encerrarGravacao.mockClear();
    await retomarPartesEFins("dona-1", opcoes());
    expect(servidor.encerrarGravacao.mock.calls.map(([id]) => id).sort()).toEqual(["r-banco-fora", "r-sem-rede", "r-sessao-vencida"]);
  });
});

describe("retomarPartesEFins — duas abas: a trava do navegador (G13c)", () => {
  it("com a trava da reunião na outra aba, esta não envia a parte nem declara o fim; solta a trava, a volta seguinte sim", async () => {
    const travas = travasDeMentira();
    Object.defineProperty(navigator, "locks", { value: travas, configurable: true });
    await guardarParte(parte("r-1", 1));
    guardarFim("r-1", 2, "dona-1");
    travas.presas.add("wrw-envio-r-1");
    const r = await retomarPartesEFins("dona-1", opcoes());
    expect(buscar).not.toHaveBeenCalled();
    expect(servidor.encerrarGravacao).not.toHaveBeenCalled();
    // A parte segue no aparelho e conta como áudio por enviar.
    expect(r.restantes).toBe(1);
    expect(await parteNoAparelho("r-1", 1)).toBe(true);
    travas.presas.delete("wrw-envio-r-1");
    await retomarPartesEFins("dona-1", opcoes());
    expect(buscar.mock.calls.map(([url]) => url)).toEqual([rotaDaParte("r-1", 1)]);
    expect(servidor.encerrarGravacao).toHaveBeenCalledWith("r-1", 2);
    expect(await parteNoAparelho("r-1", 1)).toBe(false);
  });
});

describe("retomarPartesEFins — sem o aparelho", () => {
  it("sem IndexedDB, as partes não são lidas (restantes null), e os fins seguem", async () => {
    vi.stubGlobal("indexedDB", undefined);
    guardarFim("r-1", 2, "dona-1");
    const r = await retomarPartesEFins("dona-1", opcoes());
    expect(r).toEqual({ restantes: null, semSessao: false });
    expect(servidor.encerrarGravacao).toHaveBeenCalledWith("r-1", 2);
    expect(await partesPorEnviar("dona-1")).toBe(0);
  });
});

/**
 * A revisão da G13c. O fim sem dona (o formato de antes da G13c) recebia
 * NOT_FOUND de qualquer outra conta que entrasse no aparelho e saía da lista:
 * a dona nunca mais o declarava. A chamada que pega carona perdia o pular dela,
 * a recusa da parte de uma gravação descartada no meio do envio virava aviso, e
 * o aparelho ilegível passava em silêncio.
 */
describe("retomarPartesEFins — revisão da G13c", () => {
  it("o fim sem dona que volta NOT_FOUND fica guardado para a dona, e a mesma conta não o tenta de novo nesta aba; CONFLICT e BAD_REQUEST o tiram", async () => {
    localStorage.setItem(CHAVE_DOS_FINS, JSON.stringify({ "r-alheia": 2, "r-ja-na-fila-sem-dona": 1, "r-total-errado-sem-dona": 4 }));
    const respostas: Record<string, unknown> = {
      // Para a conta-b, a reunião de outra conta responde NOT_FOUND.
      "r-alheia": erroDoServidor("NOT_FOUND"),
      "r-ja-na-fila-sem-dona": erroDoServidor("CONFLICT"),
      "r-total-errado-sem-dona": erroDoServidor("BAD_REQUEST"),
    };
    servidor.encerrarGravacao.mockImplementation(async (id: string) => { throw respostas[id]; });
    await retomarPartesEFins("conta-b", opcoes());
    expect(servidor.encerrarGravacao).toHaveBeenCalledTimes(3);
    // Regravado no formato novo, sem dona, quando os outros dois saíram.
    expect(fins()).toEqual({ "r-alheia": { partes: 2 } });
    // A volta seguinte da conta-b não manda de novo o id da reunião alheia.
    servidor.encerrarGravacao.mockClear();
    await retomarPartesEFins("conta-b", opcoes());
    expect(servidor.encerrarGravacao).not.toHaveBeenCalled();
    expect(finsDa("conta-b")).toEqual([]);
    // A dona entra no mesmo aparelho e o declara.
    servidor.encerrarGravacao.mockResolvedValue({ partes: 2 });
    await retomarPartesEFins("dona-1", opcoes());
    expect(servidor.encerrarGravacao).toHaveBeenCalledWith("r-alheia", 2);
    expect(localStorage.getItem(CHAVE_DOS_FINS)).toBeNull();
  });

  it("o fim guardado com dona que volta NOT_FOUND para ela sai (a reunião foi excluída)", async () => {
    guardarFim("r-excluida-da-dona", 2, "dona-1");
    servidor.encerrarGravacao.mockRejectedValue(erroDoServidor("NOT_FOUND"));
    await retomarPartesEFins("dona-1", opcoes());
    expect(localStorage.getItem(CHAVE_DOS_FINS)).toBeNull();
  });

  it("quem pega carona numa volta em curso tira dela as gravações que pula (a de Reuniões passa as que descartou ali)", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-2", 0));
    let soltar: () => void = () => {};
    buscar.mockImplementationOnce(() => new Promise(resolver => { soltar = () => resolver(recebida()); }));
    const primeira = retomarPartesEFins("dona-1", opcoes());
    await vi.waitFor(() => expect(buscar).toHaveBeenCalledTimes(1));
    // A da tela de Reuniões chega com a parte de r-1 no ar e pula r-2.
    const segunda = retomarPartesEFins("dona-1", { ...opcoes(), pular: id => id === "r-2" });
    soltar();
    expect(await segunda).toEqual(await primeira);
    expect(buscar.mock.calls.map(([url]) => url)).toEqual([rotaDaParte("r-1", 0)]);
    expect(await parteNoAparelho("r-2", 0)).toBe(true);
  });

  it("a parte que subia quando a gravação foi descartada volta recusada sem aviso; a de outra gravação avisa", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-2", 0));
    buscar.mockImplementation(async (url: string) => {
      // A dona descarta r-1 enquanto a parte dela sobe: o servidor exclui a reunião e a recusa.
      if (url === rotaDaParte("r-1", 0)) guardarDescarte("r-1", "dona-1");
      return new Response(JSON.stringify({ codigo: "SEM_REUNIAO" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const aoRecusar = vi.fn();
    await retomarPartesEFins("dona-1", { ...opcoes(), aoRecusar });
    expect(aoRecusar).toHaveBeenCalledTimes(1);
    expect(aoRecusar.mock.calls[0][0]).toMatchObject({ meetingId: "r-2", seq: 0 });
    expect(aoRecusar.mock.calls[0][1]).toBe("SEM_REUNIAO");
  });

  it("o aparelho ilegível (outra aba bloqueando o IndexedDB): registra o erro, declara os fins mesmo assim e devolve restantes null", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubGlobal("indexedDB", {
        open: () => {
          const pedido: { onblocked?: () => void } = {};
          setTimeout(() => pedido.onblocked?.(), 0);
          return pedido;
        },
      });
      guardarFim("r-1", 2, "dona-1");
      const r = await retomarPartesEFins("dona-1", opcoes());
      expect(r).toEqual({ restantes: null, semSessao: false });
      expect(servidor.encerrarGravacao).toHaveBeenCalledWith("r-1", 2);
      expect(aviso).toHaveBeenCalledWith(expect.stringContaining("não puderam ser lidas"), "O IndexedDB está bloqueado por outra aba.");
    } finally {
      aviso.mockRestore();
    }
  });
});
