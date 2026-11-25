import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A próxima ação na Google Agenda (H5c, server/acoes-na-google.ts), contra um
 * banco falso que renderiza o WHERE pelo dialeto do MySQL e anota cada efeito
 * na ordem, com a Google de mentira no lugar do fetch. As escritas da ação
 * (server/proximas-acoes.ts) são dublês: o que elas gravam está em
 * proximas-acoes.test.ts. Prova:
 * - o evento: às 9h do dia do prazo no fuso, 30 minutos, livre, aviso na hora,
 *   o texto com os rótulos da tela e o endereço da ação;
 * - primeiro o banco, depois a Google, com a ficha e a dona no WHERE do resultado;
 * - feita, sem prazo ou com o dia encerrado (e nunca enviada): nada vai à Google;
 * - os erros da Google viram motivo; o 409 vira PATCH; a ação que saiu da agenda
 *   no meio leva o evento junto;
 * - o token vem antes das escritas, e só quando a ação pode ter evento;
 * - tirar o evento: 404 conta como tirado, e a falha só vira "falhou" quando a
 *   ação estava lá.
 */

type Efeito = { tipo: "select" | "update" | "google"; sql?: string; params?: unknown[]; valores?: Record<string, unknown>; url?: string; metodo?: string; corpo?: Record<string, unknown> };

const estado = vi.hoisted(() => ({
  efeitos: [] as Array<Record<string, unknown>>,
  linhas: [] as Array<Array<Record<string, unknown>>>,
  afetadas: [] as number[],
}));

