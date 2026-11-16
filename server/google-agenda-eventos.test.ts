import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const eventos = await import("./google-agenda-eventos");
const { RecusaDaGoogle } = await import("./google-oauth");

/**
 * A conversa com a API da Google Agenda (H16c), com o fetch dublado no lugar
 * da Google. Prova o que vai na chamada (o id do evento, o corpo, o convite e o
 * token no cabeçalho) e o que cada resposta faz: 409 na criação vira PATCH, 401
 * renova o token UMA vez, 404 e 410 na exclusão contam como sucesso, e o resto
 * vira recusa com o motivo da Google, sem token nem título na mensagem. Sem
 * criar (a reunião que já acabou), só o PATCH, e o evento que não está lá é
 * "ausente", nunca criado.
 */

const AGENDA_ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const EVENTO_ID = "8b1f6a2e3c4d4e5f8a9b0c1d2e3f4a5b";
const reuniao = (extra: Partial<Parameters<typeof eventos.corpoDoEvento>[0]> = {}) => ({
  id: AGENDA_ID,
  titulo: "Conversa com a Bia",
  inicioEm: Date.UTC(2026, 10, 20, 17, 0),
  duracaoMinutos: 90,
  fuso: "America/Sao_Paulo",
  local: "https://meet.google.com/abc-defg-hij",
  participantes: [{ nome: "Ana", email: "Ana@Exemplo.com" }, { nome: "Bia", email: null }, { nome: null, email: "cris@exemplo.com" }],
  lembreteMinutos: 15,
  googleConvites: true,
  ...extra,
});

type Chamada = { url: string; metodo: string; cabecalhos: Record<string, string>; corpo: unknown };

