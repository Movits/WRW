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
 * - os erros da Google viram motivo, e o erro do banco sobe;
 * - o token vem antes de gravar (marcar e mudar o passam pronto) e antes de
 *   apagar: o banco fora do ar ali derruba a mutação sem nada feito;
 * - a reunião que já acabou nunca é criada na Google, só muda o evento que já
 *   está lá, sem avisar ninguém, e a exclusão dela não chama a Google;
 * - a exclusão tira o evento mesmo com o estado nulo (a desconexão o zera), e a
 *   que foi para lá, sem a Google Agenda agora, volta "falhou".
 */

type Efeito = { tipo: "select" | "update" | "delete" | "google"; sql?: string; params?: unknown[]; valores?: Record<string, unknown>; url?: string; metodo?: string; autorizacao?: string };

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
    delete: () => ({
      where: async (condicao: SQL) => {
        estado.efeitos.push({ tipo: "delete", ...render(condicao) });
        return [{ affectedRows: estado.afetadas.shift() ?? 1 }];
      },
    }),
    // A exclusão da agenda roda numa transação (H15, com o lembrete): a mesma
    // conexão falsa faz de transação, e os efeitos seguem na mesma ordem.
    transaction: async (trabalho: (tx: unknown) => Promise<unknown>) => trabalho(db),
  };
  return { getDb: async () => db, exigirDb: async () => db };
});

// O lembrete no sino (H15) é dublê: que a exclusão o esquece, na transação dela,
// está provado em server/agenda-de-reunioes.test.ts. Aqui contam só o banco da
// agenda e a Google.
vi.mock("./lembretes", () => ({
  agendarLembreteDaAgenda: vi.fn(async () => {}),
  esquecerLembrete: vi.fn(async () => {}),
}));

const servico = await import("./agenda-na-google");
const { GoogleAgendaIndisponivel, GoogleAgendaNaoConectada } = await import("./google-agenda");
const { ConexaoGoogleRevogada, RecusaDaGoogle } = await import("./google-oauth");
const { URL_DOS_EVENTOS, corpoDoEvento } = await import("./google-agenda-eventos");

const CONTA = { id: 7, openId: "dona-1" };
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const EVENTO = "8b1f6a2e3c4d4e5f8a9b0c1d2e3f4a5b";
const FICHA = 1_700_000_000_000;
const HORA = 60 * 60_000;
/** A reunião da linha() começa em 20/11/2026, às 17h UTC, e dura 1 hora. */
const INICIO = Date.UTC(2026, 10, 20, 17, 0);
/** O relógio dos dublês: na véspera da reunião, ou depois do fim dela. */
const ANTES = INICIO - 24 * HORA;
const DEPOIS = INICIO + 2 * HORA;

