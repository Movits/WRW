import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.reprocess e as travas vizinhas, no router. O serviço é dublado; o
 * que ele faz está em reuniao-reprocessar.test.ts. Aqui se prova:
 *
 * - a rota devolve { status: 'processing' } sem esperar o trabalho, com o
 *   openId da dona, e grava auditoria sem conteúdo de reunião;
 * - as recusas do serviço chegam com o código que a tela traduz;
 * - o teto de 3 pedidos aceitos a cada 10 minutos por dona, sem contar recusas;
 * - submitRecording numa reunião que já recebeu áudio dá CONFLICT;
 * - decidir sobre sugestão ou entidade com a reunião em 'processing' dá
 *   CONFLICT, sem criar contato nem atualizar nada;
 * - a sugestão de contato só é decidida UMA vez: a tomada leva status
 *   'pending' no WHERE, e o duplo clique ou a aba velha dão CONFLICT sem
 *   duplicar o contato nem mexer nas pendências do Meu Network Inteligente;
 * - "Criar contato" grava só o Quem Sou: cargo e empresa da IA viram
 *   pendências do contato novo (achado 6 da bancada de 16/11);
 * - a decisão é uma transação só (revisão do pacote P2B): falha depois da
 *   tomada desfaz a tomada, o contato e as pendências. O banco falso desfaz
 *   só o que a própria transação fez, como o MySQL; a prova com o banco de
 *   verdade está em reuniao-decidir-pessoa.integracao.test.ts.
 */

const iniciarReprocessamento = vi.fn();
const processMeetingRecording = vi.fn();
const createAuditLog = vi.fn(async () => {});
const createPrivateContact = vi.fn(async () => 99);

const banco = {
  entidade: null as Record<string, unknown> | null,
  sugestao: null as Record<string, unknown> | null,
  statusDaReuniao: "ready",
  // A transcrição da reunião da sugestão: cargo e empresa só viram pendência se ela os diz.
  transcricao: "Eu sou o Fernando Okada, da Ponte Sul Consultoria, e vim como mentor convidado.",
  // Recusa o INSERT das pendências (a conexão caiu depois do contato).
  falhaNasPendencias: null as Error | null,
  atualizacoes: [] as Array<{ tabela: unknown; valores: Record<string, unknown>; sql: string; params: unknown[] }>,
  leituras: [] as Array<{ tabela: unknown; sql: string; params: unknown[] }>,
  insercoes: [] as Array<{ tabela: unknown; valores: unknown }>,
};

// O UPDATE da sugestão obedece ao status do WHERE, como o MySQL: com
// `status = ?` e a sugestão em outro status, 0 linhas e nada muda.
const CONDICAO_DE_STATUS = "`meeting_contact_suggestions`.`status` = ?";
function atualizarSugestao(valores: Record<string, unknown>, sql: string, params: unknown[]) {
  if (!banco.sugestao) return 0;
  if (sql.includes(CONDICAO_DE_STATUS)) {
    const exigido = params[sql.slice(0, sql.indexOf(CONDICAO_DE_STATUS)).split("?").length - 1];
    if (banco.sugestao.status !== exigido) return 0;
  }
  if (sql.includes("`meeting_contact_suggestions`.`existing_contact_id` is null") && banco.sugestao.existingContactId != null) return 0;
  banco.sugestao = { ...banco.sugestao, ...valores };
  return 1;
}

