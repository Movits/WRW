import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O mapa mental como a tela o lê e o pede (H10), com o banco dublado. O banco
 * de verdade está em server/mapa-mental.integracao.test.ts; aqui se prova a
 * regra de cada caminho:
 *
 * - o estado pela linha do resumo (o resumo na fila leva o mapa junto; o
 *   resumo de antes do mapa é "sem mapa"; "gerando" só com reserva viva);
 * - a árvore guardada é conferida de novo na leitura, e a que não passa vira
 *   falha, nunca um mapa pela metade;
 * - pedir sem resumo pede o resumo; com o resumo pronto, só o mapa volta à
 *   fila, do zero; o que já está na fila, ou pronto, não gasta vaga, mas o
 *   pronto que a conferência recusa volta à fila como o que falhou; o pedido
 *   que perde a corrida devolve a vaga; sem transcrição, recusa.
 */
type Linha = {
  id: string; status: string; lockedUntil: number | null; lockToken: string | null; lastError: string | null;
  language: string | null; mindMap: unknown; mindMapStatus: string | null; mindMapError: string | null;
};
const estado = vi.hoisted(() => ({
  reuniao: { status: "ready" } as { status: string } | undefined,
  linha: undefined as undefined | Record<string, unknown>,
  transcricao: { id: "transcricao-1" } as { id: string } | undefined,
  linhasNoUpdate: 1,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  inserts: 0,
}));

vi.mock("./db", async () => {
  const schema = await import("../drizzle/schema");
  return {
    getDb: async () => null,
    exigirDb: async () => ({
      select: () => ({ from: (tabela: unknown) => {
        const linhas = () => tabela === schema.meetings ? (estado.reuniao ? [estado.reuniao] : [])
          : tabela === schema.meetingTranscripts ? (estado.transcricao ? [estado.transcricao] : [])
          : tabela === schema.meetingSummaries ? (estado.linha ? [estado.linha] : [])
          : [];
        const fim = { limit: async () => linhas(), then: (ok: (v: unknown) => unknown) => Promise.resolve(linhas()).then(ok) };
        return { where: () => fim };
      } }),
      insert: () => ({ values: async () => { estado.inserts++; } }),
      update: () => ({ set: (set: Record<string, unknown>) => ({ where: async (where: unknown) => { estado.updates.push({ set, where }); return [{ affectedRows: estado.linhasNoUpdate }]; } }) }),
    }),
  };
});
vi.mock("./link-aberto-da-reuniao", () => ({
  exigirReuniaoDoLink: async (token: string) => {
    if (token !== "t".repeat(32)) throw Object.assign(new Error("Link não encontrado."), { codigo: "NOT_FOUND" });
    return { id: "reuniao-do-link", ownerId: "dona-do-link", title: "Reunião", createdAt: 1, emPartes: false };
  },
}));

const { estadoDoMapa, mapaMentalDaDona, mapaMentalPeloLink, pedirMapaDaDona, pedirMapaPeloLink } = await import("./mapa-mental-guardado");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const MAPA = { ramos: [{ rotulo: "Exportação", folhas: [{ rotulo: "Contêiner", filhos: ["12 de março"] }] }, { rotulo: "Feiras", folhas: [] }] };
const linha = (extra: Partial<Linha> = {}): Linha => ({
  id: "resumo-1", status: "ready", lockedUntil: null, lockToken: null, lastError: null, language: "pt-BR",
  mindMap: null, mindMapStatus: null, mindMapError: null, ...extra,
});
const sqlDo = (where: unknown) => new MySqlDialect().sqlToQuery(where as never);

beforeEach(() => {
  Object.assign(estado, { reuniao: { status: "ready" }, linha: undefined, transcricao: { id: "transcricao-1" }, linhasNoUpdate: 1, updates: [], inserts: 0 });
});

