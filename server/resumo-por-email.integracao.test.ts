import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

// A Resend é dublê: nenhum e-mail de verdade sai deste arquivo. O dublê
// recebe a lista que iria à API de lote e responde, item a item, se aceitou.
const dubles = vi.hoisted(() => ({
  lote: vi.fn(async (lista: Array<{ to: string; subject: string; html: string; text?: string }>) => lista.map(() => true)),
}));
vi.mock("./_core/email", async original => ({
  ...(await original<typeof import("./_core/email")>()),
  sendEmailBatch: (lista: Array<{ to: string; subject: string; html: string; text?: string }>) => dubles.lote(lista),
}));
// O bucket também: a exclusão da reunião não pode falar com um bucket de verdade.
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: async () => {},
}));

import { getDb } from "./db";
import { apagarPelaChave } from "./test/apagar-pela-chave";
import { agendaReunioes, auditLogs, meetings, meetingSummaries, resumoPorEmail, users } from "../drizzle/schema";
import {
  EMAILS_DIGITADOS_POR_ENVIO_MAX,
  EMAILS_POR_DONA_EM_24H,
  EMAILS_POR_REUNIAO_EM_24H,
  JANELA_DOS_TETOS_MS,
  MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA,
  MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO,
  MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR,
  MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO,
  TENTATIVAS_POR_EMAIL_MAX,
} from "@shared/resumo-por-email";
import { VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { ACAO_LINK_LIGADO, linkMostraOsNomes } from "./autorizacao-do-link-aberto";
import { ligarLinkAberto, desligarLinkAberto, mudarAudioDoLink, novaSenhaDoLink } from "./link-aberto-da-reuniao";
import { deletePrivateMeeting } from "./meeting-service";
import {
  ACAO_ENVIO_AUTOMATICO_DO_RESUMO,
  ACAO_RESUMO_POR_EMAIL,
  ACAO_RESUMO_POR_EMAIL_DE_NOVO,
  definirEnvioAutomaticoDoResumo,
  envioAutomaticoDoResumo,
  hashDoEmail,
  mandarResumoPorEmail,
  mandarResumoPorEmailDeNovo,
  painelDoResumoPorEmail,
} from "./resumo-por-email";

/**
 * O resumo por e-mail (H22) contra um banco real DE TESTE (migração 0023), com
 * a Resend dublada. No CI é o MariaDB criado do zero; sem DATABASE_URL_TESTES
 * o arquivo se pula (server/test/setup-banco.ts). O que só o banco prova:
 *
 * - quem recebe: a dona pelo e-mail da conta, as participantes que estão na
 *   agenda da reunião e os e-mails digitados, cada um num e-mail à parte, sem
 *   repetir ninguém;
 * - o link aberto ligado no mesmo pedido, só com a palavra da dona, que vai
 *   para a auditoria (versão 2, H3b); sem ela, nada é gravado;
 * - a auditoria do envio na mesma transação: sem ela, nem link, nem linha;
 * - os tetos por envio, por reunião e por dona nas últimas 24 h;
 * - outra dona leva NOT_FOUND em tudo, como a reunião que não existe;
 * - a Resend fora do ar: erro traduzível, o pedido guardado ('falhou') e o
 *   "Tentar de novo";
 * - o envio automático, desligado por padrão, só para a dona e só uma vez;
 * - a reunião excluída leva os endereços, e as linhas seguem no teto.
 *
 * Donas e reuniões com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const AGORA = Date.now();
const REQUISICAO = { ipAddress: "203.0.113.7", userAgent: "vitest-resumo-por-email" };
const AUTORIZACAO = {
  idioma: "pt-BR",
  textoExibido: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram que quem receber o link ouça a gravação e leia a transcrição, com os nomes que eu der às vozes.",
  versaoDaAutorizacao: VERSAO_DA_AUTORIZACAO_COM_NOMES,
};
const sufixo = () => crypto.randomUUID().slice(0, 8);
const PARTICIPANTES = () => [
  { nome: "Ana", email: `ana-${sufixo()}@teste.invalid` },
  { nome: "Bia sem e-mail", email: null },
  { nome: null, email: `caio-${sufixo()}@teste.invalid` },
];

const criados = { openIds: [] as string[], userIds: [] as number[], meetingIds: [] as string[] };

type Cenario = {
  dona: { id: number; openId: string };
  meetingId: string;
  email: string | null;
  participantes: Array<{ nome: string | null; email: string | null }>;
};

async function cenario(opcoes: {
  idioma?: string; link?: boolean; participantes?: Array<{ nome: string | null; email: string | null }>;
  versao?: number; status?: "ready" | "processing"; email?: string | null; nome?: string | null;
  automatico?: boolean; ativa?: boolean; semAgenda?: boolean;
  /** A reunião sem gravação: a de documento (H12 e H12b) e a de vídeo do YouTube (H13), com a URL dele. */
  origem?: "pdf" | "foto" | "youtube"; sourceUrl?: string;
} = {}): Promise<Cenario> {
  const db = (await getDb())!;
  const openId = `teste-resumo-email-${crypto.randomUUID()}`;
  const email = opcoes.email === undefined ? `dona-${sufixo()}@teste.invalid` : opcoes.email;
  await db.insert(users).values({
    openId, name: opcoes.nome === undefined ? "Glenda Teste" : opcoes.nome, email,
    isActive: opcoes.ativa ?? true, onboardingCompleted: true, resumoPorEmailAutomatico: opcoes.automatico ?? false,
  });
  const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, openId));
  const meetingId = crypto.randomUUID();
  criados.openIds.push(openId);
  criados.userIds.push(conta.id);
  criados.meetingIds.push(meetingId);
  await db.insert(meetings).values({
    id: meetingId, ownerId: openId, title: "Reunião com a Apex", status: opcoes.status ?? "ready",
    consentGranted: true, consentAt: AGORA, language: opcoes.idioma ?? "pt-BR", createdAt: AGORA, updatedAt: AGORA,
    ...(opcoes.origem ? { origem: opcoes.origem, sourceUrl: opcoes.sourceUrl ?? null } : {}),
  });
  await db.insert(meetingSummaries).values({
    id: crypto.randomUUID(), meetingId, ownerId: openId, status: "ready", version: opcoes.versao ?? 1, language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
  });
  const participantes = opcoes.participantes ?? PARTICIPANTES();
  if (!opcoes.semAgenda) {
    await db.insert(agendaReunioes).values({
      id: crypto.randomUUID(), ownerId: openId, titulo: "Reunião com a Apex", inicioEm: AGORA - 3_600_000, duracaoMinutos: 60,
      fuso: "America/Sao_Paulo", participantes, meetingId, createdAt: AGORA, updatedAt: AGORA,
    });
  }
  const dona = { id: conta.id, openId };
  if (opcoes.link) {
    await ligarLinkAberto(openId, meetingId, { userId: dona.id, ...REQUISICAO, idioma: AUTORIZACAO.idioma, textoExibido: AUTORIZACAO.textoExibido, versaoDaAutorizacao: VERSAO_DA_AUTORIZACAO_COM_NOMES });
  }
  return { dona, meetingId, email, participantes };
}

