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
  resumo: undefined as undefined | { id: string; status: string; lockedUntil: number | null; lockToken: string | null; emoji: null; language: null; lastError: null },
  erroNoInsert: null as unknown,
  linhasNoUpdate: 1,
  /** O dublê de um bloco que precisa de outro banco (as travas da decisão, no fim do arquivo). */
  banco: null as unknown,
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
      insert: () => ({ values: async () => { if (estado.erroNoInsert) throw estado.erroNoInsert; } }),
      update: () => ({ set: () => ({ where: async () => [{ affectedRows: estado.linhasNoUpdate }] }) }),
    }),
  };
});

const { confirmarItensDoResumo, decidirItemDoResumo, marcarAcaoFeita, pedirResumoDaDona } = await import("./resumo-guardado");
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
  Object.assign(estado, { resumo: undefined, erroNoInsert: null, linhasNoUpdate: 1, banco: null });
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
 * escrevem. É a trava da reunião que faz a exclusão, que marca 'deleted' antes
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
  const ITEM = {
    id: "item-1", section: "action", summaryId: "resumo-1", meetingId: "reuniao-1", subject: null, text: "{F2} envia a proposta",
    assignee: "{F2}", due: null, excerpt: "eu mando a proposta", status: "confirmed", done: false, doneAt: null,
  };
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
      update: (tabela: unknown) => ({ set: () => ({ where: async () => escrever("update", tabela) }) }),
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
    estado.banco = banco;
  });

  /**
   * Uma transação só, e tudo por ela, aberta; travadas, a reunião e depois o
   * resumo; nenhuma escrita antes das duas travas. Devolve as escritas, na ordem.
   */
  function conferirAsTravas(): string[] {
    expect(registro.transacoes).toBe(1);
    expect(registro.operacoes.filter(operacao => !operacao.naTransacao)).toEqual([]);
    expect(registro.operacoes.filter(operacao => operacao.travada).map(operacao => operacao.tabela)).toEqual(["meetings", "meeting_summaries"]);
    const ultimaTrava = registro.operacoes.map(operacao => operacao.travada).lastIndexOf(true);
    const escritas = registro.operacoes.filter(operacao => operacao.tipo !== "select");
    if (escritas.length) expect(registro.operacoes.indexOf(escritas[0])).toBeGreaterThan(ultimaTrava);
    return escritas.map(operacao => `${operacao.tipo} ${operacao.tabela}`);
  }

  it("confirmar o item: a próxima ação nasce na mesma transação, depois das travas", async () => {
    await decidirItemDoResumo("dona-1", "item-1", "confirmed");
    expect(conferirAsTravas()).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
  });

  it.each(["ignored", "pending"] as const)("desconfirmar (%s): a próxima ação sai na mesma transação, depois das travas", async status => {
    await decidirItemDoResumo("dona-1", "item-1", status);
    expect(conferirAsTravas()).toEqual(["update meeting_summary_items", "delete proximas_acoes"]);
  });

  it("confirmar todos: os itens e as ações que faltam, na mesma transação, depois das travas", async () => {
    await confirmarItensDoResumo("dona-1", "reuniao-1");
    expect(conferirAsTravas()).toEqual(["update meeting_summary_items", "insert proximas_acoes"]);
  });

  it("marcar a ação feita confirma o item, cria a ação e marca as duas; desmarcar só desmarca; tudo depois das travas", async () => {
    await marcarAcaoFeita("dona-1", "item-1", true);
    expect(conferirAsTravas()).toEqual(["update meeting_summary_items", "insert proximas_acoes", "update meeting_summary_items", "update proximas_acoes"]);
    recomecar();
    await marcarAcaoFeita("dona-1", "item-1", false);
    expect(conferirAsTravas()).toEqual(["update meeting_summary_items", "update proximas_acoes"]);
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