describe("o estado do mapa pela linha do resumo", () => {
  const AGORA = 1_800_000_000_000;
  const viva = { lockToken: "token", lockedUntil: AGORA + 60_000 };
  const vencida = { lockToken: "token", lockedUntil: AGORA - 1 };

  it("sem linha: sem mapa", () => {
    expect(estadoDoMapa(undefined, AGORA)).toEqual({ estado: "sem_mapa", erro: null });
  });

  it("o resumo na fila leva o mapa junto: pendente, ou gerando com reserva viva", () => {
    expect(estadoDoMapa(linha({ status: "pending" }), AGORA).estado).toBe("pendente");
    expect(estadoDoMapa(linha({ status: "pending", ...viva }), AGORA).estado).toBe("gerando");
    expect(estadoDoMapa(linha({ status: "pending", ...vencida }), AGORA).estado).toBe("pendente");
  });

  it("o resumo que falhou leva o mapa: falhou, com o código do resumo", () => {
    expect(estadoDoMapa(linha({ status: "failed", lastError: "IA_INDISPONIVEL" }), AGORA)).toEqual({ estado: "falhou", erro: "IA_INDISPONIVEL" });
  });

  it("o resumo refeito em outro modelo (H4d): o mapa pronto da versão anterior segue valendo, na fila e na falha", () => {
    expect(estadoDoMapa(linha({ status: "pending", mindMapStatus: "ready", ...viva }), AGORA)).toEqual({ estado: "pronto", erro: null });
    expect(estadoDoMapa(linha({ status: "failed", lastError: "RESPOSTA_CORTADA", mindMapStatus: "ready" }), AGORA)).toEqual({ estado: "pronto", erro: null });
    // Sem mapa pronto, o resumo na fila ou que falhou leva o mapa junto, como antes.
    expect(estadoDoMapa(linha({ status: "pending", mindMapStatus: "failed" }), AGORA).estado).toBe("pendente");
    expect(estadoDoMapa(linha({ status: "failed", lastError: "RESPOSTA_CORTADA", mindMapStatus: null }), AGORA)).toEqual({ estado: "falhou", erro: "RESPOSTA_CORTADA" });
  });

  it("resumo pronto: o estado é o do mapa; nulo é o resumo de antes do mapa", () => {
    expect(estadoDoMapa(linha(), AGORA)).toEqual({ estado: "sem_mapa", erro: null });
    expect(estadoDoMapa(linha({ mindMapStatus: "pending" }), AGORA).estado).toBe("pendente");
    // Na espera depois de uma falha passageira, a linha tem prazo mas ninguém está gerando.
    expect(estadoDoMapa(linha({ mindMapStatus: "pending", lockToken: null, lockedUntil: AGORA + 60_000 }), AGORA).estado).toBe("pendente");
    expect(estadoDoMapa(linha({ mindMapStatus: "pending", ...viva }), AGORA).estado).toBe("gerando");
    expect(estadoDoMapa(linha({ mindMapStatus: "ready" }), AGORA)).toEqual({ estado: "pronto", erro: null });
    expect(estadoDoMapa(linha({ mindMapStatus: "failed", mindMapError: "MAPA_INVALIDO" }), AGORA)).toEqual({ estado: "falhou", erro: "MAPA_INVALIDO" });
  });
});

