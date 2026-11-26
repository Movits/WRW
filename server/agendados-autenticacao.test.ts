import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@shared/_core/errors";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Endpoints de cron (/api/scheduled/*) — a resposta a quem chega sem sessão.
 *
 * Revisão adversarial da PR de Reuniões: `sdk.authenticateRequest` lança
 * quando não há cookie válido, e os três endpoints o chamavam dentro do try
 * genérico — uma chamada anônima respondia 500 "Invalid session cookie", que
 * um agendador externo leria como "o servidor quebrou". Agora a autenticação
 * é um passo próprio (server/_core/cron.ts): sem sessão é 401, sessão de
 * usuária comum é 403, e o try do endpoint só cobre o trabalho em si.
 *
 * Os handlers vivem inline em startServer, e index.ts chama startServer ao
 * carregar. Em vez de ler o código-fonte (o que provaria o texto, não o
 * comportamento — um `if (!user)` sem `return` continuaria "contendo" a
 * guarda), o index.ts REAL sobe aqui numa jarra: o express é um dublê que só
 * guarda as rotas registradas, http/net não abrem porta, e tudo que toca
 * banco, bucket ou rede está mockado. Cada handler é então chamado com
 * req/res falsos, e o que se assevera é o que ele FAZ: o trabalho não roda
 * sem sessão de cron, roda uma vez com ela, e a resposta/auditoria batem.
 */

const jarra = vi.hoisted(() => {
  type Handler = (req: unknown, res: unknown) => Promise<unknown>;
  const rotas = new Map<string, Handler>();
  // A ordem do que o index.ts monta: a rota das partes (G5) tem de vir antes
  // do express.json e do urlencoded, que leriam o corpo binário primeiro.
  const ordem: string[] = [];
  const leitorJson = Object.assign((_req: unknown, _res: unknown, next?: () => void) => next?.(), { leitor: "json" });
  const leitorUrlencoded = Object.assign((_req: unknown, _res: unknown, next?: () => void) => next?.(), { leitor: "urlencoded" });
  let servidorNoAr: () => void = () => {};
  let subidaFalhou: (erro: unknown) => void = () => {};
  const noAr = new Promise<void>((resolve, reject) => { servidorNoAr = resolve; subidaFalhou = reject; });
  const passa = (_req: unknown, _res: unknown, next?: () => void) => next?.();
  const app = {
    set: () => app,
    use: (...args: unknown[]) => {
      const ultimo = args.at(-1) as { leitor?: string; name?: string } | undefined;
      if (ultimo?.leitor) ordem.push(`${ultimo.leitor}${typeof args[0] === "string" ? ` ${args[0]}` : ""}`);
      else if (ultimo?.name === "tratarCorpoGrandeDasPartes") ordem.push("tratador das partes");
      else if (ultimo?.name === "tratarCorpoGrandeDoWebhookDaSala") ordem.push("tratador do webhook da sala");
      return app;
    },
    get: () => app,
    // O último argumento é o handler: a rota das partes passa o leitor de corpo antes dele.
    post: (caminho: string, ...handlers: Handler[]) => { rotas.set(caminho, handlers[handlers.length - 1]); ordem.push(`post ${caminho}`); return app; },
  };
  return { rotas, ordem, leitorJson, leitorUrlencoded, noAr, servidorNoAr: () => servidorNoAr(), subidaFalhou: (erro: unknown) => subidaFalhou(erro), passa, app };
});

const authenticateRequest = vi.fn();
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: (...args: unknown[]) => authenticateRequest(...args) } }));

