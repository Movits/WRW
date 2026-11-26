import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

// O bucket é dublê: a exclusão da reunião tira o áudio do bucket, e este
// arquivo não fala com um bucket de verdade (as reuniões daqui não têm áudio).
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: vi.fn(async () => {}),
}));
import { getDb } from "./db";
import {
  auditLogs, consumoDasSalas, meetingParticipants, meetingRoomPresences, meetingRooms, meetings, platformNotifications, users,
} from "../drizzle/schema";
import { MINUTOS_PESSOA_POR_MES, PESSOAS_POR_SALA_MAX, RECUSAS_DA_SALA, SALA_DURA_MS } from "@shared/sala-de-video";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { FalhaDoDaily, type ClienteDoDaily } from "./daily";
import {
  ACAO_AVISO_DO_ORCAMENTO, ACAO_SALA_ABERTA, abrirSala, desligarLinkDeVisitante, encerrarSala, entrarComoVisitante, entrarNaSala, estadoDaSala,
  hashDoLinkDeVisitante, mesDoOrcamento, minutosPessoaDoMes, novoLinkDeVisitante, receberAvisoDaSala, usarClienteDaSalaNosTestes, verLinkDeVisitante,
} from "./sala-de-video";
import { deletePrivateMeeting } from "./meeting-service";

/**
 * A sala de vídeo (V1) contra um banco real DE TESTE, com o Daily dublado (a
 * suíte nunca chama o Daily de verdade): quem abre (Prata ou acima), a sala
 * por reunião, a ficha da dona, das participantes da R1b e dos visitantes, o
 * link de visitante só pelo hash, o teto de 8 pessoas, os avisos do Daily
 * (webhook) na conta do mês, o encerrar, a lixeira, a exclusão da reunião e o
 * teto do orçamento com o aviso de 80%. Sem DATABASE_URL_TESTES, o arquivo se
 * pula.
 *
 * O orçamento é do mês inteiro (consumo_das_salas não tem dona): só este
 * arquivo cria salas, e ele limpa o consumo do mês no começo e no fim.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const sufixo = () => crypto.randomUUID().slice(0, 8);
const DONA = `teste-sala-dona-${crypto.randomUUID()}`;
const BRONZE = `teste-sala-bronze-${crypto.randomUUID()}`;
const ANA = `teste-sala-ana-${crypto.randomUUID()}`;
const ESTRANHA = `teste-sala-estranha-${crypto.randomUUID()}`;
const PRESIDENTE = `teste-sala-presidente-${crypto.randomUUID()}`;
const NOME_DA_DONA = `Dona Sala ${sufixo()}`;
const NOME_DA_ANA = `Ana Sala ${sufixo()}`;
const R = {
  PRINCIPAL: crypto.randomUUID(), LIXEIRA: crypto.randomUUID(), CHEIA: crypto.randomUUID(), EXCLUIR: crypto.randomUUID(),
  LIXEIRA_DEPOIS: crypto.randomUUID(), FALHA: crypto.randomUUID(), ORC1: crypto.randomUUID(), ORC2: crypto.randomUUID(), ORC3: crypto.randomUUID(),
};
const TODAS = Object.values(R);
const AGORA = Date.now();
const AVISO = { aceito: true, versao: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO };
const TITULO_DO_AVISO = "Salas de vídeo: orçamento do mês em 80%";
const VARIAVEIS = ["DAILY_API_KEY", "DAILY_DOMINIO", "DAILY_WEBHOOK_SEGREDO"] as const;

type Conta = { id: number; openId: string; role: string };
let dona: Conta, bronze: Conta, ana: Conta, estranha: Conta, presidente: Conta;
const prova = (conta: { id: number }) => ({ userId: conta.id, ipAddress: "203.0.113.9", userAgent: "vitest-sala" });

const reuniao = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ownerId: DONA, title: `Reunião secreta ${id.slice(0, 4)}`, status: "ready" as const,
  consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA, ...extra,
});

// O Daily dublado: guarda o que o servidor pediu.
const daily = {
  criadas: [] as Array<{ nome: string; expiraEm: number; pessoasMax: number }>,
  fichas: [] as Array<{ sala: string; nome: string; idDaPessoa: string; dona: boolean; expiraEm: number }>,
  apagadas: [] as string[],
  falharCriar: false,
  falharFicha: false,
};
const dubleDoDaily: ClienteDoDaily = {
  enderecoDaSala: nome => `https://marquesa.daily.co/${nome}`,
  async criarSala(opcoes) {
    if (daily.falharCriar) { daily.falharCriar = false; throw new FalhaDoDaily("dublê: o Daily recusou"); }
    daily.criadas.push(opcoes);
    return { nome: opcoes.nome, url: `https://marquesa.daily.co/${opcoes.nome}` };
  },
  async emitirFicha(opcoes) {
    if (daily.falharFicha) { daily.falharFicha = false; throw new FalhaDoDaily("dublê: o Daily não respondeu"); }
    daily.fichas.push(opcoes);
    return `ficha-${opcoes.idDaPessoa}`;
  },
  async apagarSala(nome) { daily.apagadas.push(nome); },
};

async function recusa(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return erro as { code?: string; message: string };
  }
  throw new Error("era para recusar");
}

const salasCriadas: string[] = [];
const enchimentos: string[] = [];
const ambienteAntes: Partial<Record<(typeof VARIAVEIS)[number], string>> = {};

async function salaDaReuniao(meetingId: string) {
  const db = (await getDb())!;
  const [sala] = await db.select().from(meetingRooms).where(and(eq(meetingRooms.ownerId, DONA), eq(meetingRooms.meetingId, meetingId))).limit(1);
  return sala;
}
async function abrir(meetingId: string) {
  const aberta = await abrirSala(dona, meetingId, prova(dona));
  if (aberta.nova) salasCriadas.push(aberta.salaId);
  return aberta;
}
async function usadosNoMes() {
  const db = (await getDb())!;
  const linhas = await db.select().from(consumoDasSalas).where(eq(consumoDasSalas.mes, mesDoOrcamento(Date.now())));
  return minutosPessoaDoMes(linhas.map(linha => ({ ...linha, medida: Boolean(linha.medida) })), Date.now());
}
/** Uma sala fechada e medida, de mentira, que gasta exatamente `minutos` do mês. */
async function encher(minutos: number) {
  const db = (await getDb())!;
  const salaId = crypto.randomUUID();
  enchimentos.push(salaId);
  await db.insert(consumoDasSalas).values({
    salaId, nomeNoFornecedor: `teste-${salaId.slice(0, 20)}`, mes: mesDoOrcamento(Date.now()), criadaEm: Date.now() - 1000,
    expiraEm: Date.now() - 500, encerradaEm: Date.now() - 500, segundosPessoa: minutos * 60, medida: true,
  });
}

