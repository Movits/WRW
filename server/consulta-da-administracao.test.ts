import express from "express";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A consulta da administração (R1a, server/consulta-da-administracao.ts), sem
 * banco: quem entra (só admin e presidente), o motivo obrigatório, a ordem
 * "auditoria antes da leitura" na mesma transação, a falha da auditoria que
 * não deixa ler nada, a lista fechada de chaves da resposta, a reunião
 * anterior ao aviso (e a juntada com uma assim) e a rota do áudio. O que só o
 * banco prova (a hora do passe, a lista, a exclusão da conta) está em
 * consulta-da-administracao.integracao.test.ts.
 */

const resumoParaLeitura = vi.hoisted(() => vi.fn(async () => ({ estado: "pronto", emoji: null, idioma: "pt-BR", versaoAnterior: false, itens: [] })));
const gravacaoParaOuvir = vi.hoisted(() => vi.fn(async () => ({
  recording: {
    url: "/manus-storage/meetings/dona-x/r/recording.mp4", mimeType: "audio/mp4", durationSeconds: 90, sizeBytes: 10, expiresAt: 9e15,
    partes: [{ seq: 0, url: "/manus-storage/meetings/dona-x/r/recording.mp4", mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 90, expiresAt: 9e15 }],
  },
  recordingExpired: false, recordingDeletionPending: false, audioParaBaixar: null,
})));
vi.mock("./resumo-guardado", async original => ({ ...(await original<typeof import("./resumo-guardado")>()), resumoParaLeitura }));
vi.mock("./meeting-service", async original => ({ ...(await original<typeof import("./meeting-service")>()), gravacaoParaOuvir }));

const { abrirReuniaoNaConsulta, registrarConsulta, registrarRotaDoAudioDaConsulta, versoesDasJuntadas, enderecoDoAudioDaConsulta } = await import("./consulta-da-administracao");
const { auditLogs, meetings, meetingTranscripts } = await import("../drizzle/schema");
const { consultaDeReunioesRouter } = await import("./routers/consultaDeReunioes");
const { RECUSAS_DA_CONSULTA, ACAO_CONSULTA_DA_ADMINISTRACAO } = await import("@shared/consulta-da-administracao");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const QUEM = { userId: 7, ipAddress: "203.0.113.9, 10.0.0.1", userAgent: "vitest" };
const MOTIVO = { motivo: "apuracao_de_denuncia" as const, complemento: "Denúncia recebida pelo canal oficial em 24/11." };
const PORTA = {
  id: ID, ownerId: "dona-x", title: "Reunião", createdAt: 1_700_000_000_000, status: "ready", language: "pt-BR",
  audioPipeline: "single", origem: "gravacao", speakerNames: { F1: "Ana" }, versaoDoAviso: "2026-11-23",
  donaId: 42, donaNome: "Dona Nome", donaPerfil: null,
};

/**
 * Um banco de mentira que registra a ordem: cada select diz de que tabela
 * leu, e o insert, o que gravou. As respostas dos selects saem, por tabela,
 * de `respostas`. A cadeia do drizzle é "thenable" no fim.
 */
function bancoQueRegistra(respostas: { meetings?: unknown[]; audit?: unknown[][]; transcricao?: unknown[] }, opcoes: { insertFalha?: boolean } = {}) {
  const ordem: string[] = [];
  const inseridos: unknown[] = [];
  const auditorias = [...(respostas.audit ?? [])];
  const select = () => {
    let tabela = "";
    const cadeia: Record<string, unknown> = {
      from(t: unknown) {
        tabela = t === meetings ? "meetings" : t === auditLogs ? "audit_logs" : t === meetingTranscripts ? "meeting_transcripts" : "outra";
        ordem.push(`select:${tabela}`);
        return cadeia;
      },
      innerJoin: () => cadeia, leftJoin: () => cadeia, where: () => cadeia, orderBy: () => cadeia, limit: () => cadeia,
      then(ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) {
        const linhas = tabela === "meetings" ? respostas.meetings ?? [] : tabela === "audit_logs" ? auditorias.shift() ?? [] : tabela === "meeting_transcripts" ? respostas.transcricao ?? [] : [];
        return Promise.resolve(linhas).then(ok, erro);
      },
    };
    return cadeia;
  };
  const insert = () => ({
    values: async (valores: unknown) => {
      ordem.push("insert:audit_logs");
      if (opcoes.insertFalha) throw new Error("auditoria fora do ar");
      inseridos.push(valores);
    },
  });
  const tx = { select, insert };
  const banco = {
    select, insert,
    transaction: async (fn: (t: typeof tx) => unknown) => { ordem.push("tx:inicio"); const r = await fn(tx); ordem.push("tx:fim"); return r; },
  };
  return { banco, tx, ordem, inseridos };
}

beforeEach(() => {
  resumoParaLeitura.mockClear();
  gravacaoParaOuvir.mockClear();
});

