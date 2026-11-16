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
  resumo: undefined as undefined | { id: string; status: string; lockedUntil: number | null; lockToken: string | null; emoji: string | null; language: string | null; lastError: null },
  erroNoInsert: null as unknown,
  linhasNoUpdate: 1,
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
      insert: () => ({ values: async () => { if (estado.erroNoInsert) throw estado.erroNoInsert; } }),
      update: () => ({ set: () => ({ where: async () => [{ affectedRows: estado.linhasNoUpdate }] }) }),
    }),
  };
});

// O link aberto: o token sempre acha a reunião da dona (a recusa do link está
// nos testes de link-aberto-da-reuniao).
vi.mock("./link-aberto-da-reuniao", async importOriginal => ({
  ...(await importOriginal<typeof import("./link-aberto-da-reuniao")>()),
  exigirReuniaoDoLink: async () => ({ id: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", ownerId: "dona-1" }),
}));

const { pedirResumoDaDona, resumoGuardadoDaDona, resumoGuardadoPeloLink } = await import("./resumo-guardado");
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
  Object.assign(estado, { resumo: undefined, erroNoInsert: null, linhasNoUpdate: 1 });
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

/**
 * "Ouvir o resumo" (H19) lê com a voz do aparelho no idioma em que a IA
 * escreveu o resumo: o idioma vai à dona e também ao link aberto.
 */
describe("o idioma do resumo vai à tela, pela dona e pelo link", () => {
  it("pronto: o idioma gravado vai junto, nas duas leituras", async () => {
    estado.resumo = { id: "resumo-1", status: "ready", lockedUntil: null, lockToken: null, emoji: "☕", language: "en", lastError: null };
    await expect(resumoGuardadoPeloLink("t".repeat(32))).resolves.toEqual({ estado: "pronto", emoji: "☕", idioma: "en", itens: [] });
    await expect(resumoGuardadoDaDona("dona-1", ID)).resolves.toMatchObject({ estado: "pronto", idioma: "en" });
  });

  it("sem resumo, o idioma é null (a tela nem mostra o botão de ouvir)", async () => {
    await expect(resumoGuardadoPeloLink("t".repeat(32))).resolves.toEqual({ estado: "sem_resumo", emoji: null, idioma: null, itens: [] });
  });
});
