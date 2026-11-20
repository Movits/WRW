import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

// O bucket é dublê: a leitura do áudio vencido o tira do bucket com todas as
// versões, e este arquivo não pode falar com um bucket de verdade.
const apagarAudio = vi.hoisted(() => vi.fn(async (_chave: string) => {}));
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: (...args: unknown[]) => apagarAudio(...(args as [string])),
}));
import { getDb } from "./db";
import { auditLogs, meetingAudioSlices, meetingContactSuggestions, meetingEntities, meetingRecordings, meetingTranscripts, meetings, users } from "../drizzle/schema";
import {
  ACAO_LINK_LIGADO,
  chaveDoAudioDoLink,
  desligarLinkAberto,
  gerarTokenDoLink,
  ligarLinkAberto,
  LinkAbertoRecusado,
  verReuniaoPeloLink,
} from "./link-aberto-da-reuniao";
import { getPrivateMeeting } from "./meeting-service";

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
 * - a confirmação da dona entra na auditoria junto com o link, com a versão;
 * - os nomes das vozes saem pelo link só quando a última confirmação da dona,
 *   naquela reunião, é a que fala deles (H3b), e o detalhe dela diz se é o caso.
 *
 * Donas e reuniões com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-link-${crypto.randomUUID()}`;
const OUTRA = `teste-link-${crypto.randomUUID()}`;
const PRONTA = crypto.randomUUID();
const COM_FALHA = crypto.randomUUID();
// Os nomes das vozes (H3b) moram numa reunião à parte, para os testes do link
// da PRONTA não dependerem deles. A coluna é JSON livre: só F1 a F99 com texto
// valem, aparados e cortados em 60 caracteres.
const COM_NOMES = crypto.randomUUID();
const NOMES_GRAVADOS = { F1: "  Ana Voz  ", F2: "   ", F0: "Zero", X1: "Fora", F3: 7, F12: "x".repeat(80), F100: "Cem" };
const NOMES_NO_LINK = { F1: "Ana Voz", F12: "x".repeat(60) };
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
    await db.insert(meetings).values([
      reuniao(PRONTA, "ready"), reuniao(COM_FALHA, "failed"),
      { ...reuniao(COM_NOMES, "ready"), speakerNames: NOMES_GRAVADOS as never },
    ]);
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
    await apagarPelaChave(db, meetingRecordings, eq(meetingRecordings.ownerId, DONA));
    await apagarPelaChave(db, meetingEntities, eq(meetingEntities.ownerId, DONA));
    await apagarPelaChave(db, meetingContactSuggestions, eq(meetingContactSuggestions.ownerId, DONA));
    await apagarPelaChave(db, meetingTranscripts, eq(meetingTranscripts.ownerId, DONA));
    await apagarPelaChave(db, meetings, eq(meetings.ownerId, DONA));
    await db.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
    await apagarPelaChave(db, auditLogs, eq(auditLogs.userId, PROVA.userId));
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
      transcricao: { texto: "Combinamos a entrega na sexta.", idioma: "pt-BR", segmentos: [] },
      // O envio único é uma parte só, pela rota do link (D1).
      gravacao: {
        url: `/reuniao-aberta/${token}/audio`, mimeType: "audio/mp4", durationSeconds: 90,
        partes: [{ seq: 0, url: `/reuniao-aberta/${token}/audio`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 90 }],
      },
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

  it("a resposta do link tem a lista fechada de chaves: nada além do que a página mostra", async () => {
    const vista = await verReuniaoPeloLink(await ligarLinkAberto(DONA, PRONTA, PROVA));
    expect(Object.keys(vista).sort()).toEqual(["criadaEm", "gravacao", "gravacaoExpirada", "gravacaoSaindo", "titulo", "transcricao", "vozes"]);
    expect(Object.keys(vista.transcricao!).sort()).toEqual(["idioma", "segmentos", "texto"]);
    expect(Object.keys(vista.gravacao!).sort()).toEqual(["durationSeconds", "expiresAt", "mimeType", "partes", "url"]);
  });

  it("com a confirmação que fala dos nomes (versão 2), o link traz os nomes que a dona deu às vozes, só os pares válidos (H3b)", async () => {
    const token = await ligarLinkAberto(DONA, COM_NOMES, { ...PROVA, versaoDaAutorizacao: 2 });
    try {
      const vista = await verReuniaoPeloLink(token);
      expect(vista.vozes).toEqual(NOMES_NO_LINK);
      // O mapa e mais nada da dona: nem o nome, nem o e-mail, nem a conta, nem a reunião.
      const texto = JSON.stringify(vista);
      for (const daDona of [NOME_DA_DONA, EMAIL_DA_DONA, DONA, COM_NOMES]) expect(texto).not.toContain(daDona);
      expect((await getPrivateMeeting(DONA, COM_NOMES))?.meeting.linkMostraNomes).toBe(true);
    } finally {
      await desligarLinkAberto(DONA, COM_NOMES);
    }
  });

  it("com a confirmação antiga (versão 1), o link segue sem os nomes até a dona desligar e ligar com a caixa nova", async () => {
    const antigo = await ligarLinkAberto(DONA, COM_NOMES, PROVA);
    try {
      expect((await verReuniaoPeloLink(antigo)).vozes).toEqual({});
      expect((await getPrivateMeeting(DONA, COM_NOMES))?.meeting.linkMostraNomes).toBe(false);
      await desligarLinkAberto(DONA, COM_NOMES);
      expect((await getPrivateMeeting(DONA, COM_NOMES))?.meeting.linkMostraNomes).toBe(false);
      const novo = await ligarLinkAberto(DONA, COM_NOMES, { ...PROVA, versaoDaAutorizacao: 2 });
      expect(novo).not.toBe(antigo);
      expect((await verReuniaoPeloLink(novo)).vozes).toEqual(NOMES_NO_LINK);
    } finally {
      await desligarLinkAberto(DONA, COM_NOMES);
    }
  });

  it("a última vez que a dona ligou decide: confirmar de novo pela aba antiga, sem a versão, volta a esconder os nomes", async () => {
    const token = await ligarLinkAberto(DONA, COM_NOMES, { ...PROVA, versaoDaAutorizacao: 2 });
    try {
      expect((await verReuniaoPeloLink(token)).vozes).toEqual(NOMES_NO_LINK);
      // Ligar o que já está ligado devolve o mesmo link, e a confirmação nova é a da frase antiga.
      expect(await ligarLinkAberto(DONA, COM_NOMES, PROVA)).toBe(token);
      expect((await verReuniaoPeloLink(token)).vozes).toEqual({});
    } finally {
      await desligarLinkAberto(DONA, COM_NOMES);
    }
  });

  // Os dois testes abaixo provam que a versão se lê reunião por reunião: a
  // linha mais nova de ligar o link, na tabela inteira, é de OUTRA reunião da
  // mesma dona. Uma consulta que perdesse o filtro da reunião passaria nos
  // testes acima, que só mexem numa reunião de cada vez.
  it("link sem linha de auditoria não mostra os nomes, nem com a versão 2 de outra reunião da dona como a linha mais nova", async () => {
    const db = (await getDb())!;
    const SEM_PROVA = crypto.randomUUID();
    const token = gerarTokenDoLink();
    await db.insert(meetings).values({ ...reuniao(SEM_PROVA, "ready"), speakerNames: { F1: "Bia" }, shareToken: token });
    // A COM_NOMES ligada com a caixa nova vira a linha mais nova de ligar o link.
    await ligarLinkAberto(DONA, COM_NOMES, { ...PROVA, versaoDaAutorizacao: 2 });
    try {
      expect((await getPrivateMeeting(DONA, COM_NOMES))?.meeting.linkMostraNomes).toBe(true);
      // Sem prova da confirmação, vale a versão 1.
      expect((await verReuniaoPeloLink(token)).vozes).toEqual({});
      expect((await getPrivateMeeting(DONA, SEM_PROVA))?.meeting.linkMostraNomes).toBe(false);
    } finally {
      await desligarLinkAberto(DONA, COM_NOMES);
    }
  });

  it("religar outra reunião da dona pela aba antiga não esconde os nomes do link que ela ligou com a caixa nova", async () => {
    const token = await ligarLinkAberto(DONA, COM_NOMES, { ...PROVA, versaoDaAutorizacao: 2 });
    try {
      // A PRONTA religada sem a versão (vale 1) vira a linha mais nova de ligar o link.
      await ligarLinkAberto(DONA, PRONTA, PROVA);
      expect((await verReuniaoPeloLink(token)).vozes).toEqual(NOMES_NO_LINK);
      expect((await getPrivateMeeting(DONA, COM_NOMES))?.meeting.linkMostraNomes).toBe(true);
      expect((await getPrivateMeeting(DONA, PRONTA))?.meeting.linkMostraNomes).toBe(false);
    } finally {
      await desligarLinkAberto(DONA, COM_NOMES);
    }
  });

  it("reunião em partes pelo link (D1): falas no contrato (sem campo extra), cada parte por ?parte, e só as da reunião do token", async () => {
    const db = (await getDb())!;
    const EM_PARTES = crypto.randomUUID();
    await db.insert(meetings).values({ ...reuniao(EM_PARTES, "ready"), audioPipeline: "slices", expectedSlices: 3 });
    await db.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: EM_PARTES, ownerId: DONA, transcript: "Oi. Tchau.", language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
      segments: [
        { inicio: 1, fim: 2, falante: "F1", texto: "Oi.", palavras: ["campo", "fora", "do", "contrato"] },
        { inicio: 600, fim: 1200, falante: "", texto: "", lacuna: true },
        { texto: "malformado" },
      ],
    });
    const parte = (seq: number, extra: Record<string, unknown> = {}) => ({
      id: crypto.randomUUID(), meetingId: EM_PARTES, ownerId: DONA, seq, status: "transcribed" as const,
      storageKey: `meetings/${DONA}/${EM_PARTES}/partes/${seq}.m4a`, storageUrl: `/manus-storage/meetings/${DONA}/${EM_PARTES}/partes/${seq}.m4a`,
      mimeType: "audio/mp4", sizeBytes: 10, sha256: "0".repeat(64), durationMs: 600_000, offsetMs: seq * 600_000,
      expiresAt: AGORA + 86_400_000, createdAt: AGORA, updatedAt: AGORA, ...extra,
    });
    await db.insert(meetingAudioSlices).values([parte(0), parte(1, { expiresAt: AGORA - 1 }), parte(2, { status: "uploading" })]);
    try {
      const token = await ligarLinkAberto(DONA, EM_PARTES, PROVA);
      const vista = await verReuniaoPeloLink(token);
      expect(vista.transcricao?.segmentos).toEqual([
        { inicio: 1, fim: 2, falante: "F1", texto: "Oi." },
        { inicio: 600, fim: 1200, falante: "", texto: "", lacuna: true },
      ]);
      // Só a parte que vale (a 1 venceu, a 2 não subiu), pela rota do link.
      expect(vista.gravacao?.partes).toEqual([{ seq: 0, url: `/reuniao-aberta/${token}/audio?parte=0`, mimeType: "audio/mp4", inicioSegundos: 0, duracaoSegundos: 600 }]);
      expect(JSON.stringify(vista)).not.toContain("manus-storage");
      expect(await chaveDoAudioDoLink(token, 0)).toBe(`meetings/${DONA}/${EM_PARTES}/partes/0.m4a`);
      expect(await chaveDoAudioDoLink(token)).toBe(`meetings/${DONA}/${EM_PARTES}/partes/0.m4a`);
      expect(await chaveDoAudioDoLink(token, 1)).toBeNull();
      expect(await chaveDoAudioDoLink(token, 2)).toBeNull();
      expect(await chaveDoAudioDoLink(token, 9)).toBeNull();
    } finally {
      await apagarPelaChave(db, meetingAudioSlices, eq(meetingAudioSlices.meetingId, EM_PARTES));
    }
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
      .where(and(eq(auditLogs.userId, PROVA.userId), eq(auditLogs.action, ACAO_LINK_LIGADO), eq(auditLogs.resourceId, PRONTA)))
      .orderBy(auditLogs.id);
    const antes = (await linhas()).length;
    await ligarLinkAberto(DONA, PRONTA, PROVA);
    const depois = await linhas();
    expect(depois.length).toBe(antes + 1);
    expect(depois.at(-1)).toMatchObject({
      resource: "meetings", ipAddress: PROVA.ipAddress, userAgent: PROVA.userAgent, status: "success", riskLevel: "medium",
    });
    // A frase e o idioma que a dona viu, com o hash: a frase vai mudar com a revisão jurídica.
    // Sem a versão (a aba de antes da H3b), a linha leva a 1.
    expect(depois.at(-1)!.details).toEqual({
      autorizacaoDasPessoas: true,
      versaoDaAutorizacao: 1,
      idioma: PROVA.idioma,
      textoExibido: PROVA.textoExibido,
      textoHash: crypto.createHash("sha256").update(PROVA.textoExibido).digest("hex"),
    });
    // A caixa que fala dos nomes das vozes grava a versão 2 (H3b).
    await ligarLinkAberto(DONA, PRONTA, { ...PROVA, versaoDaAutorizacao: 2 });
    expect((await linhas()).at(-1)!.details).toMatchObject({ autorizacaoDasPessoas: true, versaoDaAutorizacao: 2, textoExibido: PROVA.textoExibido });
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

  it("gravação vencida não é tocada pelo link; com o bucket recusando, a página diz que ela está saindo, e só depois de sair, que expirou", async () => {
    const token = await ligarLinkAberto(DONA, PRONTA, PROVA);
    const db = (await getDb())!;
    await db.update(meetingRecordings).set({ expiresAt: AGORA - 1 }).where(eq(meetingRecordings.ownerId, DONA));
    expect(await chaveDoAudioDoLink(token)).toBeNull();

    apagarAudio.mockRejectedValueOnce(new Error("B2 fora do ar"));
    const durante = await verReuniaoPeloLink(token);
    expect(durante).toMatchObject({ gravacao: null, gravacaoExpirada: false, gravacaoSaindo: true });

    expect(await verReuniaoPeloLink(token)).toMatchObject({ gravacao: null, gravacaoExpirada: true, gravacaoSaindo: false });
    expect(apagarAudio).toHaveBeenLastCalledWith(CHAVE);
    expect(await db.select().from(meetingRecordings).where(eq(meetingRecordings.meetingId, PRONTA))).toEqual([]);
  });
});
