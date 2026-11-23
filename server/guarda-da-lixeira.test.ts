import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A guarda da lixeira nos procedimentos pelo id (H7d, server/guarda-da-lixeira.ts):
 * quais campos do pedido ela lê, que o pedido sem nenhum deles não vai ao
 * banco, e a VARREDURA do appRouter — todo procedimento que aponta para uma
 * reunião leva a guarda, salvo os da própria lixeira, e o que aponta para uma
 * reunião fora de server/routers/meetings.ts está numa lista fechada, com o
 * filtro que o serviço dele aplica. O que a guarda recusa no banco de verdade
 * está em server/lixeira-de-reunioes.integracao.test.ts.
 */

const exigirDb = vi.hoisted(() => vi.fn(async () => { throw new Error("este teste não usa banco"); }));
vi.mock("./db", async original => ({ ...(await original<typeof import("./db")>()), exigirDb: () => exigirDb() }));

const { idsDoPedido, procedimentoDaReuniao, recusarSeNaLixeira } = await import("./guarda-da-lixeira");
const { appRouter } = await import("./routers");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { RECUSAS_DA_LIXEIRA } = await import("@shared/lixeira-de-reunioes");

/** Um banco de mentira cuja consulta da guarda acha `linhas` (a cadeia select → from → [innerJoin] → where → limit). */
function bancoQueAcha(linhas: Array<{ id: string }>) {
  const cadeia = { from: () => cadeia, innerJoin: () => cadeia, where: () => cadeia, limit: async () => linhas };
  return { select: () => cadeia };
}

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const OUTRO = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

/** Os campos que apontam para uma reunião, os mesmos que a guarda lê. */
const CAMPOS_DA_REUNIAO = ["meetingId", "meetingIds", "itemId", "entityId", "suggestionId"] as const;

type Procedimento = { _def: { inputs?: unknown[]; middlewares: unknown[] } };
const procedimentos = Object.entries((appRouter as unknown as { _def: { procedures: Record<string, Procedimento> } })._def.procedures);
/** A guarda é o último middleware do construtor procedimentoDaReuniao. */
const guarda = (procedimentoDaReuniao as unknown as Procedimento)._def.middlewares.at(-1);
const temGuarda = (procedimento: Procedimento) => procedimento._def.middlewares.includes(guarda);
function camposDaEntrada(procedimento: Procedimento): string[] {
  const campos = new Set<string>();
  for (const entrada of procedimento._def.inputs ?? []) {
    const forma = (entrada as { shape?: Record<string, unknown> }).shape;
    if (forma) for (const campo of Object.keys(forma)) campos.add(campo);
  }
  return Array.from(campos);
}
const apontaParaReuniao = (procedimento: Procedimento) => camposDaEntrada(procedimento).some(campo => (CAMPOS_DA_REUNIAO as readonly string[]).includes(campo));

describe("os campos que a guarda lê", () => {
  it("meetingId, meetingIds, itemId, entityId e suggestionId, só com a forma de id; o resto fica para o zod", () => {
    expect(idsDoPedido({ meetingId: ID, itemId: OUTRO, entityId: "não é id", suggestionId: 7 })).toEqual({
      reunioes: [ID], itemId: OUTRO, entityId: null, suggestionId: null,
    });
    expect(idsDoPedido({ meetingIds: [ID, ID, "lixo", OUTRO, 3] }).reunioes).toEqual([ID, OUTRO]);
    expect(idsDoPedido({ meetingId: ID, meetingIds: [ID] }).reunioes).toEqual([ID]);
    for (const vazio of [undefined, null, "texto", 7, [], { titulo: "x" }]) {
      expect(idsDoPedido(vazio)).toEqual({ reunioes: [], itemId: null, entityId: null, suggestionId: null });
    }
  });

  it("a lista de ids tem teto: a guarda não monta um IN de mil ids (o zod recusa a lista longa depois)", () => {
    const muitos = Array.from({ length: 300 }, (_, i) => `8b1f6a2e-3c4d-4e5f-8a9b-${String(i).padStart(12, "0")}`);
    expect(idsDoPedido({ meetingIds: muitos }).reunioes).toHaveLength(100);
  });

  it("o pedido que não aponta para reunião nenhuma não vai ao banco", async () => {
    await expect(recusarSeNaLixeira("dona-1", { titulo: "Sem id" })).resolves.toBeUndefined();
    await expect(recusarSeNaLixeira("dona-1", undefined)).resolves.toBeUndefined();
    expect(exigirDb).not.toHaveBeenCalled();
  });

  it("o banco fora do ar é erro, nunca 'passou': a guarda não engole a falha da consulta", async () => {
    await expect(recusarSeNaLixeira("dona-1", { meetingId: ID })).rejects.toThrow("este teste não usa banco");
    // A queda de verdade, nas duas formas que ehErroDeBancoIndisponivel
    // reconhece: sem DATABASE_URL (BancoIndisponivel) e a conexão recusada pelo
    // driver (cause.code). Uma guarda que engolisse justo essas e deixasse o
    // pedido passar ficaria verde com o erro genérico acima.
    exigirDb.mockRejectedValueOnce(new BancoIndisponivel());
    await expect(recusarSeNaLixeira("dona-1", { meetingId: ID })).rejects.toBeInstanceOf(BancoIndisponivel);
    const recusada = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" }) });
    exigirDb.mockRejectedValueOnce(recusada);
    await expect(recusarSeNaLixeira("dona-1", { itemId: ID })).rejects.toBe(recusada);
  });

  it("a reunião da dona na lixeira é NOT_FOUND com o código dela (REUNIAO_NA_LIXEIRA), para a tela dizer que está na lixeira; sem nada achado, passa", async () => {
    // Pelo id da reunião e pelo id de um item (o mesmo código, venha por onde vier).
    for (const pedido of [{ meetingId: ID }, { itemId: ID }, { meetingIds: [OUTRO, ID] }]) {
      exigirDb.mockResolvedValueOnce(bancoQueAcha([{ id: ID }]) as never);
      await expect(recusarSeNaLixeira("dona-1", pedido)).rejects.toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_LIXEIRA.naLixeira });
    }
    // Nada na lixeira da dona (a reunião está fora dela, ou é de outra conta): a
    // guarda deixa passar, e o serviço responde com a frase de sempre.
    exigirDb.mockResolvedValueOnce(bancoQueAcha([]) as never);
    await expect(recusarSeNaLixeira("dona-1", { meetingId: ID })).resolves.toBeUndefined();
  });
});