// --- a jarra: o que startServer toca e não é o que está em teste ---
vi.mock("express", () => {
  const fabrica = Object.assign(() => jarra.app, { json: () => jarra.leitorJson, urlencoded: () => jarra.leitorUrlencoded, raw: () => jarra.passa, static: () => jarra.passa });
  return { default: fabrica, ...fabrica };
});
vi.mock("http", () => {
  const createServer = () => ({ listen: (_porta: number, aoSubir?: () => void) => { jarra.ordem.push("listen"); aoSubir?.(); jarra.servidorNoAr(); }, close: (aoFechar?: () => void) => aoFechar?.() });
  return { default: { createServer }, createServer };
});
vi.mock("net", () => {
  // findAvailablePort (fora de produção) sonda a porta com net.createServer:
  // aqui toda porta está "livre", sem tocar a máquina.
  const createServer = () => ({ listen: (_porta: number, aoSubir?: () => void) => aoSubir?.(), close: (aoFechar?: () => void) => aoFechar?.(), on: () => {} });
  return { default: { createServer }, createServer };
});
vi.mock("@trpc/server/adapters/express", () => ({ createExpressMiddleware: () => jarra.passa }));
vi.mock("./_core/storageProxy", () => ({ registerStorageProxy: () => {} }));
vi.mock("./routers", () => ({ appRouter: {} }));
vi.mock("./_core/context", () => ({ createContext: () => ({}) }));
vi.mock("./_core/vite", () => ({ serveStatic: () => {}, setupVite: async () => {} }));

const cleanupExpiredSessions = vi.fn(async () => 0);
const createAuditLog = vi.fn(async () => {});
vi.mock("./security", () => ({
  cleanupExpiredSessions: (...args: unknown[]) => cleanupExpiredSessions(...(args as [])),
  createAuditLog: (...args: unknown[]) => createAuditLog(...(args as [])),
}));
const limparGravacoesVencidas = vi.fn(async () => ({ encontradas: 0, apagadas: 0 }));
const marcarReunioesInterrompidas = vi.fn(async () => ({ encontradas: 0, marcadas: 0 }));
// A fila da reunião em partes (G7) liga no boot com banco; aqui é dublê.
const fila = vi.hoisted(() => ({ iniciarFila: vi.fn(), pararFila: vi.fn(async () => ({ partes: 2, reunioes: 1 })) }));
vi.mock("./fila-de-transcricao", () => fila);
const filaDoResumo = vi.hoisted(() => ({ iniciarFilaDoResumo: vi.fn(), pararFilaDoResumo: vi.fn(async () => ({ resumos: 1 })) }));
vi.mock("./fila-do-resumo", () => filaDoResumo);
// O laço da varredura das gravações vencidas liga no boot com banco, depois do
// listen, e para no desligar junto com as filas; aqui é dublê (o laço em si está
// em server/varredura-de-gravacoes.test.ts).
const varredura = vi.hoisted(() => ({
  iniciarVarreduraDeGravacoes: vi.fn(),
  pararVarreduraDeGravacoes: vi.fn(async () => ({ emCurso: false, terminou: true })),
}));
vi.mock("./varredura-de-gravacoes", () => ({
  iniciarVarreduraDeGravacoes: (...args: unknown[]) => { jarra.ordem.push("iniciarVarredura"); return varredura.iniciarVarreduraDeGravacoes(...args); },
  pararVarreduraDeGravacoes: (...args: unknown[]) => varredura.pararVarreduraDeGravacoes(...(args as [])),
}));
// O laço dos lembretes no sino (H15) liga junto; aqui é dublê.
const lacoDosLembretes = vi.hoisted(() => ({ iniciarLembretes: vi.fn(), pararLembretes: vi.fn(async () => ({ lembretes: 1 })) }));
vi.mock("./lembretes", () => lacoDosLembretes);
// A fila do cruzamento grande (N4b) liga junto; aqui é dublê (o laço em si está em
// server/indice-e-fila-de-cruzamento.integracao.test.ts).
const filaDoCruzamento = vi.hoisted(() => ({ iniciarFilaDeCruzamento: vi.fn(), pararFilaDeCruzamento: vi.fn(async () => ({ trabalhos: 0 })) }));
vi.mock("./fila-de-cruzamento", () => filaDoCruzamento);
// O laço do push no celular liga junto; aqui é dublê.
const lacoDoPush = vi.hoisted(() => ({ iniciarPush: vi.fn(), pararPush: vi.fn() }));
vi.mock("./push-no-celular", () => lacoDoPush);
// A rota das partes (G5) sobe junto; o recebimento é dublê (nada toca banco nem bucket).
vi.mock("./fatias-de-reuniao", () => ({
  receberParte: vi.fn(), RecusaDaParte: class extends Error {}, FalhaPassageiraDaParte: class extends Error {}, TAMANHO_MAXIMO_DA_PARTE: 16 * 1024 * 1024,
}));
vi.mock("./meeting-service", () => ({
  limparGravacoesVencidas: (...args: unknown[]) => limparGravacoesVencidas(...(args as [])),
  marcarReunioesInterrompidas: (...args: unknown[]) => marcarReunioesInterrompidas(...(args as [])),
}));
// A ida e a volta da conexão com a Google Agenda (H16b) sobem junto; aqui só se
// confere que foram montadas no app (o comportamento está em
// server/rotas-da-google-agenda.test.ts).
const googleAgenda = vi.hoisted(() => ({ registrarRotasDaGoogleAgenda: vi.fn() }));
vi.mock("./rotas-da-google-agenda", () => googleAgenda);