vi.mock("./db", async () => {
  const { MySqlDialect: Dialeto } = await import("drizzle-orm/mysql-core");
  const d = new Dialeto();
  const render = (condicao: SQL) => d.sqlToQuery(condicao);
  const consulta = () => {
    const cadeia: Record<string, unknown> = {};
    Object.assign(cadeia, {
      leftJoin: () => cadeia,
      where: (condicao: SQL) => {
        estado.efeitos.push({ tipo: "select", ...render(condicao) });
        const linhas = estado.linhas.shift() ?? [];
        return { limit: async () => linhas };
      },
    });
    return cadeia;
  };
  const db = {
    select: () => ({ from: () => consulta() }),
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

const escritas = vi.hoisted(() => ({
  criarProximaAcao: vi.fn(async (..._args: unknown[]) => ({ id: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b" })),
  editarProximaAcao: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  marcarProximaAcaoFeita: vi.fn(async (..._args: unknown[]) => ({ prazo: null as string | null, googleAntes: null as string | null })),
  apagarProximaAcao: vi.fn(async (..._args: unknown[]) => ({ prazo: null as string | null, googleAntes: null as string | null })),
}));
vi.mock("./proximas-acoes", () => escritas);

const servico = await import("./acoes-na-google");
const { GoogleAgendaNaoConectada } = await import("./google-agenda");
const { ConexaoGoogleRevogada } = await import("./google-oauth");
const { URL_DOS_EVENTOS } = await import("./google-agenda-eventos");

const CONTA = { id: 7, openId: "dona-1" };
const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const EVENTO = "acao8b1f6a2e3c4d4e5f8a9b0c1d2e3f4a5b";
const FICHA = 1_700_000_000_000;
const ROTULOS = { voz: "Falante {n}", responsavel: "Responsável: {nome}" };
const SP = "America/Sao_Paulo";
/** O prazo das ações: 20/11/2026. O relógio dos dublês fica na véspera, ou dois dias depois. */
const PRAZO = "2026-11-20";
const ANTES = Date.UTC(2026, 10, 19, 12);
const DEPOIS = Date.UTC(2026, 10, 22, 12);
const CONTEXTO = { fuso: SP, rotulos: ROTULOS, origem: "https://wrwglobal.org" };

/** A ação como o banco a devolve na leitura do envio (com as colunas das junções). */
const linha = (extra: Record<string, unknown> = {}) => ({
  id: ID, texto: "{F2} envia a proposta", detalhe: null, responsavel: "{F2}", prazo: PRAZO, feita: 0, google: null,
  updatedAt: FICHA, reuniaoViva: "reuniao-1", vozesDaReuniao: { F2: "Carla" }, itemVivo: "item-1", ...extra,
});

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const erroDaGoogle = (status: number, reason: string) => json({ error: { code: status, errors: [{ reason }] } }, status);

function deps(...respostas: Array<Response | Error>) {
  const buscar = vi.fn(async (url: string, init?: RequestInit) => {
    estado.efeitos.push({ tipo: "google", url, metodo: init?.method, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    if (proxima instanceof Error) throw proxima;
    return proxima;
  });
  return { token: vi.fn(async () => "token-1"), renovar: vi.fn(async () => "token-2"), buscar, agora: vi.fn(() => ANTES) };
}
const semConexao = (d: ReturnType<typeof deps>) => { d.token.mockRejectedValue(new GoogleAgendaNaoConectada()); return d; };
const efeitos = () => estado.efeitos as unknown as Efeito[];
const tipos = () => efeitos().map(e => (e.tipo === "google" ? `google:${e.metodo}` : e.tipo));
const updates = () => efeitos().filter(e => e.tipo === "update");
const chamadasDaGoogle = () => efeitos().filter(e => e.tipo === "google");

const NA_FICHA = "(`proximas_acoes`.`id` = ? and `proximas_acoes`.`owner_id` = ? and `proximas_acoes`.`updated_at` = ? and `proximas_acoes`.`google` is not null)";
const DA_DONA = "(`proximas_acoes`.`id` = ? and `proximas_acoes`.`owner_id` = ?)";

beforeEach(() => {
  estado.efeitos.length = 0;
  estado.linhas.length = 0;
  estado.afetadas.length = 0;
  for (const f of Object.values(escritas)) f.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("o evento da ação", () => {
  it("o id é 'acao' e o id da ação sem hífens: base32hex, e nunca o de uma reunião (só hexadecimal)", () => {
    expect(servico.idDoEventoDaAcao(ID)).toBe(EVENTO);
    expect(servico.idDoEventoDaAcao(ID)).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(servico.idDoEventoDaAcao(ID)).not.toMatch(/^[0-9a-f]+$/);
  });

  it("às 9h do prazo no fuso, 30 minutos, livre, com aviso na hora; o texto da tela e o endereço da ação", () => {
    const acao = { id: ID, texto: "{F2} envia a proposta", detalhe: "Com desconto", responsavel: "{F3}", vozes: { F2: "Carla" }, prazo: PRAZO, feita: false, google: null, updatedAt: FICHA };
    expect(servico.corpoDoEventoDaAcao(acao, CONTEXTO)).toEqual({
      summary: "Carla envia a proposta",
      description: `Com desconto\n\nResponsável: Falante 3\n\nhttps://wrwglobal.org/proximas-acoes?acao=${ID}`,
      start: { dateTime: "2026-11-20T12:00:00.000Z", timeZone: SP },
      end: { dateTime: "2026-11-20T12:30:00.000Z", timeZone: SP },
      transparency: "transparent",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
      status: "confirmed",
    });
    // Nenhum convidado, nunca.
    expect(servico.corpoDoEventoDaAcao(acao, CONTEXTO)).not.toHaveProperty("attendees");
    expect(servico.corpoDoEventoDaAcao({ ...acao, prazo: null }, CONTEXTO)).toBeNull();
  });

  it("o contexto do pedido: fuso canônico ou o padrão; rótulos fora da forma caem nos sem tradução", () => {
    expect(servico.contextoDoPedido(CONTA, { fuso: "america/recife", rotulos: ROTULOS })).toMatchObject({ fuso: "America/Recife", rotulos: ROTULOS });
    expect(servico.contextoDoPedido(CONTA, { fuso: "Lugar/Nenhum", rotulos: { voz: "sem lugar", responsavel: "{nome}" } }))
      .toMatchObject({ fuso: SP, rotulos: { voz: "F{n}", responsavel: "{nome}" } });
    expect(servico.contextoDoPedido(CONTA).fuso).toBe(SP);
  });
});

describe("mandar a ação para a Google", () => {
  it("a que nunca foi: fica 'pendente' antes da chamada, cria o evento e grava 'ok' com a dona e a ficha", async () => {
    estado.linhas.push([linha()]);
    const d = deps(json({ id: EVENTO }));
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d })).toEqual({ naGoogle: "ok" });
    expect(tipos()).toEqual(["select", "update", "google:POST", "update"]);
    const [pendente, resultado] = updates();
    expect(pendente).toMatchObject({ valores: { google: "pendente" }, sql: DA_DONA, params: [ID, "dona-1"] });
    expect(resultado).toMatchObject({ valores: { google: "ok" }, sql: NA_FICHA, params: [ID, "dona-1", FICHA] });
    const [criacao] = chamadasDaGoogle();
    expect(criacao.url).toBe(`${URL_DOS_EVENTOS}?sendUpdates=none`);
    expect(criacao.corpo).toMatchObject({ id: EVENTO, summary: "Carla envia a proposta", transparency: "transparent" });
    expect(d.token).toHaveBeenCalledWith(7);
  });

  it("o token já lido (antes da escrita) não é lido de novo; a já 'pendente' não é marcada outra vez", async () => {
    estado.linhas.push([linha({ google: "pendente" })]);
    const d = deps(json({ id: EVENTO }));
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d, acesso: { token: "ja-lido" } })).toEqual({ naGoogle: "ok" });
    expect(d.token).not.toHaveBeenCalled();
    expect(tipos()).toEqual(["select", "google:POST", "update"]);
  });

  it("o evento que já existe (409) vira PATCH, sem duplicar", async () => {
    estado.linhas.push([linha({ google: "pendente" })]);
    const d = deps(erroDaGoogle(409, "duplicate"), json({ id: EVENTO }));
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d })).toEqual({ naGoogle: "ok" });
    const [, mudanca] = chamadasDaGoogle();
    expect(mudanca).toMatchObject({ metodo: "PATCH", url: `${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=none` });
    expect(mudanca.corpo).not.toHaveProperty("id");
  });

  it("feita, sem prazo, ou do dia encerrado que nunca foi: nada sai do banco para a Google", async () => {
    for (const extra of [{ feita: 1 }, { prazo: null }]) {
      estado.linhas.push([linha(extra)]);
      const d = deps();
      expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d })).toEqual({ naGoogle: null });
      expect(d.token).not.toHaveBeenCalled();
    }
    estado.linhas.push([linha()]);
    const depois = deps();
    depois.agora.mockReturnValue(DEPOIS);
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: depois })).toEqual({ naGoogle: null });
    expect(tipos()).toEqual(["select", "select", "select"]);
  });

  it("do dia encerrado que está lá: só PATCH, sem criar; o que sumiu de lá volta a nulo", async () => {
    estado.linhas.push([linha({ google: "ok" })]);
    const d = deps(erroDaGoogle(404, "notFound"));
    d.agora.mockReturnValue(DEPOIS);
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d })).toEqual({ naGoogle: null });
    expect(tipos()).toEqual(["select", "update", "google:PATCH", "update"]);
    expect(updates()[1]).toMatchObject({ valores: { google: null }, sql: NA_FICHA });
  });

  it("sem a Google Agenda conectada: a que estava lá fica 'falhou'; a que nunca foi não é tocada", async () => {
    estado.linhas.push([linha({ google: "ok" })]);
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: semConexao(deps()) })).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(updates()).toEqual([expect.objectContaining({ valores: { google: "falhou" }, sql: NA_FICHA })]);
    estado.efeitos.length = 0;
    estado.linhas.push([linha()]);
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: semConexao(deps()) })).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(updates()).toEqual([]);
  });

  it("a Google recusa: 'falhou' com o motivo, para o 'Tentar de novo'; a conexão revogada pede reconectar", async () => {
    estado.linhas.push([linha({ google: "pendente" })]);
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: deps(erroDaGoogle(403, "forbidden")) })).toEqual({ naGoogle: "falhou", motivo: "google" });
    expect(updates().at(-1)).toMatchObject({ valores: { google: "falhou" }, sql: NA_FICHA });
    estado.linhas.push([linha({ google: "pendente" })]);
    const d = deps(erroDaGoogle(401, "authError"));
    d.renovar.mockRejectedValue(new ConexaoGoogleRevogada());
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d })).toEqual({ naGoogle: "falhou", motivo: "revogada" });
  });

  it("a ação mudou durante a chamada só no que não vai ao evento (o contato): ainda fica 'ok', na ficha nova", async () => {
    estado.linhas.push([linha({ google: "pendente" })], [linha({ google: "pendente", updatedAt: FICHA + 5 })]);
    estado.afetadas.push(0, 1);
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: deps(json({ id: EVENTO })) })).toEqual({ naGoogle: "ok" });
    expect(updates().map(u => u.params)).toEqual([[ID, "dona-1", FICHA], [ID, "dona-1", FICHA + 5]]);
  });

  it("a ação mudou o texto durante a chamada: o 'ok' não passa por cima (quem mudou manda a versão dele)", async () => {
    estado.linhas.push([linha({ google: "pendente" })], [linha({ google: "pendente", texto: "Outro texto", updatedAt: FICHA + 5 })]);
    estado.afetadas.push(0);
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: deps(json({ id: EVENTO })) })).toEqual({ naGoogle: "ok" });
    expect(updates()).toHaveLength(1);
  });

  it("a ação foi feita (ou apagada) durante a chamada: o evento recém-criado sai, para não ficar órfão", async () => {
    estado.linhas.push([linha({ google: "pendente" })], [linha({ feita: 1, google: null, updatedAt: FICHA + 5 })]);
    estado.afetadas.push(0);
    const d = deps(json({ id: EVENTO }), new Response(null, { status: 204 }));
    expect(await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d })).toEqual({ naGoogle: "ok" });
    expect(chamadasDaGoogle().map(c => c.metodo)).toEqual(["POST", "DELETE"]);
    estado.efeitos.length = 0;
    estado.linhas.push([linha({ google: "pendente" })], []);
    estado.afetadas.push(0);
    await servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: deps(json({ id: EVENTO }), new Response(null, { status: 404 })) });
    expect(chamadasDaGoogle().map(c => c.metodo)).toEqual(["POST", "DELETE"]);
  });

  it("a ação que não é da dona (ou saiu): NOT_FOUND, e nada vai à Google", async () => {
    const d = deps();
    await expect(servico.enviarAcaoParaGoogle(CONTA, ID, CONTEXTO, { deps: d })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(efeitos()[0]).toMatchObject({ tipo: "select", sql: DA_DONA, params: [ID, "dona-1"] });
    expect(d.buscar).not.toHaveBeenCalled();
  });
});

