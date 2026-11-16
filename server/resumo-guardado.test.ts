import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O pedido de resumo que perde a corrida para outro igual (H4a2), com o banco
 * dublado para forçar o que o banco real só faz por acaso: o insert que bate no
 * índice único (ER_DUP_ENTRY, embrulhado pelo drizzle) e o UPDATE de reabrir
 * que não acha linha. Nos dois casos o trabalho existe, o pedido não falha e a
 * vaga do teto volta. Erro que não é chave repetida sobe, e a vaga fica.
 */
const estado = vi.hoisted(() => ({
  resumo: undefined as undefined | { id: string; status: string; lockedUntil: number | null; lockToken: string | null; emoji: null; language: null; lastError: null; template?: string },
  erroNoInsert: null as unknown,
  linhasNoUpdate: 1,
  // O que o serviço mandou gravar, para os testes dos modelos (H4d).
  inseridos: [] as Array<Record<string, unknown>>,
  atualizados: [] as Array<Record<string, unknown>>,
}));

vi.mock("./db", async () => {
  const schema = await import("../drizzle/schema");
  return {
    getDb: async () => null,
    exigirDb: async () => ({
      select: () => ({ from: (tabela: unknown) => {
        const linhas = () => tabela === schema.meetings ? [{ status: "ready" }]
          : tabela === schema.meetingTranscripts ? [{ id: "transcricao-1" }]
          : tabela === schema.meetingSummaries ? (estado.resumo ? [estado.resumo] : [])
          : [];
        const fim = { limit: async () => linhas(), orderBy: async () => [], then: (ok: (v: unknown) => unknown) => Promise.resolve(linhas()).then(ok) };
        return { where: () => fim };
      } }),
      insert: () => ({ values: async (valores: Record<string, unknown>) => { estado.inseridos.push(valores); if (estado.erroNoInsert) throw estado.erroNoInsert; } }),
      update: () => ({ set: (campos: Record<string, unknown>) => { estado.atualizados.push(campos); return { where: async () => [{ affectedRows: estado.linhasNoUpdate }] }; } }),
      // Sem delete: pedir ou refazer o resumo nunca apaga item (quem troca os itens é a fila).
    }),
  };
});

const { pedirResumoDaDona, refazerResumoDaDona, resumoGuardadoDaDona } = await import("./resumo-guardado");
const { MENSAGEM_RESUMO_SENDO_GERADO } = await import("@shared/const");
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
  Object.assign(estado, { resumo: undefined, erroNoInsert: null, linhasNoUpdate: 1, inseridos: [], atualizados: [] });
});

describe("pedido de resumo que perde a corrida", () => {
  it("criar: o insert bate no índice único (o erro do driver vem na causa) — não falha, e a vaga volta", async () => {
    estado.erroNoInsert = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" }) });
    const soltar = vi.fn();
    await expect(pedirResumoDaDona("dona-1", ID, () => soltar)).resolves.toBeDefined();
    expect(soltar).toHaveBeenCalledTimes(1);
  });

  it("criar: outro erro do banco sobe, e a vaga não volta (banco fora do ar é erro)", async () => {
    estado.erroNoInsert = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const soltar = vi.fn();
    await expect(pedirResumoDaDona("dona-1", ID, () => soltar)).rejects.toThrow("Failed query");
    expect(soltar).not.toHaveBeenCalled();
  });

  it("criar sem corrida: a vaga fica gasta", async () => {
    const soltar = vi.fn();
    await pedirResumoDaDona("dona-1", ID, () => soltar);
    expect(soltar).not.toHaveBeenCalled();
  });

  it("reabrir o que falhou: o UPDATE sem linha (outro já reabriu) devolve a vaga; com linha, não", async () => {
    estado.resumo = { id: "resumo-1", status: "failed", lockedUntil: null, lockToken: null, emoji: null, language: null, lastError: null };
    const soltar = vi.fn();
    estado.linhasNoUpdate = 0;
    await pedirResumoDaDona("dona-1", ID, () => soltar);
    expect(soltar).toHaveBeenCalledTimes(1);
    estado.linhasNoUpdate = 1;
    await pedirResumoDaDona("dona-1", ID, () => soltar);
    expect(soltar).toHaveBeenCalledTimes(1);
  });

  it("resumo pendente ou pronto: nem chama o teto", async () => {
    const teto = vi.fn();
    for (const status of ["pending", "ready"]) {
      estado.resumo = { id: "resumo-1", status, lockedUntil: null, lockToken: null, emoji: null, language: null, lastError: null };
      await pedirResumoDaDona("dona-1", ID, teto);
    }
    expect(teto).not.toHaveBeenCalled();
  });
});

