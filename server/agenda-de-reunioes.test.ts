import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O serviço da agenda (H16a, server/agenda-de-reunioes.ts) contra um banco
 * dublado que NÃO executa o WHERE: ele é renderizado pelo dialeto do MySQL, e o
 * teste confere o SQL e os parâmetros. Assim se prova que toda leitura e toda
 * escrita leva a dona (`and`, nunca `or`), que zero linhas vira NOT_FOUND, que
 * a chave repetida vira CONFLICT e que banco fora do ar sobe como erro.
 */

type Operacao = { tipo: "select" | "insert" | "update" | "delete"; tabela: unknown; sql: string; params: unknown[]; juncao?: { sql: string; params: unknown[] }; valores?: Record<string, unknown>; ordem?: unknown; limite?: number };

const estado = vi.hoisted(() => ({
  operacoes: [] as Array<Record<string, unknown>>,
  linhasPorTabela: new Map<unknown, Array<Record<string, unknown>>[]>(),
  afetadas: 1,
  erroNoUpdate: null as unknown,
  erroNoSelect: null as unknown,
  transacoes: 0,
}));

// O lembrete no sino (H15) é dublê aqui: o que se prova é que a agenda o chama
// na mesma transação da escrita. A regra das horas está em server/lembretes.test.ts.
const lembretes = vi.hoisted(() => ({
  agendarLembreteDaAgenda: vi.fn(async () => {}),
  esquecerLembrete: vi.fn(async () => {}),
}));
vi.mock("./lembretes", () => lembretes);

vi.mock("./db", async () => {
  const { MySqlDialect: Dialeto } = await import("drizzle-orm/mysql-core");
  const d = new Dialeto();
  const render = (condicao?: SQL) => {
    const { sql, params } = condicao ? d.sqlToQuery(condicao) : { sql: "", params: [] as unknown[] };
    return { sql, params };
  };
  // Cada select tira da fila da tabela a próxima resposta; sem fila, nada.
  const proxima = (tabela: unknown) => estado.linhasPorTabela.get(tabela)?.shift() ?? [];
  const db = {
    select: (_colunas?: unknown) => ({
      from: (tabela: unknown) => {
        const operacao: Record<string, unknown> = { tipo: "select", tabela };
        const consulta = {
          leftJoin: (_alvo: unknown, condicao: SQL) => { operacao.juncao = render(condicao); return consulta; },
          where: (condicao?: SQL) => {
            if (estado.erroNoSelect) throw estado.erroNoSelect;
            Object.assign(operacao, render(condicao));
            estado.operacoes.push(operacao);
            const linhas = proxima(tabela);
            const fim = {
              orderBy: (ordem: unknown) => { operacao.ordem = ordem; return fim; },
              limit: async (n: number) => { operacao.limite = n; return linhas; },
              then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(linhas).then(ok, falha),
            };
            return fim;
          },
        };
        return consulta;
      },
    }),
    insert: (tabela: unknown) => ({
      values: async (valores: Record<string, unknown>) => { estado.operacoes.push({ tipo: "insert", tabela, valores, sql: "", params: [] }); },
    }),
    update: (tabela: unknown) => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (condicao?: SQL) => {
          estado.operacoes.push({ tipo: "update", tabela, valores, ...render(condicao) });
          if (estado.erroNoUpdate) throw estado.erroNoUpdate;
          return [{ affectedRows: estado.afetadas }];
        },
      }),
    }),
    delete: (tabela: unknown) => ({
      where: async (condicao?: SQL) => {
        estado.operacoes.push({ tipo: "delete", tabela, ...render(condicao) });
        return [{ affectedRows: estado.afetadas }];
      },
    }),
    // A transação entrega o próprio dublê: as escritas dela se registram como as outras.
    transaction: async (trabalho: (tx: unknown) => Promise<unknown>) => {
      estado.transacoes += 1;
      return trabalho(db);
    },
  };
  return { getDb: async () => db, exigirDb: async () => db };
});

const schema = await import("../drizzle/schema");
const servico = await import("./agenda-de-reunioes");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const REUNIAO = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const dados = {
  titulo: "Reunião com a Bia", inicioEm: Date.UTC(2026, 10, 20, 17, 0), duracaoMinutos: 90, fuso: "America/Sao_Paulo",
  local: null, participantes: [{ nome: "Ana", email: "ana@exemplo.com" }], lembreteMinutos: 15,
};
const operacoes = () => estado.operacoes as unknown as Operacao[];
const daTabela = (tabela: unknown, tipo?: Operacao["tipo"]) => operacoes().filter(o => o.tabela === tabela && (!tipo || o.tipo === tipo));
const fila = (tabela: unknown, ...respostas: Array<Array<Record<string, unknown>>>) => estado.linhasPorTabela.set(tabela, respostas);

