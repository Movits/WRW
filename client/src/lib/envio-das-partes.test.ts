import { beforeEach, describe, expect, it, vi } from "vitest";

const guardadas = vi.hoisted(() => ({ lista: [] as Array<{ meetingId: string; seq: number; blob: Blob; mimeType: string; duracaoMs: number; dona: string; guardadaEm: number }>, apagadas: [] as string[] }));
vi.mock("./partes-no-aparelho", () => ({
  partesGuardadas: async (dona: string) => guardadas.lista.filter(p => p.dona === dona),
  apagarParte: async (meetingId: string, seq: number) => { guardadas.apagadas.push(`${meetingId}:${seq}`); },
}));

const { enviarParte, enviarPendentes, rotaDaParte } = await import("./envio-das-partes");

const resposta = (status: number, corpo?: unknown) => new Response(corpo === undefined ? "erro" : JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const semTrava = async <T,>(_nome: string, trabalho: () => Promise<T>) => trabalho();

beforeEach(() => {
  guardadas.lista = [];
  guardadas.apagadas = [];
});

describe("enviarParte (G9)", () => {
  it("manda o áudio cru à rota da parte, com o tipo no Content-Type e o cookie da sessão", async () => {
    const buscar = vi.fn(async () => resposta(201, { codigo: "RECEBIDA" }));
    const blob = new Blob(["som"], { type: "audio/mp4" });
    expect(await enviarParte("r-1", 3, blob, "audio/mp4", buscar as never)).toEqual({ tipo: "recebida" });
    expect(buscar).toHaveBeenCalledWith(rotaDaParte("r-1", 3), expect.objectContaining({ method: "POST", body: blob, credentials: "same-origin", headers: { "Content-Type": "audio/mp4" } }));
  });

  it.each([
    [200, { codigo: "RECEBIDA" }, "recebida"],
    [429, { codigo: "MUITOS_PEDIDOS" }, "passageira"],
    [503, { codigo: "TENTE_DE_NOVO" }, "passageira"],
    [500, { codigo: "ERRO" }, "passageira"],
    [502, undefined, "passageira"],
    [401, { codigo: "SEM_SESSAO" }, "sem-sessao"],
    [404, { codigo: "SEM_REUNIAO" }, "recusada"],
    [409, { codigo: "CONTEUDO_DIFERENTE" }, "recusada"],
    [413, undefined, "passageira"],
  ] as const)("HTTP %i vira %s", async (status, corpo, tipo) => {
    expect((await enviarParte("r", 0, new Blob(["x"]), "audio/mp4", (async () => resposta(status, corpo)) as never)).tipo).toBe(tipo);
  });

  it("falha de rede é passageira", async () => {
    expect(await enviarParte("r", 0, new Blob(["x"]), "audio/mp4", (async () => { throw new TypeError("offline"); }) as never)).toEqual({ tipo: "passageira" });
  });
});

describe("enviarPendentes (G9)", () => {
  const parte = (meetingId: string, seq: number, dona = "dona") => ({ meetingId, seq, blob: new Blob(["x"]), mimeType: "audio/mp4", duracaoMs: 1000, dona, guardadaEm: 1 });

  it("manda em ordem, apaga o que o servidor confirmou ou recusou, e para no primeiro passageiro de cada gravação", async () => {
    guardadas.lista = [parte("a", 0), parte("a", 1), parte("a", 2), parte("b", 0), parte("c", 0, "outra-dona")];
    const respostas: Record<string, Response> = {
      [rotaDaParte("a", 0)]: resposta(201, { codigo: "RECEBIDA" }),
      [rotaDaParte("a", 1)]: resposta(503, { codigo: "TENTE_DE_NOVO" }),
      [rotaDaParte("b", 0)]: resposta(404, { codigo: "SEM_REUNIAO" }),
    };
    const buscar = vi.fn(async (url: string) => respostas[url]);
    const aoRecusar = vi.fn();
    const r = await enviarPendentes("dona", { buscar: buscar as never, trava: semTrava, aoRecusar });
    expect(guardadas.apagadas).toEqual(["a:0", "b:0"]);
    expect(buscar).not.toHaveBeenCalledWith(rotaDaParte("a", 2), expect.anything());
    expect(buscar).not.toHaveBeenCalledWith(rotaDaParte("c", 0), expect.anything());
    expect(aoRecusar).toHaveBeenCalledWith(expect.objectContaining({ meetingId: "b" }), "SEM_REUNIAO");
    expect(r).toEqual({ restantes: 2, semSessao: false });
  });

  it("sessão vencida: nada sai do aparelho e o retorno avisa", async () => {
    guardadas.lista = [parte("a", 0)];
    const r = await enviarPendentes("dona", { buscar: (async () => resposta(401, { codigo: "SEM_SESSAO" })) as never, trava: semTrava });
    expect(guardadas.apagadas).toEqual([]);
    expect(r).toEqual({ restantes: 1, semSessao: true });
  });

  it("outra aba já envia esta gravação (a trava não veio): esta não faz nada agora", async () => {
    guardadas.lista = [parte("a", 0)];
    const buscar = vi.fn();
    const r = await enviarPendentes("dona", { buscar: buscar as never, trava: async () => null });
    expect(buscar).not.toHaveBeenCalled();
    expect(r.restantes).toBe(1);
  });
});
