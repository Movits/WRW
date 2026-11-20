import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { auditLogs, meetingTranscripts, meetings, users } from "../drizzle/schema";
import { appRouter } from "./routers";
import { ligarLinkAberto } from "./link-aberto-da-reuniao";
import { ENTRADA_LONGA_DA_PERGUNTA } from "./reuniao-com-ia";
import {
  PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA,
  PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA,
  tetoDaIADoLinkAberto,
  tetoDaIADoVisitanteDoLink,
} from "./routers/reuniaoAberta";

/**
 * A pergunta pelo link aberto (H6) de ponta a ponta contra um banco real DE
 * TESTE: a rota pública, o link, a leitura da transcrição e o teto, com só a
 * IA dublada. No CI é o MariaDB criado do zero por scripts/criar-banco.mjs; sem
 * DATABASE_URL_TESTES o teste se pula (server/test/setup-banco.ts troca a
 * DATABASE_URL por ela). Os testes do router (reuniao-aberta-rota.test.ts)
 * dublam o serviço; aqui se prova o acordo entre os dois: o serviço mede a
 * entrada ROTULADA que vai à IA e avisa a rota, que toma a segunda vaga.
 *
 * Dona e reunião com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-pergunta-link-${crypto.randomUUID()}`;
const LONGA = crypto.randomUUID();
const AGORA = Date.now();
// userId fora de qualquer conta real: a limpeza da auditoria de ligar o link vai por ele.
const PROVA = {
  userId: 2_000_000_000 + Math.floor(Math.random() * 100_000_000), ipAddress: "203.0.113.7", userAgent: "vitest-pergunta-link",
  idioma: "pt-BR", textoExibido: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram compartilhar.",
};
// Duas falas de 49.999 letras: o texto corrido tem 99.999 caracteres, abaixo do
// limite da reunião longa; com os rótulos ("{F1}: "), a entrada da IA passa dele.
const FALAS = [
  { inicio: 0, fim: 3000, falante: "F1", texto: `1${"a".repeat(49_998)}` },
  { inicio: 3000, fim: 6000, falante: "F2", texto: `2${"b".repeat(49_998)}` },
];
const TEXTO = FALAS.map(fala => fala.texto).join("\n");

const duble = vi.hoisted(() => ({ invokeLLM: vi.fn() }));
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => duble.invokeLLM(...args) }));

// O IP da visitante sai de req.ip fora do Render (server/ip-da-cliente.ts).
const visitante = (ip: string) => appRouter.createCaller({
  user: null, req: { headers: {}, ip, socket: {} }, res: { cookie: () => {}, clearCookie: () => {} },
} as never);

describe.skipIf(!temBanco)("A pergunta pelo link aberto, no banco (integração)", () => {
  let token = "";

  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId: DONA });
    await db.insert(meetings).values({
      id: LONGA, ownerId: DONA, title: "Reunião longa de teste", status: "ready",
      consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
    });
    await db.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: LONGA, ownerId: DONA, transcript: TEXTO, segments: FALAS,
      language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
    });
    token = await ligarLinkAberto(DONA, LONGA, PROVA);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, DONA));
    await db.delete(meetings).where(eq(meetings.ownerId, DONA));
    await db.delete(users).where(eq(users.openId, DONA));
    await db.delete(auditLogs).where(eq(auditLogs.userId, PROVA.userId));
  });

  it("a pergunta sobre reunião longa gasta duas vagas do teto da reunião, e longa é a entrada rotulada que vai à IA, não o texto corrido", async () => {
    expect(TEXTO.length).toBeLessThanOrEqual(ENTRADA_LONGA_DA_PERGUNTA);
    tetoDaIADoLinkAberto.esquecer();
    tetoDaIADoVisitanteDoLink.esquecer();
    vi.spyOn(console, "info").mockImplementation(() => {});
    duble.invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ respondida: false, resposta: "", citacoes: [] }) } }] });
    const perguntar = (ip: string) => visitante(ip).reuniaoAberta.perguntar({ token, idioma: "pt-BR", pergunta: "O que ficou combinado?" });

    // Visitantes diferentes, para o teto de cada uma não ser o que recusa.
    const longas = PEDIDOS_A_IA_POR_REUNIAO_POR_JANELA / 2;
    for (let i = 0; i < longas; i++) {
      await expect(perguntar(`203.0.113.${Math.floor(i / PEDIDOS_A_IA_POR_VISITANTE_POR_JANELA) + 1}`)).resolves.toEqual({ respondida: false });
    }
    await expect(perguntar("198.51.100.30")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(duble.invokeLLM).toHaveBeenCalledTimes(longas);
    // A chamada também é a da reunião longa, e a IA leu as falas rotuladas.
    const pedido = duble.invokeLLM.mock.calls[0][0] as { timeoutMs: number; messages: Array<{ content: string }> };
    expect(pedido.timeoutMs).toBe(80_000);
    expect(pedido.messages[1].content).toContain(`{F2}: 2${"b".repeat(20)}`);
  });
});