async function linhasDa(meetingId: string) {
  const db = (await getDb())!;
  return db.select().from(resumoPorEmail).where(eq(resumoPorEmail.meetingId, meetingId));
}

async function tokenDa(meetingId: string) {
  const db = (await getDb())!;
  const [linha] = await db.select({ token: meetings.shareToken }).from(meetings).where(eq(meetings.id, meetingId));
  return linha?.token ?? null;
}

async function auditoriaDa(meetingId: string, acao: string) {
  const db = (await getDb())!;
  return db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, meetingId), eq(auditLogs.action, acao)));
}

/** A lista que o serviço mandou à Resend na chamada `n` (0 é a primeira). */
const loteMandado = (n = 0) => dubles.lote.mock.calls[n][0];

const pedido = (extra: Partial<Parameters<typeof mandarResumoPorEmail>[2]> = {}) => ({
  paraMim: false, participantes: [] as string[], outros: [] as string[], ...extra,
});

async function recusaDe(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return erro as { code?: string; message?: string };
  }
  throw new Error("era para recusar");
}

async function semearLinhas(dona: { openId: string }, meetingId: string, quantas: number, createdAt = Date.now()) {
  const db = (await getDb())!;
  if (!quantas) return;
  await db.insert(resumoPorEmail).values(Array.from({ length: quantas }, (_, i) => ({
    id: crypto.randomUUID(), meetingId, ownerId: dona.openId, loteId: crypto.randomUUID(), destinatario: `semeada-${i}-${sufixo()}@teste.invalid`,
    origem: "digitado" as const, idioma: "pt-BR", status: "enviado" as const, automatico: false, tentativas: 1, createdAt, updatedAt: createdAt, enviadoEm: createdAt,
  })));
}

