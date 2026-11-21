import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * N5 — a reunião vira conexões e refina o perfil, contra um banco real DE
 * TESTE (sem DATABASE_URL_TESTES, se pula). A extração é a "IA simulada": a
 * reunião é gravada pelo caminho de sempre (gravarResultadoDaReuniao) com o
 * que a IA teria devolvido, e o portão confere contra a transcrição inventada.
 *
 * - Nada entra sozinho: processar a reunião não muda o perfil nem os itens dos
 *   contatos, e "poderia precisar de contador" nem vira pendência.
 * - "Sou eu": não cria contato e leva o que a pessoa tem e precisa ao perfil
 *   da dona, ainda pendente; outra dona leva NOT_FOUND; reunião em
 *   processamento, CONFLICT.
 * - Perfil: o "tenho" entra uma vez, o 51º é recusado, o "preciso" curto é
 *   recusado, o confirmado chega a necessidadesEscritasDoPerfil, o item com o
 *   nome de alguém da reunião é recusado, e o motor de perfis roda UMA vez
 *   por reunião (dublado: a contagem é o que se prova).
 * - Do item à conexão: "Exportar café" × "Importar café" nasce, com a origem;
 *   "Exportar café" × "Exportar café" não nasce (concorrentes).
 * - Vincular na segunda reunião: o que o contato já tem é ignorado.
 * - Exclusões: sem a reunião, o item e a conexão ficam, sem origem; sem o
 *   contato, sai tudo dele; sem o contato, o nome dele segue barrado no perfil.
 * - Ignorar (revisão da N5): o último item do perfil, ignorado, decide a
 *   reunião e o motor roda uma vez; a reunião só com ignorados não o roda;
 *   outra dona leva NOT_FOUND; três confirmações ao mesmo tempo não perdem item.
 * - Sem o termo do Smart Match, as conexões da reunião não saem (revisão da N5).
 * - Privacidade: o link aberto não tem as conexões nem as pendências, nem
 *   nos procedimentos nem no que eles devolvem.
 *
 * Dona com openId aleatório: a limpeza no fim só alcança o que este arquivo criou.
 */
const motor = vi.hoisted(() => ({ rodadas: [] as number[] }));
vi.mock("./matching", async original => {
  const real = await original<typeof import("./matching")>();
  return { ...real, generateMatchesForUser: async (userId: number) => { motor.rodadas.push(userId); return 0; } };
});
// O banco de teste não tem termo publicado, e hasValidConsent diz "sim" a todas: o dublê deixa o teste
// negar o termo do Smart Match só onde ele pede (revisão da N5).
const termo = vi.hoisted(() => ({ negado: false }));
vi.mock("./routers/consent", async original => {
  const real = await original<typeof import("./routers/consent")>();
  return { ...real, hasValidConsent: async (...args: Parameters<typeof real.hasValidConsent>) => (termo.negado ? false : real.hasValidConsent(...args)) };
});

