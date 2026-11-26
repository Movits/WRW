import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * "Criar contato" na pessoa da reunião e o que vem depois, contra um banco real
 * DE TESTE (sem DATABASE_URL_TESTES, se pula). Revisão do pacote P2B:
 *
 * - a decisão é uma transação só: se a gravação das pendências falha depois
 *   do contato (a conexão caiu), nada fica — nem o contato, nem a sugestão
 *   'created', nem as pendências ligadas —, e a dona pode repetir;
 * - excluir a reunião depois de criar o contato não apaga, em silêncio, o
 *   cargo e a empresa que esperavam a dona no perfil (nem tira a empresa da
 *   identificação do contato); o que cita a transcrição (Tenho e Preciso,
 *   com trecho) sai com ela;
 * - a sugestão gravada antes do portão da IA3, com um cargo que ninguém disse,
 *   não vira pendência de cargo, e a pendência leva a confiança da sugestão.
 *
 * A falha das pendências é um dublê por cima da função de verdade: ela grava
 * tudo e, com a chave ligada, lança no fim, como a conexão que cai. As
 * transcrições são inventadas. Dona e reuniões com id aleatório: a limpeza no
 * fim só alcança o que este arquivo criou.
 */
const falha = vi.hoisted(() => ({ nasPendencias: false }));
vi.mock("./network-extracao", async original => {
  const real = await original<typeof import("./network-extracao")>();
  return {
    ...real,
    decidirPendenciasDaPessoaSugerida: async (...args: Parameters<typeof real.decidirPendenciasDaPessoaSugerida>) => {
      await real.decidirPendenciasDaPessoaSugerida(...args);
      if (falha.nasPendencias) throw new Error("conexão perdida (dublê)");
    },
  };
});

