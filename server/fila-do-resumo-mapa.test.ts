import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A fase do mapa mental (H10) na fila do resumo, com o banco e a IA dublados.
 * O banco de verdade está em server/mapa-mental.integracao.test.ts e em
 * fila-do-resumo.integracao.test.ts; aqui se prova a sequência de escritas:
 *
 * - gravado o resumo, a mesma rodada reserva a linha de novo (outro token) e
 *   grava o mapa; o resumo gravado põe o mapa na fila do zero;
 * - o mapa que falha não toca no resumo: a falha passageira volta à fila com
 *   espera, e a resposta cortada, o mapa que a conferência não aceita, a
 *   transcrição ausente e a 3ª tentativa falham de vez;
 * - o trabalho só do mapa não chama o resumo; o resumo que falha não chega ao
 *   mapa;
 * - reunião excluída ou transcrição trocada durante o mapa: nada é gravado;
 * - o desligamento e a desistência dos esgotados valem para as duas fases.
 */
const banco = vi.hoisted(() => ({
  // Os trabalhos na fila: 'pending' é o resumo; 'ready', o mapa de um resumo pronto.
  trabalhos: [] as Array<{ id: string; meetingId: string; ownerId: string; status: string; updatedAt?: number }>,
  transcricao: undefined as undefined | { id: string; texto: string; segmentos: unknown; idioma: string },
  transcricaoAtual: "t-1",
  tentativas: 1,
  reuniao: { status: "ready" },
  reservaNoBanco: true,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
}));
const ia = vi.hoisted(() => ({ gerarResumoDaReuniao: vi.fn(), gerarMapaMental: vi.fn() }));

