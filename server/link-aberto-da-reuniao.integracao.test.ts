import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { meetingRecordings, meetingTranscripts, meetings, users } from "../drizzle/schema";
import {
  chaveDoAudioDoLink,
  desligarLinkAberto,
  ligarLinkAberto,
  LinkAbertoRecusado,
  verReuniaoPeloLink,
} from "./link-aberto-da-reuniao";

/**
 * O link aberto da reunião contra um banco real DE TESTE (migração 0015). No CI
 * é o MariaDB criado do zero por scripts/criar-banco.mjs; sem
 * DATABASE_URL_TESTES o teste se pula (server/test/setup-banco.ts troca a
 * DATABASE_URL por ela, então o .env de trabalho nunca é usado aqui). As
 * condições estão no WHERE das consultas, e só o banco de verdade as prova:
 *
 * - ligar dá o mesmo link a pedidos simultâneos e só liga reunião pronta e da dona;
 * - o link abre a reunião sem nada da dona, toca a gravação certa e para de
 *   abrir na hora em que é desligado, de vez (o link novo é outro);
 * - conta desativada e gravação vencida param de ser servidas.
 *
 * Donas e reuniões com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-link-${crypto.randomUUID()}`;
const OUTRA = `teste-link-${crypto.randomUUID()}`;
const PRONTA = crypto.randomUUID();
const COM_FALHA = crypto.randomUUID();
const AGORA = Date.now();
const CHAVE = `meetings/${DONA}/${PRONTA}/recording.mp4`;

const reuniao = (id: string, status: "ready" | "failed") => ({
  id, ownerId: DONA, title: `Reunião ${status} de teste`, status,
  consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
});

async function recusaDe(promessa: Promise<unknown>): Promise<LinkAbertoRecusado> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof LinkAbertoRecusado) return erro;
    throw erro;
  }
  throw new Error("era para recusar");
}

describe.skipIf(!temBanco)("Link aberto da reunião no banco (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    await db.insert(meetings).values([reuniao(PRONTA, "ready"), reuniao(COM_FALHA, "failed")]);
    await db.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: PRONTA, ownerId: DONA, transcript: "Combinamos a entrega na sexta.",
      language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
    });
    await db.insert(meetingRecordings).values({
      id: crypto.randomUUID(), meetingId: PRONTA, ownerId: DONA, storageKey: CHAVE, storageUrl: `/manus-storage/${CHAVE}`,
      mimeType: "audio/mp4", sizeBytes: 1024, durationSeconds: 90, expiresAt: AGORA + 86_400_000, createdAt: AGORA,
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(meetingRecordings).where(eq(meetingRecordings.ownerId, DONA));
    await db.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, DONA));
    await db.delete(meetings).where(eq(meetings.ownerId, DONA));
    await db.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });

  it("pedidos simultâneos de ligar ficam com o MESMO link, e ligar de novo devolve o mesmo", async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => ligarLinkAberto(DONA, PRONTA)));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await ligarLinkAberto(DONA, PRONTA)).toBe(tokens[0]);
  });

  it("o link abre título, transcrição e gravação pela rota do link, sem nada da dona", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA);
    const vista = await verReuniaoPeloLink(token);
    expect(vista).toMatchObject({
      titulo: "Reunião ready de teste",
      criadaEm: AGORA,
      transcricao: { texto: "Combinamos a entrega na sexta.", idioma: "pt-BR" },
      gravacao: { url: `/reuniao-aberta/${token}/audio`, mimeType: "audio/mp4", durationSeconds: 90 },
      gravacaoExpirada: false,
    });
    // Nem o id da dona, nem a chave do bucket, nem o id da reunião.
    const texto = JSON.stringify(vista);
    expect(texto).not.toContain(DONA);
    expect(texto).not.toContain(CHAVE);
    expect(texto).not.toContain(PRONTA);
    expect(await chaveDoAudioDoLink(token)).toBe(CHAVE);
  });

  it("desligado, o link para de abrir na hora, e o link novo é outro", async () => {
    const antigo = await ligarLinkAberto(DONA, PRONTA);
    await desligarLinkAberto(DONA, PRONTA);
    expect((await recusaDe(verReuniaoPeloLink(antigo))).codigo).toBe("NOT_FOUND");
    expect(await chaveDoAudioDoLink(antigo)).toBeNull();
    // Desligar o que já está desligado não é erro.
    await desligarLinkAberto(DONA, PRONTA);
    const novo = await ligarLinkAberto(DONA, PRONTA);
    expect(novo).not.toBe(antigo);
    expect(await chaveDoAudioDoLink(antigo)).toBeNull();
    expect(await chaveDoAudioDoLink(novo)).toBe(CHAVE);
  });

  it("só a dona liga e desliga, e só reunião pronta tem link", async () => {
    const db = (await getDb())!;
    const tokenNoBanco = async (id: string) =>
      (await db.select({ shareToken: meetings.shareToken }).from(meetings).where(eq(meetings.id, id)))[0].shareToken;

    // Outra conta não desliga o link da dona: o MESMO token continua abrindo.
    const daDona = await ligarLinkAberto(DONA, PRONTA);
    expect((await recusaDe(desligarLinkAberto(OUTRA, PRONTA))).codigo).toBe("NOT_FOUND");
    expect(await chaveDoAudioDoLink(daDona)).toBe(CHAVE);

    // Nem liga: com o link desligado, a tentativa da outra não grava token.
    await desligarLinkAberto(DONA, PRONTA);
    expect((await recusaDe(ligarLinkAberto(OUTRA, PRONTA))).codigo).toBe("NOT_FOUND");
    expect(await tokenNoBanco(PRONTA)).toBeNull();

    // Reunião com falha não ganha link, nem pela dona.
    expect((await recusaDe(ligarLinkAberto(DONA, COM_FALHA))).codigo).toBe("PRECONDITION_FAILED");
    expect(await tokenNoBanco(COM_FALHA)).toBeNull();
  });

  it("token fora do formato não abre nada", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA);
    expect((await recusaDe(verReuniaoPeloLink(token.slice(0, 31)))).codigo).toBe("NOT_FOUND");
    expect((await recusaDe(verReuniaoPeloLink(`${token}x`))).codigo).toBe("NOT_FOUND");
    expect(await chaveDoAudioDoLink("")).toBeNull();
  });

  it("conta desativada deixa de servir o link; reativada, volta", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA);
    const db = (await getDb())!;
    await db.update(users).set({ isActive: false }).where(eq(users.openId, DONA));
    try {
      expect((await recusaDe(verReuniaoPeloLink(token))).codigo).toBe("NOT_FOUND");
      expect(await chaveDoAudioDoLink(token)).toBeNull();
    } finally {
      await db.update(users).set({ isActive: true }).where(eq(users.openId, DONA));
    }
    expect((await verReuniaoPeloLink(token)).titulo).toBe("Reunião ready de teste");
  });

  it("reunião em exclusão ('deleted', antes de a linha sair) não abre pelo link", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA);
    const db = (await getDb())!;
    await db.update(meetings).set({ status: "deleted" }).where(eq(meetings.id, PRONTA));
    try {
      expect((await recusaDe(verReuniaoPeloLink(token))).codigo).toBe("NOT_FOUND");
      expect(await chaveDoAudioDoLink(token)).toBeNull();
    } finally {
      await db.update(meetings).set({ status: "ready" }).where(eq(meetings.id, PRONTA));
    }
  });

  it("gravação vencida não é tocada pelo link, e a página diz que expirou", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA);
    const db = (await getDb())!;
    await db.update(meetingRecordings).set({ expiresAt: AGORA - 1 }).where(eq(meetingRecordings.ownerId, DONA));
    expect(await chaveDoAudioDoLink(token)).toBeNull();
    expect(await verReuniaoPeloLink(token)).toMatchObject({ gravacao: null, gravacaoExpirada: true });
  });
});
