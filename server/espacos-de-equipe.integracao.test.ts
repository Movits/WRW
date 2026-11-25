import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";
import { getDb } from "./db";
import {
  agendaReunioes, auditLogs, connections, meetingFolderMembers, meetingFolders, meetingFolderTasks, meetingParticipants, meetings, userProfiles, users,
} from "../drizzle/schema";
import { credencialDaParticipante } from "@shared/participantes-da-reuniao";
import { MEMBRAS_POR_EQUIPE_MAX, RECUSAS_DA_EQUIPE } from "@shared/espacos-de-equipe";
import {
  ACAO_EQUIPE_AUTORIZADA, ACAO_MEMBRA_ENTROU, aceitarConviteDaEquipe, agendaDaEquipe, apagarTarefaDaEquipe, convidarConexaoParaEquipe,
  criarConviteDaEquipe, criarTarefaDaEquipe, editarTarefaDaEquipe, listarTarefasDaEquipe, marcarTarefaDaEquipe, minhasEquipes, mudarPapel,
  porNaAgendaDaEquipe, removerMembra, responderConviteDaEquipe, reunioesDaEquipe, sairDaEquipe, verConviteDaEquipe, verEquipe,
} from "./espacos-de-equipe";
import { hashDoConvite } from "./participantes-da-reuniao";
import { LinkAbertoRecusado, verReuniaoPeloLink } from "./link-aberto-da-reuniao";
import { comCookiesDoPedido } from "./senha-do-link-aberto";
import { apagarPasta } from "./pastas-de-reunioes";