describe("os modelos do resumo (H4d): pedir e refazer", () => {
  const resumo = (status: string, template: string) => ({ id: "resumo-1", status, lockedUntil: null, lockToken: null, emoji: null, language: null, lastError: null, template });

  it("pedir com modelo: o resumo novo nasce nele; sem modelo, no Geral", async () => {
    await pedirResumoDaDona("dona-1", ID, () => undefined, "sales");
    await pedirResumoDaDona("dona-1", ID, () => undefined);
    expect(estado.inseridos.map(linha => [linha.status, linha.template])).toEqual([["pending", "sales"], ["pending", "general"]]);
  });

  it("o que falhou reabre no modelo pedido; sem modelo, fica no de antes", async () => {
    estado.resumo = resumo("failed", "networking");
    await pedirResumoDaDona("dona-1", ID, () => undefined, "sales");
    await pedirResumoDaDona("dona-1", ID, () => undefined);
    expect(estado.atualizados[0]).toMatchObject({ status: "pending", template: "sales", attempts: 0, lastError: null, lockToken: null, lockedUntil: null });
    expect(estado.atualizados[1]).toMatchObject({ status: "pending" });
    expect(estado.atualizados[1]).not.toHaveProperty("template");
  });

  it("pedir não refaz o resumo pronto, nem com outro modelo: nem chama o teto", async () => {
    estado.resumo = resumo("ready", "general");
    const teto = vi.fn();
    await pedirResumoDaDona("dona-1", ID, teto, "sales");
    expect(teto).not.toHaveBeenCalled();
    expect(estado.atualizados).toEqual([]);
  });

  it("refazer o pronto: volta à fila no modelo pedido, sem apagar item, e gasta a vaga; o modelo sai na leitura", async () => {
    estado.resumo = resumo("ready", "general");
    const soltar = vi.fn();
    const teto = vi.fn(() => soltar);
    await refazerResumoDaDona("dona-1", ID, "mentoring", teto);
    expect(teto).toHaveBeenCalledTimes(1);
    expect(soltar).not.toHaveBeenCalled();
    expect(estado.atualizados).toEqual([expect.objectContaining({ status: "pending", template: "mentoring", attempts: 0, lastError: null, lockToken: null, lockedUntil: null })]);
    estado.resumo = resumo("pending", "mentoring");
    expect(await resumoGuardadoDaDona("dona-1", ID)).toMatchObject({ estado: "pendente", modelo: "mentoring" });
  });

  it("refazer o que falhou também vale, no modelo pedido", async () => {
    estado.resumo = resumo("failed", "general");
    await refazerResumoDaDona("dona-1", ID, "one_on_one", () => undefined);
    expect(estado.atualizados).toEqual([expect.objectContaining({ status: "pending", template: "one_on_one" })]);
  });

  it("refazer: outro pedido refez antes (o UPDATE não acha a linha no estado lido), e a vaga volta", async () => {
    estado.resumo = resumo("ready", "general");
    estado.linhasNoUpdate = 0;
    const soltar = vi.fn();
    await refazerResumoDaDona("dona-1", ID, "sales", () => soltar);
    expect(soltar).toHaveBeenCalledTimes(1);
  });

  it("refazer o que ainda está na fila: no mesmo modelo não muda nada nem gasta vaga; em outro é conflito", async () => {
    estado.resumo = resumo("pending", "sales");
    const teto = vi.fn();
    await refazerResumoDaDona("dona-1", ID, "sales", teto);
    await expect(refazerResumoDaDona("dona-1", ID, "general", teto)).rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
    expect(teto).not.toHaveBeenCalled();
    expect(estado.atualizados).toEqual([]);
  });

  it("refazer sem resumo nenhum cria o trabalho no modelo pedido", async () => {
    await refazerResumoDaDona("dona-1", ID, "networking", () => undefined);
    expect(estado.inseridos).toEqual([expect.objectContaining({ status: "pending", template: "networking" })]);
  });
});
