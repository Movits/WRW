import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const {
  agendaReunioes, lembretes, meetings, meetingSummaries, meetingSummaryItems, platformNotifications, proximasAcoes, users,
} = await import("../drizzle/schema");
const laco = await import("./lembretes");
const agenda = await import("./agenda-de-reunioes");
const acoes = await import("./proximas-acoes");
const { excluirConta } = await import("./exclusao-de-conta");
const { instanteNoFuso } = await import("@shared/lembretes");

/**
 * Os lembretes no sino (H15) contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). Precisa da
 * migração da tabela lembretes e da coluna platform_notifications.parametros,
 * que a integração do pacote gera.
 *
 * Prova o que o dublê não prova: a reserva por UPDATE ... ORDER BY ... LIMIT no
 * MariaDB e no MySQL, duas rodadas ao mesmo tempo dando um aviso só, a marca e
 * o aviso juntos, o reagendamento pelas escritas da agenda e da próxima ação,
 * os nomes das vozes resolvidos no disparo, os avisos apagados com a origem e a
 * exclusão da conta levando os lembretes.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-lembretes-${crypto.randomUUID()}`;
const EXCLUIDA = `teste-lembretes-${crypto.randomUUID()}`;
const MINUTO = 60_000;
const DIA = 24 * 60 * MINUTO;
const FUSO = "America/Sao_Paulo";

async function db() { return (await getDb())!; }
const rodar = (agora: number) => laco.rodarLembretesUmaVez({ ownerId: DONA }, agora);

async function contaDe(openId: string): Promise<number> {
  const [conta] = await (await db()).select({ id: users.id }).from(users).where(eq(users.openId, openId));
  return conta.id;
}
const lembreteDe = async (origemId: string) => (await (await db()).select().from(lembretes).where(eq(lembretes.origemId, origemId)))[0];
async function avisosDe(openId: string, actionUrl?: string) {
  const avisos = await (await db()).select().from(platformNotifications).where(eq(platformNotifications.userId, await contaDe(openId)));
  return avisos.filter(aviso => !actionUrl || aviso.actionUrl === actionUrl);
}

/** Um dia, como "AAAA-MM-DD", N dias depois de hoje (UTC): o 9h dele em Brasília está no futuro. */
const diaDaqui = (dias: number) => new Date(Date.now() + dias * DIA).toISOString().slice(0, 10);

const marcada = (extra: Partial<Parameters<typeof agenda.criarNaAgenda>[1]> = {}) => ({
  titulo: "Conversa com a Bia",
  // No minuto cheio: a hora do lembrete fica exata.
  inicioEm: Math.floor((Date.now() + 2 * DIA) / MINUTO) * MINUTO,
  duracaoMinutos: 60,
  fuso: FUSO,
  local: null,
  participantes: [{ nome: "Ana", email: "ana@exemplo.com" }],
  lembreteMinutos: 15,
  ...extra,
});