describe("tirar o evento da Google", () => {
  it("DELETE pelo id da ação, sem avisar ninguém; o que não existe conta como tirado", async () => {
    const d = deps(new Response(null, { status: 404 }));
    expect(await servico.tirarAcaoDaGoogle(CONTA, ID, { estavaNaGoogle: true, deps: d })).toEqual({ naGoogle: "ok" });
    expect(chamadasDaGoogle()[0]).toMatchObject({ metodo: "DELETE", url: `${URL_DOS_EVENTOS}/${EVENTO}?sendUpdates=none` });
    expect(await servico.tirarAcaoDaGoogle(CONTA, ID, { estavaNaGoogle: false, deps: deps(new Response(null, { status: 204 })) })).toEqual({ naGoogle: null });
  });

  it("a falha só vira 'falhou' quando a ação estava lá; senão, só o log", async () => {
    expect(await servico.tirarAcaoDaGoogle(CONTA, ID, { estavaNaGoogle: true, deps: deps(erroDaGoogle(500, "backendError")) })).toEqual({ naGoogle: "falhou", motivo: "google" });
    expect(await servico.tirarAcaoDaGoogle(CONTA, ID, { estavaNaGoogle: false, deps: deps(erroDaGoogle(500, "backendError")) })).toEqual({ naGoogle: null });
    expect(await servico.tirarAcaoDaGoogle(CONTA, ID, { estavaNaGoogle: true, deps: semConexao(deps()) })).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
    expect(await servico.tirarAcaoDaGoogle(CONTA, ID, { estavaNaGoogle: false, deps: semConexao(deps()) })).toEqual({ naGoogle: null });
  });

  it("o 'Tentar de novo' da retirada recusa a ação que continua aberta e com prazo", async () => {
    estado.linhas.push([linha()]);
    await expect(servico.tirarDaGoogleAAcaoQueSaiu(CONTA, ID, deps())).rejects.toMatchObject({ code: "CONFLICT", message: servico.MENSAGEM_ACAO_AINDA_NA_AGENDA });
    estado.linhas.push([linha({ feita: 1 })]);
    expect(await servico.tirarDaGoogleAAcaoQueSaiu(CONTA, ID, deps(new Response(null, { status: 204 })))).toEqual({ naGoogle: "ok" });
    estado.linhas.push([]);
    expect(await servico.tirarDaGoogleAAcaoQueSaiu(CONTA, ID, deps(new Response(null, { status: 410 })))).toEqual({ naGoogle: "ok" });
  });
});

