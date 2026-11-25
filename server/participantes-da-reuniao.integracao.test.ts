import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

// O bucket é dublê: a exclusão da reunião tira o áudio do bucket, e este
// arquivo não fala com um bucket de verdade (a reunião daqui não tem áudio).
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: vi.fn(async () => {}),
}));
import { getDb } from "./db";
import { auditLogs, connections, meetingParticipants, meetings, meetingTranscripts, userProfiles, users } from "../drizzle/schema";
import { credencialDaParticipante, PARTICIPANTES_POR_REUNIAO_MAX, RECUSAS_DOS_PARTICIPANTES } from "@shared/participantes-da-reuniao";
import { RECUSAS_DAS_VOZES } from "@shared/vozes-da-reuniao";
import {
  ACAO_PARTICIPANTES_AUTORIZADAS, aceitarConvite, compartilhadasComigo, convidarConexao, criarConvite, hashDoConvite,
  participantesDaReuniao, removerParticipante, responderConviteDeConexao, sairDaReuniao, verConvite,
} from "./participantes-da-reuniao";
import { juntarVozes, ligarVozAConta, separarVoz } from "./vozes-da-reuniao";
import { LinkAbertoRecusado, verReuniaoPeloLink } from "./link-aberto-da-reuniao";
import { comCookiesDoPedido } from "./senha-do-link-aberto";
import { deletePrivateMeeting, getPrivateMeeting, nomearFalante } from "./meeting-service";

/**
 * As participantes da reunião (R1b) e as vozes ligadas às contas (H3c) contra
 * um banco real DE TESTE: o convite de uso único, o aceite disputado, a
 * leitura pela credencial da participante (a mesma do link aberto), o que a
 * participante não muda, os nomes das contas nas vozes, a juntada, a saída, a
 * remoção, a dona desativada, a lixeira e a exclusão da reunião. Sem
 * DATABASE_URL_TESTES, o arquivo se pula.
 *
 * Contas e reuniões com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = () => crypto.randomUUID().slice(0, 8);
const DONA = `teste-part-dona-${crypto.randomUUID()}`;
const ANA = `teste-part-ana-${crypto.randomUUID()}`;
const BIA = `teste-part-bia-${crypto.randomUUID()}`;
const CLARA = `teste-part-clara-${crypto.randomUUID()}`;
const NOME_DA_DONA = `Dona ${sufixo()}`;
const NOME_DA_ANA = `Ana Perfil ${sufixo()}`;
const NOME_DA_BIA = `Bia ${sufixo()}`;
const PRINCIPAL = crypto.randomUUID();
const LIXEIRA = crypto.randomUUID();
const CHEIA = crypto.randomUUID();
const EXCLUIR = crypto.randomUUID();
const TODAS = [PRINCIPAL, LIXEIRA, CHEIA, EXCLUIR];
const AGORA = Date.now();
const AUTORIZACAO = { idioma: "pt-BR", textoExibido: "Confirmo que as pessoas que falaram autorizaram compartilhar com as participantes." };

type Conta = { id: number; openId: string };
let dona: Conta, ana: Conta, bia: Conta, clara: Conta;
const prova = (conta: Conta) => ({ userId: conta.id, ipAddress: "203.0.113.9", userAgent: "vitest-participantes" });

const reuniao = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ownerId: DONA, title: `Reunião ${id.slice(0, 4)}`, status: "ready" as const,
  consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA, ...extra,
});

async function recusa(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return erro as { code?: string; codigo?: string; message: string };
  }
  throw new Error("era para recusar");
}

/** A leitura da participante: a mesma do link, com a credencial e a conta logada no contexto do pedido. */
const lerComo = (conta: Conta | null, meetingId: string) => comCookiesDoPedido(undefined, () => verReuniaoPeloLink(credencialDaParticipante(meetingId)), conta);