const JUNCAO_ESPERADA = {
  sql: "(`meetings`.`id` = `agenda_reunioes`.`meeting_id` and `meetings`.`owner_id` = `agenda_reunioes`.`owner_id` and `meetings`.`status` <> ?)",
  params: ["deleted"],
};
const linhaDoBanco = (extra: Record<string, unknown> = {}) => ({
  id: ID, titulo: "Reunião com a Bia", inicioEm: dados.inicioEm, duracaoMinutos: 90, fuso: "America/Sao_Paulo", local: null,
  participantes: [{ nome: "Ana", email: "ana@exemplo.com" }], lembreteMinutos: 15, createdAt: 1, updatedAt: 2,
  gravacaoId: null, gravacaoStatus: null, ...extra,
});

beforeEach(() => {
  estado.operacoes.length = 0;
  estado.linhasPorTabela.clear();
  estado.afetadas = 1;
  estado.erroNoUpdate = null;
  estado.erroNoSelect = null;
  estado.transacoes = 0;
  lembretes.agendarLembreteDaAgenda.mockClear();
  lembretes.esquecerLembrete.mockClear();
});

describe("listarAgendaDaDona", () => {
  it("duas leituras, as duas com a dona no WHERE e a gravação só da dona e não excluída; próximas pelo fim depois de agora, em ordem crescente", async () => {
    fila(schema.agendaReunioes, [linhaDoBanco()], []);
    const agora = Date.UTC(2026, 10, 16, 12, 0);
    const agenda = await servico.listarAgendaDaDona("dona-1", agora);
    const [proximas, anteriores] = daTabela(schema.agendaReunioes, "select");
    expect(proximas.sql).toBe("(`agenda_reunioes`.`owner_id` = ? and (`agenda_reunioes`.`inicio_em` + `agenda_reunioes`.`duracao_minutos` * 60000) >= ?)");
    expect(proximas.params).toEqual(["dona-1", agora]);
    expect(proximas.juncao).toEqual(JUNCAO_ESPERADA);
    expect(proximas.limite).toBe(servico.PROXIMAS_NO_MAXIMO);
    expect(anteriores.sql).toBe("(`agenda_reunioes`.`owner_id` = ? and (`agenda_reunioes`.`inicio_em` + `agenda_reunioes`.`duracao_minutos` * 60000) < ?)");
    expect(anteriores.params).toEqual(["dona-1", agora]);
    expect(anteriores.juncao).toEqual(JUNCAO_ESPERADA);
    expect(anteriores.limite).toBe(servico.ANTERIORES_NO_MAXIMO);
    expect(agenda.proximas).toEqual([expect.objectContaining({ id: ID, participantes: [{ nome: "Ana", email: "ana@exemplo.com" }], gravacao: null })]);
    expect(agenda.anteriores).toEqual([]);
  });

  it("a gravação ligada vem com o estado; o ponteiro solto (a junção não achou) vem como sem gravação", async () => {
    fila(schema.agendaReunioes, [linhaDoBanco({ gravacaoId: REUNIAO, gravacaoStatus: "ready" }), linhaDoBanco({ id: "outra", gravacaoId: null, gravacaoStatus: null })], []);
    const agenda = await servico.listarAgendaDaDona("dona-1");
    expect(agenda.proximas[0].gravacao).toEqual({ id: REUNIAO, status: "ready" });
    expect(agenda.proximas[1].gravacao).toBeNull();
    // Os campos internos da junção não vão à tela.
    expect(agenda.proximas[0]).not.toHaveProperty("gravacaoId");
    expect(agenda.proximas[0]).not.toHaveProperty("meetingId");
  });

  it("os participantes chegam como texto no MariaDB ou com lixo: só passa o que tem a forma certa", async () => {
    fila(schema.agendaReunioes, [linhaDoBanco({ participantes: [{ nome: "Ana", email: null }, { nome: "", email: "" }, null, "x", { nome: 3, email: "bia@exemplo.com" }] }), linhaDoBanco({ participantes: null })], []);
    const agenda = await servico.listarAgendaDaDona("dona-1");
    expect(agenda.proximas[0].participantes).toEqual([{ nome: "Ana", email: null }, { nome: null, email: "bia@exemplo.com" }]);
    expect(agenda.proximas[1].participantes).toEqual([]);
  });

  it("banco fora do ar é erro, nunca agenda vazia", async () => {
    estado.erroNoSelect = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    await expect(servico.listarAgendaDaDona("dona-1")).rejects.toThrow("Failed query");
  });
});