/** A Google de mentira: cada chamada tira a próxima resposta da fila e fica anotada. */
function dubleDaGoogle(...respostas: Array<Response | Error>) {
  const chamadas: Chamada[] = [];
  const buscar = vi.fn(async (url: string, init?: RequestInit) => {
    chamadas.push({
      url,
      metodo: String(init?.method),
      cabecalhos: { ...(init?.headers as Record<string, string>) },
      corpo: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const proxima = respostas.shift();
    if (!proxima) throw new Error("o teste não previu esta chamada à Google");
    if (proxima instanceof Error) throw proxima;
    return proxima;
  });
  return { buscar, chamadas };
}
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
const erroDaGoogle = (status: number, reason: string) => json({ error: { code: status, message: "o texto da Google", errors: [{ domain: "global", reason, message: "o texto da Google" }] } }, status);

function sessao(google: ReturnType<typeof dubleDaGoogle>, renovar = vi.fn(async () => "token-renovado")) {
  return { sessao: eventos.sessaoDaGoogle("token-1", renovar, google.buscar), renovar };
}

describe("o id e o corpo do evento", () => {
  it("o id é o da reunião sem hífens: só 0-9 e a-f, dentro do base32hex que a Google aceita", () => {
    expect(eventos.idDoEventoNaGoogle(AGENDA_ID)).toBe(EVENTO_ID);
    expect(eventos.idDoEventoNaGoogle(crypto.randomUUID())).toMatch(/^[0-9a-v]{32}$/);
  });

  it("título, local, a hora em UTC com o fuso da reunião, convidados com e-mail, lembrete popup e os convidados sem ver uns aos outros", () => {
    expect(eventos.corpoDoEvento(reuniao())).toEqual({
      summary: "Conversa com a Bia",
      location: "https://meet.google.com/abc-defg-hij",
      start: { dateTime: "2026-11-20T17:00:00.000Z", timeZone: "America/Sao_Paulo" },
      end: { dateTime: "2026-11-20T18:30:00.000Z", timeZone: "America/Sao_Paulo" },
      // Quem não tem e-mail não vira convidado; o e-mail vai em minúsculas.
      attendees: [{ email: "ana@exemplo.com", displayName: "Ana" }, { email: "cris@exemplo.com" }],
      guestsCanSeeOtherGuests: false,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
      status: "confirmed",
    });
  });

  it("sem local, sem participantes e sem lembrete: os campos vão vazios, para o PATCH apagar o que havia, e sem os lembretes padrão da agenda", () => {
    const corpo = eventos.corpoDoEvento(reuniao({ local: null, participantes: [], lembreteMinutos: null }));
    expect(corpo.location).toBe("");
    expect(corpo.attendees).toEqual([]);
    expect(corpo.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it("o lembrete na hora é 0 minutos, não 'sem lembrete'", () => {
    expect(eventos.corpoDoEvento(reuniao({ lembreteMinutos: 0 })).reminders.overrides).toEqual([{ method: "popup", minutes: 0 }]);
  });

  // Convidado no evento ganha uma cópia dele na própria Google Agenda, mesmo
  // com sendUpdates=none: sem a dona marcar o convite, ninguém entra no evento.
  it("sem o convite marcado, o evento vai sem convidados, e a lista vazia tira no PATCH quem estava", () => {
    const corpo = eventos.corpoDoEvento(reuniao({ googleConvites: false }));
    expect(corpo.attendees).toEqual([]);
    expect(corpo).toMatchObject({ summary: "Conversa com a Bia", location: "https://meet.google.com/abc-defg-hij" });
  });

  it("o mesmo e-mail duas vezes vira um convidado só", () => {
    const corpo = eventos.corpoDoEvento(reuniao({ participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Ana Souza", email: " ANA@exemplo.com " }] }));
    expect(corpo.attendees).toEqual([{ email: "ana@exemplo.com", displayName: "Ana" }]);
  });
});

describe("gravar o evento", () => {
  it("cria com o id da reunião, o token no cabeçalho e, sem a escolha da dona, sem convite nem convidados (sendUpdates=none)", async () => {
    const google = dubleDaGoogle(json({ id: EVENTO_ID }));
    await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao({ googleConvites: false }), false);
    expect(google.chamadas).toHaveLength(1);
    const [criacao] = google.chamadas;
    expect(criacao.metodo).toBe("POST");
    expect(criacao.url).toBe(`${eventos.URL_DOS_EVENTOS}?sendUpdates=none`);
    expect(criacao.cabecalhos).toMatchObject({ Authorization: "Bearer token-1", "Content-Type": "application/json" });
    expect(criacao.corpo).toEqual({ id: EVENTO_ID, ...eventos.corpoDoEvento(reuniao({ googleConvites: false })) });
    expect(criacao.corpo).toMatchObject({ attendees: [] });
    // O token nunca vai na URL.
    expect(criacao.url).not.toContain("token-1");
  });

  it("com o convite marcado, a Google manda o convite (sendUpdates=all)", async () => {
    const google = dubleDaGoogle(json({ id: EVENTO_ID }));
    await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), true);
    expect(google.chamadas[0].url).toBe(`${eventos.URL_DOS_EVENTOS}?sendUpdates=all`);
  });

  it("409 (o evento já existe) vira PATCH no evento, com o mesmo corpo sem o id e o mesmo convite", async () => {
    const google = dubleDaGoogle(erroDaGoogle(409, "duplicate"), json({ id: EVENTO_ID }));
    await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), true);
    expect(google.chamadas.map(c => c.metodo)).toEqual(["POST", "PATCH"]);
    const [, mudanca] = google.chamadas;
    expect(mudanca.url).toBe(`${eventos.URL_DOS_EVENTOS}/${EVENTO_ID}?sendUpdates=all`);
    expect(mudanca.corpo).toEqual(eventos.corpoDoEvento(reuniao()));
    expect(mudanca.cabecalhos.Authorization).toBe("Bearer token-1");
  });

  it("outra recusa na criação não tenta o PATCH: sobe com o motivo da Google e o status, sem token nem título", async () => {
    const google = dubleDaGoogle(erroDaGoogle(403, "rateLimitExceeded"));
    const erro = await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false).catch(e => e);
    expect(erro).toBeInstanceOf(RecusaDaGoogle);
    expect(erro).toMatchObject({ codigo: "rateLimitExceeded", status: 403 });
    expect(String(erro.message)).not.toContain("token-1");
    expect(String(erro.message)).not.toContain("Bia");
    expect(google.chamadas).toHaveLength(1);
  });

  it("o PATCH depois do 409 que falha também sobe como recusa", async () => {
    const google = dubleDaGoogle(erroDaGoogle(409, "duplicate"), new Response("<html>", { status: 503 }));
    await expect(eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false)).rejects.toMatchObject({ codigo: "http_503", status: 503 });
  });

  it("rede fora: recusa 'rede', sem a mensagem do erro de rede", async () => {
    const google = dubleDaGoogle(new Error("getaddrinfo ENOTFOUND www.googleapis.com token-1"));
    const erro = await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false).catch(e => e);
    expect(erro).toMatchObject({ codigo: "rede", status: null });
    expect(String(erro.message)).not.toContain("token-1");
  });

  it("o motivo da Google só passa quando é uma palavra; o resto vira o status", async () => {
    const google = dubleDaGoogle(json({ error: { errors: [{ reason: "x'; DROP TABLE" }] } }, 400));
    await expect(eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false)).rejects.toMatchObject({ codigo: "http_400" });
  });

  it("a criação e o PATCH depois do 409 respondem 'gravado'", async () => {
    expect(await eventos.gravarEventoNaGoogle(sessao(dubleDaGoogle(json({ id: EVENTO_ID }))).sessao, reuniao(), false)).toBe("gravado");
    const google = dubleDaGoogle(erroDaGoogle(409, "duplicate"), json({ id: EVENTO_ID }));
    expect(await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false)).toBe("gravado");
  });
});