const schema = await import("../drizzle/schema");
// O WHERE de cada leitura, renderizado pelo dialeto do MySQL: prova QUAL reunião
// a trava das decisões consultou (a da sugestão ou da entidade, e da dona).
const dialeto = new MySqlDialect();
// O que uma transação do banco falso fez, para o rollback desfazer só isso.
type FeitoNaTransacao = { registros: object[]; sugestaoAntes: Record<string, unknown> | null; mexeuNaSugestao: boolean };
function bancoFalso(transacao?: FeitoNaTransacao) {
  const falso = {
    select: () => ({ from: (tabela: unknown) => ({ where: (condicao?: SQL) => {
      const { sql, params } = condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] as unknown[] };
      banco.leituras.push({ tabela, sql, params });
      const linhas = tabela === schema.meetingEntities ? (banco.entidade ? [banco.entidade] : [])
        : tabela === schema.meetingContactSuggestions ? (banco.sugestao ? [{ ...banco.sugestao }] : [])
          : tabela === schema.meetings ? [{ status: banco.statusDaReuniao }]
            : tabela === schema.meetingTranscripts ? [{ texto: banco.transcricao }]
              : [];
      // Lida com `.limit` ou direto (as pendências abertas do contato, em gravarPendencias).
      return Object.assign(Promise.resolve(linhas), { limit: async () => linhas });
    } }) }),
    update: (tabela: unknown) => ({ set: (valores: Record<string, unknown>) => ({ where: async (condicao?: SQL) => {
      const { sql, params } = condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] as unknown[] };
      const registro = { tabela, valores, sql, params };
      banco.atualizacoes.push(registro);
      transacao?.registros.push(registro);
      if (tabela !== schema.meetingContactSuggestions) return [{ affectedRows: 1 }];
      const antes = banco.sugestao ? { ...banco.sugestao } : null;
      const affectedRows = atualizarSugestao(valores, sql, params);
      if (affectedRows && transacao && !transacao.mexeuNaSugestao) Object.assign(transacao, { mexeuNaSugestao: true, sugestaoAntes: antes });
      return [{ affectedRows }];
    } }) }),
    insert: (tabela: unknown) => ({ values: async (valores: unknown) => {
      if (tabela === schema.networkSugestoes && banco.falhaNasPendencias) throw banco.falhaNasPendencias;
      const registro = { tabela, valores };
      banco.insercoes.push(registro);
      transacao?.registros.push(registro);
      return [{ affectedRows: 1 }];
    } }),
    // Como o MySQL: o erro dentro da transação desfaz o que ELA fez, e só isso
    // (a outra requisição do duplo clique não é desfeita junto).
    transaction: async <T>(corpo: (tx: ReturnType<typeof bancoFalso>) => Promise<T>): Promise<T> => {
      const feito: FeitoNaTransacao = { registros: [], sugestaoAntes: null, mexeuNaSugestao: false };
      try {
        return await corpo(bancoFalso(feito));
      } catch (erro) {
        if (feito.mexeuNaSugestao) banco.sugestao = feito.sugestaoAntes;
        banco.atualizacoes = banco.atualizacoes.filter(registro => !feito.registros.includes(registro));
        banco.insercoes = banco.insercoes.filter(registro => !feito.registros.includes(registro));
        throw erro;
      }
    },
  };
  return falso;
}
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => bancoFalso(),
  createPrivateContact: (...args: unknown[]) => createPrivateContact(...(args as [])),
}));
vi.mock("./security", async importOriginal => ({
  ...await importOriginal<typeof import("./security")>(),
  createAuditLog: (...args: unknown[]) => createAuditLog(...(args as [])),
}));
vi.mock("./meeting-service", async importOriginal => ({
  ...await importOriginal<typeof import("./meeting-service")>(),
  iniciarReprocessamento: (...args: unknown[]) => iniciarReprocessamento(...(args as [])),
  processMeetingRecording: (...args: unknown[]) => processMeetingRecording(...(args as [])),
}));