describe("ler o mapa", () => {
  it("pronto: a árvore conferida, com o idioma do resumo", async () => {
    estado.linha = linha({ mindMapStatus: "ready", mindMap: MAPA, language: "ar" });
    expect(await mapaMentalDaDona("dona-1", ID)).toEqual({ estado: "pronto", idioma: "ar", erro: null, mapa: MAPA });
  });

  it("a árvore guardada é conferida de novo: o que não passa vira falha, nunca um mapa pela metade", async () => {
    estado.linha = linha({ mindMapStatus: "ready", mindMap: { ramos: [{ rotulo: "{F1} fala", folhas: [] }, { rotulo: "Só um", folhas: [] }] } });
    expect(await mapaMentalDaDona("dona-1", ID)).toEqual({ estado: "falhou", idioma: "pt-BR", erro: "MAPA_INVALIDO", mapa: null });
    estado.linha = linha({ mindMapStatus: "ready", mindMap: "não é JSON de mapa" });
    expect((await mapaMentalDaDona("dona-1", ID)).estado).toBe("falhou");
  });

  it("fora de 'pronto', a árvore não sai, mesmo se a coluna tiver uma", async () => {
    estado.linha = linha({ mindMapStatus: "pending", mindMap: MAPA });
    expect(await mapaMentalDaDona("dona-1", ID)).toEqual({ estado: "pendente", idioma: "pt-BR", erro: null, mapa: null });
  });

  it("enquanto o resumo é refeito (H4d), e se o refazer falhar, o mapa pronto sai para a dona e para o link", async () => {
    estado.linha = linha({ status: "pending", mindMapStatus: "ready", mindMap: MAPA });
    expect(await mapaMentalDaDona("dona-1", ID)).toEqual({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA });
    estado.linha = linha({ status: "failed", lastError: "RESPOSTA_CORTADA", mindMapStatus: "ready", mindMap: MAPA });
    expect(await mapaMentalPeloLink("t".repeat(32))).toEqual({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA });
  });

  it("reunião de outra dona (ou apagada): NOT_FOUND", async () => {
    estado.reuniao = undefined;
    await expect(mapaMentalDaDona("outra", ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pelo link: o mesmo formato; link que não abre é recusado", async () => {
    estado.linha = linha({ mindMapStatus: "ready", mindMap: MAPA });
    expect(await mapaMentalPeloLink("t".repeat(32))).toEqual({ estado: "pronto", idioma: "pt-BR", erro: null, mapa: MAPA });
    await expect(mapaMentalPeloLink("x".repeat(32))).rejects.toMatchObject({ codigo: "NOT_FOUND" });
  });
});

describe("pedir o mapa", () => {
  it("sem resumo: pede o resumo (o mapa vem com ele) e gasta a vaga", async () => {
    const teto = vi.fn();
    await pedirMapaDaDona("dona-1", ID, teto);
    expect(estado.inserts).toBe(1);
    expect(teto).toHaveBeenCalledTimes(1);
  });

  it("com o resumo que falhou: reabre o resumo, e a vaga é gasta", async () => {
    estado.linha = linha({ status: "failed", lastError: "IA_INDISPONIVEL" });
    const teto = vi.fn();
    await pedirMapaDaDona("dona-1", ID, teto);
    expect(teto).toHaveBeenCalledTimes(1);
    expect(estado.updates[0].set).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("resumo pronto sem mapa (o de antes do mapa) ou com o mapa que falhou: só o mapa volta à fila, do zero", async () => {
    for (const mindMapStatus of [null, "failed"]) {
      estado.updates = [];
      estado.linha = linha({ mindMapStatus, mindMapError: mindMapStatus ? "IA_INDISPONIVEL" : null });
      const teto = vi.fn();
      await pedirMapaDaDona("dona-1", ID, teto);
      expect(teto).toHaveBeenCalledTimes(1);
      expect(estado.updates).toHaveLength(1);
      const { set, where } = estado.updates[0];
      expect(set).toMatchObject({ mindMapStatus: "pending", mindMapError: null, attempts: 0, lockedUntil: null, lockToken: null });
      // O resumo não muda: nem o estado nem os itens.
      expect(set).not.toHaveProperty("status");
      // O UPDATE é condicional: a dona, o resumo pronto e o mapa ausente ou falho.
      const { sql, params } = sqlDo(where);
      expect(sql).toContain("`owner_id` = ?");
      expect(sql).toContain("`mind_map_status` is null");
      expect(params).toEqual(expect.arrayContaining(["dona-1", "ready", "failed"]));
    }
  });

  it("o mapa pronto que não passa mais na conferência (a tela o mostra como falha): o Tentar de novo o refaz, e o UPDATE só acha o mapa pronto", async () => {
    const invalido = { ramos: [{ rotulo: "Só um assunto", folhas: [] }] };
    for (const pedir of [(teto: () => void) => pedirMapaDaDona("dona-1", ID, teto), (teto: () => void) => pedirMapaPeloLink("t".repeat(32), teto)]) {
      estado.updates = [];
      estado.linha = linha({ mindMapStatus: "ready", mindMap: invalido });
      const teto = vi.fn();
      await pedir(teto);
      expect(teto).toHaveBeenCalledTimes(1);
      expect(estado.updates).toHaveLength(1);
      const { set, where } = estado.updates[0];
      expect(set).toMatchObject({ mindMapStatus: "pending", mindMapError: null, attempts: 0, lockedUntil: null, lockToken: null });
      expect(set).not.toHaveProperty("status");
      // Condicional ao estado lido: o pedido que perde a corrida para outro igual não acha a linha.
      const { sql, params } = sqlDo(where);
      expect(sql).not.toContain("is null");
      expect(params.slice(-2)).toEqual(["ready", "ready"]);
    }
  });

  it("resumo ou mapa na fila, ou mapa pronto: nada muda e nada se gasta", async () => {
    const teto = vi.fn();
    for (const extra of [{ status: "pending" }, { mindMapStatus: "pending" }, { mindMapStatus: "ready", mindMap: MAPA }]) {
      estado.linha = linha(extra);
      await pedirMapaDaDona("dona-1", ID, teto);
    }
    expect(teto).not.toHaveBeenCalled();
    expect(estado.updates).toEqual([]);
    expect(estado.inserts).toBe(0);
  });

  it("o pedido que perde a corrida (o UPDATE sem linha) devolve a vaga", async () => {
    estado.linha = linha({ mindMapStatus: "failed" });
    estado.linhasNoUpdate = 0;
    const soltar = vi.fn();
    await pedirMapaDaDona("dona-1", ID, () => soltar);
    expect(soltar).toHaveBeenCalledTimes(1);
  });

  it("reunião que não está pronta, ou sem transcrição: recusa antes da vaga", async () => {
    const teto = vi.fn();
    estado.reuniao = { status: "processing" };
    await expect(pedirMapaDaDona("dona-1", ID, teto)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    estado.reuniao = { status: "ready" };
    estado.linha = linha();
    estado.transcricao = undefined;
    await expect(pedirMapaDaDona("dona-1", ID, teto)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(teto).not.toHaveBeenCalled();
  });

  it("pelo link: a vaga é a da reunião do link", async () => {
    estado.linha = linha();
    const vaga = vi.fn();
    await pedirMapaPeloLink("t".repeat(32), vaga);
    expect(vaga).toHaveBeenCalledWith("reuniao-do-link");
    expect(estado.updates[0].set).toMatchObject({ mindMapStatus: "pending" });
  });

  it("no refazer que falhou (H4d): com o mapa pronto, nada a pedir; sem ele, só a dona reabre o resumo, e o link nem gasta vaga", async () => {
    const teto = vi.fn();
    estado.linha = { ...linha({ status: "failed", lastError: "RESPOSTA_CORTADA", mindMapStatus: "ready", mindMap: MAPA }), version: 1, template: "sales" };
    await pedirMapaDaDona("dona-1", ID, teto);
    await pedirMapaPeloLink("t".repeat(32), teto);
    expect(teto).not.toHaveBeenCalled();
    expect(estado.updates).toEqual([]);

    estado.linha = { ...linha({ status: "failed", lastError: "RESPOSTA_CORTADA" }), version: 1, template: "sales" };
    await pedirMapaPeloLink("t".repeat(32), teto);
    expect(teto).not.toHaveBeenCalled();
    expect(estado.updates).toEqual([]);
    await pedirMapaDaDona("dona-1", ID, teto);
    expect(teto).toHaveBeenCalledTimes(1);
    expect(estado.updates[0].set).toMatchObject({ status: "pending", attempts: 0 });
  });
});
