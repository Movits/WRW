import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A reunião da agenda na Google Agenda (H16c, server/agenda-na-google.ts),
 * contra um banco falso que renderiza o WHERE pelo dialeto do MySQL e anota
 * cada efeito na ordem, com a Google de mentira no lugar do fetch. Prova:
 * - primeiro o banco, depois a Google: a linha fica "pendente" antes da
 *   chamada, e o resultado entra depois, com a dona e a ficha (updatedAt) no
 *   WHERE;
 * - sem a Google Agenda conectada, a reunião que nunca foi para lá continua
 *   nula, e a que já foi fica "falhou";
 * - a ficha: a linha que mudou só na gravação ligada ainda fica "ok"; a que
 *   mudou no evento não; o "falhou" nunca passa por cima; a que sumiu durante o
 *   envio leva o evento junto;
 * - os erros da Google viram motivo, e o erro do banco sobe.
 */

type Efeito = { tipo: "select" | "update" | "google"; sql?: string; params?: unknown[]; valores?: Record<string, unknown>; url?: string; metodo?: string };

const estado = vi.hoisted(() => ({
  efeitos: [] as Array<Record<string, unknown>>,
  linhas: [] as Array<Array<Record<string, unknown>>>,
  afetadas: [] as number[],
}));

vi.mock("./db", async () => {
  const { MySqlDialect: Dialeto } = await import("drizzle-orm/mysql-core");
  const d = new Dialeto();
  const render = (condicao: SQL) => d.sqlToQuery(condicao);
  const db = {
    select: () => ({
      from: () => ({
        where: (condicao: SQL) => {
          estado.efeitos.push({ tipo: "select", ...render(condicao) });
          const linhas = estado.linhas.shift() ?? [];
          return { limit: async () => linhas };
        },
      }),
    }),
    update: () => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (condicao: SQL) => {
          estado.efeitos.push({ tipo: "update", valores, ...render(condicao) });
          return [{ affectedRows: estado.afetadas.shift() ?? 1 }];
        },
      }),
    }),
  };
  return { getDb: async () => db, exigirDb: async () => db };
});

const servico = await import("./agenda-na-google");
const { GoogleAgendaIndisponivel, GoogleAgendaNaoConectada } = await import("./google-agenda");
const { ConexaoGoogleRevogada, RecusaDaGoogle } = await import("./google-oauth");
const { URL_DOS_EVENTOS, corpoDoEvento } = await import("./google-agenda-eventos");

const CONTA = { id: 7, openId: "dona-1" };
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const EVENTO = "8b1f6a2e3c4d4e5f8a9b0c1d2e3f4a5b";
const FICHA = 1_700_000_000_000;

const linha = (extra: Partial<Parameters<typeof servico.enviarParaGoogle>[1]> = {}) => ({
  id: ID,
  titulo: "Conversa com a Bia",
  inicioEm: Date.UTC(2026, 10, 20, 17, 0),
  duracaoMinutos: 60,
  fuso: "America/Sao_Paulo",
  local: null,
  participantes: [{ nome: "Ana", email: "ana@exemplo.com" }],
  lembreteMinutos: 15,
  google: "pendente" as const,
  googleConvites: false,
  updatedAt: FICHA,
  ...extra,
});
/** A linha como o banco a devolve na releitura (a coluna JSON e o tinyint como vêm). */
const doBanco = (extra: Record<string, unknown> = {}) => ({ ...linha(), googleConvites: 0, ...extra });

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const erroDaGoogle = (status: number, reason: string) => json({ error: { code: status, errors: [{ reason }] } }, status);

function deps(...respostas: Array<Response | Error>) {
  const buscar = vi.fn(async (url: string, init?: RequestInit) => {
    estado.efeitos.push({ tipo: "google", url, metodo: init?.method });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    if (proxima instanceof Error) throw proxima;
    return proxima;
  });
  return { token: vi.fn(async () => "token-1"), renovar: vi.fn(async () => "token-2"), buscar };
}
const efeitos = () => estado.efeitos as unknown as Efeito[];
const tipos = () => efeitos().map(e => (e.tipo === "google" ? `google:${e.metodo}` : e.tipo));
const updates = () => efeitos().filter(e => e.tipo === "update");

const NA_FICHA = "(`agenda_reunioes`.`id` = ? and `agenda_reunioes`.`owner_id` = ? and `agenda_reunioes`.`updated_at` = ?)";
const DA_DONA = "(`agenda_reunioes`.`id` = ? and `agenda_reunioes`.`owner_id` = ?)";