describe.skipIf(!temBanco)("Resumo por e-mail no banco (integração)", () => {
  beforeEach(() => {
    process.env.FRONTEND_URL = "https://wrw.teste/";
    dubles.lote.mockReset();
    dubles.lote.mockImplementation(async lista => lista.map(() => true));
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    if (criados.openIds.length) {
      await apagarPelaChave(db, resumoPorEmail, inArray(resumoPorEmail.ownerId, criados.openIds));
      await apagarPelaChave(db, agendaReunioes, inArray(agendaReunioes.ownerId, criados.openIds));
      await apagarPelaChave(db, meetingSummaries, inArray(meetingSummaries.ownerId, criados.openIds));
      await apagarPelaChave(db, meetings, inArray(meetings.ownerId, criados.openIds));
      await db.delete(users).where(inArray(users.openId, criados.openIds));
    }
    if (criados.userIds.length) await apagarPelaChave(db, auditLogs, inArray(auditLogs.userId, criados.userIds));
    if (criados.meetingIds.length) await apagarPelaChave(db, auditLogs, inArray(auditLogs.resourceId, criados.meetingIds));
  });

  describe("quem recebe", () => {
    it("a dona pelo e-mail da conta, a participante da agenda e o digitado, cada um no seu e-mail, sem repetir ninguém", async () => {
      const { dona, meetingId, email, participantes } = await cenario({ link: true });
      const ana = participantes[0].email!;
      const resultado = await mandarResumoPorEmail(dona, meetingId, pedido({
        paraMim: true,
        // A grafia da tela não importa: vale a da agenda, e a repetida sai uma vez só.
        participantes: [ana.toUpperCase()],
        outros: [`Zeca-${sufixo()}@Teste.invalid`, ` ${ana} `, email!],
      }), REQUISICAO);
      expect(resultado).toEqual({ enviados: 3, falharam: 0, linkLigadoAgora: false });

      const linhas = await linhasDa(meetingId);
      expect(linhas.map(l => [l.origem, l.status, l.tentativas]).sort()).toEqual([
        ["digitado", "enviado", 1], ["dona", "enviado", 1], ["participante", "enviado", 1],
      ]);
      expect(linhas.find(l => l.origem === "dona")?.destinatario).toBe(email);
      expect(linhas.find(l => l.origem === "participante")?.destinatario).toBe(ana);
      expect(new Set(linhas.map(l => l.loteId)).size).toBe(1);

      // Uma chamada de lote, um destinatário por e-mail: ninguém vê o endereço de outra pessoa.
      expect(dubles.lote).toHaveBeenCalledTimes(1);
      const lote = loteMandado();
      expect(lote).toHaveLength(3);
      for (const item of lote) expect(item.to).not.toMatch(/[,;]/);
      const token = await tokenDa(meetingId);
      for (const item of lote) {
        expect(item.html).toContain(`https://wrw.teste/r/${token}`);
        expect(item.text).toContain(`https://wrw.teste/r/${token}`);
        // Nada da reunião além do título: nem a transcrição, nem o nome de outra participante.
        expect(item.html).toContain("Reunião com a Apex");
      }
      const daDona = lote.find(item => item.to === email)!;
      expect(daDona.subject).toBe("O link aberto da sua reunião “Reunião com a Apex”");
      const daAna = lote.find(item => item.to === ana)!;
      expect(daAna.subject).toBe("Glenda Teste compartilhou com você o resumo de uma reunião");
      expect(daAna.html).not.toContain(email!);
    });

    it("participante que não está na agenda: BAD_REQUEST, nada gravado e nada mandado", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ participantes: [`fora-${sufixo()}@teste.invalid`] }), REQUISICAO));
      expect(erro).toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA });
      expect(await linhasDa(meetingId)).toEqual([]);
      expect(dubles.lote).not.toHaveBeenCalled();
    });

    it("o painel lista só as participantes com e-mail, e o e-mail vai no idioma da reunião", async () => {
      const { dona, meetingId, participantes } = await cenario({ link: true, idioma: "en" });
      const painel = await painelDoResumoPorEmail(dona.openId, meetingId);
      expect(painel.participantes).toEqual([
        { nome: "Ana", email: participantes[0].email },
        { nome: null, email: participantes[2].email },
      ]);
      expect(painel).toMatchObject({ idioma: "en", linkLigado: true, automatico: false, nomeDaDona: "Glenda Teste", envios: [], podeMandarDeNovo: false });
      await mandarResumoPorEmail(dona, meetingId, pedido({ participantes: [participantes[2].email!] }), REQUISICAO);
      expect(loteMandado()[0].subject).toBe("Glenda Teste shared a meeting summary with you");
      expect((await linhasDa(meetingId))[0].idioma).toBe("en");
    });

    it("reunião que ainda não tem resumo gravado não manda", async () => {
      const { dona, meetingId, email } = await cenario({ link: true, versao: 0 });
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO));
      expect(erro).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO });
      expect(email).toBeTruthy();
      expect(await linhasDa(meetingId)).toEqual([]);
    });
  });

  describe("o link aberto ligado no pedido", () => {
    it("desligado e sem a palavra da dona: PRECONDITION_FAILED, o link continua desligado e nada é gravado", async () => {
      const { dona, meetingId } = await cenario();
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO));
      expect(erro).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO });
      expect(await tokenDa(meetingId)).toBeNull();
      expect(await linhasDa(meetingId)).toEqual([]);
      expect(await auditoriaDa(meetingId, ACAO_LINK_LIGADO)).toEqual([]);
      expect(dubles.lote).not.toHaveBeenCalled();
    });

    it("com a palavra da dona: o link liga, a confirmação vai para a auditoria (versão 2) e o e-mail leva o link novo", async () => {
      const { dona, meetingId } = await cenario();
      const resultado = await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, autorizacao: AUTORIZACAO }), REQUISICAO);
      expect(resultado).toEqual({ enviados: 1, falharam: 0, linkLigadoAgora: true });
      const token = await tokenDa(meetingId);
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(loteMandado()[0].html).toContain(`https://wrw.teste/r/${token}`);
      const [prova] = await auditoriaDa(meetingId, ACAO_LINK_LIGADO);
      expect(prova).toMatchObject({ userId: dona.id, ipAddress: REQUISICAO.ipAddress, riskLevel: "medium" });
      expect(prova.details).toMatchObject({
        autorizacaoDasPessoas: true, versaoDaAutorizacao: 2, idioma: "pt-BR", textoExibido: AUTORIZACAO.textoExibido, origem: "resumo_por_email",
      });
      // A H3b: ligado com a confirmação que fala dos nomes, o link os mostra.
      const db = (await getDb())!;
      expect(await linkMostraOsNomes(db, meetingId)).toBe(true);
    });

    it("com o link já ligado, a palavra não é pedida e o link fica o mesmo", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      const antes = await tokenDa(meetingId);
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO);
      expect(await tokenDa(meetingId)).toBe(antes);
      expect(await auditoriaDa(meetingId, ACAO_LINK_LIGADO)).toHaveLength(1);
    });
  });

  describe("a auditoria", () => {
    it("uma linha por envio, na transação, com quantos, de que origem e o hash de cada endereço (nunca o endereço)", async () => {
      const { dona, meetingId, email, participantes } = await cenario({ link: true });
      const digitado = `Zeca-${sufixo()}@teste.invalid`;
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, participantes: [participantes[0].email!], outros: [digitado] }), REQUISICAO);
      const [prova] = await auditoriaDa(meetingId, ACAO_RESUMO_POR_EMAIL);
      expect(prova).toMatchObject({ userId: dona.id, resource: "meetings", ipAddress: REQUISICAO.ipAddress, userAgent: REQUISICAO.userAgent, status: "success" });
      const detalhes = prova.details as Record<string, unknown>;
      expect(detalhes).toMatchObject({
        quantidade: 3, porOrigem: { dona: 1, participante: 1, digitado: 1 }, idioma: "pt-BR", linkLigadoAgora: false, automatico: false,
      });
      expect(new Set(detalhes.destinatarios as string[])).toEqual(new Set([hashDoEmail(email!), hashDoEmail(participantes[0].email!), hashDoEmail(digitado)]));
      expect(JSON.stringify(detalhes)).not.toContain("@");
      expect(detalhes.lote).toBe((await linhasDa(meetingId))[0].loteId);
    });

    it("se a gravação falha no meio, nada fica: nem o link ligado, nem as linhas, nem a auditoria", async () => {
      const { dona, meetingId } = await cenario();
      // O mesmo id para todas as linhas: o INSERT recusa a chave repetida depois de o link ligar.
      const fixo = crypto.randomUUID();
      const espiao = vi.spyOn(crypto, "randomUUID").mockReturnValue(fixo as ReturnType<typeof crypto.randomUUID>);
      try {
        await expect(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [`um-${sufixo()}@teste.invalid`], autorizacao: AUTORIZACAO }), REQUISICAO)).rejects.toThrow();
      } finally {
        espiao.mockRestore();
      }
      expect(await tokenDa(meetingId)).toBeNull();
      expect(await linhasDa(meetingId)).toEqual([]);
      expect(await auditoriaDa(meetingId, ACAO_LINK_LIGADO)).toEqual([]);
      expect(await auditoriaDa(meetingId, ACAO_RESUMO_POR_EMAIL)).toEqual([]);
      expect(dubles.lote).not.toHaveBeenCalled();
    });

    it("ligar e desligar o envio automático grava a opção e a auditoria juntas", async () => {
      const { dona } = await cenario();
      expect(await definirEnvioAutomaticoDoResumo(dona, true, REQUISICAO)).toEqual({ automatico: true });
      const db = (await getDb())!;
      const [conta] = await db.select({ automatico: users.resumoPorEmailAutomatico }).from(users).where(eq(users.id, dona.id));
      expect(conta.automatico).toBe(true);
      const linhas = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, dona.id), eq(auditLogs.action, ACAO_ENVIO_AUTOMATICO_DO_RESUMO)));
      expect(linhas.map(l => l.details)).toEqual([{ ligado: true }]);
    });
  });

  describe("os tetos", () => {
    it(`mais de ${EMAILS_DIGITADOS_POR_ENVIO_MAX} e-mails digitados num envio: BAD_REQUEST`, async () => {
      const { dona, meetingId } = await cenario({ link: true });
      const outros = Array.from({ length: EMAILS_DIGITADOS_POR_ENVIO_MAX + 1 }, (_, i) => `d${i}-${sufixo()}@teste.invalid`);
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ outros }), REQUISICAO));
      expect(erro).toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_DEMAIS });
      expect(await linhasDa(meetingId)).toEqual([]);
    });

    it("mais pessoas do que cabem num envio (a agenda inteira mais os digitados): BAD_REQUEST", async () => {
      const participantes = Array.from({ length: 15 }, (_, i) => ({ nome: `P${i}`, email: `p${i}-${sufixo()}@teste.invalid` }));
      const { dona, meetingId } = await cenario({ link: true, participantes });
      const outros = Array.from({ length: EMAILS_DIGITADOS_POR_ENVIO_MAX }, (_, i) => `d${i}-${sufixo()}@teste.invalid`);
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ participantes: participantes.map(p => p.email), outros }), REQUISICAO));
      expect(erro).toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_DEMAIS });
    });

    it(`a reunião: ${EMAILS_POR_REUNIAO_EM_24H} e-mails em 24 h; o que passou da janela não conta`, async () => {
      const { dona, meetingId } = await cenario({ link: true });
      await semearLinhas(dona, meetingId, 10, Date.now() - JANELA_DOS_TETOS_MS - 60_000);
      await semearLinhas(dona, meetingId, EMAILS_POR_REUNIAO_EM_24H - 1);
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO);
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ outros: [`mais-${sufixo()}@teste.invalid`] }), REQUISICAO));
      expect(erro).toMatchObject({ code: "TOO_MANY_REQUESTS", message: MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO });
      expect(dubles.lote).toHaveBeenCalledTimes(1);
    });

    it(`a dona: ${EMAILS_POR_DONA_EM_24H} e-mails em 24 h, somando as reuniões dela; outra dona não é afetada`, async () => {
      const { dona, meetingId } = await cenario({ link: true });
      await semearLinhas(dona, crypto.randomUUID(), EMAILS_POR_DONA_EM_24H - 1);
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [`mais-${sufixo()}@teste.invalid`] }), REQUISICAO));
      expect(erro).toMatchObject({ code: "TOO_MANY_REQUESTS", message: MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA });
      expect(await linhasDa(meetingId)).toEqual([]);
      await expect(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO)).resolves.toMatchObject({ enviados: 1 });
      const outra = await cenario({ link: true });
      await expect(mandarResumoPorEmail(outra.dona, outra.meetingId, pedido({ paraMim: true }), REQUISICAO)).resolves.toMatchObject({ enviados: 1 });
    });

    it("excluir a reunião leva os endereços, mas as linhas seguem contando no teto da dona", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [`um-${sufixo()}@teste.invalid`] }), REQUISICAO);
      expect(await deletePrivateMeeting(dona.openId, meetingId)).toBe(true);
      const linhas = await linhasDa(meetingId);
      expect(linhas).toHaveLength(2);
      expect(linhas.every(l => l.destinatario === null)).toBe(true);
      const outra = await cenario({ link: true });
      // As 2 da reunião excluída são da OUTRA conta: esta tem o teto inteiro.
      await semearLinhas(outra.dona, crypto.randomUUID(), EMAILS_POR_DONA_EM_24H - 1);
      await expect(mandarResumoPorEmail(outra.dona, outra.meetingId, pedido({ paraMim: true }), REQUISICAO)).resolves.toMatchObject({ enviados: 1 });
      // A dona da reunião excluída: 2 linhas sem endereço contam.
      const nova = (await getDb())!;
      const meetingNovo = crypto.randomUUID();
      criados.meetingIds.push(meetingNovo);
      await nova.insert(meetings).values({ id: meetingNovo, ownerId: dona.openId, title: "Outra", status: "ready", consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA });
      await nova.insert(meetingSummaries).values({ id: crypto.randomUUID(), meetingId: meetingNovo, ownerId: dona.openId, status: "ready", version: 1, createdAt: AGORA, updatedAt: AGORA });
      await ligarLinkAberto(dona.openId, meetingNovo, { userId: dona.id, ...REQUISICAO, idioma: "pt-BR", textoExibido: AUTORIZACAO.textoExibido });
      await semearLinhas(dona, crypto.randomUUID(), EMAILS_POR_DONA_EM_24H - 2);
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingNovo, pedido({ paraMim: true }), REQUISICAO));
      expect(erro).toMatchObject({ code: "TOO_MANY_REQUESTS", message: MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA });
      await expect(painelDoResumoPorEmail(dona.openId, meetingId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // Pacote 4d: o e-mail (H22) segue a senha e o áudio do link aberto (H23),
  // como o link está na hora de cada envio. A senha nunca vai no e-mail.
  describe("a senha e o áudio do link (H23)", () => {
    const PEDE_A_SENHA = "Este link pede uma senha de 6 dígitos, que não vai neste e-mail: peça a senha a Glenda Teste.";
    const PEDE_A_SENHA_DA_DONA = "Este link pede a senha de 6 dígitos que você criou, e ela não vai neste e-mail.";
    const COM_AUDIO = "ouve a gravação enquanto ela estiver guardada";
    const SEM_AUDIO = "Pelo link, você lê o resumo e a transcrição e pode fazer perguntas à IA sobre a reunião.";
    const provaDa = (dona: { id: number }) => ({ userId: dona.id, ...REQUISICAO });

    it("link com senha: o e-mail de cada um diz que ela não vai e a quem pedi-la, e a senha não vai em nenhum", async () => {
      const { dona, meetingId, email, participantes } = await cenario({ link: true });
      const senha = await novaSenhaDoLink(dona.openId, meetingId, provaDa(dona));
      const ana = participantes[0].email!;
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, participantes: [ana] }), REQUISICAO);
      const lote = loteMandado();
      const daAna = lote.find(item => item.to === ana)!;
      expect(daAna.text).toContain(PEDE_A_SENHA);
      expect(daAna.html).toContain(PEDE_A_SENHA);
      expect(daAna.text).toContain(COM_AUDIO);
      expect(lote.find(item => item.to === email)!.text).toContain(PEDE_A_SENHA_DA_DONA);
      for (const item of lote) {
        expect(item.html).not.toContain(senha);
        expect(item.text).not.toContain(senha);
        expect(item.subject).not.toContain(senha);
      }
    });

    it("link sem o áudio: o e-mail não promete a gravação", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      await mudarAudioDoLink(dona.openId, meetingId, false, provaDa(dona));
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO);
      const [item] = loteMandado();
      expect(item.text).toContain(SEM_AUDIO);
      expect(item.text).not.toContain(COM_AUDIO);
      expect(item.text).not.toContain("6 dígitos");
    });

    it("o link desligado liga como o de antes, sem senha e com o áudio, mesmo com o áudio tirado antes; a auditoria diz como ele ficou", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      await mudarAudioDoLink(dona.openId, meetingId, false, provaDa(dona));
      await novaSenhaDoLink(dona.openId, meetingId, provaDa(dona));
      await desligarLinkAberto(dona.openId, meetingId);
      const db = (await getDb())!;
      const [antes] = await db.select({ audio: meetings.shareAudio }).from(meetings).where(eq(meetings.id, meetingId));
      expect(antes.audio).toBe(false);

      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, autorizacao: AUTORIZACAO }), REQUISICAO);
      const [depois] = await db.select({ token: meetings.shareToken, hash: meetings.sharePasswordHash, audio: meetings.shareAudio })
        .from(meetings).where(eq(meetings.id, meetingId));
      expect(depois).toMatchObject({ hash: null, audio: true });
      expect(depois.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      const [item] = loteMandado();
      expect(item.text).toContain(COM_AUDIO);
      expect(item.text).not.toContain("6 dígitos");
      const provas = await auditoriaDa(meetingId, ACAO_LINK_LIGADO);
      const doEnvio = provas.find(prova => (prova.details as Record<string, unknown>).origem === "resumo_por_email");
      expect(doEnvio?.details).toMatchObject({ comSenha: false, incluirAudio: true, origem: "resumo_por_email", versaoDaAutorizacao: 2 });
    });

    it("o Tentar de novo segue o link de agora: a senha posta depois da falha entra no e-mail que sai", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO));
      expect(loteMandado(0)[0].text).not.toContain("6 dígitos");
      const senha = await novaSenhaDoLink(dona.openId, meetingId, provaDa(dona));
      dubles.lote.mockImplementation(async lista => lista.map(() => true));
      await expect(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO)).resolves.toEqual({ enviados: 1, falharam: 0 });
      const [item] = loteMandado(1);
      expect(item.text).toContain(PEDE_A_SENHA_DA_DONA);
      expect(item.text).not.toContain(senha);
    });
  });

  // A junção do Pacote 4c com o 4d: a reunião de documento (H12 e H12b) e a de
  // vídeo do YouTube (H13) não têm gravação. O envio ligava o link delas com o
  // áudio, e o e-mail prometia a gravação, dizia "gravada na Marquesa Global Match" e mandava
  // pedir a senha a "quem gravou a reunião".
  describe("a reunião sem gravação: o documento (H12) e o vídeo do YouTube (H13)", () => {
    const VIDEO = { origem: "youtube" as const, sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
    const SEM_GRAVACAO = [
      ["de documento", { origem: "pdf" as const },
        "Confirmo que posso compartilhar este documento e autorizo que quem receber o link leia o texto lido dele e o resumo, sem o arquivo."],
      ["de vídeo do YouTube", VIDEO,
        "Confirmo que posso compartilhar a transcrição deste vídeo e autorizo que quem receber o link a leia, com o resumo e os nomes que eu der às vozes."],
    ] as const;
    const SEM_AUDIO = "Pelo link, você lê o resumo e a transcrição e pode fazer perguntas à IA sobre a reunião.";
    const GRAVACAO = /gravaç|gravad|gravou/i;
    const provaDa = (dona: { id: number }) => ({ userId: dona.id, ...REQUISICAO });

    it.each(SEM_GRAVACAO)("reunião %s com o link desligado: o envio o liga sem o áudio, a prova guarda a frase da origem, e o e-mail não fala de gravação", async (_caso, origem, frase) => {
      const { dona, meetingId, participantes } = await cenario(origem);
      const ana = participantes[0].email!;
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, participantes: [ana], autorizacao: { ...AUTORIZACAO, textoExibido: frase } }), REQUISICAO);
      const db = (await getDb())!;
      const [depois] = await db.select({ token: meetings.shareToken, hash: meetings.sharePasswordHash, audio: meetings.shareAudio })
        .from(meetings).where(eq(meetings.id, meetingId));
      expect(depois.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(depois).toMatchObject({ hash: null, audio: false });
      const provas = await auditoriaDa(meetingId, ACAO_LINK_LIGADO);
      expect(provas).toHaveLength(1);
      expect(provas[0].details).toMatchObject({ incluirAudio: false, comSenha: false, origem: "resumo_por_email", textoExibido: frase, versaoDaAutorizacao: 2 });
      const lote = loteMandado();
      expect(lote).toHaveLength(2);
      for (const item of lote) {
        expect(item.text, item.to).toContain(SEM_AUDIO);
        for (const parte of [item.subject, item.text, item.html]) expect(parte, item.to).not.toMatch(GRAVACAO);
      }
      expect(lote.find(item => item.to === ana)!.text).toContain("Glenda Teste compartilhou com você o resumo de “Reunião com a Apex”, feito na Marquesa Global Match.");
    });

    it.each(SEM_GRAVACAO)("reunião %s com o link antigo, ligado com o áudio (o padrão da 0023): o e-mail não promete a gravação, nem no Tentar de novo", async (_caso, origem) => {
      const { dona, meetingId, participantes } = await cenario({ ...origem, link: true });
      const db = (await getDb())!;
      const [antes] = await db.select({ audio: meetings.shareAudio }).from(meetings).where(eq(meetings.id, meetingId));
      expect(antes.audio).toBe(true);
      const ana = participantes[0].email!;
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, participantes: [ana] }), REQUISICAO));
      dubles.lote.mockImplementation(async lista => lista.map(() => true));
      await expect(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO)).resolves.toEqual({ enviados: 2, falharam: 0 });
      for (const n of [0, 1]) {
        for (const item of loteMandado(n)) {
          expect(item.text, `${n} ${item.to}`).toContain(SEM_AUDIO);
          expect(item.text, `${n} ${item.to}`).not.toMatch(GRAVACAO);
        }
      }
      // O envio não mexe no link que já estava ligado.
      const [depois] = await db.select({ audio: meetings.shareAudio }).from(meetings).where(eq(meetings.id, meetingId));
      expect(depois.audio).toBe(true);
    });

    it("reunião de documento, conta sem nome e link com senha: a senha se pede a quem compartilhou o resumo, nunca a 'quem gravou a reunião'", async () => {
      const { dona, meetingId, participantes } = await cenario({ origem: "pdf", nome: null, link: true });
      await novaSenhaDoLink(dona.openId, meetingId, provaDa(dona));
      const ana = participantes[0].email!;
      await mandarResumoPorEmail(dona, meetingId, pedido({ participantes: [ana] }), REQUISICAO);
      const [item] = loteMandado();
      expect(item.text).toContain("Você recebeu o resumo de “Reunião com a Apex”, feito na Marquesa Global Match.");
      expect(item.text).toContain("Este link pede uma senha de 6 dígitos, que não vai neste e-mail: peça a senha a quem compartilhou o resumo com você.");
      expect(item.text).toContain("Você recebeu este e-mail porque quem compartilhou o resumo o mandou a você pela Marquesa Global Match.");
      for (const parte of [item.subject, item.text, item.html]) expect(parte).not.toMatch(GRAVACAO);
    });

    it("a reunião gravada continua: o link desligado liga com o áudio, e o e-mail fala da gravação", async () => {
      const { dona, meetingId } = await cenario();
      await mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, autorizacao: AUTORIZACAO }), REQUISICAO);
      const db = (await getDb())!;
      const [depois] = await db.select({ audio: meetings.shareAudio }).from(meetings).where(eq(meetings.id, meetingId));
      expect(depois.audio).toBe(true);
      expect(loteMandado()[0].text).toContain("ouve a gravação enquanto ela estiver guardada");
    });
  });

  describe("outra dona", () => {
    it("leva NOT_FOUND no painel, no envio e no mandar de novo, como a reunião que não existe; nada é gravado", async () => {
      const { meetingId } = await cenario({ link: true });
      const outra = await cenario();
      const naoExiste = crypto.randomUUID();
      for (const alvo of [meetingId, naoExiste]) {
        const doPainel = await recusaDe(painelDoResumoPorEmail(outra.dona.openId, alvo));
        const doEnvio = await recusaDe(mandarResumoPorEmail(outra.dona, alvo, pedido({ paraMim: true, autorizacao: AUTORIZACAO }), REQUISICAO));
        const doDeNovo = await recusaDe(mandarResumoPorEmailDeNovo(outra.dona, alvo, REQUISICAO));
        for (const erro of [doPainel, doEnvio, doDeNovo]) expect(erro).toMatchObject({ code: "NOT_FOUND", message: "Reunião não encontrada." });
      }
      expect(await linhasDa(meetingId)).toEqual([]);
      expect(dubles.lote).not.toHaveBeenCalled();
    });
  });

  describe("a Resend fora do ar", () => {
    it("nada saiu: erro traduzível, o pedido guardado como 'falhou' e o Tentar de novo manda o que ficou", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [`um-${sufixo()}@teste.invalid`] }), REQUISICAO));
      expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU });
      let linhas = await linhasDa(meetingId);
      expect(linhas.map(l => [l.status, l.tentativas])).toEqual([["falhou", 1], ["falhou", 1]]);
      expect((await painelDoResumoPorEmail(dona.openId, meetingId)).podeMandarDeNovo).toBe(true);

      dubles.lote.mockImplementation(async lista => lista.map(() => true));
      await expect(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO)).resolves.toEqual({ enviados: 2, falharam: 0 });
      linhas = await linhasDa(meetingId);
      expect(linhas.map(l => [l.status, l.tentativas])).toEqual([["enviado", 2], ["enviado", 2]]);
      expect(await auditoriaDa(meetingId, ACAO_RESUMO_POR_EMAIL_DE_NOVO)).toHaveLength(1);
      const nada = await recusaDe(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO));
      expect(nada).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR });
    });

    it("parte saiu: a resposta diz quantos, sem erro, e só o que não saiu fica para mandar de novo", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      dubles.lote.mockImplementation(async lista => lista.map((_, i) => i === 0));
      await expect(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [`um-${sufixo()}@teste.invalid`] }), REQUISICAO))
        .resolves.toEqual({ enviados: 1, falharam: 1, linkLigadoAgora: false });
      dubles.lote.mockClear();
      await mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO);
      expect(loteMandado()).toHaveLength(1);
    });

    it(`cada e-mail é mandado no máximo ${TENTATIVAS_POR_EMAIL_MAX} vezes`, async () => {
      const { dona, meetingId } = await cenario({ link: true });
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO));
      for (let i = 1; i < TENTATIVAS_POR_EMAIL_MAX; i++) {
        expect(await recusaDe(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO))).toMatchObject({ message: MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU });
      }
      expect(await recusaDe(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO))).toMatchObject({ message: MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR });
      expect(dubles.lote).toHaveBeenCalledTimes(TENTATIVAS_POR_EMAIL_MAX);
    });

    it("com o link desligado depois da falha, o Tentar de novo não manda link morto", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO));
      await desligarLinkAberto(dona.openId, meetingId);
      dubles.lote.mockClear();
      const erro = await recusaDe(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO));
      expect(erro).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO });
      expect(dubles.lote).not.toHaveBeenCalled();
    });

    it("nada saiu e a dona manda de novo às mesmas pessoas: as mesmas linhas saem, sem linha nova, e nada sobra para o Tentar de novo", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      const digitado = `um-${sufixo()}@teste.invalid`;
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [digitado] }), REQUISICAO));
      const antes = await linhasDa(meetingId);
      expect(antes.map(l => l.status)).toEqual(["falhou", "falhou"]);

      dubles.lote.mockImplementation(async lista => lista.map(() => true));
      await expect(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [digitado.toUpperCase()] }), REQUISICAO))
        .resolves.toEqual({ enviados: 2, falharam: 0, linkLigadoAgora: false });
      const depois = await linhasDa(meetingId);
      // As duas de antes, e não quatro: cada pessoa recebe um e-mail, e o teto conta duas linhas.
      expect(depois.map(l => l.id).sort()).toEqual(antes.map(l => l.id).sort());
      expect(depois.map(l => [l.status, l.tentativas])).toEqual([["enviado", 2], ["enviado", 2]]);
      expect(loteMandado(1)).toHaveLength(2);
      expect((await painelDoResumoPorEmail(dona.openId, meetingId)).podeMandarDeNovo).toBe(false);
      expect(await recusaDe(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO))).toMatchObject({ message: MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR });
      const provas = await auditoriaDa(meetingId, ACAO_RESUMO_POR_EMAIL);
      expect(provas.map(prova => (prova.details as Record<string, unknown>).deNovo)).toEqual([undefined, 2]);
    });

    it("o e-mail que está saindo agora (outra aba mandou há instantes) fica de fora; o das outras pessoas sai", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      const saindo = `saindo-${sufixo()}@teste.invalid`;
      const outra = `outra-${sufixo()}@teste.invalid`;
      const db = (await getDb())!;
      const idDaSaindo = crypto.randomUUID();
      await db.insert(resumoPorEmail).values({
        id: idDaSaindo, meetingId, ownerId: dona.openId, loteId: crypto.randomUUID(), destinatario: saindo, origem: "digitado",
        idioma: "pt-BR", status: "pendente", automatico: false, tentativas: 0, createdAt: Date.now() - 30_000, updatedAt: Date.now() - 30_000,
      });
      await expect(mandarResumoPorEmail(dona, meetingId, pedido({ outros: [saindo, outra] }), REQUISICAO)).resolves.toEqual({ enviados: 1, falharam: 0, linkLigadoAgora: false });
      expect(loteMandado().map(item => item.to)).toEqual([outra]);
      expect((await linhasDa(meetingId)).find(l => l.id === idDaSaindo)).toMatchObject({ status: "pendente", tentativas: 0 });
      // Só ela no pedido: nada a gravar nem a mandar, e nenhuma linha nova.
      dubles.lote.mockClear();
      await expect(mandarResumoPorEmail(dona, meetingId, pedido({ outros: [saindo] }), REQUISICAO)).resolves.toEqual({ enviados: 0, falharam: 0, linkLigadoAgora: false });
      expect(dubles.lote).not.toHaveBeenCalled();
      expect(await linhasDa(meetingId)).toHaveLength(2);
    });

    it("sendEmailBatch que lança: as linhas ficam 'falhou', o erro é traduzível, e o log diz o nome do erro, sem o endereço", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      const digitado = `um-${sufixo()}@teste.invalid`;
      dubles.lote.mockImplementation(async () => { throw new TypeError("defeito no lote"); });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, outros: [digitado] }), REQUISICAO));
        expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU });
        expect((await linhasDa(meetingId)).map(l => l.status)).toEqual(["falhou", "falhou"]);
        const linhasDoLog = log.mock.calls.map(chamada => chamada.map(String).join(" "));
        expect(linhasDoLog.some(linha => linha.includes("sendEmailBatch lançou") && linha.includes("TypeError"))).toBe(true);
        for (const linha of linhasDoLog) expect(linha).not.toContain(digitado);
      } finally {
        log.mockRestore();
      }
    });

    it("sem FRONTEND_URL não há link: nada é gravado e o link não liga", async () => {
      const { dona, meetingId } = await cenario();
      delete process.env.FRONTEND_URL;
      const erro = await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, autorizacao: AUTORIZACAO }), REQUISICAO));
      expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU });
      expect(await tokenDa(meetingId)).toBeNull();
      expect(await linhasDa(meetingId)).toEqual([]);
    });
  });

  // O "Tentar de novo" e a linha 'pendente': a recente está saindo e não volta
  // a sair; a presa (o envio cortado por um deploy) volta.
  describe("o Tentar de novo e a linha 'pendente'", () => {
    async function linhaPendente(dona: { openId: string }, meetingId: string, atrasMs: number) {
      const db = (await getDb())!;
      const id = crypto.randomUUID();
      const destinatario = `pendente-${sufixo()}@teste.invalid`;
      await db.insert(resumoPorEmail).values({
        id, meetingId, ownerId: dona.openId, loteId: crypto.randomUUID(), destinatario, origem: "digitado",
        idioma: "pt-BR", status: "pendente", automatico: false, tentativas: 0, createdAt: Date.now() - atrasMs, updatedAt: Date.now() - atrasMs,
      });
      return { id, destinatario };
    }

    it("a presa há mais de 5 minutos (o envio que não terminou) aparece no Tentar de novo e sai", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      const presa = await linhaPendente(dona, meetingId, 6 * 60_000);
      expect((await painelDoResumoPorEmail(dona.openId, meetingId)).podeMandarDeNovo).toBe(true);
      await expect(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO)).resolves.toEqual({ enviados: 1, falharam: 0 });
      expect(loteMandado().map(item => item.to)).toEqual([presa.destinatario]);
      expect((await linhasDa(meetingId)).find(l => l.id === presa.id)).toMatchObject({ status: "enviado", tentativas: 1 });
    });

    it("a de 1 minuto atrás ainda está saindo: o Tentar de novo não a manda de novo", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      await linhaPendente(dona, meetingId, 60_000);
      expect((await painelDoResumoPorEmail(dona.openId, meetingId)).podeMandarDeNovo).toBe(false);
      expect(await recusaDe(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO))).toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR });
      expect(dubles.lote).not.toHaveBeenCalled();
    });

    it("dois Tentar de novo ao mesmo tempo (duplo clique, duas abas): o e-mail sai uma vez só", async () => {
      const { dona, meetingId } = await cenario({ link: true });
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      await recusaDe(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true }), REQUISICAO));
      dubles.lote.mockClear();
      // A Resend demora: o segundo pedido chega com o primeiro ainda saindo.
      dubles.lote.mockImplementation(async lista => {
        await new Promise(pronto => setTimeout(pronto, 300));
        return lista.map(() => true);
      });
      const resultados = await Promise.allSettled([mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO), mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO)]);
      expect(dubles.lote).toHaveBeenCalledTimes(1);
      expect(resultados.filter(r => r.status === "fulfilled").map(r => (r as PromiseFulfilledResult<unknown>).value)).toEqual([{ enviados: 1, falharam: 0 }]);
      expect(resultados.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason)).toMatchObject([{ message: MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR }]);
    });
  });

  describe("o envio automático no fim da reunião", () => {
    it("desligado (o padrão): nada sai", async () => {
      const { dona, meetingId } = await cenario();
      await envioAutomaticoDoResumo(dona.openId, meetingId);
      expect(await linhasDa(meetingId)).toEqual([]);
      expect(dubles.lote).not.toHaveBeenCalled();
    });

    it("ligado: só para a dona, com o link da reunião na conta (não o aberto), uma vez só, e o link aberto continua desligado", async () => {
      const { dona, meetingId, email } = await cenario({ automatico: true, idioma: "es" });
      await envioAutomaticoDoResumo(dona.openId, meetingId);
      await envioAutomaticoDoResumo(dona.openId, meetingId);
      const linhas = await linhasDa(meetingId);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({ origem: "dona", automatico: true, destinatario: email, status: "enviado", idioma: "es" });
      expect(dubles.lote).toHaveBeenCalledTimes(1);
      const [item] = loteMandado();
      expect(item.to).toBe(email);
      expect(item.subject).toBe("El resumen de la reunión «Reunião com a Apex» está listo");
      expect(item.html).toContain(`https://wrw.teste/meetings/${meetingId}`);
      expect(item.html).not.toContain("/r/");
      expect(await tokenDa(meetingId)).toBeNull();
      const [prova] = await auditoriaDa(meetingId, ACAO_RESUMO_POR_EMAIL);
      expect(prova.details).toMatchObject({ automatico: true, quantidade: 1 });
    });

    it("o resumo refeito (versão 2), a conta desativada e a conta sem e-mail não mandam", async () => {
      const refeito = await cenario({ automatico: true, versao: 2 });
      const desativada = await cenario({ automatico: true, ativa: false });
      const semEmail = await cenario({ automatico: true, email: null });
      for (const c of [refeito, desativada, semEmail]) await envioAutomaticoDoResumo(c.dona.openId, c.meetingId);
      for (const c of [refeito, desativada, semEmail]) expect(await linhasDa(c.meetingId)).toEqual([]);
      expect(dubles.lote).not.toHaveBeenCalled();
    });

    it("a reunião que foi para a lixeira entre a fila e o envio (H7d): o automático não manda nada, e o painel e o envio dela são 'não encontrada'", async () => {
      const { dona, meetingId } = await cenario({ automatico: true });
      await (await getDb())!.update(meetings).set({ trashedAt: Date.now() }).where(eq(meetings.id, meetingId));
      await expect(envioAutomaticoDoResumo(dona.openId, meetingId)).resolves.toBeUndefined();
      expect(await linhasDa(meetingId)).toEqual([]);
      expect(dubles.lote).not.toHaveBeenCalled();
      await expect(painelDoResumoPorEmail(dona.openId, meetingId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      // O envio à mão pela dona também (a guarda do router pode ter passado antes de ela ir para a lixeira).
      await expect(mandarResumoPorEmail(dona, meetingId, pedido({ paraMim: true, autorizacao: AUTORIZACAO }), REQUISICAO)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await linhasDa(meetingId)).toEqual([]);
      expect(await tokenDa(meetingId)).toBeNull();
    });

    it("a Resend fora do ar no automático: não lança, e a linha fica para o Tentar de novo", async () => {
      const { dona, meetingId } = await cenario({ automatico: true });
      dubles.lote.mockImplementation(async lista => lista.map(() => false));
      await expect(envioAutomaticoDoResumo(dona.openId, meetingId)).resolves.toBeUndefined();
      expect((await linhasDa(meetingId)).map(l => l.status)).toEqual(["falhou"]);
      dubles.lote.mockImplementation(async lista => lista.map(() => true));
      // A linha automática não pede o link aberto: o Tentar de novo a manda com ele desligado.
      await expect(mandarResumoPorEmailDeNovo(dona, meetingId, REQUISICAO)).resolves.toEqual({ enviados: 1, falharam: 0 });
      expect(loteMandado(1)[0].html).toContain(`/meetings/${meetingId}`);
    });
  });
});
