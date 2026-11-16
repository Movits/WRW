import { getTableName, type Table } from "drizzle-orm";
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
  resumo: undefined as undefined | { id: string; status: string; lockedUntil: number | null; lockToken: string | null; emoji: string | null; language: string | null; lastError: null; template?: string },
  erroNoInsert: null as unknown,
  linhasNoUpdate: 1,
  /** O dublê de um bloco que precisa de outro banco (as travas da decisão, no fim do arquivo). */
  banco: null as unknown,
  // O que o serviço mandou gravar, para os testes dos modelos (H4d).
  inseridos: [] as Array<Record<string, unknown>>,
  atualizados: [] as Array<Record<string, unknown>>,
}));

vi.mock("./db", async () => {
  const schema = await import("../drizzle/schema");
  return {
    getDb: async () => null,
    exigirDb: async () => estado.banco ?? ({
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

// O link aberto: o token sempre acha a reunião da dona (a recusa do link está
// nos testes de link-aberto-da-reuniao).
vi.mock("./link-aberto-da-reuniao", async importOriginal => ({
  ...(await importOriginal<typeof import("./link-aberto-da-reuniao")>()),
  exigirReuniaoDoLink: async () => ({ id: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", ownerId: "dona-1" }),
}));

const {
  confirmarItensDoResumo, decidirItemDoResumo, marcarAcaoFeita, pedirResumoDaDona, refazerResumoDaDona, resumoGuardadoDaDona, resumoGuardadoPeloLink,
} = await import("./resumo-guardado");
const { MENSAGEM_RESUMO_SENDO_GERADO } = await import("@shared/const");
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
  Object.assign(estado, { resumo: undefined, erroNoInsert: null, linhasNoUpdate: 1, banco: null, inseridos: [], atualizados: [] });
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
 * Decidir um item, confirmar todos e marcar a ação feita escrevem o item e a
 * próxima ação dele (H5a). As três abrem uma transação, travam a reunião e
 * depois o resumo (SELECT ... FOR UPDATE, a ordem da fila do resumo) e só então
 * escrevem; decidir e marcar travam também o item, depois dos dois, porque o
 * estado dele decide o Desfazer (H4f). É a trava da reunião que faz a exclusão, que marca 'deleted' antes
 * de soltar as ações, esperar a decisão: sem ela, a ação gravada depois da
 * soltura guardaria a reunião, o item e o trecho de uma reunião apagada.
 *
 * O dublê dá à transação um executor próprio: cada operação registra a tabela,
 * se travou a linha e se passou pela transação com ela ainda aberta. A espera
 * de verdade, com duas conexões, está em proximas-acoes.integracao.test.ts.
 */
describe("decidir no resumo trava a reunião e o resumo numa transação, antes de escrever (H5a)", () => {
  type Operacao = { tipo: "select" | "insert" | "update" | "delete"; tabela: string; travada: boolean; naTransacao: boolean };
  const registro = { operacoes: [] as Operacao[], transacoes: 0, aberta: false, statusDoResumo: "ready" };

  // Uma linha por tabela, com todas as colunas que as três leem: cada leitura usa as dela.
  const ITEM_DA_IA = {
    id: "item-1", section: "action", summaryId: "resumo-1", meetingId: "reuniao-1", subject: null, text: "{F2} envia a proposta",
    assignee: "{F2}", due: null, excerpt: "eu mando a proposta", status: "confirmed", done: false, doneAt: null,
    origin: "ai", editedAt: null, statusBeforeIgnore: null, doneAtBeforeIgnore: null,
  };
  let ITEM: Record<string, unknown> = ITEM_DA_IA;
  const linhasDe = (tabela: string): Record<string, unknown>[] => {
    if (tabela === "meeting_summary_items") return [ITEM];
    if (tabela === "meetings") return [{ status: "ready" }];
    if (tabela === "meeting_summaries") {
      return [{ id: "resumo-1", status: registro.statusDoResumo, lockedUntil: null, lockToken: null, emoji: null, language: null, lastError: null }];
    }
    return [];
  };

  /** O banco (`daTransacao` false) ou o executor que a transação entrega (true). */
  function executor(daTransacao: boolean) {
    const anotar = (tipo: Operacao["tipo"], tabela: unknown): Operacao => {
      const operacao = { tipo, tabela: getTableName(tabela as Table), travada: false, naTransacao: daTransacao && registro.aberta };
      registro.operacoes.push(operacao);
      return operacao;
    };
    const escrever = (tipo: Operacao["tipo"], tabela: unknown) => {
      anotar(tipo, tabela);
      return [{ affectedRows: 1 }];
    };
    const selecionar = () => ({
      from: (tabela: unknown) => {
        const operacao = anotar("select", tabela);
        const cadeia: Record<string, unknown> = {};
        Object.assign(cadeia, {
          innerJoin: () => cadeia,
          leftJoin: () => cadeia,
          where: () => cadeia,
          orderBy: () => cadeia,
          limit: () => cadeia,
          for: (modo: string) => { operacao.travada = modo === "update"; return cadeia; },
          then: (ok: (valor: unknown) => unknown, falha?: (erro: unknown) => unknown) => Promise.resolve(linhasDe(operacao.tabela)).then(ok, falha),
        });
        return cadeia;
      },
    });
    return {
      select: selecionar,
      selectDistinct: selecionar,
      insert: (tabela: unknown) => ({
        values: () => ({
          onDuplicateKeyUpdate: async () => escrever("insert", tabela),
          then: (ok: (valor: unknown) => unknown, falha?: (erro: unknown) => unknown) => Promise.resolve().then(() => escrever("insert", tabela)).then(ok, falha),
        }),
      }),
      // O item guarda o que a decisão gravou: quem lê depois (criarDoItem) vê o estado novo.
      update: (tabela: unknown) => ({ set: (valores: Record<string, unknown>) => ({ where: async () => {
        if (getTableName(tabela as Table) === "meeting_summary_items") ITEM = { ...ITEM, ...valores };
        return escrever("update", tabela);
      } }) }),
      delete: (tabela: unknown) => ({ where: async () => escrever("delete", tabela) }),
    };
  }

  const banco = {
    ...executor(false),
    transaction: async <T>(trabalho: (tx: ReturnType<typeof executor>) => Promise<T>): Promise<T> => {
      registro.transacoes += 1;
      registro.aberta = true;
      try {
        return await trabalho(executor(true));
      } finally {
        registro.aberta = false;
      }
    },
  };

  const recomecar = () => Object.assign(registro, { operacoes: [], transacoes: 0, aberta: false });

  beforeEach(() => {
    recomecar();
    registro.statusDoResumo = "ready";
    ITEM = ITEM_DA_IA;
    estado.banco = banco;
  });

  const ATE_O_ITEM = ["meetings", "meeting_summaries", "meeting_summary_items"];

  /**
   * Uma transação só, e tudo por ela, aberta; travadas, a reunião e depois o
   * resumo (e o item, em quem decide sobre ele); nenhuma escrita antes das
   * travas. Devolve as escritas, na ordem.
   */
  function conferirAsTravas(travas: string[] = ["meetings", "meeting_summaries"]): string[] {
    expect(registro.transacoes).toBe(1);
    expect(registro.operacoes.filter(operacao => !operacao.naTransacao)).toEqual([]);
    expect(registro.operacoes.filter(operacao => operacao.travada).map(operacao => operacao.tabela)).toEqual(travas);
    const ultimaTrava = registro.operacoes.map(operacao => operacao.travada).lastIndexOf(true);
    const escritas = registro.operacoes.filter(operacao => operacao.tipo !== "select");
    if (escritas.length) expect(registro.operacoes.indexOf(escritas[0])).toBeGreaterThan(ultimaTrava);
    return escritas.map(operacao => `${operacao.tipo} ${operacao.tabela}`);
  }

  it("confirmar o item: a próxima ação nasce na mesma transação, depois das travas", async () => {
    await expect(decidirItemDoResumo("dona-1", "item-1", "confirmed")).resolves.toEqual({ acaoSaiu: false });
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
  });

  it.each(["ignored", "pending"] as const)("desconfirmar (%s): a próxima ação sai na mesma transação, depois das travas", async status => {
    await decidirItemDoResumo("dona-1", "item-1", status);
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "delete proximas_acoes"]);
  });

  // Depois da junção com a H4f: quem decide a ação é o estado gravado, não o
  // pedido. O item que a dona escreveu, pedido de volta a "para conferir",
  // fica confirmado (estadoDaDecisao); apagar a ação dele deixaria o item
  // confirmado sem ação, e a leitura seguinte criaria outra, em branco.
  it.each([
    ["acrescentado à mão", { origin: "owner", editedAt: null }],
    ["da IA, editado", { origin: "ai", editedAt: 500 }],
  ])("o item da dona (%s) pedido de volta a pendente fica confirmado: a ação fica, e nada sai da Google", async (_nome, quem) => {
    ITEM = { ...ITEM_DA_IA, ...quem };
    await expect(decidirItemDoResumo("dona-1", "item-1", "pending")).resolves.toEqual({ acaoSaiu: false });
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
  });

  it("o Desfazer do ignorado que volta confirmado recria a ação; o que volta pendente não", async () => {
    ITEM = { ...ITEM_DA_IA, status: "ignored", statusBeforeIgnore: "confirmed" };
    await expect(decidirItemDoResumo("dona-1", "item-1", "pending")).resolves.toEqual({ acaoSaiu: false });
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
    recomecar();
    ITEM = { ...ITEM_DA_IA, status: "ignored", statusBeforeIgnore: "pending" };
    await decidirItemDoResumo("dona-1", "item-1", "pending");
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "delete proximas_acoes"]);
  });

  it("confirmar todos: os itens e as ações que faltam, na mesma transação, depois das travas", async () => {
    await confirmarItensDoResumo("dona-1", "reuniao-1");
    expect(conferirAsTravas()).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
  });

  it("marcar a ação feita confirma o item, cria a ação e marca as duas; desmarcar só desmarca; tudo depois das travas", async () => {
    await marcarAcaoFeita("dona-1", "item-1", true);
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "insert proximas_acoes", "update meeting_summary_items", "update proximas_acoes"]);
    recomecar();
    await marcarAcaoFeita("dona-1", "item-1", false);
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "update proximas_acoes"]);
  });

  // O refazer que falhou (H4d): a versão anterior segue valendo, e a dona
  // decide sobre ela; as ações nascem como no resumo pronto.
  it("o refazer que falhou aceita as três, com as ações", async () => {
    registro.statusDoResumo = "failed";
    await decidirItemDoResumo("dona-1", "item-1", "confirmed");
    expect(conferirAsTravas(ATE_O_ITEM)).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
    recomecar();
    await confirmarItensDoResumo("dona-1", "reuniao-1");
    expect(conferirAsTravas()).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
    recomecar();
    await marcarAcaoFeita("dona-1", "item-1", true);
    expect(conferirAsTravas(ATE_O_ITEM)).toContain("insert proximas_acoes");
  });

  it("o resumo sendo refeito recusa as três depois das travas, sem escrever nada", async () => {
    registro.statusDoResumo = "pending";
    const decisoes = [
      () => decidirItemDoResumo("dona-1", "item-1", "confirmed"),
      () => confirmarItensDoResumo("dona-1", "reuniao-1"),
      () => marcarAcaoFeita("dona-1", "item-1", true),
    ];
    for (const decidir of decisoes) {
      recomecar();
      await expect(decidir()).rejects.toMatchObject({ code: "CONFLICT" });
      expect(conferirAsTravas()).toEqual([]);
    }
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

/**
 * "Ouvir o resumo" (H19) lê com a voz do aparelho no idioma em que a IA
 * escreveu o resumo: o idioma vai à dona e também ao link aberto.
 */
describe("o idioma do resumo vai à tela, pela dona e pelo link", () => {
  it("pronto: o idioma gravado vai junto, nas duas leituras", async () => {
    estado.resumo = { id: "resumo-1", status: "ready", lockedUntil: null, lockToken: null, emoji: "☕", language: "en", lastError: null };
    await expect(resumoGuardadoPeloLink("t".repeat(32))).resolves.toEqual({ estado: "pronto", emoji: "☕", idioma: "en", versaoAnterior: false, itens: [] });
    await expect(resumoGuardadoDaDona("dona-1", ID)).resolves.toMatchObject({ estado: "pronto", idioma: "en" });
  });

  it("sem resumo, o idioma é null (a tela nem mostra o botão de ouvir)", async () => {
    await expect(resumoGuardadoPeloLink("t".repeat(32))).resolves.toEqual({ estado: "sem_resumo", emoji: null, idioma: null, versaoAnterior: false, itens: [] });
  });
});