beforeEach(() => {
  estado.efeitos.length = 0;
  estado.linhas.length = 0;
  estado.afetadas.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("mandar a reunião para a Google", () => {
  it("logo depois de marcar (já pendente): cria o evento e grava 'ok' com a dona e a ficha no WHERE", async () => {
    const d = deps(json({ id: EVENTO }));
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "ok" });
    expect(d.token).toHaveBeenCalledWith(7);
    expect(tipos()).toEqual(["google:POST", "update"]);
    const [resultado] = updates();
    expect(resultado.valores).toEqual({ google: "ok" });
    expect({ sql: resultado.sql, params: resultado.params }).toEqual({ sql: NA_FICHA, params: [ID, "dona-1", FICHA] });
  });

  it("o 'Tentar de novo' marca 'pendente' ANTES de chamar a Google, só com a dona no WHERE, e a ficha não muda", async () => {
    const d = deps(erroDaGoogle(409, "duplicate"), json({ id: EVENTO }));
    expect(await servico.enviarParaGoogle(CONTA, linha({ google: "falhou" }), d)).toEqual({ naGoogle: "ok" });
    expect(tipos()).toEqual(["update", "google:POST", "google:PATCH", "update"]);
    const [pendente, ok] = updates();
    expect(pendente.valores).toEqual({ google: "pendente" });
    expect({ sql: pendente.sql, params: pendente.params }).toEqual({ sql: DA_DONA, params: [ID, "dona-1"] });
    expect(ok.params).toEqual([ID, "dona-1", FICHA]);
  });

  it("o convite escolhido vai junto (sendUpdates=all)", async () => {
    const d = deps(json({ id: EVENTO }));
    await servico.enviarParaGoogle(CONTA, linha({ googleConvites: true }), d);
    expect(efeitos().find(e => e.tipo === "google")?.url).toBe(`${URL_DOS_EVENTOS}?sendUpdates=all`);
  });

  it("a reunião que saiu da agenda antes do envio: NOT_FOUND, e nada vai à Google", async () => {
    estado.afetadas.push(0);
    const d = deps();
    await expect(servico.enviarParaGoogle(CONTA, linha({ google: null }), d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(d.buscar).not.toHaveBeenCalled();
  });

  it("o 401 renova o token pela conta e repete", async () => {
    const d = deps(erroDaGoogle(401, "authError"), json({ id: EVENTO }));
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "ok" });
    expect(d.renovar).toHaveBeenCalledWith(7);
  });
});

describe("sem a Google Agenda", () => {
  it.each([
    ["a função indisponível", new GoogleAgendaIndisponivel()],
    ["a conta não conectada", new GoogleAgendaNaoConectada()],
  ])("%s, e a reunião nunca foi para lá: nada muda no banco e nada vai à Google", async (_caso, erro) => {
    const d = deps();
    d.token.mockRejectedValueOnce(erro);
    expect(await servico.enviarParaGoogle(CONTA, linha({ google: null }), d)).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(efeitos()).toEqual([]);
  });

  it("a que já foi para lá fica 'falhou' na ficha: a Google ficou com a versão antiga", async () => {
    const d = deps();
    d.token.mockRejectedValueOnce(new GoogleAgendaNaoConectada());
    expect(await servico.enviarParaGoogle(CONTA, linha({ google: "pendente" }), d)).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: "falhou" }, sql: NA_FICHA })]);
  });

  it("a conexão revogada: 'falhou' com o motivo, para a tela pedir Reconectar", async () => {
    const d = deps();
    d.token.mockRejectedValueOnce(new ConexaoGoogleRevogada());
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "falhou", motivo: "revogada" });
    expect(d.buscar).not.toHaveBeenCalled();
  });

  it("a Google fora do ar na renovação: 'falhou', motivo google", async () => {
    const d = deps();
    d.token.mockRejectedValueOnce(new RecusaDaGoogle("rede", null));
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "falhou", motivo: "google" });
  });

  it("banco fora do ar ao ler a conexão sobe como erro, nunca como falha da Google", async () => {
    const d = deps();
    const queda = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    d.token.mockRejectedValueOnce(queda);
    await expect(servico.enviarParaGoogle(CONTA, linha(), d)).rejects.toBe(queda);
    expect(updates()).toEqual([]);
  });
});

describe("a Google recusa", () => {
  it("grava 'falhou' na ficha, e o log leva o motivo, sem token, título nem e-mail", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps(erroDaGoogle(403, "rateLimitExceeded"));
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "falhou", motivo: "google" });
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: "falhou" }, params: [ID, "dona-1", FICHA] })]);
    const log = avisos.mock.calls.map(c => String(c[0])).join("\n");
    expect(log).toContain("rateLimitExceeded");
    for (const segredo of ["token-1", "Conversa com a Bia", "ana@exemplo.com"]) expect(log).not.toContain(segredo);
  });

  it("um erro que ninguém previu vira falha da Google, com o log só do nome do erro", async () => {
    const erros = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    d.buscar.mockImplementationOnce(async () => ({ status: 200, arrayBuffer: () => { throw new TypeError("token-1 vazou?"); } }) as never);
    // O corpo ilegível no 200 não é erro: a Google respondeu que gravou.
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "ok" });
    expect(servico.motivoSemGoogle(new TypeError("token-1 vazou?"))).toBe("google");
    expect(String(erros.mock.calls.at(-1)?.[0])).toContain("TypeError");
    expect(String(erros.mock.calls.at(-1)?.[0])).not.toContain("token-1");
  });

  it("erro do banco (fora do ar ou não) nunca vira motivo", () => {
    const deConsulta = Object.assign(new Error("Failed query: select"), { query: "select 1", cause: Object.assign(new Error("Unknown column"), { code: "ER_BAD_FIELD_ERROR" }) });
    expect(() => servico.motivoSemGoogle(deConsulta)).toThrow(deConsulta);
  });
});