async function limpar() {
  const banco = await db();
  for (const dona of [DONA, EXCLUIDA]) {
    const contas = await banco.select({ id: users.id }).from(users).where(eq(users.openId, dona));
    if (contas.length) await apagarPelaChave(banco, platformNotifications, inArray(platformNotifications.userId, contas.map(conta => conta.id)));
    await apagarPelaChave(banco, lembretes, eq(lembretes.ownerId, dona));
    await apagarPelaChave(banco, agendaReunioes, eq(agendaReunioes.ownerId, dona));
    await apagarPelaChave(banco, proximasAcoes, eq(proximasAcoes.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
    await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
    await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
  }
}

describe.skipIf(!temBanco)("Lembretes no sino (integração)", () => {
  beforeAll(async () => {
    await (await db()).insert(users).values([{ openId: DONA }, { openId: EXCLUIDA }]);
  });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limpar();
    await (await db()).delete(users).where(inArray(users.openId, [DONA, EXCLUIDA]));
  });
  beforeEach(async () => {
    await limpar();
    laco.religarLembretesParaTestes();
    await (await db()).update(users).set({ isActive: true }).where(eq(users.openId, DONA));
  });

  it("a reunião marcada com lembrete: na hora, um aviso no sino, com a marca; antes da hora e depois do aviso, nada", async () => {
    const dados = marcada();
    const { id } = await agenda.criarNaAgenda(DONA, dados);
    const hora = dados.inicioEm - 15 * MINUTO;
    expect(await lembreteDe(id)).toMatchObject({
      ownerId: DONA, origem: "agenda", dispararEm: hora, expiraEm: dados.inicioEm + 60 * MINUTO, disparadoEm: null, lockToken: null,
    });

    expect(await rodar(hora - 1_000)).toEqual({ avisos: 0 });
    expect(await avisosDe(DONA)).toEqual([]);

    expect(await rodar(hora + 1_000)).toEqual({ avisos: 1 });
    const [aviso] = await avisosDe(DONA);
    expect(aviso).toMatchObject({
      type: "lembrete", title: "Conversa com a Bia", body: null, isRead: false, actionUrl: `/gravar?agendada=${id}`,
      parametros: { origem: "agenda", titulo: "Conversa com a Bia", inicioEm: dados.inicioEm, fuso: FUSO },
    });
    expect(await lembreteDe(id)).toMatchObject({ disparadoEm: hora + 1_000, lockToken: null, lockedUntil: null });

    expect(await rodar(hora + 2 * MINUTO)).toEqual({ avisos: 0 });
    expect(await avisosDe(DONA)).toHaveLength(1);
  });

  it("duas rodadas ao mesmo tempo: a reserva é de uma só, e sai um aviso", async () => {
    const dados = marcada();
    await agenda.criarNaAgenda(DONA, dados);
    const depois = dados.inicioEm - 15 * MINUTO + 1_000;
    const [a, b] = await Promise.all([rodar(depois), rodar(depois)]);
    expect(a.avisos + b.avisos).toBe(1);
    expect(await avisosDe(DONA)).toHaveLength(1);
  });

  it("mudar o título não repete o aviso; mudar a hora reagenda; tirar o lembrete o tira; excluir apaga os avisos dela", async () => {
    const dados = marcada();
    const { id } = await agenda.criarNaAgenda(DONA, dados);
    await rodar(dados.inicioEm - 15 * MINUTO + 1_000);

    await agenda.atualizarNaAgenda(DONA, id, { ...dados, titulo: "Conversa com a Bia e a Ana" });
    expect(await rodar(dados.inicioEm - 5 * MINUTO)).toEqual({ avisos: 0 });

    const maisTarde = { ...dados, titulo: "Conversa com a Bia e a Ana", inicioEm: dados.inicioEm + 60 * MINUTO };
    await agenda.atualizarNaAgenda(DONA, id, maisTarde);
    expect(await lembreteDe(id)).toMatchObject({ dispararEm: maisTarde.inicioEm - 15 * MINUTO, disparadoEm: null });
    expect(await rodar(maisTarde.inicioEm - 15 * MINUTO + 1_000)).toEqual({ avisos: 1 });
    const avisos = await avisosDe(DONA, `/gravar?agendada=${id}`);
    expect(avisos.map(aviso => (aviso.parametros as { titulo: string }).titulo).sort()).toEqual(["Conversa com a Bia", "Conversa com a Bia e a Ana"]);

    await agenda.atualizarNaAgenda(DONA, id, { ...maisTarde, inicioEm: maisTarde.inicioEm + DIA, lembreteMinutos: null });
    expect(await lembreteDe(id)).toBeUndefined();

    await agenda.excluirDaAgenda(DONA, id);
    expect(await avisosDe(DONA, `/gravar?agendada=${id}`)).toEqual([]);
  });

  it("a próxima ação com prazo: às 9h do dia, no fuso de quem marcou; feita, não avisa; apagada, leva o lembrete e os avisos", async () => {
    const prazo = diaDaqui(3);
    const as9h = instanteNoFuso(prazo, 9, FUSO)!;
    const { id } = await acoes.criarProximaAcao(DONA, { texto: "Mandar o contrato", prazo, fuso: FUSO });
    const { id: feitaId } = await acoes.criarProximaAcao(DONA, { texto: "Ligar para a Bia", prazo, fuso: FUSO });
    expect(await lembreteDe(id)).toMatchObject({ origem: "acao", dispararEm: as9h, expiraEm: instanteNoFuso(prazo, 24, FUSO) });
    await acoes.marcarProximaAcaoFeita(DONA, feitaId, true);

    expect(await rodar(as9h + 1_000)).toEqual({ avisos: 1 });
    const [aviso] = await avisosDe(DONA);
    expect(aviso).toMatchObject({
      type: "lembrete", actionUrl: `/proximas-acoes?acao=${id}`, parametros: { origem: "acao", texto: "Mandar o contrato", prazo },
    });
    // A feita foi marcada sem aviso: desmarcar depois da hora não a faz avisar.
    expect(await lembreteDe(feitaId)).toMatchObject({ disparadoEm: as9h + 1_000 });

    await acoes.apagarProximaAcao(DONA, id);
    expect(await lembreteDe(id)).toBeUndefined();
    expect(await avisosDe(DONA)).toEqual([]);
  });

  it("o prazo tirado na edição tira o lembrete; o prazo de hoje, marcado depois das 9h, não agenda", async () => {
    const { id } = await acoes.criarProximaAcao(DONA, { texto: "Mandar o contrato", prazo: diaDaqui(3), fuso: FUSO });
    await acoes.editarProximaAcao(DONA, id, { prazo: null });
    expect(await lembreteDe(id)).toBeUndefined();
    // Ontem, em qualquer fuso, já passou das 9h.
    await acoes.editarProximaAcao(DONA, id, { prazo: diaDaqui(-1), fuso: FUSO });
    expect(await lembreteDe(id)).toBeUndefined();
  });

  it("a ação presa ao item da reunião: os nomes das vozes entram no disparo, e a voz sem nome fica rótulo", async () => {
    const banco = await db();
    const agora = Date.now();
    const reuniao = crypto.randomUUID();
    const resumo = crypto.randomUUID();
    const item = crypto.randomUUID();
    const acao = crypto.randomUUID();
    const prazo = diaDaqui(2);
    await banco.insert(meetings).values({
      id: reuniao, ownerId: DONA, title: "Comitê", status: "ready", consentGranted: true, speakerNames: { F2: "Carla" }, createdAt: agora, updatedAt: agora,
    });
    await banco.insert(meetingSummaries).values({ id: resumo, meetingId: reuniao, ownerId: DONA, status: "ready", createdAt: agora, updatedAt: agora });
    await banco.insert(meetingSummaryItems).values({
      id: item, summaryId: resumo, meetingId: reuniao, ownerId: DONA, section: "action", position: 0, text: "{F2} manda a proposta a {F3}",
      excerpt: "eu mando a proposta", status: "confirmed", done: false, createdAt: agora, updatedAt: agora,
    });
    await banco.insert(proximasAcoes).values({
      id: acao, ownerId: DONA, origem: "reuniao", texto: "{F2} manda a proposta a {F3}", responsavel: "{F2}", prazo,
      meetingId: reuniao, itemId: item, trecho: "eu mando a proposta", feita: false, createdAt: agora, updatedAt: agora,
    });
    await laco.agendarLembreteDaAcao(banco, DONA, acao, prazo, FUSO);
    expect(await rodar(instanteNoFuso(prazo, 9, FUSO)! + 1_000)).toEqual({ avisos: 1 });
    const [aviso] = await avisosDe(DONA);
    expect(aviso.parametros).toEqual({ origem: "acao", texto: "Carla manda a proposta a {F3}", prazo });
    // O nome nunca ficou na ação: ela segue com os rótulos.
    const [guardada] = await banco.select({ texto: proximasAcoes.texto }).from(proximasAcoes).where(eq(proximasAcoes.id, acao));
    expect(guardada.texto).toBe("{F2} manda a proposta a {F3}");
  });

  it("conta desativada e aviso vencido: marca sem avisar", async () => {
    const dados = marcada();
    const { id } = await agenda.criarNaAgenda(DONA, dados);
    await (await db()).update(users).set({ isActive: false }).where(eq(users.openId, DONA));
    expect(await rodar(dados.inicioEm - 15 * MINUTO + 1_000)).toEqual({ avisos: 0 });
    expect(await lembreteDe(id)).toMatchObject({ disparadoEm: dados.inicioEm - 15 * MINUTO + 1_000 });

    await (await db()).update(users).set({ isActive: true }).where(eq(users.openId, DONA));
    const outra = marcada({ inicioEm: dados.inicioEm + DIA });
    const { id: vencidaId } = await agenda.criarNaAgenda(DONA, outra);
    // Um deploy de horas: a reunião já acabou quando a rodada chega.
    expect(await rodar(outra.inicioEm + 2 * 60 * MINUTO)).toEqual({ avisos: 0 });
    expect((await lembreteDe(vencidaId)).disparadoEm).not.toBeNull();
    expect(await avisosDe(DONA)).toEqual([]);
  });

  it("o desligamento devolve a reserva da rodada em curso, sem a marca", async () => {
    const dados = marcada();
    const { id } = await agenda.criarNaAgenda(DONA, dados);
    const hora = dados.inicioEm - 15 * MINUTO + 1_000;
    // Reserva como a rodada faria, e o desligamento chega antes do disparo.
    const token = crypto.randomUUID();
    laco._paraTestes.tokensVivos.add(token);
    await (await db()).update(lembretes).set({ lockToken: token, lockedUntil: hora + 2 * MINUTO }).where(eq(lembretes.origemId, id));
    expect(await laco.pararLembretes()).toEqual({ lembretes: 1 });
    expect(await lembreteDe(id)).toMatchObject({ lockToken: null, lockedUntil: null, disparadoEm: null });
    laco.religarLembretesParaTestes();
    expect(await rodar(hora)).toEqual({ avisos: 1 });
  });

  it("a exclusão da conta leva os lembretes e os avisos dela", async () => {
    const dados = marcada();
    const { id } = await agenda.criarNaAgenda(EXCLUIDA, dados);
    await laco.rodarLembretesUmaVez({ ownerId: EXCLUIDA }, dados.inicioEm - 15 * MINUTO + 1_000);
    const conta = await contaDe(EXCLUIDA);
    expect(await avisosDe(EXCLUIDA)).toHaveLength(1);
    await excluirConta(await db(), { id: conta, openId: EXCLUIDA, email: null }, { apagarArquivo: async () => undefined });
    expect(await lembreteDe(id)).toBeUndefined();
    expect(await (await db()).select().from(platformNotifications).where(eq(platformNotifications.userId, conta))).toEqual([]);
  });
});