/**
 * Os espaços de equipe (R2) contra um banco real DE TESTE: o convite com
 * papel, a confirmação da dona, o aceite, o anonimato entre membras (só as
 * ativas aparecem, e o convite por link não tem nome), a leitura das reuniões
 * da pasta pela credencial da participante, o que corta o acesso (fora da
 * pasta, lixeira, dona desativada, remoção, saída), as tarefas por papel, a
 * agenda sem os participantes e a pasta apagada. Sem DATABASE_URL_TESTES, o
 * arquivo se pula. Contas, pastas e reuniões com id aleatório: a limpeza no
 * fim só alcança o que este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = () => crypto.randomUUID().slice(0, 8);
const DONA = `teste-eq-dona-${crypto.randomUUID()}`;
const ANA = `teste-eq-ana-${crypto.randomUUID()}`;
const BIA = `teste-eq-bia-${crypto.randomUUID()}`;
const CLARA = `teste-eq-clara-${crypto.randomUUID()}`;
const OUTRA = `teste-eq-outra-${crypto.randomUUID()}`;
const NOME_DA_DONA = `Dona ${sufixo()}`;
const NOME_DA_ANA = `Ana ${sufixo()}`;
const NOME_DA_BIA = `Bia ${sufixo()}`;
const NOME_DA_CLARA = `Clara ${sufixo()}`;
const PASTA = crypto.randomUUID();
const OUTRA_PASTA = crypto.randomUUID();
const PASTA_DA_OUTRA = crypto.randomUUID();
const PASTA_A_APAGAR = crypto.randomUUID();
const PASTAS = [PASTA, OUTRA_PASTA, PASTA_DA_OUTRA, PASTA_A_APAGAR];
const NA_PASTA = crypto.randomUUID();
const FORA_DA_PASTA = crypto.randomUUID();
const NA_OUTRA_PASTA = crypto.randomUUID();
const REUNIOES = [NA_PASTA, FORA_DA_PASTA, NA_OUTRA_PASTA];
const AGENDA = crypto.randomUUID();
const AGENDA_DA_OUTRA = crypto.randomUUID();
const AGORA = Date.now();
const AUTORIZACAO = { idioma: "pt-BR", textoExibido: "Confirmo que as pessoas que falaram autorizaram compartilhar com a equipe." };

type Conta = { id: number; openId: string };
let dona: Conta, ana: Conta, bia: Conta, clara: Conta, outra: Conta;
let membraDaAna = "";
const prova = (conta: Conta) => ({ userId: conta.id, ipAddress: "203.0.113.7", userAgent: "vitest-equipes" });

async function recusa(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return erro as { code?: string; message: string };
  }
  throw new Error("era para recusar");
}

const lerComo = (conta: Conta, meetingId: string) => comCookiesDoPedido(undefined, () => verReuniaoPeloLink(credencialDaParticipante(meetingId)), conta);
const pasta = (id: string, ownerId: string, nome: string) => ({ id, ownerId, name: nome, icon: "pasta", color: "ambar", createdAt: AGORA, updatedAt: AGORA });
const reuniao = (id: string, folderId: string | null) => ({
  id, ownerId: DONA, title: `Reunião ${id.slice(0, 4)}`, status: "ready" as const, consentGranted: true, consentAt: AGORA,
  createdAt: AGORA, updatedAt: AGORA, folderId,
});

describe.skipIf(!temBanco)("Espaços de equipe (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([
      { openId: DONA, name: NOME_DA_DONA }, { openId: ANA, name: NOME_DA_ANA }, { openId: BIA, name: NOME_DA_BIA },
      { openId: CLARA, name: NOME_DA_CLARA }, { openId: OUTRA, name: "Outra dona" },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId }).from(users).where(inArray(users.openId, [DONA, ANA, BIA, CLARA, OUTRA]));
    const por = (openId: string) => linhas.find(linha => linha.openId === openId)!;
    [dona, ana, bia, clara, outra] = [por(DONA), por(ANA), por(BIA), por(CLARA), por(OUTRA)];
    await db.insert(meetingFolders).values([
      pasta(PASTA, DONA, `Equipe ${sufixo()}`), pasta(OUTRA_PASTA, DONA, `Outra ${sufixo()}`),
      pasta(PASTA_DA_OUTRA, OUTRA, `Da outra ${sufixo()}`), pasta(PASTA_A_APAGAR, DONA, `Apagar ${sufixo()}`),
    ]);
    await db.insert(meetings).values([reuniao(NA_PASTA, PASTA), reuniao(FORA_DA_PASTA, null), reuniao(NA_OUTRA_PASTA, OUTRA_PASTA)]);
    // A Bia é conexão ACEITA da dona; a Clara, só pedido pendente.
    await db.insert(connections).values([
      { requesterId: dona.id, recipientId: bia.id, status: "accepted" },
      { requesterId: clara.id, recipientId: dona.id, status: "pending" },
    ]);
    const marcada = (id: string, ownerId: string) => ({
      id, ownerId, titulo: `Marcada ${id.slice(0, 4)}`, inicioEm: AGORA + 86_400_000, duracaoMinutos: 30, fuso: "America/Sao_Paulo",
      local: "https://exemplo.com/sala", participantes: [{ nome: "Terceira Pessoa", email: "terceira@exemplo.com" }], createdAt: AGORA, updatedAt: AGORA,
    });
    await db.insert(agendaReunioes).values([marcada(AGENDA, DONA), marcada(AGENDA_DA_OUTRA, OUTRA)]);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const contas = [dona, ana, bia, clara, outra].filter(Boolean).map(conta => conta.id);
    await apagarPelaChave(db, meetingFolderMembers, inArray(meetingFolderMembers.folderId, PASTAS));
    await apagarPelaChave(db, meetingFolderTasks, inArray(meetingFolderTasks.folderId, PASTAS));
    await apagarPelaChave(db, agendaReunioes, inArray(agendaReunioes.id, [AGENDA, AGENDA_DA_OUTRA]));
    for (const id of REUNIOES) await db.delete(meetings).where(and(eq(meetings.id, id), eq(meetings.ownerId, DONA)));
    await apagarPelaChave(db, meetingFolders, inArray(meetingFolders.id, PASTAS));
    if (contas.length) {
      await apagarPelaChave(db, auditLogs, inArray(auditLogs.userId, contas));
      await apagarPelaChave(db, connections, inArray(connections.requesterId, contas));
      await apagarPelaChave(db, userProfiles, inArray(userProfiles.userId, contas));
      await apagarPelaChave(db, users, inArray(users.id, contas));
    }
  });

  it("o primeiro convite pede a confirmação da dona, grava a prova na transação e guarda só o hash do token, com o papel", async () => {
    expect(await recusa(criarConviteDaEquipe(dona, PASTA, "member", prova(dona)))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_EQUIPE.autorizacaoPedida });
    const { token } = await criarConviteDaEquipe(dona, PASTA, "member", prova(dona), AUTORIZACAO);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const db = (await getDb())!;
    const [linha] = await db.select().from(meetingFolderMembers).where(eq(meetingFolderMembers.inviteTokenHash, hashDoConvite(token)));
    expect(linha).toMatchObject({ status: "invited", source: "link", role: "member", userId: null, ownerId: DONA, folderId: PASTA });
    expect(JSON.stringify(linha)).not.toContain(token);
    const provas = await db.select({ details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.action, ACAO_EQUIPE_AUTORIZADA), eq(auditLogs.resourceId, PASTA)));
    expect(provas).toHaveLength(1);
    expect(provas[0].details).toMatchObject({ autorizacaoDasPessoas: true, textoExibido: AUTORIZACAO.textoExibido });
    // A segunda vez não pede de novo.
    await criarConviteDaEquipe(dona, PASTA, "reader", prova(dona));
    expect(await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, ACAO_EQUIPE_AUTORIZADA), eq(auditLogs.resourceId, PASTA)))).toHaveLength(1);
  });

  it("outra conta não convida para a pasta da dona, e a dona não aceita o próprio convite", async () => {
    expect(await recusa(criarConviteDaEquipe(outra, PASTA, "member", prova(outra), AUTORIZACAO))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.equipeNaoEncontrada });
    const { token } = await criarConviteDaEquipe(dona, PASTA, "member", prova(dona));
    expect(await verConviteDaEquipe(token, dona)).toMatchObject({ valido: true, propria: true });
    expect(await recusa(aceitarConviteDaEquipe(token, dona, prova(dona)))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_EQUIPE.conviteDaPropriaDona });
  });

  it("a Ana aceita o convite de membro; o link vale uma vez, e o convite inválido não diz nada", async () => {
    const { token } = await criarConviteDaEquipe(dona, PASTA, "member", prova(dona));
    const visto = await verConviteDaEquipe(token, ana);
    expect(visto).toMatchObject({ valido: true, pastaId: PASTA, nomeDaDona: NOME_DA_DONA, papel: "member", propria: false, jaEsta: false });
    expect(await aceitarConviteDaEquipe(token, ana, prova(ana))).toEqual({ pastaId: PASTA });
    expect(await verConviteDaEquipe(token, bia)).toEqual({ valido: false });
    expect(await recusa(aceitarConviteDaEquipe(token, bia, prova(bia)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.conviteInvalido });
    expect(await verConviteDaEquipe("x".repeat(32), ana)).toEqual({ valido: false });
    const db = (await getDb())!;
    const [linha] = await db.select().from(meetingFolderMembers).where(and(eq(meetingFolderMembers.folderId, PASTA), eq(meetingFolderMembers.userId, ana.id)));
    expect(linha).toMatchObject({ status: "active", role: "member", inviteTokenHash: null, expiresAt: null });
    membraDaAna = linha.id;
    expect(await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, ACAO_MEMBRA_ENTROU), eq(auditLogs.userId, ana.id)))).toHaveLength(1);
  });

  it("o convite de conexão vale só para conexão aceita da dona, com o papel, e a convidada aceita na conta dela", async () => {
    expect(await recusa(convidarConexaoParaEquipe(dona, PASTA, 999_999_999, "reader", prova(dona)))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_EQUIPE.conexaoInvalida });
    const db = (await getDb())!;
    const [daClara] = await db.select({ id: connections.id }).from(connections).where(eq(connections.requesterId, clara.id));
    expect(await recusa(convidarConexaoParaEquipe(dona, PASTA, daClara.id, "reader", prova(dona)))).toMatchObject({ message: RECUSAS_DA_EQUIPE.conexaoInvalida });
    const [daBia] = await db.select({ id: connections.id }).from(connections).where(eq(connections.recipientId, bia.id));
    const { membraId } = await convidarConexaoParaEquipe(dona, PASTA, daBia.id, "reader", prova(dona));
    expect(await recusa(convidarConexaoParaEquipe(dona, PASTA, daBia.id, "reader", prova(dona)))).toMatchObject({ code: "CONFLICT", message: RECUSAS_DA_EQUIPE.jaEstaNaEquipe });
    // Enquanto o convite está pendente, a Bia não lê nada da equipe.
    expect(await recusa(verEquipe(bia, PASTA))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.equipeNaoEncontrada });
    expect(await recusa(lerComo(bia, NA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect((await minhasEquipes(bia)).convites).toEqual([expect.objectContaining({ membraId, pastaId: PASTA, papel: "reader", nomeDaDona: NOME_DA_DONA })]);
    expect(await responderConviteDaEquipe(bia, membraId, true, prova(bia))).toEqual({ pastaId: PASTA });
    expect((await minhasEquipes(bia)).equipes).toEqual([expect.objectContaining({ pastaId: PASTA, papel: "reader" })]);
  });

  it("anonimato: a membra vê a dona e só as membras ativas, sem ids nem convites; a dona vê o convite por link sem nome", async () => {
    const daAna = await verEquipe(ana, PASTA);
    expect(daAna).toMatchObject({ papel: "member", nomeDaDona: NOME_DA_DONA });
    const nomes = (daAna as { membras: Array<{ nome: string }> }).membras.map(membra => membra.nome).sort();
    expect(nomes).toEqual([NOME_DA_ANA, NOME_DA_BIA].sort());
    expect(JSON.stringify(daAna)).not.toMatch(/"id"|expiraEm|invited|userId/);
    const daDona = await verEquipe(dona, PASTA);
    expect(daDona.papel).toBe("owner");
    const membras = (daDona as { membras: Array<{ status: string; nome: string | null }> }).membras;
    expect(membras.filter(membra => membra.status === "invited").every(membra => membra.nome === null)).toBe(true);
    expect(membras.filter(membra => membra.status === "active").map(membra => membra.nome).sort()).toEqual([NOME_DA_ANA, NOME_DA_BIA].sort());
    // Quem não é da equipe não vê nem que ela existe.
    expect(await recusa(verEquipe(clara, PASTA))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.equipeNaoEncontrada });
  });

  it("as membras leem as reuniões da pasta pela credencial, nos dois papéis; a reunião fora da pasta não abre", async () => {
    expect(await reunioesDaEquipe(ana, PASTA)).toEqual([expect.objectContaining({ id: NA_PASTA })]);
    expect(await lerComo(ana, NA_PASTA)).toMatchObject({ participante: true });
    expect(await lerComo(bia, NA_PASTA)).toMatchObject({ participante: true });
    expect(await recusa(lerComo(ana, FORA_DA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await recusa(lerComo(ana, NA_OUTRA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await recusa(lerComo(clara, NA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await recusa(reunioesDaEquipe(clara, PASTA))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("a membra vê os nomes que a dona deu e o da dona, mas não o da conta de uma participante ligada a uma voz (H3c)", async () => {
    const db = (await getDb())!;
    // A Clara não é da equipe: é participante da reunião (R1b), e a dona liga a voz F2 à conta dela.
    const participacao = crypto.randomUUID();
    await db.insert(meetingParticipants).values({
      id: participacao, meetingId: NA_PASTA, ownerId: DONA, userId: clara.id, status: "active", source: "connection",
      invitedAt: AGORA, acceptedAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
    });
    await db.update(meetings).set({ speakerAccounts: { F1: "owner", F2: participacao }, speakerNames: { F2: "Nome livre de antes", F3: "Caio" } })
      .where(eq(meetings.id, NA_PASTA));
    try {
      const daMembra = await lerComo(ana, NA_PASTA) as { vozes: Record<string, string> };
      expect(daMembra.vozes.F2).toBeUndefined();
      expect(JSON.stringify(daMembra)).not.toContain(NOME_DA_CLARA);
      expect(daMembra.vozes).toMatchObject({ F1: expect.any(String), F3: "Caio" });
      // A participante segue vendo o nome dela, como aceitou.
      const daParticipante = await lerComo(clara, NA_PASTA) as { vozes: Record<string, string> };
      expect(daParticipante.vozes).toMatchObject({ F2: NOME_DA_CLARA, F3: "Caio" });
    } finally {
      await db.delete(meetingParticipants).where(eq(meetingParticipants.id, participacao));
      await db.update(meetings).set({ speakerAccounts: null, speakerNames: null }).where(eq(meetings.id, NA_PASTA));
    }
  });

  it("a reunião que sai da pasta, vai para a lixeira ou é de dona desativada deixa de abrir na hora", async () => {
    const db = (await getDb())!;
    await db.update(meetings).set({ folderId: null }).where(eq(meetings.id, NA_PASTA));
    expect(await recusa(lerComo(ana, NA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await reunioesDaEquipe(ana, PASTA)).toEqual([]);
    await db.update(meetings).set({ folderId: PASTA, trashedAt: Date.now() }).where(eq(meetings.id, NA_PASTA));
    expect(await recusa(lerComo(ana, NA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await reunioesDaEquipe(ana, PASTA)).toEqual([]);
    await db.update(meetings).set({ trashedAt: null }).where(eq(meetings.id, NA_PASTA));
    await db.update(users).set({ isActive: false }).where(eq(users.id, dona.id));
    try {
      expect(await recusa(lerComo(ana, NA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
      expect(await recusa(verEquipe(ana, PASTA))).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await db.update(users).set({ isActive: true }).where(eq(users.id, dona.id));
    }
    expect(await lerComo(ana, NA_PASTA)).toMatchObject({ participante: true });
  });

  it("tarefas: a dona e a membro escrevem; a leitora só lê; quem é de fora nem lê", async () => {
    const { id } = await criarTarefaDaEquipe(ana, PASTA, { texto: "Mandar a proposta", responsavel: "Ana", prazo: "2030-01-15" }, prova(ana));
    await criarTarefaDaEquipe(dona, PASTA, { texto: "Revisar o contrato" }, prova(dona));
    expect(await recusa(criarTarefaDaEquipe(bia, PASTA, { texto: "Não pode" }, prova(bia)))).toMatchObject({ code: "FORBIDDEN", message: RECUSAS_DA_EQUIPE.soLeitura });
    expect(await recusa(marcarTarefaDaEquipe(bia, PASTA, id, true, prova(bia)))).toMatchObject({ code: "FORBIDDEN", message: RECUSAS_DA_EQUIPE.soLeitura });
    expect(await recusa(criarTarefaDaEquipe(clara, PASTA, { texto: "De fora" }, prova(clara)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.equipeNaoEncontrada });
    expect(await recusa(criarTarefaDaEquipe(ana, PASTA, { texto: "Prazo ruim", prazo: "2030-02-31" }, prova(ana)))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_EQUIPE.prazoInvalido });
    const daBia = await listarTarefasDaEquipe(bia, PASTA);
    expect(daBia.podeEscrever).toBe(false);
    expect(daBia.tarefas.map(tarefa => tarefa.texto)).toEqual(["Mandar a proposta", "Revisar o contrato"]);
    await editarTarefaDaEquipe(dona, PASTA, id, { responsavel: null, prazo: null }, prova(dona));
    await marcarTarefaDaEquipe(ana, PASTA, id, true, prova(ana));
    const depois = (await listarTarefasDaEquipe(ana, PASTA)).tarefas.find(tarefa => tarefa.id === id)!;
    expect(depois).toMatchObject({ feita: true, responsavel: null, prazo: null });
    expect(depois.feitaEm).toEqual(expect.any(Number));
    // A tarefa de uma equipe não se mexe pela outra pasta.
    expect(await recusa(apagarTarefaDaEquipe(dona, OUTRA_PASTA, id, prova(dona)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.tarefaNaoEncontrada });
    await apagarTarefaDaEquipe(ana, PASTA, id, prova(ana));
    expect((await listarTarefasDaEquipe(dona, PASTA)).tarefas.map(tarefa => tarefa.texto)).toEqual(["Revisar o contrato"]);
  });

  it("a dona muda o papel: a membro que vira leitora para de escrever na hora", async () => {
    await mudarPapel(DONA, membraDaAna, "reader", prova(dona));
    expect(await recusa(criarTarefaDaEquipe(ana, PASTA, { texto: "Agora não" }, prova(ana)))).toMatchObject({ code: "FORBIDDEN" });
    expect(await recusa(mudarPapel(OUTRA, membraDaAna, "member", prova(outra)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.membraNaoEncontrada });
    await mudarPapel(DONA, membraDaAna, "member", prova(dona));
    await criarTarefaDaEquipe(ana, PASTA, { texto: "De novo membro" }, prova(ana));
  });

  it("agenda: a dona põe a reunião marcada na equipe, e as membras veem sem os participantes", async () => {
    expect(await agendaDaEquipe(ana, PASTA)).toEqual([]);
    await porNaAgendaDaEquipe(dona, AGENDA, PASTA, prova(dona));
    const vista = await agendaDaEquipe(bia, PASTA);
    expect(vista).toEqual([expect.objectContaining({ id: AGENDA, local: "https://exemplo.com/sala", duracaoMinutos: 30 })]);
    expect(JSON.stringify(vista)).not.toMatch(/terceira|participantes/i);
    // A reunião marcada de outra conta, e a pasta de outra conta, são "não encontradas".
    expect(await recusa(porNaAgendaDaEquipe(dona, AGENDA_DA_OUTRA, PASTA, prova(dona)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.agendaNaoEncontrada });
    expect(await recusa(porNaAgendaDaEquipe(dona, AGENDA, PASTA_DA_OUTRA, prova(dona)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.equipeNaoEncontrada });
    expect(await recusa(porNaAgendaDaEquipe(ana, AGENDA, PASTA, prova(ana)))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("a removida e a que sai perdem o acesso na hora", async () => {
    await removerMembra(DONA, membraDaAna, prova(dona));
    expect(await recusa(lerComo(ana, NA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await recusa(listarTarefasDaEquipe(ana, PASTA))).toMatchObject({ code: "NOT_FOUND" });
    expect((await minhasEquipes(ana)).equipes).toEqual([]);
    await sairDaEquipe(bia, PASTA, prova(bia));
    expect(await recusa(lerComo(bia, NA_PASTA))).toBeInstanceOf(LinkAbertoRecusado);
    expect(await recusa(sairDaEquipe(bia, PASTA, prova(bia)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_EQUIPE.membraNaoEncontrada });
  });

  it("a equipe tem até 50 membras, contando os convites pendentes", async () => {
    const db = (await getDb())!;
    const agora = Date.now();
    const existentes = await db.select({ id: meetingFolderMembers.id }).from(meetingFolderMembers).where(eq(meetingFolderMembers.folderId, PASTA));
    const faltam = MEMBRAS_POR_EQUIPE_MAX - existentes.length;
    await db.insert(meetingFolderMembers).values(Array.from({ length: faltam }, () => ({
      id: crypto.randomUUID(), folderId: PASTA, ownerId: DONA, userId: null, role: "reader" as const, status: "invited" as const, source: "link" as const,
      inviteTokenHash: crypto.randomBytes(32).toString("hex"), invitedAt: agora, expiresAt: agora + 3_600_000, acceptedAt: null, createdAt: agora, updatedAt: agora,
    })));
    expect(await recusa(criarConviteDaEquipe(dona, PASTA, "member", prova(dona)))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_EQUIPE.equipeCheia });
  });

  it("a pasta apagada leva as membras e as tarefas, e a agenda fica sem equipe", async () => {
    const db = (await getDb())!;
    const { token } = await criarConviteDaEquipe(dona, PASTA_A_APAGAR, "member", prova(dona), AUTORIZACAO);
    await aceitarConviteDaEquipe(token, clara, prova(clara));
    await criarTarefaDaEquipe(clara, PASTA_A_APAGAR, { texto: "Some com a pasta" }, prova(clara));
    await porNaAgendaDaEquipe(dona, AGENDA, PASTA_A_APAGAR, prova(dona));
    await apagarPasta(DONA, PASTA_A_APAGAR);
    expect(await db.select().from(meetingFolderMembers).where(eq(meetingFolderMembers.folderId, PASTA_A_APAGAR))).toEqual([]);
    expect(await db.select().from(meetingFolderTasks).where(eq(meetingFolderTasks.folderId, PASTA_A_APAGAR))).toEqual([]);
    const [marcada] = await db.select({ folderId: agendaReunioes.folderId }).from(agendaReunioes).where(eq(agendaReunioes.id, AGENDA));
    expect(marcada.folderId).toBeNull();
    expect((await minhasEquipes(clara)).equipes).toEqual([]);
  });
});
