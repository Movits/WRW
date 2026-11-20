import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { meetings, users } from "../drizzle/schema";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

/**
 * A reunião nasce com o idioma falado (G1b) e a versão do aviso de gravação
 * que a tela mostrou (G4), contra um banco real DE TESTE: sem
 * DATABASE_URL_TESTES o teste se pula (server/test/setup-banco.ts troca a
 * DATABASE_URL por ela). Dona com id aleatório: a limpeza só alcança o que
 * este arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-idioma-${crypto.randomUUID()}`;

function contexto(): TrpcContext {
  return {
    user: { id: 2_000_000_000 + Math.floor(Math.random() * 100_000_000), openId: DONA, role: "user", name: "Dona Teste" },
    req: { headers: {}, ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}

async function criada(id: string) {
  const db = (await getDb())!;
  const [linha] = await db.select({ language: meetings.language, versao: meetings.consentNoticeVersion }).from(meetings).where(eq(meetings.id, id));
  return linha;
}

describe.skipIf(!temBanco)("Idioma da reunião e versão do aviso (integração)", () => {
  const caller = () => appRouter.createCaller(contexto());

  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values({ openId: DONA });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await apagarPelaChave(db, meetings, eq(meetings.ownerId, DONA));
    await db.delete(users).where(eq(users.openId, DONA));
  });

  it("grava o idioma normalizado e a versão do aviso que veio", async () => {
    const { id } = await caller().meetings.create({ title: "Reunião em inglês", consentGranted: true, language: "en-US", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
    expect(await criada(id)).toEqual({ language: "en", versao: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
  });

  it("a aba antiga ('pt', sem versão) segue gravando: vira pt-BR e a versão fica nula", async () => {
    const { id } = await caller().meetings.create({ title: "Reunião da aba antiga", consentGranted: true, language: "pt" });
    expect(await criada(id)).toEqual({ language: "pt-BR", versao: null });
    const semIdioma = await caller().meetings.create({ title: "Reunião sem idioma", consentGranted: true });
    expect((await criada(semIdioma.id)).language).toBe("pt-BR");
  });

  it("idioma fora dos 10 e versão de aviso desconhecida são recusados, sem gravar nada", async () => {
    const db = (await getDb())!;
    const antes = (await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.ownerId, DONA))).length;
    for (const entrada of [
      { title: "Reunião em italiano", consentGranted: true as const, language: "it" },
      { title: "Reunião com aviso inventado", consentGranted: true as const, consentNoticeVersion: "2099-01-01" as never },
    ]) {
      const erro = await caller().meetings.create(entrada).then(() => null, e => e);
      expect(erro).toBeInstanceOf(TRPCError);
      expect((erro as TRPCError).code).toBe("BAD_REQUEST");
    }
    expect((await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.ownerId, DONA))).length).toBe(antes);
  });
});
