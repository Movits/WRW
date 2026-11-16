import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { getDb } = await import("./db");
const {
  consumoDeMinutos, meetingContactSuggestions, meetingEntities, meetingSummaries, meetingTranscripts, meetings,
  networkSugestoes, privateContacts, users,
} = await import("../drizzle/schema");
const { getPrivateMeeting, gravarResultadoDaReuniao } = await import("./meeting-service");
const { appRouter } = await import("./routers");

/**
 * O portão da extração (achados 6 e 7 da bancada de 16/11) contra um banco
 * real DE TESTE: sem DATABASE_URL_TESTES se pula (server/test/setup-banco.ts).
 * Precisa da migração que cria `meeting_contact_suggestions.presence`. O que
 * se prova:
 *
 * - a presença vai para a linha da sugestão e volta no detalhe da dona;
 * - o cargo que a transcrição não diz ("fundadora") não chega à linha, e o
 *   dito ("mentor convidado") chega;
 * - "Criar contato" grava só o Quem Sou: cargo e empresa viram pendências do
 *   contato novo e só entram nele quando a dona confirma.
 *
 * A transcrição são falas da reunião sintética da bancada (inventada). Dona
 * e reunião com id aleatório: a limpeza no fim só alcança o que este arquivo
 * criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-portao-${crypto.randomUUID()}`;
const REUNIAO = crypto.randomUUID();

const TRANSCRICAO = [
  "Boa noite, gente. Eu sou a Renata Albuquerque, vou facilitar a conversa, e hoje estamos em três: a Camila, que já conhece todo mundo, e o Fernando, que veio como mentor convidado.",
  "Bom, eu sou a Camila Duarte, da Cacau Tupinã. O que eu procuro: um distribuidor em São Paulo e uma embalagem que não seja de plástico, porque os meus clientes estão cobrando isso.",
  "Boa noite. Eu sou o Fernando Okada, da Ponte Sul Consultoria. Trabalho com finanças para pequenos negócios e com comércio exterior.",
  "Então, aqui tem duas possibilidades. A primeira é a Sônia Pacheco, da Embalagens Girassol. Ela faz caixa de papelão reciclado, muito bem acabada, com impressão em uma cor. Ela não pôde vir hoje, mas me pediu para falar dela.",
].join("\n");

const pessoa = (dados: Record<string, unknown> & { fullName: string }) => ({
  jobTitle: null, company: null, phone: null, email: null, confidence: 1, tipoPessoa: "fisica" as const,
  oQueTenho: [], oQuePreciso: [], presence: "present" as const, ...dados,
});

const rota = () => appRouter.createCaller({ user: { openId: DONA, role: "silver", onboardingCompleted: true } } as never);

describe.skipIf(!temBanco)("Portão da extração: presença, cargo e empresa (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId: DONA });
    const ficha = Date.now();
    await db.insert(meetings).values({
      id: REUNIAO, ownerId: DONA, title: "Mentoria do núcleo (sintética)", status: "processing", consentGranted: true,
      createdAt: ficha, updatedAt: ficha,
    });
    await gravarResultadoDaReuniao(db, {
      meetingId: REUNIAO, ownerId: DONA, ficha, limparAntes: false, durationSeconds: 120,
      transcription: { text: TRANSCRICAO, segments: [], language: "pt-BR" },
      extraction: {
        entities: [],
        contacts: [
          pessoa({ fullName: "Fernando Okada", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" }),
          pessoa({
            fullName: "Camila Duarte", jobTitle: "fundadora", company: "Cacau Tupinã",
            oQuePreciso: [{ texto: "Embalagem que não seja de plástico", trecho: "uma embalagem que não seja de plástico", confianca: 1 }],
          }),
          pessoa({ fullName: "Sônia Pacheco", company: "Embalagens Girassol", presence: "mentioned" }),
        ],
      } as never,
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(networkSugestoes).where(eq(networkSugestoes.ownerId, DONA));
    await db.delete(privateContacts).where(eq(privateContacts.ownerId, DONA));
    await db.delete(meetingContactSuggestions).where(eq(meetingContactSuggestions.ownerId, DONA));
    await db.delete(meetingEntities).where(eq(meetingEntities.ownerId, DONA));
    await db.delete(meetingSummaries).where(eq(meetingSummaries.ownerId, DONA));
    await db.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, DONA));
    await db.delete(consumoDeMinutos).where(eq(consumoDeMinutos.ownerId, DONA));
    await db.delete(meetings).where(eq(meetings.ownerId, DONA));
    await db.delete(users).where(eq(users.openId, DONA));
  });

  it("a presença e o cargo conferido ficam na linha e voltam no detalhe da dona; o 'não' do item passa", async () => {
    const detalhe = await getPrivateMeeting(DONA, REUNIAO);
    const porNome = Object.fromEntries((detalhe?.suggestions ?? []).map(s => [s.fullName, s]));
    expect(porNome["Fernando Okada"]).toMatchObject({ presence: "present", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" });
    expect(porNome["Camila Duarte"]).toMatchObject({ presence: "present", jobTitle: null, company: "Cacau Tupinã" });
    expect(porNome["Sônia Pacheco"]).toMatchObject({ presence: "mentioned", company: "Embalagens Girassol" });

    const db = (await getDb())!;
    const daCamila = await db.select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor }).from(networkSugestoes)
      .where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.meetingSuggestionId, porNome["Camila Duarte"].id)));
    expect(daCamila).toContainEqual({ campo: "preciso", valor: "Embalagem que não seja de plástico" });
  });

  it("Criar contato grava só o Quem Sou; cargo e empresa esperam a dona, e confirmar grava cada um", async () => {
    const db = (await getDb())!;
    const [fernando] = await db.select({ id: meetingContactSuggestions.id }).from(meetingContactSuggestions)
      .where(and(eq(meetingContactSuggestions.ownerId, DONA), eq(meetingContactSuggestions.fullName, "Fernando Okada")));
    const { contactId } = await rota().meetings.decideContactSuggestion({ suggestionId: fernando.id, action: "create" });
    expect(contactId).toEqual(expect.any(Number));

    const contato = async () => (await db.select({ fullName: privateContacts.fullName, jobTitle: privateContacts.jobTitle, company: privateContacts.company })
      .from(privateContacts).where(and(eq(privateContacts.id, contactId!), eq(privateContacts.ownerId, DONA))))[0];
    expect(await contato()).toEqual({ fullName: "Fernando Okada", jobTitle: null, company: null });

    const apoio = await db.select({ id: networkSugestoes.id, campo: networkSugestoes.campo, valor: networkSugestoes.valor, status: networkSugestoes.status })
      .from(networkSugestoes)
      .where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.contactId, contactId!), inArray(networkSugestoes.campo, ["cargo", "empresa"])));
    expect(apoio.map(({ campo, valor, status }) => ({ campo, valor, status })).sort((a, b) => a.campo.localeCompare(b.campo))).toEqual([
      { campo: "cargo", valor: "mentor convidado", status: "pendente" },
      { campo: "empresa", valor: "Ponte Sul Consultoria", status: "pendente" },
    ]);

    for (const pendencia of apoio) await rota().networkInteligente.confirmarPendencia({ id: pendencia.id });
    expect(await contato()).toEqual({ fullName: "Fernando Okada", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" });
  });
});