const { autenticarCron } = await import("./_core/cron");

// Com DATABASE_URL o boot varre as reuniões presas (contra o mock acima) e
// agenda a varredura periódica; o setInterval é falso para o teste avançar
// os 5 min sem esperar. NODE_ENV não é "production": nada de migração.
const databaseUrlAntes = process.env.DATABASE_URL;
process.env.DATABASE_URL = "mysql://jarra";
vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { jarra.subidaFalhou(args[0]); });
vi.spyOn(console, "log").mockImplementation(() => {});
await import("./_core/index");
await jarra.noAr;
const varredurasNoBoot = marcarReunioesInterrompidas.mock.calls.length;
// Lido antes do restoreAllMocks, que zera o histórico dos dublês.
const appsDaGoogleAgendaNoBoot = googleAgenda.registrarRotasDaGoogleAgenda.mock.calls.map(chamada => chamada[0]);
vi.restoreAllMocks();
afterAll(() => {
  vi.useRealTimers();
  if (databaseUrlAntes === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrlAntes;
});

const requisicao = (rota = "mark-interrupted-meetings") => ({ url: `/api/scheduled/${rota}`, headers: {} }) as never;
function resposta() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
const SESSAO_DE_CRON = { id: -1, openId: "cron_tarefa", isCron: true, taskUid: "uid-1" };
const USUARIA_COMUM = { id: 7, openId: "dona-1", isCron: false };

beforeEach(() => {
  authenticateRequest.mockReset();
  cleanupExpiredSessions.mockClear();
  limparGravacoesVencidas.mockClear();
  marcarReunioesInterrompidas.mockClear();
  createAuditLog.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("a fila da reunião em partes no index.ts real (G7)", () => {
  it("as duas filas, o laço dos lembretes e a varredura das gravações ligam no boot com banco, e o SIGTERM para os quatro ANTES de o processo sair", async () => {
    expect(fila.iniciarFila).toHaveBeenCalledTimes(1);
    expect(filaDoResumo.iniciarFilaDoResumo).toHaveBeenCalledTimes(1);
    expect(varredura.iniciarVarreduraDeGravacoes).toHaveBeenCalledTimes(1);
    expect(lacoDosLembretes.iniciarLembretes).toHaveBeenCalledTimes(1);
    expect(filaDoCruzamento.iniciarFilaDeCruzamento).toHaveBeenCalledTimes(1);
    expect(lacoDoPush.iniciarPush).toHaveBeenCalledTimes(1);
    const sair = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const ordem: string[] = [];
    fila.pararFila.mockImplementationOnce(async () => { ordem.push("pararFila"); return { partes: 2, reunioes: 1 }; });
    // A falha da fila do resumo não segura a saída nem a parada dos outros laços.
    filaDoResumo.pararFilaDoResumo.mockImplementationOnce(async () => { ordem.push("pararFilaDoResumo"); throw new Error("banco caiu"); });
    // A varredura das gravações termina por último (a passada em curso estourou
    // a espera): a saída espera por ela também, como pelas filas.
    let soltarVarredura: () => void = () => {};
    varredura.pararVarreduraDeGravacoes.mockImplementationOnce(() => new Promise(resolver => {
      soltarVarredura = () => { ordem.push("pararVarredura"); resolver({ emCurso: true, terminou: false }); };
    }));
    lacoDosLembretes.pararLembretes.mockImplementationOnce(async () => { ordem.push("pararLembretes"); return { lembretes: 1 }; });
    vi.spyOn(console, "error").mockImplementation(() => {});
    sair.mockImplementation(((codigo?: number) => { ordem.push(`exit ${codigo}`); }) as never);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    process.emit("SIGTERM");
    // Só microtarefas: o setInterval deste arquivo é falso, e o vi.waitFor o
    // avançaria, disparando a varredura que o teste seguinte conta.
    const esperar = async () => { for (let i = 0; i < 20 && ordem.at(-1) !== "exit 0"; i++) await new Promise(resolve => setImmediate(resolve)); };
    await esperar();
    expect(varredura.pararVarreduraDeGravacoes).toHaveBeenCalledTimes(1);
    expect(filaDoCruzamento.pararFilaDeCruzamento).toHaveBeenCalledTimes(1);
    // O push só para de procurar avisos: não há reserva a devolver.
    expect(lacoDoPush.pararPush).toHaveBeenCalledTimes(1);
    expect(ordem).toEqual(["pararFila", "pararFilaDoResumo", "pararLembretes"]);
    soltarVarredura();
    await esperar();
    expect(ordem).toEqual(["pararFila", "pararFilaDoResumo", "pararLembretes", "pararVarredura", "exit 0"]);
    expect(JSON.stringify(logs.mock.calls)).toContain("a passada em curso fica para a próxima instância");
    // O SIGINT do dev também está ligado (process.once: um por sinal).
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
  });

  it("a varredura das gravações liga uma vez, DEPOIS do listen: a subida não espera o bucket", () => {
    expect(jarra.ordem.filter(item => item === "iniciarVarredura")).toHaveLength(1);
    expect(jarra.ordem.indexOf("listen")).toBeGreaterThanOrEqual(0);
    expect(jarra.ordem.indexOf("iniciarVarredura")).toBeGreaterThan(jarra.ordem.indexOf("listen"));
  });
});

describe("as rotas da Google Agenda no index.ts real (H16b)", () => {
  it("são montadas uma vez, no app do servidor", () => {
    expect(appsDaGoogleAgendaNoBoot).toEqual([jarra.app]);
  });
});

describe("ordem no index.ts real", () => {
  it("a rota binária das partes (G5) é montada ANTES de todo express.json e do urlencoded", () => {
    const rota = jarra.ordem.indexOf("post /api/reunioes/:meetingId/partes/:seq");
    expect(rota).toBeGreaterThanOrEqual(0);
    const leitores = jarra.ordem.map((item, i) => [item, i] as const).filter(([item]) => item.startsWith("json") || item.startsWith("urlencoded"));
    expect(leitores.length).toBeGreaterThan(5);
    for (const [, i] of leitores) expect(i).toBeGreaterThan(rota);
    // O 413 em JSON da rota: o tratador vem logo depois dela (sem ele, o
    // Express responderia HTML ao corpo grande).
    expect(jarra.ordem.indexOf("tratador das partes")).toBe(rota + 1);
  });

  it("a rota binária do documento (H12) também vem antes de todo leitor de corpo e do tratador do 413", () => {
    const rota = jarra.ordem.indexOf("post /api/reunioes/:meetingId/documento");
    expect(rota).toBeGreaterThanOrEqual(0);
    const leitores = jarra.ordem.map((item, i) => [item, i] as const).filter(([item]) => item.startsWith("json") || item.startsWith("urlencoded"));
    for (const [, i] of leitores) expect(i).toBeGreaterThan(rota);
    expect(jarra.ordem.indexOf("tratador das partes")).toBeGreaterThan(rota);
  });

  it("a rota dos avisos do Daily (sala de vídeo, V1) vem antes de todo leitor de corpo: a assinatura é sobre o corpo cru", () => {
    const rota = jarra.ordem.indexOf("post /api/sala-de-video/avisos");
    expect(rota).toBeGreaterThanOrEqual(0);
    const leitores = jarra.ordem.map((item, i) => [item, i] as const).filter(([item]) => item.startsWith("json") || item.startsWith("urlencoded"));
    expect(leitores.length).toBeGreaterThan(5);
    for (const [, i] of leitores) expect(i).toBeGreaterThan(rota);
    // O 413 em JSON da rota vem logo depois dela.
    expect(jarra.ordem.indexOf("tratador do webhook da sala")).toBe(rota + 1);
  });
});

describe("autenticarCron — sem sessão é 401, usuária comum é 403, cron passa", () => {
  it("cookie ausente ou inválido: 401 (não 500) e o endpoint não segue", async () => {
    authenticateRequest.mockRejectedValue(new HttpError(403, "Invalid session cookie"));
    const res = resposta();

    expect(await autenticarCron(requisicao(), res as never)).toBeNull();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Sessão de cron ausente ou inválida." });
  });

  it("qualquer falha da autenticação (banco fora, sessão revogada) também é 401 — nunca a mensagem interna", async () => {
    authenticateRequest.mockRejectedValue(new Error("Banco de dados indisponível; tente de novo em instantes"));
    const res = resposta();

    expect(await autenticarCron(requisicao(), res as never)).toBeNull();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("Banco de dados");
  });

  it("sessão de usuária comum: 403, rota é só de cron", async () => {
    authenticateRequest.mockResolvedValue(USUARIA_COMUM);
    const res = resposta();

    expect(await autenticarCron(requisicao(), res as never)).toBeNull();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "cron-only endpoint" });
  });

  it("sessão de cron: devolve a sessão (com taskUid) e não responde nada", async () => {
    authenticateRequest.mockResolvedValue(SESSAO_DE_CRON);
    const res = resposta();

    expect(await autenticarCron(requisicao(), res as never)).toBe(SESSAO_DE_CRON);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

// Cada rota, o trabalho que ela dispara, o que ele devolve e como isso vira
// resposta e auditoria. cleanup-sessions é a exceção de forma: o trabalho
// devolve um número, que vai como `cleaned` na resposta e `cleanedCount` na
// auditoria.
const ROTAS = [
  {
    rota: "cleanup-sessions", trabalho: cleanupExpiredSessions, devolve: 3,
    acao: "CRON_CLEANUP_SESSIONS", recurso: "sessions", naResposta: { cleaned: 3 }, naAuditoria: { cleanedCount: 3 },
  },
  {
    rota: "cleanup-recordings", trabalho: limparGravacoesVencidas, devolve: { encontradas: 2, apagadas: 1 },
    acao: "CRON_CLEANUP_RECORDINGS", recurso: "meeting_recordings", naResposta: { encontradas: 2, apagadas: 1 }, naAuditoria: { encontradas: 2, apagadas: 1 },
  },
  {
    rota: "mark-interrupted-meetings", trabalho: marcarReunioesInterrompidas, devolve: { encontradas: 1, marcadas: 1 },
    acao: "CRON_MARK_INTERRUPTED_MEETINGS", recurso: "meetings", naResposta: { encontradas: 1, marcadas: 1 }, naAuditoria: { encontradas: 1, marcadas: 1 },
  },
] as const;
const handlerDe = (rota: string) => {
  const handler = jarra.rotas.get(`/api/scheduled/${rota}`);
  expect(handler, `POST /api/scheduled/${rota} não foi registrado`).toBeDefined();
  return handler!;
};
const trabalhos = () => ROTAS.map(({ trabalho }) => trabalho);

describe("os três endpoints /api/scheduled/* — o trabalho só roda com sessão de cron", () => {
  it.each(ROTAS)("/api/scheduled/$rota sem sessão: 401 e NENHUM trabalho roda (nem auditoria)", async ({ rota }) => {
    authenticateRequest.mockRejectedValue(new HttpError(403, "Invalid session cookie"));
    const res = resposta();

    await handlerDe(rota)(requisicao(rota), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Sessão de cron ausente ou inválida." });
    for (const trabalho of trabalhos()) expect(trabalho).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it.each(ROTAS)("/api/scheduled/$rota com sessão de usuária comum: 403 e NENHUM trabalho roda", async ({ rota }) => {
    authenticateRequest.mockResolvedValue(USUARIA_COMUM);
    const res = resposta();

    await handlerDe(rota)(requisicao(rota), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "cron-only endpoint" });
    expect(res.json).toHaveBeenCalledTimes(1);
    for (const trabalho of trabalhos()) expect(trabalho).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it.each(ROTAS)("/api/scheduled/$rota com sessão de cron: o trabalho roda UMA vez, a resposta traz ok + resultado e a auditoria leva o taskUid", async ({ rota, trabalho, devolve, acao, recurso, naResposta, naAuditoria }) => {
    authenticateRequest.mockResolvedValue(SESSAO_DE_CRON);
    (trabalho as ReturnType<typeof vi.fn>).mockResolvedValueOnce(devolve);
    const res = resposta();

    await handlerDe(rota)(requisicao(rota), res);

    expect(trabalho).toHaveBeenCalledTimes(1);
    for (const outro of trabalhos()) if (outro !== trabalho) expect(outro).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ ok: true, ...naResposta, timestamp: expect.any(String) });
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: null, action: acao, resource: recurso, status: "success",
      details: expect.objectContaining({ ...naAuditoria, taskUid: "uid-1" }),
    }));
  });

  it("o trabalho lança: 500 com a mensagem — a autenticação já passou, então não é 401 nem 403", async () => {
    authenticateRequest.mockResolvedValue(SESSAO_DE_CRON);
    marcarReunioesInterrompidas.mockRejectedValueOnce(new Error("Banco de dados indisponível"));
    const res = resposta();

    await handlerDe("mark-interrupted-meetings")(requisicao(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Banco de dados indisponível" }));
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("a auditoria fora do ar não derruba a resposta: o trabalho feito é respondido como ok", async () => {
    authenticateRequest.mockResolvedValue(SESSAO_DE_CRON);
    createAuditLog.mockRejectedValueOnce(new Error("audit_logs fora do ar"));
    const res = resposta();

    await handlerDe("mark-interrupted-meetings")(requisicao(), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
});

describe("a varredura de reuniões presas fora do endpoint — no boot e a cada 5 min", () => {
  it("o boot (com DATABASE_URL) varreu exatamente uma vez antes de o servidor aceitar tráfego", () => {
    expect(varredurasNoBoot).toBe(1);
  });

  it("a cada 5 min varre de novo, e um erro na varredura periódica é log, não queda do processo", async () => {
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(marcarReunioesInterrompidas).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(marcarReunioesInterrompidas).toHaveBeenCalledTimes(1);

    marcarReunioesInterrompidas.mockRejectedValueOnce(new Error("banco fora"));
    const registrado = vi.spyOn(console, "error").mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(marcarReunioesInterrompidas).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(registrado.mock.calls)).toContain("banco fora");
  });
});