const { meetingsRouter, esquecerTentativasDeReprocesso, MENSAGEM_REUNIAO_PROCESSANDO, MENSAGEM_SUGESTAO_JA_DECIDIDA } = await import("./routers/meetings");
const { ReprocessamentoRecusado, ReuniaoForaDoEstado, ReuniaoTomadaPorOutraExecucao } = await import("./meeting-service");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = "dona-1") => meetingsRouter.createCaller(contexto(openId));
// O trabalho em segundo plano nunca termina aqui: a rota não pode esperá-lo.
const aceito = () => ({ trabalho: new Promise<void>(() => {}) });
const leiturasDaReuniao = () => banco.leituras.filter(leitura => leitura.tabela === schema.meetings).map(({ sql, params }) => ({ sql, params }));
const REUNIAO_DA_DONA = (meetingId: string) => ({ sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ?)", params: [meetingId, "dona-1"] });

beforeEach(() => {
  esquecerTentativasDeReprocesso();
  iniciarReprocessamento.mockReset();
  iniciarReprocessamento.mockImplementation(async () => aceito());
  processMeetingRecording.mockReset();
  createAuditLog.mockClear();
  createPrivateContact.mockClear();
  banco.entidade = { meetingId: "reuniao-da-entidade" };
  banco.sugestao = { id: ID, meetingId: "reuniao-da-sugestao", status: "pending", existingContactId: null, fullName: "Ana Souza", jobTitle: null, company: null, phone: null, email: null };
  createPrivateContact.mockImplementation(async () => 99);
  banco.statusDaReuniao = "ready";
  banco.transcricao = "Eu sou o Fernando Okada, da Ponte Sul Consultoria, e vim como mentor convidado.";
  banco.falhaNasPendencias = null;
  banco.atualizacoes = [];
  banco.leituras = [];
  banco.insercoes = [];
});
afterEach(() => { vi.useRealTimers(); });

describe("meetings.reprocess — devolve logo e registra", () => {
  it("devolve { status: 'processing' } sem esperar o trabalho, pedindo pelo openId da dona", async () => {
    await expect(rota().reprocess({ meetingId: ID })).resolves.toEqual({ status: "processing" });
    expect(iniciarReprocessamento).toHaveBeenCalledWith("dona-1", ID);
  });

  it("auditoria com a ação e o id da reunião, sem nenhum conteúdo dela", async () => {
    await rota().reprocess({ meetingId: ID });
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog.mock.calls[0]).toEqual([{
      userId: 7, action: "MEETING_REPROCESS_REQUESTED", resource: "meetings", resourceId: ID, status: "success", riskLevel: "low",
    }]);
  });

  it("meetingId que não é uuid: BAD_REQUEST, sem chegar ao serviço", async () => {
    await expect(rota().reprocess({ meetingId: "reuniao-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(iniciarReprocessamento).not.toHaveBeenCalled();
  });

  it("não recebe arquivo: fica fora do parser de 15 MB", () => {
    const fonte = readFileSync(join(__dirname, "_core", "corpo-grande-para-uploads.ts"), "utf8");
    expect(fonte).not.toContain("meetings.reprocess");
  });
});

describe("meetings.reprocess — recusas com o código que a tela traduz", () => {
  it.each(["NOT_FOUND", "CONFLICT", "PRECONDITION_FAILED"] as const)("%s do serviço vira TRPCError com o mesmo código e a mesma frase, sem auditoria", async codigo => {
    iniciarReprocessamento.mockRejectedValue(new ReprocessamentoRecusado(codigo, `frase de ${codigo}`));
    await expect(rota().reprocess({ meetingId: ID })).rejects.toMatchObject({ code: codigo, message: `frase de ${codigo}` });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("qualquer outro erro sai como erro do servidor", async () => {
    iniciarReprocessamento.mockRejectedValue(new Error("falha inesperada"));
    await expect(rota().reprocess({ meetingId: ID })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

describe("meetings.reprocess — teto de 3 pedidos aceitos a cada 10 minutos por dona", () => {
  it("o 4º pedido dá TOO_MANY_REQUESTS sem chegar ao serviço; outra dona passa", async () => {
    for (let i = 0; i < 3; i++) await rota().reprocess({ meetingId: ID });
    await expect(rota().reprocess({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(iniciarReprocessamento).toHaveBeenCalledTimes(3);
    await expect(rota("outra-dona").reprocess({ meetingId: ID })).resolves.toEqual({ status: "processing" });
  });

  it("uma rajada simultânea (lote tRPC, várias abas) não fura o teto: só 3 pedidos chegam ao serviço", async () => {
    let liberar!: () => void;
    const portao = new Promise<void>(resolver => { liberar = resolver; });
    iniciarReprocessamento.mockImplementation(async () => { await portao; return aceito(); });

    const pedidos = Array.from({ length: 6 }, () =>
      rota().reprocess({ meetingId: ID }).then(() => "aceito", (erro: { code?: string }) => erro.code));
    // Todos os pedidos chegam ao ponto de espera antes de o serviço responder:
    // conferir e registrar depois do await deixaria os 6 passarem.
    await new Promise(resolver => setTimeout(resolver, 20));
    expect(iniciarReprocessamento).toHaveBeenCalledTimes(3);

    liberar();
    const resultados = await Promise.all(pedidos);
    expect(resultados.filter(resultado => resultado === "aceito")).toHaveLength(3);
    expect(resultados.filter(resultado => resultado === "TOO_MANY_REQUESTS")).toHaveLength(3);
  });

  it("erro inesperado do serviço também devolve a vaga", async () => {
    iniciarReprocessamento.mockRejectedValue(new Error("banco fora do ar"));
    for (let i = 0; i < 4; i++) await expect(rota().reprocess({ meetingId: ID })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    iniciarReprocessamento.mockImplementation(async () => aceito());
    await expect(rota().reprocess({ meetingId: ID })).resolves.toEqual({ status: "processing" });
  });

  it("recusas não contam", async () => {
    iniciarReprocessamento.mockRejectedValue(new ReprocessamentoRecusado("CONFLICT", "x"));
    for (let i = 0; i < 5; i++) await expect(rota().reprocess({ meetingId: ID })).rejects.toMatchObject({ code: "CONFLICT" });
    iniciarReprocessamento.mockImplementation(async () => aceito());
    await expect(rota().reprocess({ meetingId: ID })).resolves.toEqual({ status: "processing" });
  });

  it("passados 10 minutos, a janela libera", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
    for (let i = 0; i < 3; i++) await rota().reprocess({ meetingId: ID });
    await expect(rota().reprocess({ meetingId: ID })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    vi.setSystemTime(new Date("2026-09-14T12:10:00.001Z"));
    await expect(rota().reprocess({ meetingId: ID })).resolves.toEqual({ status: "processing" });
  });
});

describe("meetings.submitRecording — reunião que já recebeu áudio", () => {
  it.each([
    ["ReuniaoForaDoEstado", () => new ReuniaoForaDoEstado()],
    ["ReuniaoTomadaPorOutraExecucao", () => new ReuniaoTomadaPorOutraExecucao()],
  ])("%s vira CONFLICT com a frase do serviço", async (_nome, criar) => {
    const erro = criar();
    processMeetingRecording.mockRejectedValue(erro);
    await expect(rota().submitRecording({
      meetingId: ID, audioBase64: "A".repeat(40), mimeType: "audio/webm", durationSeconds: 30, language: "pt",
    })).rejects.toMatchObject({ code: "CONFLICT", message: erro.message });
  });
});

describe("decisões durante o reprocessamento", () => {
  it("criar contato de uma sugestão com a reunião em 'processing': CONFLICT, nenhum contato criado, nada atualizado", async () => {
    banco.statusDaReuniao = "processing";
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_REUNIAO_PROCESSANDO });
    expect(createPrivateContact).not.toHaveBeenCalled();
    expect(banco.atualizacoes).toEqual([]);
    // a reunião consultada é a DA sugestão, e da dona
    expect(leiturasDaReuniao()).toEqual([REUNIAO_DA_DONA("reuniao-da-sugestao")]);
  });

  it("com a reunião pronta, criar contato segue como antes", async () => {
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).resolves.toMatchObject({ success: true, contactId: 99 });
    expect(createPrivateContact).toHaveBeenCalledTimes(1);
  });

  it("decidir entidade com a reunião em 'processing': CONFLICT, sem UPDATE", async () => {
    banco.statusDaReuniao = "processing";
    await expect(rota().decideEntity({ entityId: ID, status: "confirmed" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(banco.atualizacoes).toEqual([]);
    // a reunião consultada é a DA entidade, e da dona
    expect(leiturasDaReuniao()).toEqual([REUNIAO_DA_DONA("reuniao-da-entidade")]);
  });

  it("entidade de outra dona ou inexistente: NOT_FOUND", async () => {
    banco.entidade = null;
    await expect(rota().decideEntity({ entityId: ID, status: "ignored" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(banco.atualizacoes).toEqual([]);
  });

  it("reunião com falha (tentativa parcial): decidir continua possível", async () => {
    banco.statusDaReuniao = "failed";
    await expect(rota().decideEntity({ entityId: ID, status: "confirmed" })).resolves.toEqual({ success: true });
    expect(banco.atualizacoes).toHaveLength(1);
  });
});

describe("meetings.decideContactSuggestion — uma decisão só por sugestão", () => {
  const atualizacoesDe = (tabela: unknown) => banco.atualizacoes.filter(atualizacao => atualizacao.tabela === tabela);

  it("criar: a sugestão é tomada com status 'pending' no WHERE, o contato nasce e as pendências da IA vão para ele", async () => {
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).resolves.toEqual({ success: true, contactId: 99 });
    const [tomada] = atualizacoesDe(schema.meetingContactSuggestions);
    expect(tomada.sql).toContain(CONDICAO_DE_STATUS);
    expect(tomada.params).toEqual([ID, "dona-1", "pending"]);
    expect(banco.sugestao).toMatchObject({ status: "created", existingContactId: 99 });
    expect(atualizacoesDe(schema.networkSugestoes).map(({ valores }) => valores.contactId)).toEqual([99]);
  });

  it.each(["create", "ignore"] as const)("sugestão já decidida (aba velha ou API): '%s' dá CONFLICT sem criar contato nem tocar nas pendências", async action => {
    banco.sugestao = { ...banco.sugestao!, status: "created", existingContactId: 42 };
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action }))
      .rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_SUGESTAO_JA_DECIDIDA });
    expect(createPrivateContact).not.toHaveBeenCalled();
    expect(banco.atualizacoes).toEqual([]);
    expect(banco.sugestao).toMatchObject({ status: "created", existingContactId: 42 });
  });

  it("duplo clique simultâneo em 'Criar contato': um só contato, a outra requisição dá CONFLICT e as pendências mudam uma vez", async () => {
    const resultados = await Promise.all([1, 2].map(() =>
      rota().decideContactSuggestion({ suggestionId: ID, action: "create" }).then(() => "ok", (erro: { code?: string }) => erro.code)));
    expect(resultados.sort()).toEqual(["CONFLICT", "ok"]);
    expect(createPrivateContact).toHaveBeenCalledTimes(1);
    expect(atualizacoesDe(schema.networkSugestoes)).toHaveLength(1);
    expect(banco.sugestao).toMatchObject({ status: "created", existingContactId: 99 });
  });

  it("'Ignorar' que chega depois de 'Criar contato' não ignora as pendências do contato criado", async () => {
    const [criar, ignorar] = await Promise.allSettled([
      rota().decideContactSuggestion({ suggestionId: ID, action: "create" }),
      rota().decideContactSuggestion({ suggestionId: ID, action: "ignore" }),
    ]);
    expect(criar.status).toBe("fulfilled");
    expect(ignorar).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    expect(atualizacoesDe(schema.networkSugestoes).map(({ valores }) => valores.status)).toEqual([undefined]);
    expect(banco.sugestao).toMatchObject({ status: "created", existingContactId: 99 });
  });

  it("contato não nasceu (erro no INSERT): a sugestão volta a pendente, o erro sobe e as pendências ficam como estavam", async () => {
    createPrivateContact.mockImplementation(async () => { throw new Error("falha no insert"); });
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(banco.sugestao).toMatchObject({ status: "pending", existingContactId: null });
    expect(atualizacoesDe(schema.networkSugestoes)).toEqual([]);
    // e dá para decidir de novo
    createPrivateContact.mockImplementation(async () => 99);
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).resolves.toMatchObject({ contactId: 99 });
  });

  it("vincular a contato que não é da dona: NOT_FOUND ANTES da tomada, a sugestão continua pendente", async () => {
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "link", contactId: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(banco.atualizacoes).toEqual([]);
    expect(banco.sugestao).toMatchObject({ status: "pending" });
  });

  // Achado 6 da bancada de 16/11: com um clique, "fundadora" e "Consultor" iam para o contato.
  it("criar: cargo e empresa da IA não vão para o contato — viram pendências dele, para a dona confirmar", async () => {
    banco.sugestao = { ...banco.sugestao!, fullName: "Fernando Okada", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria", email: "fernando@exemplo.invalid" };
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).resolves.toEqual({ success: true, contactId: 99 });
    // na transação da tomada
    expect(createPrivateContact).toHaveBeenCalledWith("dona-1", { fullName: "Fernando Okada", phone: null, email: "fernando@exemplo.invalid" }, expect.objectContaining({ transaction: expect.any(Function) }));
    const pendencias = banco.insercoes.filter(({ tabela }) => tabela === schema.networkSugestoes)
      .flatMap(({ valores }) => valores as Array<Record<string, unknown>>);
    expect(pendencias.map(p => [p.campo, p.valor, p.contactId, p.status, p.origem])).toEqual([
      ["cargo", "mentor convidado", 99, "pendente", "reuniao"],
      ["empresa", "Ponte Sul Consultoria", 99, "pendente", "reuniao"],
    ]);
  });

  // Revisão do pacote P2B: com um commit por passo, a sugestão ficava 'created'
  // e o contato sem cargo nem empresa, e a dona não podia repetir (CONFLICT).
  it("a gravação das pendências falhou depois do contato: tudo é desfeito e a sugestão volta a pendente, sem o contato", async () => {
    banco.sugestao = { ...banco.sugestao!, fullName: "Fernando Okada", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" };
    banco.falhaNasPendencias = new Error("conexão perdida");
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(createPrivateContact).toHaveBeenCalledTimes(1);
    expect(banco.sugestao).toMatchObject({ status: "pending", existingContactId: null });
    expect(atualizacoesDe(schema.networkSugestoes)).toEqual([]);
    // e dá para decidir de novo
    banco.falhaNasPendencias = null;
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).resolves.toEqual({ success: true, contactId: 99 });
    expect(banco.sugestao).toMatchObject({ status: "created", existingContactId: 99 });
  });

  it("criar: o cargo que a transcrição não diz (sugestão de antes do portão) não vira pendência", async () => {
    banco.sugestao = { ...banco.sugestao!, fullName: "Fernando Okada", jobTitle: "fundadora", company: "Ponte Sul Consultoria", confidence: "0.910" };
    await expect(rota().decideContactSuggestion({ suggestionId: ID, action: "create" })).resolves.toEqual({ success: true, contactId: 99 });
    const pendencias = banco.insercoes.filter(({ tabela }) => tabela === schema.networkSugestoes)
      .flatMap(({ valores }) => valores as Array<Record<string, unknown>>);
    expect(pendencias.map(p => [p.campo, p.valor, p.confianca])).toEqual([["empresa", "Ponte Sul Consultoria", "0.910"]]);
  });
});