describe("quem entra: só admin e presidente (plataformaProcedure)", () => {
  const ctx = (role: string) => ({
    user: { id: 1, openId: "u-1", email: "t@local", role, onboardingCompleted: true },
    req: { headers: {}, socket: {} }, res: { cookie: () => {} },
  }) as never;

  it("Ouro, Prata e Bronze levam FORBIDDEN na lista e na abertura, antes de qualquer leitura", async () => {
    for (const role of ["gold", "silver", "bronze"]) {
      const caller = consultaDeReunioesRouter.createCaller(ctx(role));
      await expect(caller.listar()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.abrir({ meetingId: ID, ...MOTIVO })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("admin e presidente passam da porta (o motivo inválido é que recusa, com BAD_REQUEST)", async () => {
    for (const role of ["admin", "president"]) {
      const caller = consultaDeReunioesRouter.createCaller(ctx(role));
      await expect(caller.abrir({ meetingId: ID, motivo: "apuracao_de_denuncia", complemento: "curto" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("sem motivo, com motivo fora da lista ou com o texto curto ou longo demais: BAD_REQUEST", async () => {
    const caller = consultaDeReunioesRouter.createCaller(ctx("admin"));
    const invalidos = [
      { meetingId: ID, complemento: MOTIVO.complemento },
      { meetingId: ID, motivo: "curiosidade", complemento: MOTIVO.complemento },
      { meetingId: ID, motivo: "seguranca", complemento: "         x          " },
      { meetingId: ID, motivo: "seguranca", complemento: "x".repeat(501) },
      { meetingId: ID, motivo: "seguranca" },
    ];
    for (const pedido of invalidos) await expect(caller.abrir(pedido as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("abrir: a auditoria antes da leitura, na mesma transação", () => {
  it("lê só a porta da reunião, grava MEETING_ADMIN_READ com o motivo e a dona, e SÓ ENTÃO lê o conteúdo", async () => {
    const { banco, ordem, inseridos } = bancoQueRegistra({ meetings: [PORTA], audit: [[]], transcricao: [{ texto: "Oi", idioma: "pt-BR", segmentos: [], editada: 0 }] });
    resumoParaLeitura.mockImplementationOnce(async () => { ordem.push("resumo"); return { estado: "pronto", emoji: null, idioma: "pt-BR", versaoAnterior: false, itens: [] }; });
    gravacaoParaOuvir.mockImplementationOnce(async () => { ordem.push("gravacao"); return { recording: null, recordingExpired: false, recordingDeletionPending: false, audioParaBaixar: null }; });
    await abrirReuniaoNaConsulta(QUEM, ID, MOTIVO, banco as never);
    expect(ordem).toEqual([
      "tx:inicio", "select:meetings", "select:audit_logs", "insert:audit_logs", "tx:fim",
      "select:meeting_transcripts", "resumo", "gravacao",
    ]);
    expect(inseridos).toEqual([{
      userId: 7, ipAddress: "203.0.113.9", userAgent: "vitest",
      action: ACAO_CONSULTA_DA_ADMINISTRACAO, resource: "meetings", resourceId: ID,
      details: { motivo: "apuracao_de_denuncia", complemento: MOTIVO.complemento, donaUserId: 42 },
      status: "success", riskLevel: "high",
    }]);
  });

  it("a auditoria que falha não deixa ler nada: nem transcrição, nem resumo, nem gravação", async () => {
    const { banco, ordem } = bancoQueRegistra({ meetings: [PORTA], audit: [[]] }, { insertFalha: true });
    await expect(abrirReuniaoNaConsulta(QUEM, ID, MOTIVO, banco as never)).rejects.toThrow("auditoria fora do ar");
    expect(ordem).not.toContain("select:meeting_transcripts");
    expect(resumoParaLeitura).not.toHaveBeenCalled();
    expect(gravacaoParaOuvir).not.toHaveBeenCalled();
  });

  it("a reunião que não existe (ou excluída, ou na lixeira: o WHERE as tira) é NOT_FOUND com o código, sem auditoria", async () => {
    const { tx, ordem } = bancoQueRegistra({ meetings: [] });
    await expect(registrarConsulta(tx as never, QUEM, ID, MOTIVO)).rejects.toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_CONSULTA.naoEncontrada });
    expect(ordem).not.toContain("insert:audit_logs");
  });

  it("a reunião gravada antes do aviso que anuncia a consulta fica FECHADA, com o código, sem auditoria", async () => {
    for (const versao of ["2026-11-14", null, "2026-11-23 ", "doc-2026-11-14"]) {
      const { tx, ordem } = bancoQueRegistra({ meetings: [{ ...PORTA, versaoDoAviso: versao }] });
      await expect(registrarConsulta(tx as never, QUEM, ID, MOTIVO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_CONSULTA.anteriorAoAviso });
      expect(ordem).not.toContain("insert:audit_logs");
    }
  });

  it("a reunião que absorveu, numa junção, uma reunião gravada antes do aviso também fica fechada", async () => {
    const juntou = { details: { juntadas: ["b"], avisosDeGravacao: [{ id: ID, consentNoticeVersion: "2026-11-23" }, { id: "b", consentNoticeVersion: "2026-11-14" }] } };
    const { tx, ordem } = bancoQueRegistra({ meetings: [PORTA], audit: [[juntou]] });
    await expect(registrarConsulta(tx as never, QUEM, ID, MOTIVO)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(ordem).not.toContain("insert:audit_logs");
  });

  it("a resposta tem a lista fechada de chaves: nada da rede particular, do link, da dona ou do bucket", async () => {
    const { banco } = bancoQueRegistra({ meetings: [PORTA], audit: [[]], transcricao: [{ texto: "Oi", idioma: "pt-BR", segmentos: [{ inicio: 0, fim: 1, falante: "F1", texto: "Oi", extra: "x" }], editada: 0 }] });
    const vista = await abrirReuniaoNaConsulta(QUEM, ID, MOTIVO, banco as never);
    expect(Object.keys(vista).sort()).toEqual([
      "criadaEm", "dona", "gravacao", "gravacaoExpirada", "gravacaoSaindo", "idioma", "origem", "passeDoAudioAte", "resumo", "status", "titulo", "transcricao", "vozes",
    ]);
    const texto = JSON.stringify(vista);
    // O openId da dona e a chave do bucket não saem: o áudio vai pela rota da consulta.
    expect(texto).not.toContain("dona-x");
    expect(texto).not.toContain("manus-storage");
    for (const proibida of ["ownerId", "owner_id", "contactId", "contextId", "shareToken", "entities", "suggestions", "donaId", "userId"]) expect(texto).not.toContain(proibida);
    expect(vista.gravacao?.partes[0].url).toBe(enderecoDoAudioDaConsulta(ID));
    expect(vista.vozes).toEqual({ F1: "Ana" });
    expect(vista.dona).toBe("Dona Nome");
    expect(vista.transcricao?.segmentos).toEqual([{ inicio: 0, fim: 1, falante: "F1", texto: "Oi" }]);
  });
});

describe("as juntadas, pela auditoria da junção", () => {
  const leitor = (porRodada: unknown[][]) => bancoQueRegistra({ audit: porRodada }).tx;

  it("sem junção, nenhuma versão; com junção, a de cada reunião, seguindo a corrente", async () => {
    expect(await versoesDasJuntadas(leitor([[]]) as never, ID)).toEqual([]);
    const primeira = { details: { juntadas: ["b"], avisosDeGravacao: [{ consentNoticeVersion: "2026-11-23" }, { consentNoticeVersion: "2026-11-23" }] } };
    const deB = { details: { juntadas: ["c"], avisosDeGravacao: [{ consentNoticeVersion: "2026-11-23" }, { consentNoticeVersion: "2026-11-14" }] } };
    expect(await versoesDasJuntadas(leitor([[primeira], [deB], []]) as never, ID)).toEqual(["2026-11-23", "2026-11-23", "2026-11-23", "2026-11-14"]);
  });

  it("a linha da junção sem os avisos conta como versão ausente (fecha a consulta)", async () => {
    expect(await versoesDasJuntadas(leitor([[{ details: { juntadas: [] } }]]) as never, ID)).toEqual([null]);
  });
});

describe("a rota do áudio da consulta", () => {
  async function pedir(deps: Parameters<typeof registrarRotaDoAudioDaConsulta>[1], caminho = `/consulta-da-administracao/${ID}/audio?parte=2`) {
    const app = express();
    registrarRotaDoAudioDaConsulta(app, deps);
    const servidor = app.listen(0);
    try {
      const { port } = servidor.address() as AddressInfo;
      return await fetch(`http://127.0.0.1:${port}${caminho}`, { redirect: "manual" });
    } finally {
      servidor.close();
    }
  }
  const assinar = async (chave: string) => `https://bucket.invalid/${chave}?assinada`;

  it("sem sessão, 401; Ouro, 403; sem consulta aberta, 404; com ela, 307 sem cache, pela parte pedida", async () => {
    const acharChave = vi.fn(async (_admin: number, _id: string, parte?: number) => (parte === 2 ? "meetings/dona/r/partes/0002.webm" : null));
    expect((await pedir({ autenticar: async () => { throw new Error("sem sessão"); }, acharChave, assinar })).status).toBe(401);
    expect((await pedir({ autenticar: async () => ({ id: 3, role: "gold" }), acharChave, assinar })).status).toBe(403);
    expect(acharChave).not.toHaveBeenCalled();
    expect((await pedir({ autenticar: async () => ({ id: 3, role: "admin" }), acharChave: async () => null, assinar })).status).toBe(404);
    const resposta = await pedir({ autenticar: async () => ({ id: 3, role: "president" }), acharChave, assinar });
    expect(resposta.status).toBe(307);
    expect(resposta.headers.get("location")).toBe("https://bucket.invalid/meetings/dona/r/partes/0002.webm?assinada");
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(acharChave).toHaveBeenCalledWith(3, ID, 2);
  });

  it("banco fora do ar é 503, nunca 'sem gravação'", async () => {
    const queda = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    const resposta = await pedir({ autenticar: async () => ({ id: 3, role: "admin" }), acharChave: async () => { throw queda; }, assinar });
    expect(resposta.status).toBe(503);
  });
});
