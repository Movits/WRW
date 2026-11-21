import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { meetings } from "../../drizzle/schema";
import { apagarPelaChave } from "./apagar-pela-chave";
import { terminaComALinhaPresa } from "./linha-presa";

/**
 * A limpeza dos testes de integração (server/test/apagar-pela-chave.ts) contra
 * o banco real DE TESTE; sem DATABASE_URL_TESTES, se pula. O que se prova é a
 * trava: apagar pela chave não espera pela linha que outro arquivo acabou de
 * inserir, nem quando a condição obriga a varrer a tabela (o DELETE pela
 * condição esperaria, e é dessa espera que vinha o deadlock do link aberto).
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-limpeza-${crypto.randomUUID()}`;
const VIZINHA = `teste-limpeza-${crypto.randomUUID()}`;
const AGORA = Date.now();

const reuniao = (ownerId: string, title: string) => ({
  id: crypto.randomUUID(), ownerId, title, status: "ready" as const, consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
});
const reunioesDe = async (ownerId: string) => (await getDb())!.select({ id: meetings.id }).from(meetings).where(eq(meetings.ownerId, ownerId));

describe.skipIf(!temBanco)("Limpeza dos testes de integração pela chave (integração)", () => {
  it("apaga só as linhas da condição e devolve quantas foram", async () => {
    const banco = (await getDb())!;
    await banco.insert(meetings).values([reuniao(DONA, "Limpeza A"), reuniao(DONA, "Limpeza B"), reuniao(VIZINHA, "Limpeza C")]);
    try {
      expect(await apagarPelaChave(banco, meetings, eq(meetings.ownerId, DONA))).toBe(2);
      expect(await reunioesDe(DONA)).toEqual([]);
      expect(await reunioesDe(VIZINHA)).toHaveLength(1);
      expect(await apagarPelaChave(banco, meetings, eq(meetings.ownerId, DONA))).toBe(0);
    } finally {
      await banco.delete(meetings).where(inArray(meetings.ownerId, [DONA, VIZINHA]));
    }
  });

  it("não espera pela linha que outra transação acabou de inserir, nem com a condição que varre a tabela inteira", async () => {
    const banco = (await getDb())!;
    // O título não tem índice: a condição só se resolve varrendo `meetings`,
    // como fazia o DELETE da limpeza de fatias-de-reuniao no deadlock.
    const titulo = `Limpeza ${crypto.randomUUID()}`;
    await banco.insert(meetings).values([reuniao(DONA, titulo), reuniao(DONA, titulo)]);
    try {
      const terminou = await terminaComALinhaPresa(
        banco,
        tx => tx.insert(meetings).values(reuniao(VIZINHA, "Reunião ainda sem commit")),
        () => apagarPelaChave(banco, meetings, eq(meetings.title, titulo)),
      );
      expect(terminou).toBe(true);
      expect(await reunioesDe(DONA)).toEqual([]);
      // A linha da outra transação foi desfeita, e nada dela ficou.
      expect(await reunioesDe(VIZINHA)).toEqual([]);
    } finally {
      await banco.delete(meetings).where(inArray(meetings.ownerId, [DONA, VIZINHA]));
    }
  });
});