describe("obterDaAgenda", () => {
  it("lê pela id E pela dona; sem linha, NOT_FOUND", async () => {
    fila(schema.agendaReunioes, [linhaDoBanco()], []);
    expect(await servico.obterDaAgenda("dona-1", ID)).toMatchObject({ id: ID, titulo: "Reunião com a Bia" });
    const [leitura] = daTabela(schema.agendaReunioes, "select");
    expect({ sql: leitura.sql, params: leitura.params }).toEqual({ sql: "(`agenda_reunioes`.`id` = ? and `agenda_reunioes`.`owner_id` = ?)", params: [ID, "dona-1"] });
    expect(leitura.juncao).toEqual(JUNCAO_ESPERADA);
    await expect(servico.obterDaAgenda("dona-2", ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("criarNaAgenda", () => {
  it("conta só as da dona, grava com a dona, sem gravação, e devolve a id nova", async () => {
    fila(schema.agendaReunioes, [{ total: 3 }]);
    const { id } = await servico.criarNaAgenda("dona-1", dados);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const [contagem] = daTabela(schema.agendaReunioes, "select");
    expect({ sql: contagem.sql, params: contagem.params }).toEqual({ sql: "`agenda_reunioes`.`owner_id` = ?", params: ["dona-1"] });
    const [insercao] = daTabela(schema.agendaReunioes, "insert");
    expect(insercao.valores).toMatchObject({ ...dados, id, ownerId: "dona-1", meetingId: null });
    expect(typeof insercao.valores!.createdAt).toBe("number");
  });

  it("no teto, recusa sem gravar (PRECONDITION_FAILED)", async () => {
    fila(schema.agendaReunioes, [{ total: servico.AGENDA_MAXIMO_POR_DONA }]);
    await expect(servico.criarNaAgenda("dona-1", dados)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(daTabela(schema.agendaReunioes, "insert")).toHaveLength(0);
  });
});

describe("atualizarNaAgenda e excluirDaAgenda", () => {
  it("mudam só a da dona (id E owner_id); zero linhas é NOT_FOUND", async () => {
    await servico.atualizarNaAgenda("dona-1", ID, dados);
    await servico.excluirDaAgenda("dona-1", ID);
    const esperado = { sql: "(`agenda_reunioes`.`id` = ? and `agenda_reunioes`.`owner_id` = ?)", params: [ID, "dona-1"] };
    const [atualizacao] = daTabela(schema.agendaReunioes, "update");
    expect({ sql: atualizacao.sql, params: atualizacao.params }).toEqual(esperado);
    // A gravação ligada não muda ao editar.
    expect(atualizacao.valores).not.toHaveProperty("meetingId");
    const [exclusao] = daTabela(schema.agendaReunioes, "delete");
    expect({ sql: exclusao.sql, params: exclusao.params }).toEqual(esperado);
    estado.afetadas = 0;
    await expect(servico.atualizarNaAgenda("dona-2", ID, dados)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.excluirDaAgenda("dona-2", ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("o lembrete no sino (H15) anda com a reunião da agenda", () => {
  it("marcar agenda o lembrete na transação da inserção, com a hora, a duração e os minutos do lembrete", async () => {
    fila(schema.agendaReunioes, [{ total: 0 }]);
    const { exigirDb } = await import("./db");
    const banco = await exigirDb();
    lembretes.agendarLembreteDaAgenda.mockImplementationOnce(async () => { estado.operacoes.push({ tipo: "lembrete" }); });
    const { id } = await servico.criarNaAgenda("dona-1", dados);
    expect(estado.transacoes).toBe(1);
    expect(lembretes.agendarLembreteDaAgenda).toHaveBeenCalledTimes(1);
    expect(lembretes.agendarLembreteDaAgenda).toHaveBeenCalledWith(banco, "dona-1", id, dados, expect.any(Number));
    // A contagem, a reunião e depois o lembrete, que a lê pela id nova.
    expect(estado.operacoes.map(operacao => operacao.tipo)).toEqual(["select", "insert", "lembrete"]);
  });

  it("no teto, nem a reunião nem o lembrete", async () => {
    fila(schema.agendaReunioes, [{ total: servico.AGENDA_MAXIMO_POR_DONA }]);
    await expect(servico.criarNaAgenda("dona-1", dados)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(lembretes.agendarLembreteDaAgenda).not.toHaveBeenCalled();
  });

  it("mudar reagenda com o que a dona escreveu agora; a de outra dona (zero linhas) não toca no lembrete", async () => {
    const mudada = { ...dados, inicioEm: dados.inicioEm + 3_600_000, lembreteMinutos: 60 };
    await servico.atualizarNaAgenda("dona-1", ID, mudada);
    expect(estado.transacoes).toBe(1);
    expect(lembretes.agendarLembreteDaAgenda).toHaveBeenCalledWith(expect.anything(), "dona-1", ID, mudada, expect.any(Number));
    lembretes.agendarLembreteDaAgenda.mockClear();
    estado.afetadas = 0;
    await expect(servico.atualizarNaAgenda("dona-2", ID, mudada)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(lembretes.agendarLembreteDaAgenda).not.toHaveBeenCalled();
  });

  it("tirar da agenda esquece o lembrete e os avisos dela, na transação da exclusão; a de outra dona, não", async () => {
    await servico.excluirDaAgenda("dona-1", ID);
    expect(estado.transacoes).toBe(1);
    expect(lembretes.esquecerLembrete).toHaveBeenCalledWith(expect.anything(), "dona-1", "agenda", ID);
    lembretes.esquecerLembrete.mockClear();
    estado.afetadas = 0;
    await expect(servico.excluirDaAgenda("dona-2", ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(lembretes.esquecerLembrete).not.toHaveBeenCalled();
  });

  it("ligar a gravação (o \"Gravar agora\") não mexe no lembrete", async () => {
    fila(schema.meetings, [{ id: REUNIAO }]);
    await servico.ligarGravacaoNaAgenda("dona-1", ID, REUNIAO);
    expect(lembretes.agendarLembreteDaAgenda).not.toHaveBeenCalled();
    expect(lembretes.esquecerLembrete).not.toHaveBeenCalled();
  });
});

describe("ligarGravacaoNaAgenda", () => {
  it("confere a gravação da dona, não excluída, e liga com id E owner_id", async () => {
    fila(schema.meetings, [{ id: REUNIAO }]);
    await servico.ligarGravacaoNaAgenda("dona-1", ID, REUNIAO);
    const [leitura] = daTabela(schema.meetings, "select");
    expect({ sql: leitura.sql, params: leitura.params }).toEqual({
      sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ? and `meetings`.`status` <> ?)", params: [REUNIAO, "dona-1", "deleted"],
    });
    const [ligacao] = daTabela(schema.agendaReunioes, "update");
    expect(ligacao.valores).toMatchObject({ meetingId: REUNIAO });
    expect({ sql: ligacao.sql, params: ligacao.params }).toEqual({ sql: "(`agenda_reunioes`.`id` = ? and `agenda_reunioes`.`owner_id` = ?)", params: [ID, "dona-1"] });
  });

  it("gravação de outra dona (ou excluída): NOT_FOUND, e a agenda não muda", async () => {
    fila(schema.meetings, []);
    await expect(servico.ligarGravacaoNaAgenda("dona-1", ID, REUNIAO)).rejects.toMatchObject({ code: "NOT_FOUND", message: servico.MENSAGEM_GRAVACAO_NAO_ENCONTRADA });
    expect(daTabela(schema.agendaReunioes, "update")).toHaveLength(0);
  });

  it("reunião da agenda que não é da dona: NOT_FOUND", async () => {
    fila(schema.meetings, [{ id: REUNIAO }]);
    estado.afetadas = 0;
    await expect(servico.ligarGravacaoNaAgenda("dona-1", ID, REUNIAO)).rejects.toMatchObject({ code: "NOT_FOUND", message: servico.MENSAGEM_AGENDADA_NAO_ENCONTRADA });
  });

  it("a mesma gravação em outra reunião da agenda: o índice único recusa, e sai CONFLICT", async () => {
    fila(schema.meetings, [{ id: REUNIAO }]);
    estado.erroNoUpdate = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 }) });
    await expect(servico.ligarGravacaoNaAgenda("dona-1", ID, REUNIAO)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("outro erro do banco sobe como veio (banco fora do ar é erro)", async () => {
    fila(schema.meetings, [{ id: REUNIAO }]);
    estado.erroNoUpdate = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    await expect(servico.ligarGravacaoNaAgenda("dona-1", ID, REUNIAO)).rejects.toThrow("Failed query");
  });
});

describe("soltarGravacaoDaAgenda", () => {
  it("volta o ponteiro a nulo só na agenda da dona e só para aquela gravação", async () => {
    const { exigirDb } = await import("./db");
    await servico.soltarGravacaoDaAgenda(await exigirDb(), "dona-1", REUNIAO);
    const [soltura] = daTabela(schema.agendaReunioes, "update");
    expect(soltura.valores).toMatchObject({ meetingId: null });
    expect({ sql: soltura.sql, params: soltura.params }).toEqual({ sql: "(`agenda_reunioes`.`owner_id` = ? and `agenda_reunioes`.`meeting_id` = ?)", params: ["dona-1", REUNIAO] });
    expect(daTabela(schema.agendaReunioes, "delete")).toHaveLength(0);
  });
});