describe("a ficha: a linha mudou durante a chamada", () => {
  it("mudou só fora do evento (a gravação ligada pelo Gravar agora): o 'ok' vale, na ficha nova", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([doBanco({ updatedAt: FICHA + 5 })]);
    const d = deps(json({ id: EVENTO }));
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "ok" });
    const [, segunda] = updates();
    expect(segunda.valores).toEqual({ google: "ok" });
    expect(segunda.params).toEqual([ID, "dona-1", FICHA + 5]);
  });

  it("mudou no evento (outra aba salvou outro título): o resultado fica para quem mudou", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([doBanco({ titulo: "Outro título", updatedAt: FICHA + 5 })]);
    const d = deps(json({ id: EVENTO }));
    expect(await servico.enviarParaGoogle(CONTA, linha(), d)).toEqual({ naGoogle: "ok" });
    expect(updates()).toHaveLength(1);
  });

  it("mudou só o convite: também fica para quem mudou", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([doBanco({ googleConvites: 1, updatedAt: FICHA + 5 })]);
    await servico.enviarParaGoogle(CONTA, linha(), deps(json({ id: EVENTO })));
    expect(updates()).toHaveLength(1);
  });

  it("o 'falhou' nunca passa por cima de quem mudou a linha: nem relê a linha", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    estado.afetadas.push(0);
    await servico.enviarParaGoogle(CONTA, linha(), deps(erroDaGoogle(500, "backendError")));
    expect(tipos()).toEqual(["google:POST", "update"]);
  });

  it("a reunião sumiu durante o envio (excluída em outra aba): o evento recém-gravado sai da Google", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([]);
    const d = deps(json({ id: EVENTO }), new Response(null, { status: 204 }));
    expect(await servico.enviarParaGoogle(CONTA, linha({ googleConvites: true }), d)).toEqual({ naGoogle: "ok" });
    expect(tipos()).toEqual(["google:POST", "update", "select", "google:DELETE"]);
    expect(efeitos().at(-1)?.url).toBe(`${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=all`);
  });

  it("o mesmo evento compara pelo que vai à Google: participantes iguais, mesmo vindos do banco", () => {
    expect(JSON.stringify(corpoDoEvento(linha()))).toBe(JSON.stringify(corpoDoEvento({ ...linha(), participantes: [{ nome: "Ana", email: "ana@exemplo.com" }] })));
  });
});

describe("tirar o evento da reunião que saiu da agenda", () => {
  it("tira com o convite escolhido; o evento que já não existe conta como tirado", async () => {
    const d = deps(new Response(null, { status: 204 }), erroDaGoogle(410, "deleted"));
    expect(await servico.tirarEventoDaGoogle(CONTA, ID, false, d)).toEqual({ naGoogle: "ok" });
    expect(await servico.tirarEventoDaGoogle(CONTA, ID, true, d)).toEqual({ naGoogle: "ok" });
    expect(efeitos().map(e => e.url)).toEqual([`${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=none`, `${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=all`]);
    // Nada no banco: a linha já saiu.
    expect(updates()).toEqual([]);
  });

  it("sem a Google Agenda conectada, nada é tentado, e sem log", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    d.token.mockRejectedValueOnce(new GoogleAgendaNaoConectada());
    expect(await servico.tirarEventoDaGoogle(CONTA, ID, false, d)).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(d.buscar).not.toHaveBeenCalled();
    expect(avisos).not.toHaveBeenCalled();
  });

  it("a Google recusa: 'falhou', motivo google, com log sem token", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps(erroDaGoogle(503, "backendError"));
    expect(await servico.tirarEventoDaGoogle(CONTA, ID, false, d)).toEqual({ naGoogle: "falhou", motivo: "google" });
    expect(String(avisos.mock.calls[0][0])).toContain("backendError");
    expect(String(avisos.mock.calls[0][0])).not.toContain("token-1");
  });
});

describe("ler a reunião para o 'Tentar de novo'", () => {
  it("lê pela id E pela dona; a linha do banco vira o que o envio precisa", async () => {
    estado.linhas.push([doBanco({ participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, null, { nome: "", email: "" }], google: "ok", googleConvites: 1 })]);
    const lida = await servico.lerParaGoogle("dona-1", ID);
    // Só passa o participante com a forma certa; o tinyint 1 é o convite marcado.
    expect(lida).toMatchObject({ id: ID, google: "ok", googleConvites: true, updatedAt: FICHA, participantes: [{ nome: "Ana", email: "ana@exemplo.com" }] });
    const [leitura] = efeitos();
    expect({ sql: leitura.sql, params: leitura.params }).toEqual({ sql: DA_DONA, params: [ID, "dona-1"] });
  });

  it("de outra dona, ou que saiu: NOT_FOUND", async () => {
    await expect(servico.lerParaGoogle("dona-2", ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await servico.existeNaAgenda("dona-2", ID)).toBe(false);
  });
});