describe.skipIf(!temBanco)("Sala de vídeo (integração, Daily dublado)", () => {
  beforeAll(async () => {
    for (const nome of VARIAVEIS) ambienteAntes[nome] = process.env[nome];
    process.env.DAILY_API_KEY = "chave-de-teste-nao-e-real";
    process.env.DAILY_DOMINIO = "marquesa";
    process.env.DAILY_WEBHOOK_SEGREDO = Buffer.from("segredo-do-webhook-de-teste-32by").toString("base64");
    usarClienteDaSalaNosTestes(() => dubleDoDaily);
    const db = (await getDb())!;
    // O consumo do mês é global: começa limpo (só este arquivo cria salas no banco de testes).
    await db.delete(consumoDasSalas).where(eq(consumoDasSalas.mes, mesDoOrcamento(Date.now())));
    await db.delete(auditLogs).where(and(eq(auditLogs.action, ACAO_AVISO_DO_ORCAMENTO), eq(auditLogs.resourceId, mesDoOrcamento(Date.now()))));
    await db.insert(users).values([
      { openId: DONA, name: NOME_DA_DONA, role: "silver" }, { openId: BRONZE, name: "Bronze", role: "bronze" },
      { openId: ANA, name: NOME_DA_ANA, role: "bronze" }, { openId: ESTRANHA, name: "Estranha", role: "silver" },
      { openId: PRESIDENTE, name: "Presidente", role: "president" },
    ]);
    const linhas = await db.select({ id: users.id, openId: users.openId, role: users.role }).from(users)
      .where(inArray(users.openId, [DONA, BRONZE, ANA, ESTRANHA, PRESIDENTE]));
    const por = (openId: string) => linhas.find(linha => linha.openId === openId)!;
    [dona, bronze, ana, estranha, presidente] = [por(DONA), por(BRONZE), por(ANA), por(ESTRANHA), por(PRESIDENTE)];
    await db.insert(meetings).values(TODAS.map(id => reuniao(id, id === R.LIXEIRA ? { trashedAt: AGORA } : {})));
    // A Ana participa da reunião principal (R1b, ativa).
    await db.insert(meetingParticipants).values({
      id: crypto.randomUUID(), meetingId: R.PRINCIPAL, ownerId: DONA, userId: ana.id, status: "active", source: "connection",
      inviteTokenHash: null, invitedAt: AGORA, expiresAt: null, acceptedAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
    });
  });

  afterAll(async () => {
    usarClienteDaSalaNosTestes(null);
    for (const nome of VARIAVEIS) {
      if (ambienteAntes[nome] === undefined) delete process.env[nome];
      else process.env[nome] = ambienteAntes[nome];
    }
    const db = await getDb();
    if (!db) return;
    const contas = [dona, bronze, ana, estranha, presidente].filter(Boolean).map(conta => conta.id);
    await apagarPelaChave(db, meetingRoomPresences, eq(meetingRoomPresences.ownerId, DONA));
    await apagarPelaChave(db, meetingRooms, eq(meetingRooms.ownerId, DONA));
    for (const salaId of [...salasCriadas, ...enchimentos]) await db.delete(consumoDasSalas).where(eq(consumoDasSalas.salaId, salaId));
    await db.delete(auditLogs).where(and(eq(auditLogs.action, ACAO_AVISO_DO_ORCAMENTO), eq(auditLogs.resourceId, mesDoOrcamento(Date.now()))));
    await apagarPelaChave(db, platformNotifications, eq(platformNotifications.title, TITULO_DO_AVISO));
    await apagarPelaChave(db, meetingParticipants, inArray(meetingParticipants.meetingId, TODAS));
    if (contas.length) {
      await apagarPelaChave(db, auditLogs, inArray(auditLogs.userId, contas));
      await apagarPelaChave(db, users, inArray(users.id, contas));
    }
    for (const id of TODAS) await db.delete(meetings).where(and(eq(meetings.id, id), eq(meetings.ownerId, DONA)));
  });

  it("Bronze não abre; Prata abre a sala no Daily (privada, 2 horas, 8 pessoas), com a linha, o consumo e a auditoria; abrir de novo devolve a mesma", async () => {
    expect(await recusa(abrirSala(bronze, R.PRINCIPAL, prova(bronze)))).toMatchObject({ code: "FORBIDDEN", message: RECUSAS_DA_SALA.soPrataOuAcima });
    const antes = Date.now();
    const aberta = await abrir(R.PRINCIPAL);
    expect(aberta.nova).toBe(true);
    expect(daily.criadas).toHaveLength(1);
    expect(daily.criadas[0].pessoasMax).toBe(PESSOAS_POR_SALA_MAX);
    expect(daily.criadas[0].expiraEm).toBeGreaterThanOrEqual(antes + SALA_DURA_MS);
    expect(daily.criadas[0].nome).toMatch(/^sala-[0-9a-f]{24}$/);
    const sala = await salaDaReuniao(R.PRINCIPAL);
    expect(sala).toMatchObject({ id: aberta.salaId, providerRoomName: daily.criadas[0].nome, guestLinkHash: null, endedAt: null });
    const db = (await getDb())!;
    const [consumo] = await db.select().from(consumoDasSalas).where(eq(consumoDasSalas.salaId, aberta.salaId));
    expect(consumo).toMatchObject({ nomeNoFornecedor: sala.providerRoomName, mes: mesDoOrcamento(antes), segundosPessoa: 0, encerradaEm: null });
    expect(Boolean(consumo.medida)).toBe(true);
    const [auditoria] = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, dona.id), eq(auditLogs.action, ACAO_SALA_ABERTA)));
    expect(auditoria.resourceId).toBe(R.PRINCIPAL);

    const deNovo = await abrir(R.PRINCIPAL);
    expect(deNovo).toEqual({ salaId: aberta.salaId, nova: false, expiraEm: aberta.expiraEm });
    expect(daily.criadas).toHaveLength(1);
  });

  it("a reunião de outra conta, a da lixeira e a que não existe: SALA_REUNIAO_NAO_ENCONTRADA, sem sala no Daily", async () => {
    const criadasAntes = daily.criadas.length;
    for (const [conta, meetingId] of [[estranha, R.PRINCIPAL], [dona, R.LIXEIRA], [dona, crypto.randomUUID()]] as const) {
      expect(await recusa(abrirSala(conta, meetingId, prova(conta)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.reuniaoNaoEncontrada });
    }
    expect(daily.criadas).toHaveLength(criadasAntes);
  });

  it("o Daily recusa criar a sala: SALA_FORNECEDOR_FALHOU, e nada fica no banco", async () => {
    daily.falharCriar = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recusa(abrirSala(dona, R.FALHA, prova(dona)))).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: RECUSAS_DA_SALA.fornecedorFalhou });
    expect(await salaDaReuniao(R.FALHA)).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("a ficha: a dona (dona da sala no Daily, com o nome da conta), a participante ativa com o aviso; a estranha e a participante sem aviso não", async () => {
    const sala = await salaDaReuniao(R.PRINCIPAL);
    const daDona = await entrarNaSala(dona, sala.id, null);
    expect(daDona).toMatchObject({ salaId: sala.id, url: `https://marquesa.daily.co/${sala.providerRoomName}`, papel: "owner" });
    const fichaDaDona = daily.fichas.at(-1)!;
    expect(fichaDaDona).toMatchObject({ sala: sala.providerRoomName, nome: NOME_DA_DONA, dona: true });
    expect(daDona.ficha).toBe(`ficha-${fichaDaDona.idDaPessoa}`);

    expect(await recusa(entrarNaSala(ana, sala.id, null))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_SALA.avisoPedido });
    expect(await recusa(entrarNaSala(ana, sala.id, { aceito: true, versao: "1999-01-01" }))).toMatchObject({ message: RECUSAS_DA_SALA.avisoPedido });
    const daAna = await entrarNaSala(ana, sala.id, AVISO);
    expect(daAna.papel).toBe("participant");
    const fichaDaAna = daily.fichas.at(-1)!;
    expect(fichaDaAna).toMatchObject({ nome: NOME_DA_ANA, dona: false });
    // O identificador que vai ao Daily é o id da presença, nunca o users.id.
    expect(fichaDaAna.idDaPessoa).toMatch(/^[0-9a-f-]{36}$/);
    expect(fichaDaAna.idDaPessoa).not.toBe(String(ana.id));
    expect(fichaDaAna.expiraEm).toBeLessThanOrEqual(Date.now() + 10 * 60_000);

    expect(await recusa(entrarNaSala(estranha, sala.id, AVISO))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.salaNaoEncontrada });
    expect(await recusa(entrarNaSala(ana, crypto.randomUUID(), AVISO))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.salaNaoEncontrada });

    // A conta tem uma presença por sala, reaproveitada; o aceite fica guardado.
    await entrarNaSala(ana, sala.id, AVISO);
    const db = (await getDb())!;
    const presencas = await db.select().from(meetingRoomPresences).where(and(eq(meetingRoomPresences.roomId, sala.id), eq(meetingRoomPresences.userId, ana.id)));
    expect(presencas).toHaveLength(1);
    expect(presencas[0]).toMatchObject({ id: fichaDaAna.idDaPessoa, role: "participant", ownerId: DONA, noticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
  });

  it("o Daily não emite a ficha: SALA_FORNECEDOR_FALHOU, e o lugar volta (a ficha vence na hora)", async () => {
    const sala = await salaDaReuniao(R.PRINCIPAL);
    daily.falharFicha = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recusa(entrarNaSala(dona, sala.id, null))).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: RECUSAS_DA_SALA.fornecedorFalhou });
    vi.restoreAllMocks();
    const db = (await getDb())!;
    const [presenca] = await db.select().from(meetingRoomPresences).where(and(eq(meetingRoomPresences.roomId, sala.id), eq(meetingRoomPresences.userId, dona.id)));
    expect(presenca.tokenExpiresAt).toBe(presenca.tokenIssuedAt);
  });

  it("o link de visitante: só o hash no banco, a página mostra só o nome da dona, o visitante entra só com o nome; trocar e desligar fecham o link antigo", async () => {
    const sala = await salaDaReuniao(R.PRINCIPAL);
    expect(await recusa(novoLinkDeVisitante(ana, sala.id, prova(ana)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.salaNaoEncontrada });
    const { segredo } = await novoLinkDeVisitante(dona, sala.id, prova(dona));
    const db = (await getDb())!;
    const [linha] = await db.select().from(meetingRooms).where(eq(meetingRooms.id, sala.id));
    expect(linha.guestLinkHash).toBe(hashDoLinkDeVisitante(segredo));
    expect(linha.guestLinkHash).not.toContain(segredo);

    const pagina = await verLinkDeVisitante(segredo, "rede-link");
    expect(pagina).toEqual({ valido: true, nomeDaDona: NOME_DA_DONA, expiraEm: sala.expiresAt, versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
    expect(JSON.stringify(pagina)).not.toContain("Reunião secreta");

    const doVisitante = await entrarComoVisitante(segredo, "  Carla   Visitante ", AVISO, "rede-link");
    expect(doVisitante.papel).toBe("guest");
    expect(daily.fichas.at(-1)).toMatchObject({ nome: "Carla Visitante", dona: false });
    const [visitante] = await db.select().from(meetingRoomPresences).where(and(eq(meetingRoomPresences.roomId, sala.id), eq(meetingRoomPresences.role, "guest")));
    expect(visitante).toMatchObject({ userId: null, guestName: "Carla Visitante", ownerId: DONA, noticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });

    // O estado: a dona vê quem recebeu ficha, só pelo nome; a participante, só a sala; a estranha, nada.
    const daDona = await estadoDaSala(dona, R.PRINCIPAL);
    expect(daDona).toMatchObject({ disponivel: true, papel: "dona", podeAbrir: true, sala: { id: sala.id, linkLigado: true } });
    const nomes = daDona.disponivel && daDona.papel === "dona" ? daDona.sala!.pessoas.map(pessoa => `${pessoa.papel}:${pessoa.nome}`) : [];
    expect(nomes).toEqual(expect.arrayContaining([`owner:${NOME_DA_DONA}`, `participant:${NOME_DA_ANA}`, "guest:Carla Visitante"]));
    expect(await estadoDaSala(ana, R.PRINCIPAL)).toEqual({ disponivel: true, papel: "participante", podeAbrir: false, sala: { id: sala.id, expiraEm: sala.expiresAt } });
    expect(await recusa(estadoDaSala(estranha, R.PRINCIPAL))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.reuniaoNaoEncontrada });

    // Trocar o segredo: o antigo para de abrir.
    const { segredo: novo } = await novoLinkDeVisitante(dona, sala.id, prova(dona));
    expect(await verLinkDeVisitante(segredo, "rede-link")).toEqual({ valido: false });
    expect(await recusa(entrarComoVisitante(segredo, "Outra", AVISO, "rede-link"))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.linkInvalido });
    // Desligar: o novo também.
    await desligarLinkDeVisitante(dona, sala.id, prova(dona));
    expect(await verLinkDeVisitante(novo, "rede-link")).toEqual({ valido: false });
    expect((await estadoDaSala(dona, R.PRINCIPAL)) as { sala: { linkLigado: boolean } }).toMatchObject({ sala: { linkLigado: false } });
  });

  it("o teto de 8 pessoas na hora da ficha, contando a dona e os visitantes; quem sai devolve o lugar", async () => {
    const aberta = await abrir(R.CHEIA);
    await entrarNaSala(dona, aberta.salaId, null);
    const { segredo } = await novoLinkDeVisitante(dona, aberta.salaId, prova(dona));
    const entradas = [];
    for (let vez = 1; vez < PESSOAS_POR_SALA_MAX; vez += 1) entradas.push(await entrarComoVisitante(segredo, `Visitante ${vez}`, AVISO, "rede-cheia"));
    expect(entradas).toHaveLength(7);
    const db = (await getDb())!;
    const contar = async () => (await db.select({ id: meetingRoomPresences.id }).from(meetingRoomPresences).where(eq(meetingRoomPresences.roomId, aberta.salaId))).length;
    expect(await contar()).toBe(8);
    expect(await recusa(entrarComoVisitante(segredo, "A nona", AVISO, "rede-cheia"))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_SALA.salaCheia });
    expect(await contar()).toBe(8);

    // Um visitante entra e sai (os avisos do Daily): o lugar volta.
    const sala = await salaDaReuniao(R.CHEIA);
    const primeiro = daily.fichas.find(ficha => ficha.nome === "Visitante 1")!.idDaPessoa;
    const agora = Date.now();
    expect(await receberAvisoDaSala({ tipo: "entrou", sala: sala.providerRoomName, pessoa: primeiro, sessao: "s-cheia", em: agora })).toBe("aplicado");
    expect(await receberAvisoDaSala({ tipo: "saiu", sala: sala.providerRoomName, pessoa: primeiro, sessao: "s-cheia", em: agora + 1000, segundos: 1 })).toBe("aplicado");
    await entrarComoVisitante(segredo, "A nona", AVISO, "rede-cheia");
    expect(await contar()).toBe(9);
  });

  it("os avisos do Daily: a entrada abre a sessão, a saída soma ao consumo ao minuto, o repetido não soma, e o fim fecha as sessões abertas sem fechar a sala", async () => {
    const sala = await salaDaReuniao(R.PRINCIPAL);
    const db = (await getDb())!;
    const presencaDe = async (userId: number) => (await db.select().from(meetingRoomPresences)
      .where(and(eq(meetingRoomPresences.roomId, sala.id), eq(meetingRoomPresences.userId, userId))))[0];
    const consumo = async () => (await db.select().from(consumoDasSalas).where(eq(consumoDasSalas.salaId, sala.id)))[0];
    const daAna = await presencaDe(ana.id);
    const daDona = await presencaDe(dona.id);
    const t0 = Date.now();

    expect(await receberAvisoDaSala({ tipo: "entrou", sala: sala.providerRoomName, pessoa: daAna.id, sessao: "s1", em: t0 })).toBe("aplicado");
    expect(await receberAvisoDaSala({ tipo: "entrou", sala: sala.providerRoomName, pessoa: daAna.id, sessao: "s1", em: t0 })).toBe("ignorado");
    expect(await presencaDe(ana.id)).toMatchObject({ joinedAt: t0, openSessionId: "s1" });
    expect(await receberAvisoDaSala({ tipo: "saiu", sala: sala.providerRoomName, pessoa: daAna.id, sessao: "s1", em: t0 + 125_000, segundos: 125 })).toBe("aplicado");
    expect(await receberAvisoDaSala({ tipo: "saiu", sala: sala.providerRoomName, pessoa: daAna.id, sessao: "s1", em: t0 + 125_000, segundos: 125 })).toBe("ignorado");
    expect(await presencaDe(ana.id)).toMatchObject({ leftAt: t0 + 125_000, openSessionId: null, lastSessionId: "s1", secondsInRoom: 180 });
    expect((await consumo()).segundosPessoa).toBe(180);

    // Sala e pessoa que não existem: ignorado.
    expect(await receberAvisoDaSala({ tipo: "entrou", sala: "sala-que-nao-existe", pessoa: daAna.id, sessao: "x", em: t0 })).toBe("ignorado");
    expect(await receberAvisoDaSala({ tipo: "entrou", sala: sala.providerRoomName, pessoa: crypto.randomUUID(), sessao: "x", em: t0 })).toBe("ignorado");
    expect(await receberAvisoDaSala({ tipo: "entrou", sala: sala.providerRoomName, pessoa: null, sessao: "x", em: t0 })).toBe("ignorado");

    const t1 = t0 + 200_000;
    await receberAvisoDaSala({ tipo: "entrou", sala: sala.providerRoomName, pessoa: daAna.id, sessao: "s2", em: t1 });
    await receberAvisoDaSala({ tipo: "entrou", sala: sala.providerRoomName, pessoa: daDona.id, sessao: "sd", em: t1 });
    expect(await receberAvisoDaSala({ tipo: "fim", sala: sala.providerRoomName, em: t1 + 61_000 })).toBe("aplicado");
    // As duas sessões abertas fecham no fim: 61 s viram 120 s cada.
    expect((await presencaDe(ana.id)).secondsInRoom).toBe(300);
    expect(await presencaDe(dona.id)).toMatchObject({ openSessionId: null, secondsInRoom: 120 });
    // O fim do Daily (a última pessoa saiu) não fecha a sala nem o consumo: quem caiu volta para a mesma sala.
    expect(await consumo()).toMatchObject({ segundosPessoa: 420, encerradaEm: null });
    expect(await salaDaReuniao(R.PRINCIPAL)).toMatchObject({ endedAt: null });
    expect(await receberAvisoDaSala({ tipo: "fim", sala: sala.providerRoomName, em: t1 + 61_000 })).toBe("aplicado");
    expect((await consumo()).segundosPessoa).toBe(420);
    expect((await entrarNaSala(ana, sala.id, AVISO)).papel).toBe("participant");
  });

  it("encerrar: só a dona; a sala sai do Daily e o consumo fecha; encerrar de novo não faz nada", async () => {
    const sala = await salaDaReuniao(R.CHEIA);
    expect(await recusa(encerrarSala(estranha, sala.id, prova(estranha)))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.salaNaoEncontrada });
    expect(await encerrarSala(dona, sala.id, prova(dona))).toEqual({ encerrada: true });
    expect(daily.apagadas).toContain(sala.providerRoomName);
    const db = (await getDb())!;
    const [consumo] = await db.select().from(consumoDasSalas).where(eq(consumoDasSalas.salaId, sala.id));
    expect(consumo.encerradaEm).not.toBeNull();
    expect(await salaDaReuniao(R.CHEIA)).toMatchObject({ guestLinkHash: null });
    expect(await encerrarSala(dona, sala.id, prova(dona))).toEqual({ encerrada: false });
  });

  it("a reunião que vai para a lixeira fecha a sala: nenhuma ficha, o link não abre e o estado não acha a reunião", async () => {
    const aberta = await abrir(R.LIXEIRA_DEPOIS);
    const { segredo } = await novoLinkDeVisitante(dona, aberta.salaId, prova(dona));
    const db = (await getDb())!;
    await db.update(meetings).set({ trashedAt: Date.now() }).where(and(eq(meetings.id, R.LIXEIRA_DEPOIS), eq(meetings.ownerId, DONA)));
    expect(await recusa(entrarNaSala(dona, aberta.salaId, null))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.salaNaoEncontrada });
    expect(await verLinkDeVisitante(segredo, "rede-lixeira")).toEqual({ valido: false });
    expect(await recusa(estadoDaSala(dona, R.LIXEIRA_DEPOIS))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("excluir a reunião leva a sala e as presenças (com o nome do visitante); o consumo fica, e a sala ainda aberta passa a contar pelo teto", async () => {
    const aberta = await abrir(R.EXCLUIR);
    await entrarNaSala(dona, aberta.salaId, null);
    const { segredo } = await novoLinkDeVisitante(dona, aberta.salaId, prova(dona));
    await entrarComoVisitante(segredo, "Visitante da excluída", AVISO, "rede-excluir");
    await deletePrivateMeeting(DONA, R.EXCLUIR);
    const db = (await getDb())!;
    expect(await salaDaReuniao(R.EXCLUIR)).toBeUndefined();
    expect(await db.select().from(meetingRoomPresences).where(eq(meetingRoomPresences.roomId, aberta.salaId))).toEqual([]);
    const [consumo] = await db.select().from(consumoDasSalas).where(eq(consumoDasSalas.salaId, aberta.salaId));
    expect(consumo).toBeDefined();
    expect(Boolean(consumo.medida)).toBe(false);
  });

  it("o orçamento do mês: aos 80% a presidência é avisada uma vez; a sala que passaria do teto é recusada, sem sala no Daily", async () => {
    const db = (await getDb())!;
    const avisosDaPresidente = async () => (await db.select({ id: platformNotifications.id }).from(platformNotifications)
      .where(and(eq(platformNotifications.userId, presidente.id), eq(platformNotifications.title, TITULO_DO_AVISO)))).length;
    expect(await avisosDaPresidente()).toBe(0);

    // Logo abaixo dos 80%: a próxima sala (960) passa da linha.
    await encher(MINUTOS_PESSOA_POR_MES * 0.8 - 900 - (await usadosNoMes()));
    await abrir(R.ORC1);
    expect(await avisosDaPresidente()).toBe(1);
    const marcas = await db.select().from(auditLogs).where(and(eq(auditLogs.action, ACAO_AVISO_DO_ORCAMENTO), eq(auditLogs.resourceId, mesDoOrcamento(Date.now()))));
    expect(marcas).toHaveLength(1);
    expect(marcas[0].userId).toBeNull();
    // A segunda sala acima dos 80% não avisa de novo.
    await abrir(R.ORC2);
    expect(await avisosDaPresidente()).toBe(1);

    // A uma sala do teto: a próxima passaria dele e é recusada.
    await encher(MINUTOS_PESSOA_POR_MES - 959 - (await usadosNoMes()));
    const criadasAntes = daily.criadas.length;
    expect(await recusa(abrirSala(dona, R.ORC3, prova(dona)))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_SALA.orcamentoEsgotado });
    expect(daily.criadas).toHaveLength(criadasAntes);
    expect(await salaDaReuniao(R.ORC3)).toBeUndefined();
  });
});