const linha = (extra: Partial<Parameters<typeof servico.enviarParaGoogle>[1]> = {}) => ({
  id: ID,
  titulo: "Conversa com a Bia",
  inicioEm: INICIO,
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
    estado.efeitos.push({ tipo: "google", url, metodo: init?.method, autorizacao: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    if (proxima instanceof Error) throw proxima;
    return proxima;
  });
  return { token: vi.fn(async () => "token-1"), renovar: vi.fn(async () => "token-2"), buscar, agora: vi.fn(() => ANTES) };
}
/** O envio com os dublês, como as rotas o chamam (as opções no terceiro parâmetro). */
const enviar = (linhaDoEnvio: Parameters<typeof servico.enviarParaGoogle>[1], d: ReturnType<typeof deps>, acesso?: { token: string } | { motivo: "nao-conectada" | "revogada" | "google" }) =>
  servico.enviarParaGoogle(CONTA, linhaDoEnvio, acesso ? { deps: d, acesso } : { deps: d });
const efeitos = () => estado.efeitos as unknown as Efeito[];
const tipos = () => efeitos().map(e => (e.tipo === "google" ? `google:${e.metodo}` : e.tipo));
const updates = () => efeitos().filter(e => e.tipo === "update");
const quedaDoBanco = () => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

// O resultado só grava na versão da ficha que ainda tem estado na Google: o
// nulo que a desconexão ou a troca da conta Google deixou não volta.
const NA_FICHA = "(`agenda_reunioes`.`id` = ? and `agenda_reunioes`.`owner_id` = ? and `agenda_reunioes`.`updated_at` = ? and `agenda_reunioes`.`google` is not null)";
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
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "ok" });
    expect(d.token).toHaveBeenCalledWith(7);
    expect(tipos()).toEqual(["google:POST", "update"]);
    const [resultado] = updates();
    expect(resultado.valores).toEqual({ google: "ok" });
    expect({ sql: resultado.sql, params: resultado.params }).toEqual({ sql: NA_FICHA, params: [ID, "dona-1", FICHA] });
  });

  it("o 'Tentar de novo' marca 'pendente' ANTES de chamar a Google, só com a dona no WHERE, e a ficha não muda", async () => {
    const d = deps(erroDaGoogle(409, "duplicate"), json({ id: EVENTO }));
    expect(await enviar(linha({ google: "falhou" }), d)).toEqual({ naGoogle: "ok" });
    expect(tipos()).toEqual(["update", "google:POST", "google:PATCH", "update"]);
    const [pendente, ok] = updates();
    expect(pendente.valores).toEqual({ google: "pendente" });
    expect({ sql: pendente.sql, params: pendente.params }).toEqual({ sql: DA_DONA, params: [ID, "dona-1"] });
    expect(ok.params).toEqual([ID, "dona-1", FICHA]);
  });

  it("o convite escolhido vai junto (sendUpdates=all)", async () => {
    const d = deps(json({ id: EVENTO }));
    await enviar(linha({ googleConvites: true }), d);
    expect(efeitos().find(e => e.tipo === "google")?.url).toBe(`${URL_DOS_EVENTOS}?sendUpdates=all`);
  });

  it("a reunião que saiu da agenda antes do envio: NOT_FOUND, e nada vai à Google", async () => {
    estado.afetadas.push(0);
    const d = deps();
    await expect(enviar(linha({ google: null }), d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(d.buscar).not.toHaveBeenCalled();
  });

  it("o 401 renova o token pela conta e repete", async () => {
    const d = deps(erroDaGoogle(401, "authError"), json({ id: EVENTO }));
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "ok" });
    expect(d.renovar).toHaveBeenCalledWith(7);
  });

  it("o token que marcar e mudar leram antes de gravar vem pronto: não é lido de novo", async () => {
    const d = deps(json({ id: EVENTO }));
    expect(await enviar(linha(), d, { token: "token-lido-antes" })).toEqual({ naGoogle: "ok" });
    expect(d.token).not.toHaveBeenCalled();
    expect(efeitos().find(e => e.tipo === "google")?.autorizacao).toBe("Bearer token-lido-antes");
  });

  it("o motivo lido antes de gravar (a conexão revogada) vira 'falhou' na ficha, sem ler o token nem chamar a Google", async () => {
    const d = deps();
    expect(await enviar(linha(), d, { motivo: "revogada" })).toEqual({ naGoogle: "falhou", motivo: "revogada" });
    expect(d.token).not.toHaveBeenCalled();
    expect(d.buscar).not.toHaveBeenCalled();
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: "falhou" }, sql: NA_FICHA })]);
  });
});

describe("o token antes de gravar ou apagar (acessoDaGoogle)", () => {
  it("o token, ou o motivo de não haver; o banco fora do ar sobe como erro", async () => {
    const d = deps();
    expect(await servico.acessoDaGoogle(CONTA, d)).toEqual({ token: "token-1" });
    expect(d.token).toHaveBeenCalledWith(7);
    d.token.mockRejectedValueOnce(new ConexaoGoogleRevogada());
    expect(await servico.acessoDaGoogle(CONTA, d)).toEqual({ motivo: "revogada" });
    d.token.mockRejectedValueOnce(new GoogleAgendaIndisponivel());
    expect(await servico.acessoDaGoogle(CONTA, d)).toEqual({ motivo: "nao-conectada" });
    const erro = quedaDoBanco();
    d.token.mockRejectedValueOnce(erro);
    await expect(servico.acessoDaGoogle(CONTA, d)).rejects.toBe(erro);
    expect(efeitos()).toEqual([]);
  });
});