vi.mock("./db", async () => {
  const schema = await import("../drizzle/schema");
  const { MySqlDialect: Dialeto } = await import("drizzle-orm/mysql-core");
  const resultado = (tabela: unknown, colunas: Record<string, unknown>, condicao: unknown) => {
    const chaves = Object.keys(colunas);
    if (tabela === schema.meetingSummaries) {
      // A busca do próximo trabalho é uma consulta por fase: a do mapa filtra pelo estado dele.
      if (chaves.includes("meetingId")) {
        const doMapa = new Dialeto().sqlToQuery(condicao as never).sql.includes("`mind_map_status`");
        const i = banco.trabalhos.findIndex(trabalho => (trabalho.status === "ready") === doMapa);
        if (i < 0) return [];
        const [trabalho] = banco.trabalhos.splice(i, 1);
        return [{ ...trabalho, updatedAt: trabalho.updatedAt ?? 1 }];
      }
      if (chaves.includes("attempts")) return [{ attempts: banco.tentativas }];
      return banco.reservaNoBanco ? [{ id: "resumo-1" }] : [];
    }
    if (tabela === schema.meetingTranscripts) {
      if (chaves.includes("texto")) return banco.transcricao ? [banco.transcricao] : [];
      return [{ id: banco.transcricaoAtual }];
    }
    if (tabela === schema.meetings) return [banco.reuniao];
    return [];
  };
  const db = {
    select: (colunas: Record<string, unknown>) => ({
      from: (tabela: unknown) => {
        const cadeia: Record<string, unknown> = {};
        let condicao: unknown;
        for (const metodo of ["innerJoin", "orderBy", "limit", "for"]) cadeia[metodo] = () => cadeia;
        cadeia.where = (onde: unknown) => { condicao = onde; return cadeia; };
        cadeia.then = (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve().then(() => resultado(tabela, colunas, condicao)).then(ok, erro);
        return cadeia;
      },
    }),
    update: () => ({ set: (set: Record<string, unknown>) => ({ where: async (where: unknown) => { banco.updates.push({ set, where }); return [{ affectedRows: 1 }]; } }) }),
    insert: () => ({ values: async () => undefined }),
    delete: () => ({ where: async () => undefined }),
    transaction: async (trabalho: (tx: unknown) => Promise<unknown>) => trabalho(db),
  };
  return { getDb: async () => db, exigirDb: async () => db };
});
vi.mock("./resumo-da-reuniao", () => ({ gerarResumoDaReuniao: (...a: unknown[]) => ia.gerarResumoDaReuniao(...a) }));
vi.mock("./mapa-mental", () => ({ gerarMapaMental: (...a: unknown[]) => ia.gerarMapaMental(...a) }));
vi.mock("./link-aberto-da-reuniao", () => ({ segmentosDoContrato: (bruto: unknown) => Array.isArray(bruto) ? bruto : [] }));

const fila = await import("./fila-do-resumo");
const { FalhaDaIA } = await import("./ia-em-json");

const MAPA = { ramos: [{ rotulo: "Exportação", folhas: [{ rotulo: "Contêiner", filhos: [] }] }, { rotulo: "Feiras", folhas: [] }] };
const RESUMO = { emoji: "☕", modelo: "gemini-teste-1", itens: [], recebidos: 0 };
const TEXTO = "Bom dia. O contêiner sai de Santos no dia 12 de março.";
const trabalho = (status: "pending" | "ready") => ({ id: "resumo-1", meetingId: "reuniao-1", ownerId: "dona-1", status });
const sqlDo = (where: unknown) => new MySqlDialect().sqlToQuery(where as never);
// As escritas da rodada, sem as duas da desistência dos esgotados (sempre as primeiras).
const escritas = () => banco.updates.slice(2).map(u => u.set);
const ultima = () => banco.updates.at(-1)!.set;

beforeEach(() => {
  Object.assign(banco, {
    trabalhos: [], transcricao: { id: "t-1", texto: TEXTO, segmentos: [], idioma: "pt-BR" }, transcricaoAtual: "t-1",
    tentativas: 1, reuniao: { status: "ready" }, reservaNoBanco: true, updates: [],
  });
  ia.gerarResumoDaReuniao.mockReset().mockResolvedValue(RESUMO);
  ia.gerarMapaMental.mockReset().mockResolvedValue(MAPA);
  fila.religarParaTestes();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("o mapa mental na fila do resumo", () => {
  it("gravado o resumo, a mesma rodada reserva de novo (outro token) e grava o mapa", async () => {
    banco.trabalhos = [trabalho("pending")];
    await fila.rodarUmaVez();

    const [reservaDoResumo, resumo, reservaDoMapa, mapa] = escritas();
    expect(escritas()).toHaveLength(4);
    expect(reservaDoResumo.lockToken).toEqual(expect.any(String));
    // O resumo pronto põe o mapa na fila do zero, com as tentativas dele.
    expect(resumo).toMatchObject({ status: "ready", mindMap: null, mindMapStatus: "pending", mindMapGeneratedAt: null, mindMapError: null, attempts: 0, lockToken: null });
    expect(reservaDoMapa.lockToken).toEqual(expect.any(String));
    expect(reservaDoMapa.lockToken).not.toBe(reservaDoResumo.lockToken);
    expect(mapa).toMatchObject({ mindMap: MAPA, mindMapStatus: "ready", mindMapError: null, lockToken: null, lockedUntil: null });
    expect(mapa.mindMapGeneratedAt).toEqual(expect.any(Number));
    // A versão do resumo (a da tradução, H11) não sobe com o mapa.
    expect(mapa).not.toHaveProperty("version");
    expect(ia.gerarMapaMental).toHaveBeenCalledWith({ transcricao: TEXTO, idioma: "pt-BR" });

    // A reserva do mapa só pega o mapa pendente de um resumo pronto.
    const { sql, params } = sqlDo(banco.updates[4].where);
    expect(sql).toContain("`mind_map_status` = ?");
    expect(params).toEqual(expect.arrayContaining(["ready", "pending"]));
    // A gravação do mapa confere o token e a fase.
    expect(sqlDo(banco.updates[5].where).params).toEqual(expect.arrayContaining([reservaDoMapa.lockToken, "ready", "pending"]));
  });

  it("o trabalho só do mapa (o resumo já pronto) não chama o resumo", async () => {
    banco.trabalhos = [trabalho("ready")];
    await fila.rodarUmaVez();
    expect(ia.gerarResumoDaReuniao).not.toHaveBeenCalled();
    expect(ia.gerarMapaMental).toHaveBeenCalledTimes(1);
    expect(escritas()).toHaveLength(2);
    expect(ultima()).toMatchObject({ mindMapStatus: "ready", mindMap: MAPA });
  });

  it("com um resumo e um mapa na fila, vai o mais antigo dos dois (uma consulta por fase)", async () => {
    banco.trabalhos = [{ ...trabalho("pending"), updatedAt: 200 }, { ...trabalho("ready"), id: "resumo-2", updatedAt: 100 }];
    await fila.rodarUmaVez();
    expect(ia.gerarResumoDaReuniao).not.toHaveBeenCalled();
    expect(ia.gerarMapaMental).toHaveBeenCalledTimes(1);

    ia.gerarMapaMental.mockClear();
    banco.trabalhos = [{ ...trabalho("pending"), updatedAt: 100 }, { ...trabalho("ready"), id: "resumo-2", updatedAt: 200 }];
    await fila.rodarUmaVez();
    // O resumo mais antigo vai primeiro, e o mapa dele vem na mesma rodada.
    expect(ia.gerarResumoDaReuniao).toHaveBeenCalledTimes(1);
    expect(ia.gerarMapaMental).toHaveBeenCalledTimes(1);
  });

  it("o resumo que falha não chega ao mapa", async () => {
    banco.trabalhos = [trabalho("pending")];
    ia.gerarResumoDaReuniao.mockRejectedValue(new FalhaDaIA("IA_INDISPONIVEL"));
    await fila.rodarUmaVez();
    expect(ia.gerarMapaMental).not.toHaveBeenCalled();
    expect(ultima()).toMatchObject({ status: "pending", lastError: "IA_INDISPONIVEL" });
    expect(ultima()).not.toHaveProperty("mindMapStatus");
  });

  it("o mapa que falha com a IA fora volta à fila com espera, e o resumo não é tocado", async () => {
    banco.trabalhos = [trabalho("ready")];
    ia.gerarMapaMental.mockRejectedValue(new FalhaDaIA("IA_INDISPONIVEL"));
    const antes = Date.now();
    await fila.rodarUmaVez();
    expect(ultima()).toMatchObject({ mindMapStatus: "pending", mindMapError: "IA_INDISPONIVEL", lockToken: null });
    expect(Number(ultima().lockedUntil)).toBeGreaterThanOrEqual(antes + 60_000);
    expect(ultima()).not.toHaveProperty("status");
    expect(ultima()).not.toHaveProperty("lastError");
  });

  it.each([
    ["a resposta cortada", () => ia.gerarMapaMental.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA")), "RESPOSTA_CORTADA"],
    ["o mapa que a conferência não aceita", () => ia.gerarMapaMental.mockResolvedValue(null), "MAPA_INVALIDO"],
    ["a transcrição vazia", () => { banco.transcricao = { id: "t-1", texto: "   ", segmentos: [], idioma: "pt-BR" }; }, "SEM_TRANSCRICAO"],
    ["a 3ª tentativa", () => { banco.tentativas = 3; ia.gerarMapaMental.mockRejectedValue(new FalhaDaIA("IA_INDISPONIVEL")); }, "IA_INDISPONIVEL"],
  ])("%s: o mapa falha de vez, e só ele", async (_caso, preparar, codigo) => {
    banco.trabalhos = [trabalho("ready")];
    preparar();
    await fila.rodarUmaVez();
    expect(ultima()).toMatchObject({ mindMapStatus: "failed", mindMapError: codigo, lockToken: null, lockedUntil: null });
    expect(ultima()).not.toHaveProperty("status");
  });

  it("um erro que não é da IA vira o código ERRO e volta à fila", async () => {
    banco.trabalhos = [trabalho("ready")];
    ia.gerarMapaMental.mockRejectedValue(new Error("bug"));
    await fila.rodarUmaVez();
    expect(ultima()).toMatchObject({ mindMapStatus: "pending", mindMapError: "ERRO" });
  });

  it("reunião excluída (ou reprocessada) durante o mapa: nada é gravado", async () => {
    banco.trabalhos = [trabalho("ready")];
    ia.gerarMapaMental.mockImplementation(async () => { banco.reservaNoBanco = false; return MAPA; });
    await fila.rodarUmaVez();
    expect(banco.updates.some(u => "mindMap" in u.set)).toBe(false);
  });

  it("transcrição trocada durante o mapa: nada é gravado, e a reserva volta sem gastar a tentativa", async () => {
    banco.trabalhos = [trabalho("ready")];
    ia.gerarMapaMental.mockImplementation(async () => { banco.transcricaoAtual = "t-2"; return MAPA; });
    await fila.rodarUmaVez();
    expect(banco.updates.some(u => "mindMap" in u.set)).toBe(false);
    expect(ultima()).toMatchObject({ lockToken: null, lockedUntil: null });
    expect(sqlDo(ultima().attempts).sql).toContain("greatest");
  });

  it("o desligamento durante o mapa devolve as reservas das duas fases, e o mapa não é gravado", async () => {
    banco.trabalhos = [trabalho("ready")];
    let devolvidas = -1;
    ia.gerarMapaMental.mockImplementation(async () => { devolvidas = (await fila.pararFilaDoResumo()).resumos; return MAPA; });
    await fila.rodarUmaVez();
    expect(devolvidas).toBe(1);
    expect(banco.updates.some(u => "mindMap" in u.set)).toBe(false);
    const { sql, params } = sqlDo(banco.updates.at(-1)!.where);
    expect(sql).toContain("`lock_token` in");
    expect(sql).toContain("`mind_map_status` = ?");
    expect(params).toEqual(expect.arrayContaining(["pending", "ready"]));
  });

  it("o desligamento antes do mapa: o resumo fica gravado, e o mapa nem é reservado", async () => {
    banco.trabalhos = [trabalho("pending")];
    ia.gerarResumoDaReuniao.mockImplementation(async () => RESUMO);
    // O resumo é gravado, e o desligamento chega logo depois.
    const gravar = banco.updates.push.bind(banco.updates);
    banco.updates.push = (...itens) => {
      const n = gravar(...itens);
      if (itens.some(item => item.set.status === "ready")) void fila.pararFilaDoResumo();
      return n;
    };
    await fila.rodarUmaVez();
    expect(ia.gerarMapaMental).not.toHaveBeenCalled();
    expect(banco.updates.some(u => u.set.status === "ready")).toBe(true);
  });

  it("os esgotados: o resumo e o mapa desistem cada um no seu campo", async () => {
    await fila.rodarUmaVez();
    const [doResumo, doMapa] = banco.updates;
    expect(doResumo.set).toMatchObject({ status: "failed", lastError: "TENTATIVAS_ESGOTADAS" });
    expect(doMapa.set).toMatchObject({ mindMapStatus: "failed", mindMapError: "TENTATIVAS_ESGOTADAS", lockToken: null, lockedUntil: null });
    expect(doMapa.set).not.toHaveProperty("status");
    const { sql, params } = sqlDo(doMapa.where);
    expect(sql).toContain("`mind_map_status` = ?");
    expect(sql).toContain("`attempts` >= ?");
    expect(params).toEqual(expect.arrayContaining(["ready", "pending", fila.TENTATIVAS_DO_RESUMO]));
  });
});
