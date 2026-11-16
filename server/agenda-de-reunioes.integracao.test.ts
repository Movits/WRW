import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const { agendaReunioes, meetings, users } = await import("../drizzle/schema");
const servico = await import("./agenda-de-reunioes");
const { deletePrivateMeeting } = await import("./meeting-service");
const { excluirConta } = await import("./exclusao-de-conta");
const { appRouter } = await import("./routers");

/**
 * A agenda de reuniões (H16a) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). Precisa da
 * migração da tabela agenda_reunioes, que a integração do pacote gera.
 *
 * Prova o que o dublê não prova: a coluna JSON dos participantes volta igual no
 * MariaDB e no MySQL, a divisão entre próximas e anteriores pelo fim da
 * reunião, o índice único da gravação, a exclusão da gravação soltando o
 * ponteiro e a exclusão da conta levando a agenda.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-agenda-${crypto.randomUUID()}`;
const OUTRA = `teste-agenda-${crypto.randomUUID()}`;
const EXCLUIDA = `teste-agenda-${crypto.randomUUID()}`;
const HORA = 60 * 60_000;

const dados = (extra: Partial<Parameters<typeof servico.criarNaAgenda>[1]> = {}) => ({
  titulo: "Conversa com a Bia",
  inicioEm: Date.now() + 24 * HORA,
  duracaoMinutos: 60,
  fuso: "America/Sao_Paulo",
  local: "https://meet.google.com/abc-defg-hij",
  participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }],
  lembreteMinutos: 15,
  ...extra,
});

async function novaReuniao(ownerId: string, status: "ready" | "deleted" = "ready") {
  const id = crypto.randomUUID();
  const agora = Date.now();
  await (await getDb())!.insert(meetings).values({ id, ownerId, title: "Gravação", status, consentGranted: true, createdAt: agora, updatedAt: agora });
  return id;
}

const rotaDe = (openId: string) => appRouter.createCaller({ user: { id: 1, openId, role: "silver", onboardingCompleted: true }, req: { headers: {} }, res: { cookie: () => {} } } as never);

describe.skipIf(!temBanco)("Agenda de reuniões (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: DONA }, { openId: OUTRA }, { openId: EXCLUIDA }]);
  });
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const donas = [DONA, OUTRA, EXCLUIDA];
    await db.delete(agendaReunioes).where(inArray(agendaReunioes.ownerId, donas));
    await db.delete(meetings).where(inArray(meetings.ownerId, donas));
    await db.delete(users).where(inArray(users.openId, donas));
  });

  it("marca, lê e lista: os participantes voltam como foram, e a reunião futura está nas próximas", async () => {
    const { id } = await servico.criarNaAgenda(DONA, dados());
    const lida = await servico.obterDaAgenda(DONA, id);
    expect(lida).toMatchObject({
      id, titulo: "Conversa com a Bia", duracaoMinutos: 60, fuso: "America/Sao_Paulo", lembreteMinutos: 15, gravacao: null,
      participantes: [{ nome: "Ana", email: "ana@exemplo.com" }, { nome: "Bia", email: null }],
    });
    const { proximas, anteriores } = await servico.listarAgendaDaDona(DONA);
    expect(proximas.map(r => r.id)).toContain(id);
    expect(anteriores.map(r => r.id)).not.toContain(id);
  });

  it("próximas e anteriores pelo FIM: a que está acontecendo fica nas próximas; a que acabou vai para as anteriores", async () => {
    const agora = Date.now();
    const { id: acontecendo } = await servico.criarNaAgenda(DONA, dados({ titulo: "Em curso", inicioEm: agora - 30 * 60_000, duracaoMinutos: 60 }));
    const { id: acabou } = await servico.criarNaAgenda(DONA, dados({ titulo: "Já foi", inicioEm: agora - 3 * HORA, duracaoMinutos: 60 }));
    const { proximas, anteriores } = await servico.listarAgendaDaDona(DONA, agora);
    expect(proximas.map(r => r.id)).toContain(acontecendo);
    expect(anteriores.map(r => r.id)).toContain(acabou);
    // Próximas da mais perto à mais longe; anteriores da mais recente à mais antiga.
    expect(proximas.map(r => r.inicioEm)).toEqual([...proximas.map(r => r.inicioEm)].sort((a, b) => a - b));
    expect(anteriores.map(r => r.inicioEm)).toEqual([...anteriores.map(r => r.inicioEm)].sort((a, b) => b - a));
  });

  it("outra conta não lê, não muda, não tira e não liga (NOT_FOUND), e não vê nada na lista dela", async () => {
    const { id } = await servico.criarNaAgenda(DONA, dados());
    const reuniaoDaOutra = await novaReuniao(OUTRA);
    const rota = rotaDe(OUTRA);
    await expect(rota.agenda.obter({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rota.agenda.atualizar({ ...dados({ titulo: "Invadida" }), id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rota.agenda.excluir({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rota.agenda.ligarGravacao({ id, meetingId: reuniaoDaOutra })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await rota.agenda.listar()).proximas.map(r => r.id)).not.toContain(id);
    expect((await servico.obterDaAgenda(DONA, id)).titulo).toBe("Conversa com a Bia");
  });

  it("muda pela dona, e a gravação ligada fica como estava", async () => {
    const { id } = await servico.criarNaAgenda(DONA, dados());
    const gravacao = await novaReuniao(DONA);
    await servico.ligarGravacaoNaAgenda(DONA, id, gravacao);
    await servico.atualizarNaAgenda(DONA, id, dados({ titulo: "Conversa com a Bia e a Cris", participantes: [], lembreteMinutos: null, local: null }));
    expect(await servico.obterDaAgenda(DONA, id)).toMatchObject({
      titulo: "Conversa com a Bia e a Cris", participantes: [], lembreteMinutos: null, local: null, gravacao: { id: gravacao, status: "ready" },
    });
  });

  it("liga a gravação da dona; a de outra dona ou a excluída não; a mesma gravação em duas reuniões é CONFLICT", async () => {
    const { id: primeira } = await servico.criarNaAgenda(DONA, dados());
    const { id: segunda } = await servico.criarNaAgenda(DONA, dados({ titulo: "Outra" }));
    const gravacao = await novaReuniao(DONA);
    await servico.ligarGravacaoNaAgenda(DONA, primeira, gravacao);
    expect((await servico.obterDaAgenda(DONA, primeira)).gravacao).toEqual({ id: gravacao, status: "ready" });
    // Ligar de novo a mesma (o mesmo clique repetido) não é erro.
    await servico.ligarGravacaoNaAgenda(DONA, primeira, gravacao);
    await expect(servico.ligarGravacaoNaAgenda(DONA, segunda, gravacao)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(servico.ligarGravacaoNaAgenda(DONA, segunda, await novaReuniao(OUTRA))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(servico.ligarGravacaoNaAgenda(DONA, segunda, await novaReuniao(DONA, "deleted"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await servico.obterDaAgenda(DONA, segunda)).gravacao).toBeNull();
  });

  it("excluir a gravação solta o ponteiro e deixa a reunião na agenda, pronta para outro Gravar agora", async () => {
    const { id } = await servico.criarNaAgenda(DONA, dados());
    const gravacao = await novaReuniao(DONA);
    await servico.ligarGravacaoNaAgenda(DONA, id, gravacao);
    expect(await deletePrivateMeeting(DONA, gravacao)).toBe(true);
    const [linha] = await (await getDb())!.select({ meetingId: agendaReunioes.meetingId }).from(agendaReunioes).where(eq(agendaReunioes.id, id));
    expect(linha.meetingId).toBeNull();
    expect((await servico.obterDaAgenda(DONA, id)).gravacao).toBeNull();
    // A nova gravação liga de novo.
    const nova = await novaReuniao(DONA);
    await servico.ligarGravacaoNaAgenda(DONA, id, nova);
    expect((await servico.obterDaAgenda(DONA, id)).gravacao?.id).toBe(nova);
  });

  it("tirar da agenda não apaga a gravação", async () => {
    const { id } = await servico.criarNaAgenda(DONA, dados());
    const gravacao = await novaReuniao(DONA);
    await servico.ligarGravacaoNaAgenda(DONA, id, gravacao);
    await servico.excluirDaAgenda(DONA, id);
    await expect(servico.obterDaAgenda(DONA, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [reuniao] = await (await getDb())!.select({ id: meetings.id }).from(meetings).where(eq(meetings.id, gravacao));
    expect(reuniao?.id).toBe(gravacao);
  });

  it("a exclusão da conta leva a agenda dela, e só a dela", async () => {
    const db = (await getDb())!;
    const { id: daExcluida } = await servico.criarNaAgenda(EXCLUIDA, dados());
    const { id: daOutra } = await servico.criarNaAgenda(OUTRA, dados());
    const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, EXCLUIDA));
    await excluirConta(db, { id: conta.id, openId: EXCLUIDA, email: null }, { apagarArquivo: async () => undefined });
    const restantes = await db.select({ id: agendaReunioes.id }).from(agendaReunioes).where(inArray(agendaReunioes.id, [daExcluida, daOutra]));
    expect(restantes.map(r => r.id)).toEqual([daOutra]);
  });
});