describe("sem a Google Agenda", () => {
  it.each([
    ["a função indisponível", new GoogleAgendaIndisponivel()],
    ["a conta não conectada", new GoogleAgendaNaoConectada()],
  ])("%s, e a reunião nunca foi para lá: nada muda no banco e nada vai à Google", async (_caso, erro) => {
    const d = deps();
    d.token.mockRejectedValueOnce(erro);
    expect(await enviar(linha({ google: null }), d)).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(efeitos()).toEqual([]);
  });

  it("a que já foi para lá fica 'falhou' na ficha: a Google ficou com a versão antiga", async () => {
    const d = deps();
    d.token.mockRejectedValueOnce(new GoogleAgendaNaoConectada());
    expect(await enviar(linha({ google: "pendente" }), d)).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: "falhou" }, sql: NA_FICHA })]);
  });

  it("a conexão revogada: 'falhou' com o motivo, para a tela pedir Reconectar", async () => {
    const d = deps();
    d.token.mockRejectedValueOnce(new ConexaoGoogleRevogada());
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "falhou", motivo: "revogada" });
    expect(d.buscar).not.toHaveBeenCalled();
  });

  it("a Google fora do ar na renovação: 'falhou', motivo google", async () => {
    const d = deps();
    d.token.mockRejectedValueOnce(new RecusaDaGoogle("rede", null));
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "falhou", motivo: "google" });
  });

  it("banco fora do ar ao ler a conexão sobe como erro, nunca como falha da Google", async () => {
    const d = deps();
    const queda = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    d.token.mockRejectedValueOnce(queda);
    await expect(enviar(linha(), d)).rejects.toBe(queda);
    expect(updates()).toEqual([]);
  });
});

describe("a Google recusa", () => {
  it("grava 'falhou' na ficha, e o log leva o motivo, sem token, título nem e-mail", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps(erroDaGoogle(403, "rateLimitExceeded"));
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "falhou", motivo: "google" });
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
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "ok" });
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
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "ok" });
    const [, segunda] = updates();
    expect(segunda.valores).toEqual({ google: "ok" });
    expect(segunda.params).toEqual([ID, "dona-1", FICHA + 5]);
  });

  it("mudou no evento (outra aba salvou outro título): o resultado fica para quem mudou", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([doBanco({ titulo: "Outro título", updatedAt: FICHA + 5 })]);
    const d = deps(json({ id: EVENTO }));
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "ok" });
    expect(updates()).toHaveLength(1);
  });

  it("mudou só o convite: também fica para quem mudou", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([doBanco({ googleConvites: 1, updatedAt: FICHA + 5 })]);
    await enviar(linha(), deps(json({ id: EVENTO })));
    expect(updates()).toHaveLength(1);
  });

  it("o 'falhou' nunca passa por cima de quem mudou a linha: nem relê a linha", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    estado.afetadas.push(0);
    await enviar(linha(), deps(erroDaGoogle(500, "backendError")));
    expect(tipos()).toEqual(["google:POST", "update"]);
  });

  it("a reunião sumiu durante o envio (excluída em outra aba): o evento recém-gravado sai da Google", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([]);
    const d = deps(json({ id: EVENTO }), new Response(null, { status: 204 }));
    expect(await enviar(linha({ googleConvites: true }), d)).toEqual({ naGoogle: "ok" });
    expect(tipos()).toEqual(["google:POST", "update", "select", "google:DELETE"]);
    expect(efeitos().at(-1)?.url).toBe(`${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=all`);
  });

  it("o mesmo evento compara pelo que vai à Google: participantes iguais, mesmo vindos do banco", () => {
    expect(JSON.stringify(corpoDoEvento(linha()))).toBe(JSON.stringify(corpoDoEvento({ ...linha(), participantes: [{ nome: "Ana", email: "ana@exemplo.com" }] })));
  });
});