describe.skipIf(!temBanco)("Participantes da reunião e vozes ligadas às contas (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: DONA, name: NOME_DA_DONA }, { openId: ANA, name: "Ana Conta" }, { openId: BIA, name: NOME_DA_BIA }, { openId: CLARA, name: "Clara" },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [DONA, ANA, BIA, CLARA]));
    const por = (openId: string) => linhas.find(linha => linha.openId === openId)!;
    [dona, ana, bia, clara] = [por(DONA), por(ANA), por(BIA), por(CLARA)];
    // O nome do perfil vence o da conta (H3c).
    await db.insert(userProfiles).values({ userId: ana.id, displayName: NOME_DA_ANA });
    await db.insert(meetings).values([
      reuniao(PRINCIPAL, { speakerNames: { F1: "Nome livre" } }), reuniao(LIXEIRA), reuniao(CHEIA), reuniao(EXCLUIR),
    ]);
    await db.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: PRINCIPAL, ownerId: DONA, transcript: "Oi. Tudo bem. Combinado. Até.", language: "pt-BR",
      segments: [
        { inicio: 0, fim: 2, falante: "F1", texto: "Oi." }, { inicio: 2, fim: 4, falante: "F2", texto: "Tudo bem." },
        { inicio: 4, fim: 6, falante: "F3", texto: "Combinado." }, { inicio: 6, fim: 8, falante: "F4", texto: "Até." },
      ],
      createdAt: AGORA, updatedAt: AGORA,
    });
    // A Bia é conexão ACEITA da dona; a Clara, só pedido pendente.
    await db.insert(connections).values([
      { requesterId: dona.id, recipientId: bia.id, status: "accepted" },
      { requesterId: clara.id, recipientId: dona.id, status: "pending" },
    ]);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const contas = [dona, ana, bia, clara].filter(Boolean).map(conta => conta.id);
    await apagarPelaChave(db, meetingParticipants, inArray(meetingParticipants.meetingId, TODAS));
    await apagarPelaChave(db, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    if (contas.length) {
      await apagarPelaChave(db, auditLogs, inArray(auditLogs.userId, contas));
      await apagarPelaChave(db, connections, inArray(connections.requesterId, contas));
      await apagarPelaChave(db, userProfiles, inArray(userProfiles.userId, contas));
      await apagarPelaChave(db, users, inArray(users.id, contas));
    }
    for (const id of TODAS) await db.delete(meetings).where(and(eq(meetings.id, id), eq(meetings.ownerId, DONA)));
  });

  it("o convite pede a confirmação da dona na primeira vez, grava a prova na transação e guarda só o hash do token", async () => {
    expect(await recusa(criarConvite(DONA, PRINCIPAL, prova(dona)))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DOS_PARTICIPANTES.autorizacaoPedida });
    const { token, expiraEm } = await criarConvite(DONA, PRINCIPAL, prova(dona), AUTORIZACAO);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(expiraEm).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    const db = (await getDb())!;
    const [linha] = await db.select().from(meetingParticipants).where(eq(meetingParticipants.inviteTokenHash, hashDoConvite(token)));
    expect(linha).toMatchObject({ status: "invited", source: "link", userId: null, ownerId: DONA });
    expect(JSON.stringify(linha)).not.toContain(token);
    const provas = await db.select({ details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.action, ACAO_PARTICIPANTES_AUTORIZADAS), eq(auditLogs.resourceId, PRINCIPAL)));
    expect(provas).toHaveLength(1);
    expect(provas[0].details).toMatchObject({ autorizacaoDasPessoas: true, idioma: "pt-BR", textoExibido: AUTORIZACAO.textoExibido });
    // A segunda vez não pede de novo, nem grava outra prova.
    await criarConvite(DONA, PRINCIPAL, prova(dona));
    expect(await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, ACAO_PARTICIPANTES_AUTORIZADAS), eq(auditLogs.resourceId, PRINCIPAL)))).toHaveLength(1);
  });

  it("outra conta não convida para a reunião da dona, e a reunião que não está pronta não recebe convite", async () => {
    expect(await recusa(criarConvite(ANA, PRINCIPAL, prova(ana), AUTORIZACAO))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DOS_PARTICIPANTES.reuniaoNaoEncontrada });
    const db = (await getDb())!;
    await db.update(meetings).set({ status: "processing" }).where(eq(meetings.id, EXCLUIR));
    expect(await recusa(criarConvite(DONA, EXCLUIR, prova(dona), AUTORIZACAO))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DOS_PARTICIPANTES.soReuniaoPronta });
    await db.update(meetings).set({ status: "ready" }).where(eq(meetings.id, EXCLUIR));
  });

  it("o convite vale uma vez: de dois aceites ao mesmo tempo só um vence, a dona não aceita o próprio, e o vencido não abre", async () => {
    const { token } = await criarConvite(DONA, PRINCIPAL, prova(dona), AUTORIZACAO);
    // A página do convite: o título e o nome da dona, para quem abriu; a dona vê que é dela.
    expect(await verConvite(token, ana)).toMatchObject({ valido: true, meetingId: PRINCIPAL, nomeDaDona: NOME_DA_DONA, propria: false, jaParticipa: false });
    expect(await verConvite(token, dona)).toMatchObject({ valido: true, propria: true });
    expect(await recusa(aceitarConvite(token, dona, prova(dona)))).toMatchObject({ message: RECUSAS_DOS_PARTICIPANTES.conviteDaPropriaDona });
    const [daAna, daClara] = await Promise.allSettled([aceitarConvite(token, ana, prova(ana)), aceitarConvite(token, clara, prova(clara))]);
    const venceu = [daAna, daClara].filter(r => r.status === "fulfilled");
    expect(venceu).toHaveLength(1);
    const perdeu = [daAna, daClara].find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(perdeu.reason).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DOS_PARTICIPANTES.conviteInvalido });
    // Usado, não abre mais: nem a página, nem outro aceite.
    expect(await verConvite(token, bia)).toEqual({ valido: false });
    expect(await recusa(aceitarConvite(token, bia, prova(bia)))).toMatchObject({ message: RECUSAS_DOS_PARTICIPANTES.conviteInvalido });
    // Se a Clara venceu, a Ana entra por outro convite (os testes seguintes contam com a Ana dentro e a Clara fora).
    const db = (await getDb())!;
    if (daClara.status === "fulfilled") {
      await db.delete(meetingParticipants).where(and(eq(meetingParticipants.meetingId, PRINCIPAL), eq(meetingParticipants.userId, clara.id)));
      const outro = await criarConvite(DONA, PRINCIPAL, prova(dona));
      await aceitarConvite(outro.token, ana, prova(ana));
    }
    // O convite vencido não abre.
    const vencido = await criarConvite(DONA, PRINCIPAL, prova(dona));
    await db.update(meetingParticipants).set({ expiresAt: Date.now() - 1000 }).where(eq(meetingParticipants.inviteTokenHash, hashDoConvite(vencido.token)));
    expect(await verConvite(vencido.token, bia)).toEqual({ valido: false });
    expect(await recusa(aceitarConvite(vencido.token, bia, prova(bia)))).toMatchObject({ message: RECUSAS_DOS_PARTICIPANTES.conviteInvalido });
    // E sai quando a dona abre o painel (limpeza preguiçosa).
    await participantesDaReuniao(dona, PRINCIPAL);
    expect(await db.select({ id: meetingParticipants.id }).from(meetingParticipants).where(eq(meetingParticipants.inviteTokenHash, hashDoConvite(vencido.token)))).toHaveLength(0);
  });

  it("a participante lê a reunião pela credencial, com os nomes das vozes; quem não participa, ou sem sessão, não abre", async () => {
    const lida = await lerComo(ana, PRINCIPAL);
    expect(lida).toMatchObject({ participante: true, vozes: { F1: "Nome livre" }, transcricao: { texto: "Oi. Tudo bem. Combinado. Até." } });
    for (const conta of [bia, dona, null]) {
      expect(await recusa(lerComo(conta, PRINCIPAL))).toBeInstanceOf(LinkAbertoRecusado);
    }
    // Nada da rede particular da dona nem o id dela.
    expect(JSON.stringify(lida)).not.toContain(DONA);
    expect(await compartilhadasComigo(ana)).toMatchObject({ reunioes: [{ meetingId: PRINCIPAL, nomeDaDona: NOME_DA_DONA }], convites: [] });
  });

  it("a participante não muda nada: nomear, ligar e juntar vozes e convidar a tratam como quem não é dona", async () => {
    expect(await nomearFalante(ANA, PRINCIPAL, "F1", "Outro")).toBeNull();
    expect(await recusa(ligarVozAConta(ANA, PRINCIPAL, "F1", "owner"))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DAS_VOZES.reuniaoNaoEncontrada });
    expect(await recusa(juntarVozes(ANA, PRINCIPAL, "F3", "F1"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await recusa(criarConvite(ANA, PRINCIPAL, prova(ana), AUTORIZACAO))).toMatchObject({ code: "NOT_FOUND" });
    expect(await getPrivateMeeting(ANA, PRINCIPAL)).toBeNull();
    // A participante vê as que aceitaram e a dona, sem ids.
    const vistas = await participantesDaReuniao(ana, PRINCIPAL);
    expect(vistas).toMatchObject({ papel: "participante", nomeDaDona: NOME_DA_DONA, participantes: [{ nome: NOME_DA_ANA, souEu: true }] });
    expect(JSON.stringify(vistas)).not.toMatch(/"id"/);
    // E quem não participa leva NOT_FOUND.
    expect(await recusa(participantesDaReuniao(bia, PRINCIPAL))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("a conexão aceita recebe o convite na conta e aceita; a conexão pendente é recusada", async () => {
    const [pendente] = await (await getDb())!.select({ id: connections.id }).from(connections).where(eq(connections.requesterId, clara.id));
    expect(await recusa(convidarConexao(dona, PRINCIPAL, pendente.id, prova(dona)))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DOS_PARTICIPANTES.conexaoInvalida });
    const [aceita] = await (await getDb())!.select({ id: connections.id }).from(connections).where(eq(connections.recipientId, bia.id));
    const { participanteId } = await convidarConexao(dona, PRINCIPAL, aceita.id, prova(dona));
    expect(await recusa(convidarConexao(dona, PRINCIPAL, aceita.id, prova(dona)))).toMatchObject({ code: "CONFLICT", message: RECUSAS_DOS_PARTICIPANTES.jaParticipa });
    // Antes do aceite, a Bia não lê, e a voz não se liga a ela.
    expect(await recusa(lerComo(bia, PRINCIPAL))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await recusa(ligarVozAConta(DONA, PRINCIPAL, "F2", participanteId))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DAS_VOZES.contaInvalida });
    expect((await compartilhadasComigo(bia)).convites).toMatchObject([{ participanteId, meetingId: PRINCIPAL, nomeDaDona: NOME_DA_DONA }]);
    // Outra conta não responde pelo convite da Bia.
    expect(await recusa(responderConviteDeConexao(ana, participanteId, true, prova(ana)))).toMatchObject({ code: "NOT_FOUND" });
    await responderConviteDeConexao(bia, participanteId, true, prova(bia));
    expect(await lerComo(bia, PRINCIPAL)).toMatchObject({ participante: true });
  });

  it("H3c: a dona liga as vozes às contas e junta vozes; a participante vê os nomes das contas e as juntadas", async () => {
    const painel = await participantesDaReuniao(dona, PRINCIPAL);
    if (painel.papel !== "dona") throw new Error("era a dona");
    const daAna = painel.participantes.find(p => p.nome === NOME_DA_ANA)!;
    const daBia = painel.participantes.find(p => p.nome === NOME_DA_BIA)!;
    expect(daAna).toMatchObject({ status: "active" });
    await ligarVozAConta(DONA, PRINCIPAL, "F2", daAna.id);
    await ligarVozAConta(DONA, PRINCIPAL, "F3", "owner");
    // A conta vence o nome livre: F1 tem nome livre e passa a ser a Bia.
    await ligarVozAConta(DONA, PRINCIPAL, "F1", daBia.id);
    await juntarVozes(DONA, PRINCIPAL, "F4", "F2");
    // Sem cadeia, sem a voz a si mesma, sem voz que não está nas falas.
    expect(await recusa(juntarVozes(DONA, PRINCIPAL, "F1", "F4"))).toMatchObject({ message: RECUSAS_DAS_VOZES.principalJuntada });
    expect(await recusa(juntarVozes(DONA, PRINCIPAL, "F1", "F1"))).toMatchObject({ message: RECUSAS_DAS_VOZES.juntarASiMesma });
    expect(await recusa(juntarVozes(DONA, PRINCIPAL, "F9", "F1"))).toMatchObject({ message: RECUSAS_DAS_VOZES.vozInvalida });
    const lida = await lerComo(ana, PRINCIPAL);
    expect(lida.vozes).toEqual({ F1: NOME_DA_BIA, F2: NOME_DA_ANA, F3: NOME_DA_DONA });
    expect(lida.juntadas).toEqual({ F4: "F2" });
    // A dona vê o mesmo, e a ligação de cada voz para o seletor.
    const daDona = (await getPrivateMeeting(DONA, PRINCIPAL))!;
    expect(daDona.meeting.vozes).toEqual({ nomes: { F1: NOME_DA_BIA, F2: NOME_DA_ANA, F3: NOME_DA_DONA }, juntadas: { F4: "F2" } });
    expect(daDona.meeting.contasDasVozes).toEqual({ F1: daBia.id, F2: daAna.id, F3: "owner" });
    // Juntar a principal leva as que apontavam para ela (F4 vai junto para F1).
    await juntarVozes(DONA, PRINCIPAL, "F2", "F1");
    expect((await lerComo(ana, PRINCIPAL)).juntadas).toEqual({ F2: "F1", F4: "F1" });
    await separarVoz(DONA, PRINCIPAL, "F2");
    await separarVoz(DONA, PRINCIPAL, "F4");
    await juntarVozes(DONA, PRINCIPAL, "F4", "F2");
    // O nome livre digitado numa voz ligada tira a ligação (o seletor "Outra pessoa").
    await nomearFalante(DONA, PRINCIPAL, "F3", "Convidada sem conta");
    expect((await lerComo(ana, PRINCIPAL)).vozes.F3).toBe("Convidada sem conta");
    expect((await getPrivateMeeting(DONA, PRINCIPAL))!.meeting.contasDasVozes).toEqual({ F1: daBia.id, F2: daAna.id });
  });

  it("a participante que sai perde o acesso, e a voz dela volta a 'Falante n'; a removida também", async () => {
    await sairDaReuniao(ana, PRINCIPAL, prova(ana));
    expect(await recusa(lerComo(ana, PRINCIPAL))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await recusa(sairDaReuniao(ana, PRINCIPAL, prova(ana)))).toMatchObject({ message: RECUSAS_DOS_PARTICIPANTES.participanteNaoEncontrada });
    const lida = await lerComo(bia, PRINCIPAL);
    expect(lida.vozes).toEqual({ F1: NOME_DA_BIA, F3: "Convidada sem conta" });
    // A ligação sai também da coluna, não só da leitura.
    const [linha] = await (await getDb())!.select({ contas: meetings.speakerAccounts }).from(meetings).where(eq(meetings.id, PRINCIPAL));
    expect(Object.values(linha.contas ?? {})).toHaveLength(1);
    // A dona remove a Bia: o acesso acaba na hora.
    const painel = await participantesDaReuniao(dona, PRINCIPAL);
    if (painel.papel !== "dona") throw new Error("era a dona");
    const daBia = painel.participantes.find(p => p.nome === NOME_DA_BIA)!;
    expect(await recusa(removerParticipante(ANA, daBia.id, prova(ana)))).toMatchObject({ code: "NOT_FOUND" });
    // "Cancelar convite" não tira quem já aceitou.
    expect(await recusa(removerParticipante(DONA, daBia.id, prova(dona), { soConvite: true }))).toMatchObject({ code: "NOT_FOUND" });
    await removerParticipante(DONA, daBia.id, prova(dona));
    expect(await recusa(lerComo(bia, PRINCIPAL))).toBeInstanceOf(LinkAbertoRecusado);
    expect((await lerComo(null, PRINCIPAL).catch(() => null))).toBeNull();
  });

  it("a dona desativada e a reunião na lixeira cortam as participantes; restaurar devolve", async () => {
    const db = (await getDb())!;
    const { token } = await criarConvite(DONA, LIXEIRA, prova(dona), AUTORIZACAO);
    await aceitarConvite(token, clara, prova(clara));
    expect(await lerComo(clara, LIXEIRA)).toMatchObject({ participante: true });
    await db.update(meetings).set({ trashedAt: Date.now() }).where(eq(meetings.id, LIXEIRA));
    expect(await recusa(lerComo(clara, LIXEIRA))).toBeInstanceOf(LinkAbertoRecusado);
    expect((await compartilhadasComigo(clara)).reunioes.map(r => r.meetingId)).not.toContain(LIXEIRA);
    expect(await recusa(sairDaReuniao(clara, LIXEIRA, prova(clara)))).toBeTruthy();
    await db.update(meetings).set({ trashedAt: null }).where(eq(meetings.id, LIXEIRA));
    expect(await lerComo(clara, LIXEIRA)).toMatchObject({ participante: true });
    await db.update(users).set({ isActive: false }).where(eq(users.id, dona.id));
    try {
      expect(await recusa(lerComo(clara, LIXEIRA))).toBeInstanceOf(LinkAbertoRecusado);
      expect((await compartilhadasComigo(clara)).reunioes).toEqual([]);
    } finally {
      await db.update(users).set({ isActive: true }).where(eq(users.id, dona.id));
    }
  });

  it("até 50 participantes por reunião, contando os convites pendentes", async () => {
    const db = (await getDb())!;
    await criarConvite(DONA, CHEIA, prova(dona), AUTORIZACAO);
    const agora = Date.now();
    await db.insert(meetingParticipants).values(Array.from({ length: PARTICIPANTES_POR_REUNIAO_MAX - 1 }, () => ({
      id: crypto.randomUUID(), meetingId: CHEIA, ownerId: DONA, userId: null, status: "invited" as const, source: "link" as const,
      inviteTokenHash: crypto.randomBytes(32).toString("hex"), invitedAt: agora, expiresAt: agora + 3600_000, createdAt: agora, updatedAt: agora,
    })));
    expect(await recusa(criarConvite(DONA, CHEIA, prova(dona)))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DOS_PARTICIPANTES.reuniaoCheia });
  });

  it("excluir a reunião leva as participações e os convites", async () => {
    const { token } = await criarConvite(DONA, EXCLUIR, prova(dona), AUTORIZACAO);
    await aceitarConvite(token, bia, prova(bia));
    await criarConvite(DONA, EXCLUIR, prova(dona));
    const db = (await getDb())!;
    const contar = async () => Number((await db.select({ n: sql<number>`count(*)` }).from(meetingParticipants).where(eq(meetingParticipants.meetingId, EXCLUIR)))[0].n);
    expect(await contar()).toBe(2);
    await deletePrivateMeeting(DONA, EXCLUIR);
    expect(await contar()).toBe(0);
  });
});