describe("as mutações da lista", () => {
  it("anotar com prazo por vir: o token antes da escrita, a ação nasce 'pendente' e vai para a Google", async () => {
    estado.linhas.push([linha({ google: "pendente" })]);
    const d = deps(json({ id: EVENTO }));
    expect(await servico.criarAcaoComAGoogle(CONTA, { texto: "Mandar", prazo: PRAZO }, { fuso: SP, rotulos: ROTULOS }, d)).toEqual({ id: ID, naGoogle: "ok" });
    expect(escritas.criarProximaAcao).toHaveBeenCalledWith("dona-1", { texto: "Mandar", prazo: PRAZO }, { naGoogle: true });
    expect(d.token.mock.invocationCallOrder[0]).toBeLessThan(escritas.criarProximaAcao.mock.invocationCallOrder[0]);
  });

  it("anotar sem prazo, ou sem a Google Agenda: nada de token nem de Google", async () => {
    const d = deps();
    expect(await servico.criarAcaoComAGoogle(CONTA, { texto: "Mandar" }, {}, d)).toEqual({ id: ID, naGoogle: null });
    expect(d.token).not.toHaveBeenCalled();
    expect(escritas.criarProximaAcao).toHaveBeenLastCalledWith("dona-1", { texto: "Mandar" }, { naGoogle: false });
    expect(await servico.criarAcaoComAGoogle(CONTA, { texto: "Mandar", prazo: PRAZO }, {}, semConexao(deps()))).toEqual({ id: ID, naGoogle: null });
    expect(escritas.criarProximaAcao).toHaveBeenLastCalledWith("dona-1", { texto: "Mandar", prazo: PRAZO }, { naGoogle: false });
  });

  it("a conexão quebrada conta como ligada: a ação vai 'pendente' e volta 'falhou' com o motivo, para a tela pedir reconectar", async () => {
    estado.linhas.push([linha({ google: "pendente" })]);
    const d = deps();
    d.token.mockRejectedValue(new ConexaoGoogleRevogada());
    expect(await servico.criarAcaoComAGoogle(CONTA, { texto: "Mandar", prazo: PRAZO }, {}, d)).toEqual({ id: ID, naGoogle: "falhou", motivo: "revogada" });
    expect(escritas.criarProximaAcao).toHaveBeenLastCalledWith("dona-1", expect.anything(), { naGoogle: true });
  });

  it("editar: a ação sem prazo antes nem depois não lê o token; tirar o prazo tira o evento", async () => {
    estado.linhas.push([linha({ prazo: null })]);
    const d = deps();
    escritas.editarProximaAcao.mockResolvedValueOnce({ destino: "tirar", googleAntes: null });
    expect(await servico.editarAcaoComAGoogle(CONTA, ID, { texto: "x" }, {}, d)).toEqual({ naGoogle: null });
    expect(d.token).not.toHaveBeenCalled();
    expect(escritas.editarProximaAcao).toHaveBeenCalledWith("dona-1", ID, { texto: "x" }, { naGoogle: false, fuso: SP, agora: ANTES });

    estado.linhas.push([linha({ google: "ok" })]);
    const tira = deps(new Response(null, { status: 204 }));
    escritas.editarProximaAcao.mockResolvedValueOnce({ destino: "tirar", googleAntes: "ok" });
    expect(await servico.editarAcaoComAGoogle(CONTA, ID, { prazo: null }, {}, tira)).toEqual({ naGoogle: "ok" });
    expect(chamadasDaGoogle().at(-1)).toMatchObject({ metodo: "DELETE" });
    expect(tira.token.mock.invocationCallOrder[0]).toBeLessThan(escritas.editarProximaAcao.mock.invocationCallOrder[1]);
  });

  it("editar o texto da ação com prazo: a versão nova vai para a Google", async () => {
    estado.linhas.push([linha({ google: "ok" })], [linha({ google: "pendente", texto: "Novo" })]);
    escritas.editarProximaAcao.mockResolvedValueOnce({ destino: "gravar", googleAntes: "ok" });
    const d = deps(erroDaGoogle(409, "duplicate"), json({ id: EVENTO }));
    expect(await servico.editarAcaoComAGoogle(CONTA, ID, { texto: "Novo" }, { rotulos: ROTULOS }, d)).toEqual({ naGoogle: "ok" });
    expect(chamadasDaGoogle().at(-1)?.corpo).toMatchObject({ summary: "Novo" });
  });

  it("marcar feita tira o evento; reabrir manda de novo; o que não tem prazo nem pergunta à Google", async () => {
    estado.linhas.push([linha({ google: "ok" })]);
    escritas.marcarProximaAcaoFeita.mockResolvedValueOnce({ prazo: PRAZO, googleAntes: "ok" });
    expect(await servico.marcarAcaoFeitaComAGoogle(CONTA, ID, true, {}, deps(new Response(null, { status: 204 })))).toEqual({ naGoogle: "ok" });
    expect(chamadasDaGoogle().map(c => c.metodo)).toEqual(["DELETE"]);

    estado.efeitos.length = 0;
    estado.linhas.push([linha({ feita: 1 })], [linha()]);
    escritas.marcarProximaAcaoFeita.mockResolvedValueOnce({ prazo: PRAZO, googleAntes: null });
    expect(await servico.marcarAcaoFeitaComAGoogle(CONTA, ID, false, { rotulos: ROTULOS }, deps(json({ id: EVENTO })))).toEqual({ naGoogle: "ok" });
    expect(chamadasDaGoogle().map(c => c.metodo)).toEqual(["POST"]);

    estado.linhas.push([linha({ prazo: null })]);
    const sem = deps();
    escritas.marcarProximaAcaoFeita.mockResolvedValueOnce({ prazo: null, googleAntes: null });
    expect(await servico.marcarAcaoFeitaComAGoogle(CONTA, ID, true, {}, sem)).toEqual({ naGoogle: null });
    expect(sem.token).not.toHaveBeenCalled();
  });

  it("apagar a ação que estava lá tira o evento; sem a Google Agenda agora, avisa que ele ficou", async () => {
    estado.linhas.push([linha({ google: "ok" })]);
    escritas.apagarProximaAcao.mockResolvedValueOnce({ prazo: PRAZO, googleAntes: "ok" });
    expect(await servico.apagarAcaoComAGoogle(CONTA, ID, deps(new Response(null, { status: 204 })))).toEqual({ naGoogle: "ok" });
    estado.linhas.push([linha({ google: "ok" })]);
    escritas.apagarProximaAcao.mockResolvedValueOnce({ prazo: PRAZO, googleAntes: "ok" });
    expect(await servico.apagarAcaoComAGoogle(CONTA, ID, semConexao(deps()))).toEqual({ naGoogle: "falhou", motivo: "nao-conectada" });
  });

  it("a ação de outra dona: NOT_FOUND antes de qualquer escrita ou token", async () => {
    const d = deps();
    await expect(servico.apagarAcaoComAGoogle(CONTA, ID, d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.marcarAcaoFeitaComAGoogle(CONTA, ID, true, {}, d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.editarAcaoComAGoogle(CONTA, ID, { texto: "x" }, {}, d)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(d.token).not.toHaveBeenCalled();
    expect(escritas.apagarProximaAcao).not.toHaveBeenCalled();
    expect(escritas.marcarProximaAcaoFeita).not.toHaveBeenCalled();
    expect(escritas.editarProximaAcao).not.toHaveBeenCalled();
  });
});

describe("pelo resumo da reunião", () => {
  it("a ação do item com prazo: o token antes; desconfirmada ou feita, o evento sai, com o id dela na resposta", async () => {
    estado.linhas.push([{ id: ID, prazo: PRAZO, google: "ok" }]);
    const d = deps(erroDaGoogle(500, "backendError"));
    const preparo = await servico.prepararAcaoDoItem(CONTA, "item-1", d);
    expect(preparo).toMatchObject({ acaoId: ID, estavaNaGoogle: true, ligada: true });
    expect(efeitos()[0]).toMatchObject({ sql: "(`proximas_acoes`.`owner_id` = ? and `proximas_acoes`.`item_id` = ?)", params: ["dona-1", "item-1"] });
    expect(await servico.depoisDeMexerNoItem(CONTA, preparo, false, {}, d)).toEqual({ acaoId: ID, naGoogle: "falhou", motivo: "google" });
  });

  it("sem ação, ou sem prazo: nada, nem o token", async () => {
    const d = deps();
    estado.linhas.push([]);
    expect(await servico.prepararAcaoDoItem(CONTA, "item-1", d)).toBeNull();
    estado.linhas.push([{ id: ID, prazo: null, google: null }]);
    expect(await servico.prepararAcaoDoItem(CONTA, "item-1", d)).toBeNull();
    expect(d.token).not.toHaveBeenCalled();
    expect(await servico.depoisDeMexerNoItem(CONTA, null, false)).toEqual({ acaoId: null, naGoogle: null });
  });

  it("reaberta no resumo, com a Google Agenda: volta para lá; sem ela, nada", async () => {
    estado.linhas.push([linha()]);
    const d = deps(json({ id: EVENTO }));
    const preparo = { acaoId: ID, estavaNaGoogle: false, acesso: { token: "token-1" }, ligada: true };
    expect(await servico.depoisDeMexerNoItem(CONTA, preparo, true, { rotulos: ROTULOS }, d)).toEqual({ acaoId: ID, naGoogle: "ok" });
    expect(await servico.depoisDeMexerNoItem(CONTA, { ...preparo, ligada: false, acesso: { motivo: "nao-conectada" as const } }, true, {}, d))
      .toEqual({ acaoId: ID, naGoogle: null });
  });
});