const { getDb } = await import("./db");
const {
  consumoDeMinutos, meetingContactSuggestions, meetingEntities, meetingSummaries, meetingTranscripts, meetings,
  networkSugestoes, privateContacts, users,
} = await import("../drizzle/schema");
const { deletePrivateMeeting, gravarResultadoDaReuniao } = await import("./meeting-service");
const { identificacaoDoContato } = await import("./network-extracao");
const { appRouter } = await import("./routers");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-decidir-pessoa-${crypto.randomUUID()}`;

const TRANSCRICAO = [
  "Boa noite. Eu sou o Fernando Okada, da Ponte Sul Consultoria, e vim como mentor convidado.",
  "Eu sou a Camila Duarte, da Cacau Tupinã. O que eu procuro: um distribuidor em São Paulo.",
].join("\n");

const pessoa = (dados: Record<string, unknown> & { fullName: string }) => ({
  jobTitle: null, company: null, phone: null, email: null, confidence: 0.9, tipoPessoa: "fisica" as const,
  oQueTenho: [], oQuePreciso: [], presence: "present" as const, ...dados,
});

const rota = () => appRouter.createCaller({ user: { openId: DONA, role: "silver", onboardingCompleted: true } } as never);
const banco = async () => (await getDb())!;

/** Uma reunião pronta, gravada pelo caminho de sempre, com as pessoas dadas. */
async function reuniaoPronta(contatos: ReturnType<typeof pessoa>[]) {
  const id = crypto.randomUUID();
  const db = await banco();
  const ficha = Date.now();
  await db.insert(meetings).values({
    id, ownerId: DONA, title: "Reunião inventada", status: "processing", consentGranted: true, createdAt: ficha, updatedAt: ficha,
  });
  await gravarResultadoDaReuniao(db, {
    meetingId: id, ownerId: DONA, ficha, limparAntes: false, durationSeconds: 60,
    transcription: { text: TRANSCRICAO, segments: [], language: "pt-BR" },
    extraction: { entities: [], contacts: contatos } as never,
  });
  return id;
}

async function sugestaoDe(meetingId: string, fullName: string) {
  const [linha] = await (await banco()).select().from(meetingContactSuggestions)
    .where(and(eq(meetingContactSuggestions.ownerId, DONA), eq(meetingContactSuggestions.meetingId, meetingId), eq(meetingContactSuggestions.fullName, fullName)));
  return linha;
}

const contatosDaDona = async () => (await banco()).select({ id: privateContacts.id, fullName: privateContacts.fullName })
  .from(privateContacts).where(eq(privateContacts.ownerId, DONA));

describe.skipIf(!temBanco)("Criar contato na pessoa da reunião (integração)", () => {
  beforeAll(async () => {
    await (await banco()).insert(users).values({ openId: DONA });
  });

  beforeEach(() => {
    falha.nasPendencias = false;
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await apagarPelaChave(db, networkSugestoes, eq(networkSugestoes.ownerId, DONA));
    await apagarPelaChave(db, privateContacts, eq(privateContacts.ownerId, DONA));
    await apagarPelaChave(db, meetingContactSuggestions, eq(meetingContactSuggestions.ownerId, DONA));
    await apagarPelaChave(db, meetingEntities, eq(meetingEntities.ownerId, DONA));
    await apagarPelaChave(db, meetingSummaries, eq(meetingSummaries.ownerId, DONA));
    await apagarPelaChave(db, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    await apagarPelaChave(db, consumoDeMinutos, eq(consumoDeMinutos.ownerId, DONA));
    await apagarPelaChave(db, meetings, eq(meetings.ownerId, DONA));
    await db.delete(users).where(eq(users.openId, DONA));
  });

  it("a gravação das pendências falha depois do contato: nada fica, e a dona repete com sucesso", async () => {
    const reuniao = await reuniaoPronta([pessoa({ fullName: "Fernando Okada", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria", tipoPessoa: "nao_informado" })]);
    const fernando = await sugestaoDe(reuniao, "Fernando Okada");
    const antes = (await contatosDaDona()).length;

    falha.nasPendencias = true;
    await expect(rota().meetings.decideContactSuggestion({ suggestionId: fernando.id, action: "create" })).rejects.toThrow();
    expect(await contatosDaDona()).toHaveLength(antes);
    expect(await sugestaoDe(reuniao, "Fernando Okada")).toMatchObject({ status: "pending", existingContactId: null });
    const daSugestao = await (await banco()).select().from(networkSugestoes)
      .where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.meetingSuggestionId, fernando.id)));
    expect(daSugestao).toEqual([]);

    falha.nasPendencias = false;
    const { contactId } = await rota().meetings.decideContactSuggestion({ suggestionId: fernando.id, action: "create" });
    expect(await contatosDaDona()).toHaveLength(antes + 1);
    expect(await sugestaoDe(reuniao, "Fernando Okada")).toMatchObject({ status: "created", existingContactId: contactId });
    const apoio = await (await banco()).select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor }).from(networkSugestoes)
      .where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.contactId, contactId!)));
    expect(apoio.sort((a, b) => a.campo.localeCompare(b.campo))).toEqual([
      { campo: "cargo", valor: "mentor convidado" },
      { campo: "empresa", valor: "Ponte Sul Consultoria" },
    ]);
  });

  it("excluir a reunião depois de criar o contato: cargo e empresa continuam esperando a dona; o que tem trecho sai", async () => {
    const reuniao = await reuniaoPronta([pessoa({
      fullName: "Camila Duarte", company: "Cacau Tupinã",
      oQuePreciso: [{ texto: "Distribuidor em São Paulo", trecho: "um distribuidor em São Paulo", confianca: 0.9 }],
    })]);
    const camila = await sugestaoDe(reuniao, "Camila Duarte");
    const { contactId } = await rota().meetings.decideContactSuggestion({ suggestionId: camila.id, action: "create" });
    const doContato = async () => (await banco()).select({
      campo: networkSugestoes.campo, valor: networkSugestoes.valor, status: networkSugestoes.status,
      meetingId: networkSugestoes.meetingId, meetingSuggestionId: networkSugestoes.meetingSuggestionId,
    }).from(networkSugestoes).where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.contactId, contactId!)));
    expect((await doContato()).map(p => p.campo).sort()).toEqual(["empresa", "preciso", "tipo_pessoa"]);

    expect(await deletePrivateMeeting(DONA, reuniao)).toBe(true);

    // ficam, desligadas da reunião que não existe mais; o Preciso citava a transcrição e saiu
    expect((await doContato()).sort((a, b) => a.campo.localeCompare(b.campo))).toEqual([
      { campo: "empresa", valor: "Cacau Tupinã", status: "pendente", meetingId: null, meetingSuggestionId: null },
      { campo: "tipo_pessoa", valor: "fisica", status: "pendente", meetingId: null, meetingSuggestionId: null },
    ]);
    // e a empresa continua identificando o contato: "Chocolate da Cacau Tupinã" segue barrado
    const [contato] = await (await banco()).select({
      id: privateContacts.id, fullName: privateContacts.fullName, company: privateContacts.company,
      phone: privateContacts.phone, whatsapp: privateContacts.whatsapp,
    }).from(privateContacts).where(and(eq(privateContacts.id, contactId!), eq(privateContacts.ownerId, DONA)));
    expect(contato.company).toBeNull();
    expect((await identificacaoDoContato(await banco(), DONA, contato)).nomes).toContain("Cacau Tupinã");
  });

  it("sugestão de antes do portão, com cargo que ninguém disse: só a empresa dita vira pendência, com a confiança da sugestão", async () => {
    const reuniao = await reuniaoPronta([]);
    const id = crypto.randomUUID();
    const agora = Date.now();
    // gravada direto, como a extração antiga gravava: sem conferência de cargo e sem presença
    await (await banco()).insert(meetingContactSuggestions).values({
      id, meetingId: reuniao, ownerId: DONA, fullName: "Camila Duarte", jobTitle: "fundadora", company: "Cacau Tupinã",
      phone: null, email: null, presence: null, sourceEntityIds: [], confidence: "0.910", status: "pending", createdAt: agora, updatedAt: agora,
    });
    const { contactId } = await rota().meetings.decideContactSuggestion({ suggestionId: id, action: "create" });
    const apoio = await (await banco()).select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor, confianca: networkSugestoes.confianca })
      .from(networkSugestoes).where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.contactId, contactId!)));
    expect(apoio).toEqual([{ campo: "empresa", valor: "Cacau Tupinã", confianca: "0.910" }]);
  });
});