describe("a reunião que já acabou", () => {
  const googles = () => efeitos().filter(e => e.tipo === "google").map(e => [e.metodo, e.url]);

  it("a que nunca foi para a Google fica de fora: nem token, nem banco, nem Google", async () => {
    const d = deps();
    d.agora.mockReturnValue(DEPOIS);
    expect(await enviar(linha({ google: null, googleConvites: true }), d)).toEqual({ naGoogle: null });
    expect(d.token).not.toHaveBeenCalled();
    expect(efeitos()).toEqual([]);
  });

  it("a que já foi só muda o evento que está lá (PATCH, nunca POST), sem avisar os convidados, mesmo com o convite marcado", async () => {
    const d = deps(json({ id: EVENTO }));
    d.agora.mockReturnValue(DEPOIS);
    expect(await enviar(linha({ googleConvites: true }), d)).toEqual({ naGoogle: "ok" });
    expect(googles()).toEqual([["PATCH", `${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=none`]]);
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: "ok" }, sql: NA_FICHA })]);
  });

  it.each([[404], [410]])("o evento que não está lá (%s) não é criado: a reunião volta a nulo, como a que nunca foi", async status => {
    const d = deps(erroDaGoogle(status, "notFound"));
    d.agora.mockReturnValue(DEPOIS);
    expect(await enviar(linha({ googleConvites: true }), d)).toEqual({ naGoogle: null });
    expect(googles()).toEqual([["PATCH", `${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=none`]]);
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: null }, sql: NA_FICHA, params: [ID, "dona-1", FICHA] })]);
  });

  it("o 'Tentar de novo' dela também só muda, sem aviso: 'pendente' antes, e o que não está lá fica nulo", async () => {
    const d = deps(erroDaGoogle(404, "notFound"));
    d.agora.mockReturnValue(DEPOIS);
    expect(await enviar(linha({ google: "falhou", googleConvites: true }), d)).toEqual({ naGoogle: null });
    expect(tipos()).toEqual(["update", "google:PATCH", "update"]);
    expect(updates().map(u => u.valores)).toEqual([{ google: "pendente" }, { google: null }]);
  });

  it("a Google recusa a mudança dela: 'falhou', como na que vai acontecer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps(erroDaGoogle(503, "backendError"));
    d.agora.mockReturnValue(DEPOIS);
    expect(await enviar(linha(), d)).toEqual({ naGoogle: "falhou", motivo: "google" });
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: "falhou" } })]);
  });

  it("sumiu durante a mudança: o evento que já estava lá fica (como na exclusão dela), sem DELETE", async () => {
    estado.afetadas.push(0);
    estado.linhas.push([]);
    const d = deps(json({ id: EVENTO }));
    d.agora.mockReturnValue(DEPOIS);
    expect(await enviar(linha({ googleConvites: true }), d)).toEqual({ naGoogle: "ok" });
    expect(tipos()).toEqual(["google:PATCH", "update", "select"]);
  });

  it("a que está acontecendo ainda vai acabar: cria e avisa como as próximas", async () => {
    const d = deps(json({ id: EVENTO }));
    d.agora.mockReturnValue(INICIO + 30 * 60_000);
    await enviar(linha({ googleConvites: true }), d);
    expect(googles()).toEqual([["POST", `${URL_DOS_EVENTOS}?sendUpdates=all`]]);
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

describe("excluir a reunião (excluirComAGoogle)", () => {
  /** As duas leituras da exclusão: a reunião inteira (lerParaGoogle) e o estado dela (excluirDaAgenda). */
  const naAgenda = (google: string | null, googleConvites: 0 | 1) => {
    estado.linhas.push([doBanco({ google, googleConvites })], [{ google, googleConvites }]);
  };

  it("a que vai acontecer e foi: o token antes de apagar, depois o DELETE com o convite que ela tinha", async () => {
    naAgenda("ok", 1);
    const d = deps(new Response(null, { status: 204 }));
    let antesDoToken: string[] = [];
    d.token.mockImplementationOnce(async () => { antesDoToken = tipos(); return "token-1"; });
    expect(await servico.excluirComAGoogle(CONTA, ID, d)).toEqual({ avisarConvidados: true, naGoogle: "ok" });
    // Na hora do token, só a reunião tinha sido lida: nada apagado.
    expect(antesDoToken).toEqual(["select"]);
    expect(tipos()).toEqual(["select", "select", "delete", "google:DELETE"]);
    expect(efeitos().at(-1)?.url).toBe(`${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=all`);
  });

  it("o banco fora do ar ao ler o token: o erro sobe, e a reunião continua na agenda", async () => {
    naAgenda("ok", 0);
    const d = deps();
    const erro = quedaDoBanco();
    d.token.mockRejectedValueOnce(erro);
    await expect(servico.excluirComAGoogle(CONTA, ID, d)).rejects.toBe(erro);
    expect(tipos()).toEqual(["select"]);
  });

  it("a que já acabou sai só da WRW: nem token, nem Google, e ninguém recebe o cancelamento", async () => {
    naAgenda("ok", 1);
    const d = deps();
    d.agora.mockReturnValue(DEPOIS);
    expect(await servico.excluirComAGoogle(CONTA, ID, d)).toEqual({ avisarConvidados: false, naGoogle: null });
    expect(d.token).not.toHaveBeenCalled();
    expect(d.buscar).not.toHaveBeenCalled();
    expect(tipos()).toEqual(["select", "select", "delete"]);
  });

  it("o estado nulo com a Google conectada: tenta o DELETE (quem reconectou a mesma conta ainda tem o evento), e o que não existe conta como tirado", async () => {
    naAgenda(null, 1);
    const d = deps(erroDaGoogle(404, "notFound"));
    expect(await servico.excluirComAGoogle(CONTA, ID, d)).toEqual({ avisarConvidados: true, naGoogle: null });
    expect(efeitos().at(-1)).toMatchObject({ tipo: "google", metodo: "DELETE", url: `${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=all` });
  });

  it("o estado nulo e a Google falhando: só o log, e a resposta é nula (a reunião provavelmente nunca foi para lá)", async () => {
    const avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
    naAgenda(null, 0);
    expect(await servico.excluirComAGoogle(CONTA, ID, deps(erroDaGoogle(503, "backendError")))).toEqual({ avisarConvidados: false, naGoogle: null });
    expect(String(avisos.mock.calls[0][0])).toContain("backendError");
    expect(String(avisos.mock.calls[0][0])).not.toContain("token-1");
  });

  it.each([
    ["desconectada", () => new GoogleAgendaNaoConectada(), "nao-conectada"],
    ["fora da lista do modo Teste, ou sem as variáveis", () => new GoogleAgendaIndisponivel(), "nao-conectada"],
    ["com a conexão revogada", () => new ConexaoGoogleRevogada(), "revogada"],
  ])("a que foi para a Google, %s agora: 'falhou' com o motivo, sem chamar a Google, e a reunião sai", async (_caso, erro, motivo) => {
    naAgenda("ok", 1);
    const d = deps();
    d.token.mockRejectedValueOnce(erro());
    expect(await servico.excluirComAGoogle(CONTA, ID, d)).toEqual({ avisarConvidados: true, naGoogle: "falhou", motivo });
    expect(d.buscar).not.toHaveBeenCalled();
    expect(tipos()).toEqual(["select", "select", "delete"]);
  });

  it("a que nunca foi, sem a Google Agenda: nula, e a reunião sai", async () => {
    naAgenda(null, 0);
    const d = deps();
    d.token.mockRejectedValueOnce(new GoogleAgendaNaoConectada());
    expect(await servico.excluirComAGoogle(CONTA, ID, d)).toEqual({ avisarConvidados: false, naGoogle: null });
    expect(tipos()).toEqual(["select", "select", "delete"]);
  });

  it("a Google recusa a que foi: 'falhou', motivo google, para o Tentar de novo", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    naAgenda("pendente", 0);
    expect(await servico.excluirComAGoogle(CONTA, ID, deps(erroDaGoogle(503, "backendError")))).toEqual({ avisarConvidados: false, naGoogle: "falhou", motivo: "google" });
  });

  it("de outra dona, ou que já saiu: NOT_FOUND, sem ler o token nem apagar", async () => {
    const d = deps();
    await expect(servico.excluirComAGoogle(CONTA, ID, d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(d.token).not.toHaveBeenCalled();
    expect(tipos()).toEqual(["select"]);
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