/**
 * Todo procedimento de server/routers/meetings.ts leva a guarda, menos os da
 * lixeira (são os únicos que veem a reunião de lá, e cada serviço confere
 * sozinho) e o Excluir imediato (o descarte da gravação tira a reunião de vez,
 * também a que foi para a lixeira por outro aparelho). A lista fechada pega o
 * procedimento novo que esquecer a guarda.
 */
describe("a varredura do router: quem leva a guarda", () => {
  const DA_LIXEIRA = ["lixeira", "mandarParaALixeira", "restaurarDaLixeira", "apagarDeVez", "esvaziarLixeira"];
  const EXCLUIR_IMEDIATO = "delete";

  it("todo procedimento de meetings leva a guarda, fora os cinco da lixeira e o Excluir imediato", () => {
    const deMeetings = procedimentos.filter(([caminho]) => caminho.startsWith("meetings."));
    expect(deMeetings.length).toBeGreaterThan(50);
    const semGuarda = deMeetings.filter(([, procedimento]) => !temGuarda(procedimento)).map(([caminho]) => caminho.slice("meetings.".length));
    expect(semGuarda.sort()).toEqual([...DA_LIXEIRA, EXCLUIR_IMEDIATO].sort());
  });

  it("os da lixeira existem e apontam para a reunião só pela lista (mandar, restaurar e apagar de vez)", () => {
    const porNome = new Map(procedimentos.map(([caminho, procedimento]) => [caminho, procedimento]));
    for (const nome of ["mandarParaALixeira", "restaurarDaLixeira", "apagarDeVez"]) {
      expect(camposDaEntrada(porNome.get(`meetings.${nome}`)!)).toEqual(["meetingIds"]);
    }
  });

  it("fora de meetings, o procedimento que aponta para uma reunião está na lista, com o filtro que o serviço dele aplica", () => {
    // O motivo de cada um: o serviço filtra a lixeira na consulta, ou o campo é de outra tabela.
    const CONFERIDOS: Record<string, string> = {
      "agenda.ligarGravacao": "ligarGravacaoNaAgenda só liga a gravação visível (reuniaoVisivel)",
      "networkInteligente.pendencias": "listarPendencias tira as da reunião na lixeira (semReuniaoNaLixeira)",
      "enrichment.confirmSuggestion": "suggestionId é da sugestão do enriquecimento (enrichment_suggestions), não da reunião",
      "enrichment.createSuggestedContext": "suggestionId é da sugestão do enriquecimento, não da reunião",
      "enrichment.ignoreSuggestion": "suggestionId é da sugestão do enriquecimento, não da reunião",
      "enrichment.undoSuggestion": "suggestionId é da sugestão do enriquecimento, não da reunião",
    };
    const fora = procedimentos
      .filter(([caminho, procedimento]) => !caminho.startsWith("meetings.") && apontaParaReuniao(procedimento))
      .map(([caminho]) => caminho);
    expect(fora.filter(caminho => !(caminho in CONFERIDOS))).toEqual([]);
    for (const caminho of fora) expect(CONFERIDOS[caminho].length).toBeGreaterThan(20);
  });
});
