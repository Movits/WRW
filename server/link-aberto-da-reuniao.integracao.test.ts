import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { auditLogs, meetingContactSuggestions, meetingEntities, meetingRecordings, meetingTranscripts, meetings, users } from "../drizzle/schema";
import {
  ACAO_LINK_LIGADO,
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
 * - conta desativada e gravação vencida param de ser servidas;
 * - o token vale com a caixa exata, embora a coluna herde a collation que não
 *   distingue maiúsculas;
 * - a confirmação da dona entra na auditoria junto com o link.
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
// userId fora de qualquer conta real: a limpeza das linhas de auditoria vai por ele.
const PROVA = {
  userId: 2_000_000_000 + Math.floor(Math.random() * 100_000_000), ipAddress: "203.0.113.7", userAgent: "vitest-link-aberto",
  idioma: "pt-BR", textoExibido: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram compartilhar.",
};
// O que é da dona e NÃO pode sair pelo link: o nome e o e-mail da conta, as
// entidades e as sugestões de contato da reunião.
const NOME_DA_DONA = `Dona Teste ${crypto.randomUUID().slice(0, 8)}`;
const EMAIL_DA_DONA = `dona-${crypto.randomUUID().slice(0, 8)}@teste.invalid`;
const ENTIDADE = `Empresa Secreta ${crypto.randomUUID().slice(0, 8)}`;
const SUGERIDA = `Pessoa Sugerida ${crypto.randomUUID().slice(0, 8)}`;

/** A mesma letra com a outra caixa: o banco _ci acharia a mesma linha. */
function trocarCaixa(token: string): string {
  const i = token.search(/[A-Za-z]/);
  const letra = token[i];
  return token.slice(0, i) + (letra === letra.toUpperCase() ? letra.toLowerCase() : letra.toUpperCase()) + token.slice(i + 1);
}

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
    await db.insert(users).values([{ openId: DONA, name: NOME_DA_DONA, email: EMAIL_DA_DONA }, { openId: OUTRA }]);
    await db.insert(meetings).values([reuniao(PRONTA, "ready"), reuniao(COM_FALHA, "failed")]);
    await db.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: PRONTA, ownerId: DONA, transcript: "Combinamos a entrega na sexta.",
      language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
    });
    await db.insert(meetingEntities).values({
      id: crypto.randomUUID(), meetingId: PRONTA, ownerId: DONA, entityType: "company", value: ENTIDADE, createdAt: AGORA, updatedAt: AGORA,
    });
    await db.insert(meetingContactSuggestions).values({
      id: crypto.randomUUID(), meetingId: PRONTA, ownerId: DONA, fullName: SUGERIDA, createdAt: AGORA, updatedAt: AGORA,
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
    await db.delete(meetingEntities).where(eq(meetingEntities.ownerId, DONA));
    await db.delete(meetingContactSuggestions).where(eq(meetingContactSuggestions.ownerId, DONA));
    await db.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, DONA));
    await db.delete(meetings).where(eq(meetings.ownerId, DONA));
    await db.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
    await db.delete(auditLogs).where(eq(auditLogs.userId, PROVA.userId));
  });

  it("pedidos simultâneos de ligar ficam com o MESMO link, e ligar de novo devolve o mesmo", async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => ligarLinkAberto(DONA, PRONTA, PROVA)));
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await ligarLinkAberto(DONA, PRONTA, PROVA)).toBe(tokens[0]);
  });

  it("o link abre título, transcrição e gravação pela rota do link, sem nada da dona", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA, PROVA);
    const vista = await verReuniaoPeloLink(token);
    expect(vista).toMatchObject({
      titulo: "Reunião ready de teste",
      criadaEm: AGORA,
      transcricao: { texto: "Combinamos a entrega na sexta.", idioma: "pt-BR" },
      gravacao: { url: `/reuniao-aberta/${token}/audio`, mimeType: "audio/mp4", durationSeconds: 90 },
      gravacaoExpirada: false,
    });
    // Nem o id da dona, nem a chave do bucket, nem o id da reunião; nem o nome
    // e o e-mail dela, nem as entidades e as sugestões de contato da reunião.
    const texto = JSON.stringify(vista);
    for (const daDona of [NOME_DA_DONA, EMAIL_DA_DONA, ENTIDADE, SUGERIDA]) expect(texto).not.toContain(daDona);
    expect(texto).not.toContain(DONA);
    expect(texto).not.toContain(CHAVE);
    expect(texto).not.toContain(PRONTA);
    expect(await chaveDoAudioDoLink(token)).toBe(CHAVE);
  });

  it("desligado, o link para de abrir na hora, e o link novo é outro", async () => {
    const antigo = await ligarLinkAberto(DONA, PRONTA, PROVA);
    await desligarLinkAberto(DONA, PRONTA, PROVA);
    expect((await recusaDe(verReuniaoPeloLink(antigo))).codigo).toBe("NOT_FOUND");
    expect(await chaveDoAudioDoLink(antigo)).toBeNull();
    // Desligar o que já está desligado não é erro.
    await desligarLinkAberto(DONA, PRONTA, PROVA);
    const novo = await ligarLinkAberto(DONA, PRONTA, PROVA);
    expect(novo).not.toBe(antigo);
    expect(await chaveDoAudioDoLink(antigo)).toBeNull();
    expect(await chaveDoAudioDoLink(novo)).toBe(CHAVE);
  });

  it("só a dona liga e desliga, e só reunião pronta tem link", async () => {
    const db = (await getDb())!;
    const tokenNoBanco = async (id: string) =>
      (await db.select({ shareToken: meetings.shareToken }).from(meetings).where(eq(meetings.id, id)))[0].shareToken;

    // Outra conta não desliga o link da dona: o MESMO token continua abrindo.
    const daDona = await ligarLinkAberto(DONA, PRONTA, PROVA);
    expect((await recusaDe(desligarLinkAberto(OUTRA, PRONTA, PROVA))).codigo).toBe("NOT_FOUND");
    expect(await chaveDoAudioDoLink(daDona)).toBe(CHAVE);

    // Nem liga: com o link desligado, a tentativa da outra não grava token.
    await desligarLinkAberto(DONA, PRONTA, PROVA);
    expect((await recusaDe(ligarLinkAberto(OUTRA, PRONTA, PROVA))).codigo).toBe("NOT_FOUND");
    expect(await tokenNoBanco(PRONTA)).toBeNull();

    // Reunião com falha não ganha link, nem pela dona.
    expect((await recusaDe(ligarLinkAberto(DONA, COM_FALHA, PROVA))).codigo).toBe("PRECONDITION_FAILED");
    expect(await tokenNoBanco(COM_FALHA)).toBeNull();
  });

  it("token fora do formato não abre nada", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA, PROVA);
    expect((await recusaDe(verReuniaoPeloLink(token.slice(0, 31)))).codigo).toBe("NOT_FOUND");
    expect((await recusaDe(verReuniaoPeloLink(`${token}x`))).codigo).toBe("NOT_FOUND");
    expect(await chaveDoAudioDoLink("")).toBeNull();
  });

  it("conta desativada deixa de servir o link; reativada, volta", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA, PROVA);
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

  it("o token vale com a caixa exata: a mesma letra em outra caixa não abre a reunião nem o áudio", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA, PROVA);
    const outraCaixa = trocarCaixa(token);
    expect(outraCaixa).not.toBe(token);
    expect((await recusaDe(verReuniaoPeloLink(outraCaixa))).codigo).toBe("NOT_FOUND");
    expect(await chaveDoAudioDoLink(outraCaixa)).toBeNull();
    expect(await chaveDoAudioDoLink(token)).toBe(CHAVE);
  });

  it("a confirmação da dona entra na auditoria, com IP e navegador, a cada vez que ela liga", async () => {
    const db = (await getDb())!;
    const linhas = () => db.select().from(auditLogs)
      .where(and(eq(auditLogs.userId, PROVA.userId), eq(auditLogs.action, ACAO_LINK_LIGADO), eq(auditLogs.resourceId, PRONTA)));
    const antes = (await linhas()).length;
    await ligarLinkAberto(DONA, PRONTA, PROVA);
    const depois = await linhas();
    expect(depois.length).toBe(antes + 1);
    expect(depois.at(-1)).toMatchObject({
      resource: "meetings", ipAddress: PROVA.ipAddress, userAgent: PROVA.userAgent, status: "success", riskLevel: "medium",
    });
    // A frase e o idioma que a dona viu, com o hash: a frase vai mudar com a revisão jurídica.
    expect(depois.at(-1)!.details).toEqual({
      autorizacaoDasPessoas: true,
      idioma: PROVA.idioma,
      textoExibido: PROVA.textoExibido,
      textoHash: crypto.createHash("sha256").update(PROVA.textoExibido).digest("hex"),
    });
  });

  it("recusado, o link não liga e nada vai para a auditoria", async () => {
    const db = (await getDb())!;
    const naFalha = () => db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.userId, PROVA.userId), eq(auditLogs.resourceId, COM_FALHA)));
    expect((await recusaDe(ligarLinkAberto(DONA, COM_FALHA, PROVA))).codigo).toBe("PRECONDITION_FAILED");
    expect(await naFalha()).toHaveLength(0);
  });

  it("reunião em exclusão ('deleted', antes de a linha sair) não abre pelo link", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA, PROVA);
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
    const token = await ligarLinkAberto(DONA, PRONTA, PROVA);
    const db = (await getDb())!;
    await db.update(meetingRecordings).set({ expiresAt: AGORA - 1 }).where(eq(meetingRecordings.ownerId, DONA));
    expect(await chaveDoAudioDoLink(token)).toBeNull();
    expect(await verReuniaoPeloLink(token)).toMatchObject({ gravacao: null, gravacaoExpirada: true });
  });
});