const { getDb } = await import("./db");
const {
  aiMatchSuggestions, auditLogs, conexoesParticipantes, conexoesRegistradas, consumoDeMinutos, contactAssets, contactNeeds,
  meetingContactSuggestions, meetingEntities, meetingSummaries, meetingTranscripts, meetings, networkSugestoes,
  privateContacts, userProfiles, users,
} = await import("../drizzle/schema");
const { gravarResultadoDaReuniao } = await import("./meeting-service");
const { ligarLinkAberto } = await import("./link-aberto-da-reuniao");
const { appRouter } = await import("./routers");
const { necessidadesEscritasDoPerfil } = await import("./portao-da-demanda-expressa");
const { MENSAGEM_ITEM_DO_PERFIL_COM_IDENTIFICACAO, MENSAGEM_O_QUE_TENHO_CHEIO } = await import("./reuniao-no-match");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-reuniao-no-match-${crypto.randomUUID()}`;
const OUTRA = `teste-reuniao-no-match-outra-${crypto.randomUUID()}`;

const TRANSCRICAO = [
  "Eu sou a Ana Lima, da Torrefação Aurora. Eu exporto café para a Europa e preciso de um distribuidor no Chile.",
  "Eu sou o Bruno Prado. Nós precisamos importar café do Brasil.",
  "Eu sou a Carla Dias. A gente exporta café, e a gente poderia precisar de contador no ano que vem.",
  "Eu sou o Diego Reis. Nós precisamos exportar café também.",
].join("\n");
const TRANSCRICAO_2 = [
  "Eu sou a Ana Lima. Eu exporto café para a Europa e também torramos café especial.",
  "Eu sou a Carla Dias. A gente exporta café e tem armazém em Santos.",
].join("\n");
const TRANSCRICAO_3 = [
  "Eu sou a Ana Lima. Eu vendo cacau fino, faço chocolate artesanal e embalo bombons, e preciso de uma gráfica para os rótulos.",
  "Eu sou a Elisa Prado. Eu imprimo rótulos.",
].join("\n");

const item = (texto: string, trecho: string) => ({ texto, trecho, confianca: 0.9 });
const pessoa = (dados: Record<string, unknown> & { fullName: string }) => ({
  jobTitle: null, company: null, phone: null, email: null, confidence: 0.9, tipoPessoa: "fisica" as const,
  oQueTenho: [], oQuePreciso: [], presence: "present" as const, ...dados,
});

let idDaDona = 0;
const rota = (openId = DONA) => appRouter.createCaller({
  user: { id: openId === DONA ? idDaDona : idDaDona + 100_000, openId, role: "silver", onboardingCompleted: true, email: null },
} as never);
const banco = async () => (await getDb())!;

async function reuniaoPronta(titulo: string, transcricao: string, contatos: ReturnType<typeof pessoa>[], entidades: unknown[] = []) {
  const id = crypto.randomUUID();
  const db = await banco();
  const ficha = Date.now();
  await db.insert(meetings).values({ id, ownerId: DONA, title: titulo, status: "processing", consentGranted: true, createdAt: ficha, updatedAt: ficha });
  await gravarResultadoDaReuniao(db, {
    meetingId: id, ownerId: DONA, ficha, limparAntes: false, durationSeconds: 60,
    transcription: { text: transcricao, segments: [], language: "pt-BR" },
    extraction: { entities: entidades, contacts: contatos } as never,
  });
  return id;
}

/** Todas as chaves de uma resposta, em qualquer nível. */
function chavesDe(valor: unknown, saida = new Set<string>()): Set<string> {
  if (Array.isArray(valor)) for (const item of valor) chavesDe(item, saida);
  else if (valor && typeof valor === "object") {
    for (const [chave, dentro] of Object.entries(valor)) {
      saida.add(chave);
      chavesDe(dentro, saida);
    }
  }
  return saida;
}

async function sugestaoDe(meetingId: string, fullName: string) {
  const [linha] = await (await banco()).select().from(meetingContactSuggestions)
    .where(and(eq(meetingContactSuggestions.ownerId, DONA), eq(meetingContactSuggestions.meetingId, meetingId), eq(meetingContactSuggestions.fullName, fullName)));
  return linha;
}

const pendenciasDe = async (meetingSuggestionId: string) => (await banco()).select().from(networkSugestoes)
  .where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.meetingSuggestionId, meetingSuggestionId)));

async function perfilDaDona() {
  const [perfil] = await (await banco()).select().from(userProfiles).where(eq(userProfiles.userId, idDaDona));
  return perfil;
}

describe.skipIf(!temBanco)("N5 — a reunião vira conexões e refina o perfil (integração)", () => {
  let reuniao = "";
  let terceira = "";
  const contatos: Record<string, number> = {};

  beforeAll(async () => {
    const db = await banco();
    await db.insert(users).values({ openId: DONA, name: "Ana Lima", email: null });
    const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
    idDaDona = conta.id;
    await db.insert(userProfiles).values({ userId: idDaDona, displayName: "Ana Lima", whatIHave: [], whatINeed: [], whatINeedDetails: [] });
    reuniao = await reuniaoPronta("Rodada do café", TRANSCRICAO, [
      pessoa({
        fullName: "Ana Lima", company: "Torrefação Aurora",
        oQueTenho: [item("Exportar café", "exporto café para a Europa")],
        oQuePreciso: [item("Distribuidor no Chile", "preciso de um distribuidor no Chile")],
      }),
      pessoa({ fullName: "Bruno Prado", oQuePreciso: [item("Importar café", "precisamos importar café do Brasil")] }),
      pessoa({
        fullName: "Carla Dias",
        oQueTenho: [item("Exportar café", "exporta café")],
        oQuePreciso: [item("Contador", "poderia precisar de contador")],
      }),
      pessoa({ fullName: "Diego Reis", oQuePreciso: [item("Exportar café", "precisamos exportar café")] }),
    ]);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const participacoes = await db.select({ conexaoId: conexoesParticipantes.conexaoId }).from(conexoesParticipantes).where(eq(conexoesParticipantes.ownerId, DONA));
    if (participacoes.length) {
      const ids = participacoes.map(p => p.conexaoId);
      await apagarPelaChave(db, conexoesParticipantes, inArray(conexoesParticipantes.conexaoId, ids));
      await db.delete(conexoesRegistradas).where(inArray(conexoesRegistradas.id, ids));
    }
    await apagarPelaChave(db, aiMatchSuggestions, eq(aiMatchSuggestions.ownerId, DONA));
    await apagarPelaChave(db, contactAssets, eq(contactAssets.ownerId, DONA));
    await apagarPelaChave(db, contactNeeds, eq(contactNeeds.ownerId, DONA));
    await apagarPelaChave(db, networkSugestoes, eq(networkSugestoes.ownerId, DONA));
    await apagarPelaChave(db, privateContacts, eq(privateContacts.ownerId, DONA));
    await apagarPelaChave(db, meetingContactSuggestions, eq(meetingContactSuggestions.ownerId, DONA));
    await apagarPelaChave(db, meetingEntities, eq(meetingEntities.ownerId, DONA));
    await apagarPelaChave(db, meetingSummaries, eq(meetingSummaries.ownerId, DONA));
    await apagarPelaChave(db, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    await apagarPelaChave(db, consumoDeMinutos, eq(consumoDeMinutos.ownerId, DONA));
    await apagarPelaChave(db, meetings, eq(meetings.ownerId, DONA));
    // A prova do link ligado (ligarLinkAberto grava a auditoria).
    await apagarPelaChave(db, auditLogs, eq(auditLogs.userId, idDaDona));
    await apagarPelaChave(db, userProfiles, eq(userProfiles.userId, idDaDona));
    await db.delete(users).where(eq(users.openId, DONA));
  });

  it("nada entra sozinho: processar a reunião não muda o perfil nem os itens dos contatos, e o 'poderia precisar' nem vira pendência", async () => {
    expect(await perfilDaDona()).toMatchObject({ whatIHave: [], whatINeed: [], whatINeedDetails: [] });
    const db = await banco();
    expect(await db.select().from(contactAssets).where(eq(contactAssets.ownerId, DONA))).toEqual([]);
    expect(await db.select().from(contactNeeds).where(eq(contactNeeds.ownerId, DONA))).toEqual([]);
    const carla = await sugestaoDe(reuniao, "Carla Dias");
    const daCarla = await pendenciasDe(carla.id);
    expect(daCarla.filter(p => p.campo === "tenho" || p.campo === "preciso").map(p => [p.campo, p.valor, p.status, p.alvo, p.contactId]))
      .toEqual([["tenho", "Exportar café", "pendente", "contato", null]]);
  });

  it("a tela pergunta 'É você?' na pessoa com o nome da conta, e só nela", async () => {
    const { suggestions } = await rota().meetings.get({ meetingId: reuniao });
    expect(suggestions.filter(s => s.pareceSerADona).map(s => s.fullName)).toEqual(["Ana Lima"]);
  });

  it("'Sou eu': outra dona leva NOT_FOUND, a reunião em processamento leva CONFLICT, e a decisão não cria contato", async () => {
    const ana = await sugestaoDe(reuniao, "Ana Lima");
    await expect(rota(OUTRA).meetings.decideContactSuggestion({ suggestionId: ana.id, action: "self" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const db = await banco();
    await db.update(meetings).set({ status: "processing" }).where(eq(meetings.id, reuniao));
    await expect(rota().meetings.decideContactSuggestion({ suggestionId: ana.id, action: "self" })).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(meetings).set({ status: "ready" }).where(eq(meetings.id, reuniao));

    const antes = (await db.select().from(privateContacts).where(eq(privateContacts.ownerId, DONA))).length;
    const resposta = await rota().meetings.decideContactSuggestion({ suggestionId: ana.id, action: "self" });
    expect(resposta).toEqual({ success: true, contactId: null });
    expect((await db.select().from(privateContacts).where(eq(privateContacts.ownerId, DONA))).length).toBe(antes);
    expect(await sugestaoDe(reuniao, "Ana Lima")).toMatchObject({ status: "self", existingContactId: null });
    const daAna = await pendenciasDe(ana.id);
    expect(daAna.filter(p => p.status === "pendente").map(p => [p.campo, p.alvo, p.contactId]).sort())
      .toEqual([["preciso", "perfil", null], ["tenho", "perfil", null]]);
    // O tipo de pessoa da IA não vai a lugar nenhum: é ignorado.
    expect(daAna.filter(p => p.campo === "tipo_pessoa").map(p => p.status)).toEqual(["ignorada"]);
    // E nada foi ao perfil ainda.
    expect(await perfilDaDona()).toMatchObject({ whatIHave: [], whatINeed: [], whatINeedDetails: [] });
  });

  it("perfil: o 'tenho' entra, o 'preciso' curto e o que nomeia alguém da reunião são recusados, e o motor de perfis roda uma vez", async () => {
    const ana = await sugestaoDe(reuniao, "Ana Lima");
    const [tenho, preciso] = ["tenho", "preciso"].map(campo => async () => (await pendenciasDe(ana.id)).find(p => p.campo === campo && p.status === "pendente")!);

    const confirmado = await rota().networkInteligente.confirmarPendencia({ id: (await tenho()).id });
    expect(confirmado).toMatchObject({ alvo: "perfil", campo: "tenho", mudouPerfil: true, reuniaoDecidida: false, promovidaAPrata: false });
    expect((await perfilDaDona()).whatIHave).toEqual(["Exportar café"]);
    expect(motor.rodadas).toEqual([]);

    const idDoPreciso = (await preciso()).id;
    await expect(rota().networkInteligente.confirmarPendencia({ id: idDoPreciso, valor: "Chile" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rota().networkInteligente.confirmarPendencia({ id: idDoPreciso, valor: "Distribuidor indicado pelo Bruno Prado" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_ITEM_DO_PERFIL_COM_IDENTIFICACAO });
    // As recusas não tomam a pendência: ela segue esperando.
    expect((await preciso()).id).toBe(idDoPreciso);

    const segundo = await rota().networkInteligente.confirmarPendencia({ id: idDoPreciso });
    expect(segundo).toMatchObject({ alvo: "perfil", campo: "preciso", mudouPerfil: true, reuniaoDecidida: true });
    const perfil = await perfilDaDona();
    expect(perfil.whatINeed).toEqual(["outra_necessidade"]);
    expect(perfil.whatINeedDetails).toEqual([expect.objectContaining({ category: "outra_necessidade", description: "Distribuidor no Chile" })]);
    expect(necessidadesEscritasDoPerfil(perfil)).toContain("Distribuidor no Chile");
    await vi.waitFor(() => expect(motor.rodadas).toEqual([idDaDona]));
  });

  it("do item à conexão: 'Exportar café' × 'Importar café' nasce com a origem; 'Exportar café' × 'Exportar café' não nasce", async () => {
    for (const nome of ["Bruno Prado", "Carla Dias", "Diego Reis"]) {
      const sugestao = await sugestaoDe(reuniao, nome);
      const { contactId } = await rota().meetings.decideContactSuggestion({ suggestionId: sugestao.id, action: "create" });
      contatos[nome] = contactId!;
      for (const pendencia of (await pendenciasDe(sugestao.id)).filter(p => p.status === "pendente" && (p.campo === "tenho" || p.campo === "preciso"))) {
        expect(pendencia.contactId).toBe(contactId);
        await rota().networkInteligente.confirmarPendencia({ id: pendencia.id });
      }
    }
    const lista = await rota().intelligentMatches.list();
    expect(lista).toHaveLength(1);
    const [conexao] = lista;
    expect([conexao.contactAId, conexao.contactBId].sort()).toEqual([contatos["Bruno Prado"], contatos["Carla Dias"]].sort());
    expect(conexao.origem).toMatchObject({ meetingId: reuniao, titulo: "Rodada do café" });
    expect(["exporta café", "precisamos importar café do Brasil"]).toContain(conexao.origem?.trecho);

    const daReuniao = await rota().meetings.conexoes({ meetingId: reuniao });
    expect(daReuniao.totalDeConexoes).toBe(1);
    expect(daReuniao.pessoas.find(p => p.nome === "Carla Dias")?.conexoes).toEqual([{ id: conexao.id, com: "Bruno Prado" }]);
    expect(daReuniao.pessoas.find(p => p.nome === "Diego Reis")?.conexoes).toEqual([]);
    expect(daReuniao.pessoas.find(p => p.nome === "Ana Lima")).toMatchObject({
      status: "self", tenho: [{ valor: "Exportar café", confirmado: true }], preciso: [{ valor: "Distribuidor no Chile", confirmado: true }],
    });
    await expect(rota(OUTRA).meetings.conexoes({ meetingId: reuniao })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Sem o termo do Smart Match (revogado, ou a versão nova não aceita), a reunião mostra as pessoas e os
    // itens, e nenhuma conexão: nem a contagem do resumo nem o ramo do mapa (revisão da N5).
    termo.negado = true;
    try {
      const semTermo = await rota().meetings.conexoes({ meetingId: reuniao });
      expect(semTermo.totalDeConexoes).toBe(0);
      expect(semTermo.pessoas.flatMap(p => p.conexoes)).toEqual([]);
      expect(semTermo.pessoas.find(p => p.nome === "Carla Dias")).toMatchObject({ tenho: [{ valor: "Exportar café", confirmado: true }] });
    } finally {
      termo.negado = false;
    }

    const perfilDaCarla = await rota().networkInteligente.contato({ contactId: contatos["Carla Dias"] });
    expect(perfilDaCarla.tenho).toEqual([expect.objectContaining({ label: "Exportar café", origem: expect.objectContaining({ meetingId: reuniao, titulo: "Rodada do café", trecho: "exporta café" }) })]);
  });

  it("segunda reunião: o perfil não pede de novo o que já tem; o vincular ignora o que o contato já tem e sugere o contato pelo nome", async () => {
    const segunda = await reuniaoPronta("Segunda rodada", TRANSCRICAO_2, [
      pessoa({ fullName: "Ana Lima", oQueTenho: [item("Exportar café", "exporto café para a Europa"), item("Torrefação de café especial", "torramos café especial")] }),
      pessoa({ fullName: "Carla Dias", oQueTenho: [item("Exportar café", "exporta café"), item("Armazém em Santos", "tem armazém em Santos")] }),
    ]);
    const ana = await sugestaoDe(segunda, "Ana Lima");
    await rota().meetings.decideContactSuggestion({ suggestionId: ana.id, action: "self" });
    expect((await pendenciasDe(ana.id)).filter(p => p.campo === "tenho").map(p => [p.valor, p.status]).sort())
      .toEqual([["Exportar café", "ignorada"], ["Torrefação de café especial", "pendente"]]);

    const carla = await sugestaoDe(segunda, "Carla Dias");
    expect(await rota().meetings.candidatosParaVincular({ suggestionId: carla.id }))
      .toEqual([{ id: contatos["Carla Dias"], nome: "Carla Dias", empresa: null, motivo: "nome" }]);
    await rota().meetings.decideContactSuggestion({ suggestionId: carla.id, action: "link", contactId: contatos["Carla Dias"] });
    expect(await sugestaoDe(segunda, "Carla Dias")).toMatchObject({ status: "linked", existingContactId: contatos["Carla Dias"] });
    expect((await pendenciasDe(carla.id)).filter(p => p.campo === "tenho").map(p => [p.valor, p.status, p.contactId]).sort())
      .toEqual([["Armazém em Santos", "pendente", contatos["Carla Dias"]], ["Exportar café", "ignorada", contatos["Carla Dias"]]]);
    const { suggestions } = await rota().meetings.get({ meetingId: segunda });
    expect(suggestions.find(s => s.fullName === "Carla Dias")?.existingContactName).toBe("Carla Dias");

    // O 51º "tenho" é recusado, e a pendência segue esperando.
    const db = await banco();
    const cheio = Array.from({ length: 50 }, (_, i) => `Item gravado ${i + 1}`);
    await db.update(userProfiles).set({ whatIHave: cheio }).where(eq(userProfiles.userId, idDaDona));
    const torrefacao = (await pendenciasDe(ana.id)).find(p => p.valor === "Torrefação de café especial")!;
    await expect(rota().networkInteligente.confirmarPendencia({ id: torrefacao.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_O_QUE_TENHO_CHEIO });
    expect((await pendenciasDe(ana.id)).find(p => p.id === torrefacao.id)?.status).toBe("pendente");
    await db.update(userProfiles).set({ whatIHave: ["Exportar café"] }).where(eq(userProfiles.userId, idDaDona));

    // A pendência do perfil sai na lista do Perfil, com a reunião de onde veio.
    const doPerfil = await rota().networkInteligente.pendenciasDoPerfil();
    expect(doPerfil.map(p => [p.valor, p.reuniao?.titulo])).toEqual([["Torrefação de café especial", "Segunda rodada"]]);
  });

  it("exclusões: sem a reunião, o item e a conexão ficam, sem origem; sem o contato, sai tudo dele", async () => {
    await rota().meetings.delete({ meetingId: reuniao });
    const db = await banco();
    expect((await db.select().from(contactAssets).where(and(eq(contactAssets.ownerId, DONA), eq(contactAssets.contactId, contatos["Carla Dias"])))).map(a => a.tagLabel))
      .toEqual(["Exportar café"]);
    expect((await perfilDaDona()).whatIHave).toEqual(["Exportar café"]);
    const [conexao] = await rota().intelligentMatches.list();
    expect(conexao).toMatchObject({ origem: null });
    const perfilDaCarla = await rota().networkInteligente.contato({ contactId: contatos["Carla Dias"] });
    expect(perfilDaCarla.tenho).toEqual([expect.objectContaining({ label: "Exportar café", origem: null })]);

    await rota().network.delete({ id: contatos["Bruno Prado"] });
    expect(await db.select().from(contactNeeds).where(and(eq(contactNeeds.ownerId, DONA), eq(contactNeeds.contactId, contatos["Bruno Prado"])))).toEqual([]);
    expect(await rota().intelligentMatches.list()).toEqual([]);
    expect(await db.select().from(networkSugestoes).where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.contactId, contatos["Bruno Prado"])))).toEqual([]);
  });

  it("ignorar (revisão da N5): o último item do perfil decide a reunião e o motor roda uma vez; só ignorados não o rodam; outra dona leva NOT_FOUND", async () => {
    // A segunda reunião: o "Exportar café" foi ignorado sozinho (o perfil já tem), e só a "Torrefação" espera.
    const [torrefacao] = (await rota().networkInteligente.pendenciasDoPerfil()).filter(p => p.valor === "Torrefação de café especial");
    await expect(rota(OUTRA).networkInteligente.ignorarPendencia({ id: torrefacao.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rodadasAntes = motor.rodadas.length;
    // Tudo ignorado, nada confirmado: o perfil não mudou, e o motor não roda.
    expect(await rota().networkInteligente.ignorarPendencia({ id: torrefacao.id })).toMatchObject({ alvo: "perfil", reuniaoDecidida: false });

    terceira = await reuniaoPronta("Terceira rodada", TRANSCRICAO_3, [
      pessoa({
        fullName: "Ana Lima",
        oQueTenho: [item("Cacau fino", "vendo cacau fino"), item("Chocolate artesanal", "faço chocolate artesanal"), item("Bombons embalados", "embalo bombons")],
        oQuePreciso: [item("Gráfica para rótulos", "preciso de uma gráfica para os rótulos")],
      }),
      pessoa({ fullName: "Elisa Prado", oQueTenho: [item("Impressão de rótulos", "imprimo rótulos")] }),
    ], [{ type: "person", value: "Elisa Prado", normalizedValue: null, confidence: 0.9 }]);
    const ana = await sugestaoDe(terceira, "Ana Lima");
    await rota().meetings.decideContactSuggestion({ suggestionId: ana.id, action: "self" });

    // Excluir o contato criado na reunião apaga a sugestão dele, e o nome segue barrado no perfil (as entidades da reunião ficam).
    const elisa = await sugestaoDe(terceira, "Elisa Prado");
    const { contactId: idDaElisa } = await rota().meetings.decideContactSuggestion({ suggestionId: elisa.id, action: "create" });
    await rota().network.delete({ id: idDaElisa! });
    expect(await sugestaoDe(terceira, "Elisa Prado")).toBeUndefined();
    const pendentes = (await pendenciasDe(ana.id)).filter(p => p.status === "pendente");
    const precisoDaAna = pendentes.find(p => p.campo === "preciso")!;
    await expect(rota().networkInteligente.confirmarPendencia({ id: precisoDaAna.id, valor: "Gráfica indicada pela Elisa Prado" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_ITEM_DO_PERFIL_COM_IDENTIFICACAO });

    // Três confirmações ao mesmo tempo: o perfil travado na transação (FOR UPDATE) não perde nenhuma.
    const tenhos = pendentes.filter(p => p.campo === "tenho");
    expect(tenhos).toHaveLength(3);
    const respostas = await Promise.all(tenhos.map(p => rota().networkInteligente.confirmarPendencia({ id: p.id })));
    expect(respostas.map(r => r?.reuniaoDecidida)).toEqual([false, false, false]);
    expect([...(await perfilDaDona()).whatIHave as string[]].sort()).toEqual(["Bombons embalados", "Cacau fino", "Chocolate artesanal", "Exportar café"]);
    expect(motor.rodadas).toHaveLength(rodadasAntes);

    // O último item do perfil, ignorado, decide a reunião: o motor de perfis roda uma vez.
    await expect(rota(OUTRA).networkInteligente.ignorarPendencia({ id: precisoDaAna.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await rota().networkInteligente.ignorarPendencia({ id: precisoDaAna.id })).toMatchObject({ alvo: "perfil", reuniaoDecidida: true });
    await vi.waitFor(() => expect(motor.rodadas).toEqual([...motor.rodadas.slice(0, rodadasAntes), idDaDona]));
  });

  it("privacidade: o link aberto não tem as conexões nem as pendências da reunião, nem nos procedimentos nem no que eles devolvem", async () => {
    const doLink = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures)
      .filter(caminho => caminho.startsWith("reuniaoAberta."));
    expect(doLink.length).toBeGreaterThan(0);
    expect(doLink.filter(caminho => /conex|pendenc|candidat/i.test(caminho))).toEqual([]);

    // A reunião com pessoas decididas e itens confirmados, aberta pelo link, para quem não tem conta (revisão da N5).
    const token = await ligarLinkAberto(DONA, terceira, { userId: idDaDona, ipAddress: "127.0.0.1", userAgent: "teste", idioma: "pt-BR", textoExibido: "As pessoas autorizaram." });
    const visitante = appRouter.createCaller({ user: null, req: { headers: {}, socket: {} }, res: { cookie: () => {} } } as never);
    const chaves = new Set([
      ...chavesDe(await visitante.reuniaoAberta.ver({ token })),
      ...chavesDe(await visitante.reuniaoAberta.mapaMental({ token })),
    ]);
    expect(chaves.size).toBeGreaterThan(0);
    const proibidas = ["pessoas", "conexoes", "totalDeConexoes", "sugestoes", "suggestions", "existingContactName", "pareceSerADona", "tenho", "preciso", "valor"];
    expect(proibidas.filter(chave => chaves.has(chave))).toEqual([]);
  });
});