describe("gravar sem criar (a reunião que já acabou)", () => {
  it("só o PATCH no evento, nunca o POST, com o corpo sem o id e o convite escolhido", async () => {
    const google = dubleDaGoogle(json({ id: EVENTO_ID }));
    expect(await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false, false)).toBe("gravado");
    expect(google.chamadas.map(c => [c.metodo, c.url])).toEqual([["PATCH", `${eventos.URL_DOS_EVENTOS}/${EVENTO_ID}?sendUpdates=none`]]);
    expect(google.chamadas[0].corpo).toEqual(eventos.corpoDoEvento(reuniao()));
  });

  it.each([[404, "notFound"], [410, "deleted"]])("o evento que não está lá (%i) é 'ausente': não é criado", async (status, reason) => {
    const google = dubleDaGoogle(erroDaGoogle(status, reason));
    expect(await eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false, false)).toBe("ausente");
    expect(google.chamadas).toHaveLength(1);
  });

  it("outra recusa sobe como recusa, e o 404 do PATCH depois do 409 (criando) também", async () => {
    await expect(eventos.gravarEventoNaGoogle(sessao(dubleDaGoogle(erroDaGoogle(403, "forbidden"))).sessao, reuniao(), false, false))
      .rejects.toMatchObject({ codigo: "forbidden", status: 403 });
    const google = dubleDaGoogle(erroDaGoogle(409, "duplicate"), erroDaGoogle(404, "notFound"));
    await expect(eventos.gravarEventoNaGoogle(sessao(google).sessao, reuniao(), false)).rejects.toMatchObject({ codigo: "notFound", status: 404 });
  });
});

describe("401: o token renovado uma vez", () => {
  it("o 401 renova o token e repete a mesma chamada com o novo", async () => {
    const google = dubleDaGoogle(erroDaGoogle(401, "authError"), json({ id: EVENTO_ID }));
    const { sessao: s, renovar } = sessao(google);
    await eventos.gravarEventoNaGoogle(s, reuniao(), false);
    expect(renovar).toHaveBeenCalledTimes(1);
    expect(google.chamadas.map(c => [c.metodo, c.cabecalhos.Authorization])).toEqual([["POST", "Bearer token-1"], ["POST", "Bearer token-renovado"]]);
  });

  it("uma vez só por operação: o segundo 401 sobe como recusa, sem renovar de novo", async () => {
    const google = dubleDaGoogle(erroDaGoogle(401, "authError"), erroDaGoogle(401, "authError"));
    const { sessao: s, renovar } = sessao(google);
    await expect(eventos.gravarEventoNaGoogle(s, reuniao(), false)).rejects.toMatchObject({ codigo: "authError", status: 401 });
    expect(renovar).toHaveBeenCalledTimes(1);
    expect(google.chamadas).toHaveLength(2);
  });

  it("o token renovado segue no PATCH depois do 409, e um 401 ali não renova outra vez", async () => {
    const google = dubleDaGoogle(erroDaGoogle(401, "authError"), erroDaGoogle(409, "duplicate"), erroDaGoogle(401, "authError"));
    const { sessao: s, renovar } = sessao(google);
    await expect(eventos.gravarEventoNaGoogle(s, reuniao(), false)).rejects.toMatchObject({ status: 401 });
    expect(google.chamadas.map(c => [c.metodo, c.cabecalhos.Authorization])).toEqual([
      ["POST", "Bearer token-1"], ["POST", "Bearer token-renovado"], ["PATCH", "Bearer token-renovado"],
    ]);
    expect(renovar).toHaveBeenCalledTimes(1);
  });

  it("a renovação que falha (a conexão foi revogada) sobe como veio", async () => {
    const google = dubleDaGoogle(erroDaGoogle(401, "authError"));
    const revogada = new Error("revogada");
    const s = eventos.sessaoDaGoogle("token-1", async () => { throw revogada; }, google.buscar);
    await expect(eventos.gravarEventoNaGoogle(s, reuniao(), false)).rejects.toBe(revogada);
  });
});

describe("tirar o evento", () => {
  it.each([[204], [200]])("a Google tirou (%i): DELETE no evento, sem corpo, com o convite escolhido", async status => {
    const google = dubleDaGoogle(new Response(null, { status }));
    await eventos.excluirEventoNaGoogle(sessao(google).sessao, AGENDA_ID, true);
    expect(google.chamadas).toEqual([expect.objectContaining({
      metodo: "DELETE", url: `${eventos.URL_DOS_EVENTOS}/${EVENTO_ID}?sendUpdates=all`, corpo: undefined,
    })]);
    expect(google.chamadas[0].cabecalhos).not.toHaveProperty("Content-Type");
  });

  it.each([[404, "notFound"], [410, "deleted"]])("o evento que já não existe (%i) conta como tirado", async (status, reason) => {
    const google = dubleDaGoogle(erroDaGoogle(status, reason));
    await expect(eventos.excluirEventoNaGoogle(sessao(google).sessao, AGENDA_ID, false)).resolves.toBeUndefined();
    expect(google.chamadas[0].url).toContain("sendUpdates=none");
  });

  it("outra recusa sobe; o 401 renova uma vez", async () => {
    const google = dubleDaGoogle(erroDaGoogle(401, "authError"), erroDaGoogle(500, "backendError"));
    const { sessao: s, renovar } = sessao(google);
    await expect(eventos.excluirEventoNaGoogle(s, AGENDA_ID, false)).rejects.toMatchObject({ codigo: "backendError", status: 500 });
    expect(renovar).toHaveBeenCalledTimes(1);
  });
});
