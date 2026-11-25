import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { camposPreenchidosDoContato, getDb } from "./db";
import { acrescentarItemDaFicha, editarItemDaFicha } from "./possui-procura-da-ficha";
import { contactAssets, contactContexts, contactNeeds, privateContacts } from "../drizzle/schema";
import { apagarPelaChave } from "./test/apagar-pela-chave";
import { RECUSAS_DO_ITEM_DA_FICHA } from "@shared/possui-procura-da-ficha";

/**
 * T45 (24/11), contra o MariaDB de teste (DATABASE_URL_TESTES; pulado sem ele):
 *
 * - a dona acrescenta e corrige, na ficha do contato, o que ele possui e o que
 *   ele procura (antes a ficha só removia); o item de outra dona, ou o contato
 *   dela, sai como NOT_FOUND; o repetido e o texto sem letras saem como código;
 * - camposPreenchidosDoContato diz quais perguntas do Chat de Enriquecimento o
 *   contato já tem respondidas (o chat as pula), só do contato da dona.
 *
 * Duas donas fictícias com prefixo só desta execução; tudo é apagado no fim.
 */
const PREFIXO = `teste-ficha-${crypto.randomUUID()}`;
const DONA = `${PREFIXO}-dona`;
const OUTRA = `${PREFIXO}-outra`;
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);

let contato = 0;
let vazio = 0;

describe.skipIf(!temBanco)("Ficha do contato — acrescentar e corrigir o possui e o procura (T45)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    const agora = Date.now();
    await db.insert(privateContacts).values([
      { ownerId: DONA, fullName: "Contato Fictício Um", phone: "+55 11 90000-0000", company: "Empresa Fictícia", notes: "Relacionamento: profissional", createdAt: agora, updatedAt: agora },
      { ownerId: DONA, fullName: "Contato Fictício Dois", phone: "  ", createdAt: agora, updatedAt: agora },
    ] as never);
    const linhas = await db.select({ id: privateContacts.id, fullName: privateContacts.fullName }).from(privateContacts).where(eq(privateContacts.ownerId, DONA));
    contato = linhas.find(l => l.fullName === "Contato Fictício Um")!.id;
    vazio = linhas.find(l => l.fullName === "Contato Fictício Dois")!.id;
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    for (const dona of [DONA, OUTRA]) {
      await apagarPelaChave(db, contactAssets, eq(contactAssets.ownerId, dona));
      await apagarPelaChave(db, contactNeeds, eq(contactNeeds.ownerId, dona));
      await apagarPelaChave(db, privateContacts, eq(privateContacts.ownerId, dona));
    }
  });

  const itensDe = async (tabela: typeof contactAssets | typeof contactNeeds, contactId: number) => {
    const db = (await getDb())!;
    return db.select({ id: tabela.id, label: tabela.tagLabel, slug: tabela.tagSlug, ownerId: tabela.ownerId }).from(tabela)
      .where(and(eq(tabela.ownerId, DONA), eq(tabela.contactId, contactId)));
  };

  it("acrescenta ao possui e ao procura o texto da dona, limpo dos espaços, com o slug do cruzamento", async () => {
    const possui = await acrescentarItemDaFicha(DONA, contato, "possui", "  Exportação   de café ");
    const procura = await acrescentarItemDaFicha(DONA, contato, "procura", "Investidores para a fábrica");
    expect(possui.contactId).toBe(contato);
    expect(await itensDe(contactAssets, contato)).toEqual([expect.objectContaining({ id: possui.id, label: "Exportação de café", ownerId: DONA })]);
    expect(await itensDe(contactNeeds, contato)).toEqual([expect.objectContaining({ id: procura.id, label: "Investidores para a fábrica" })]);
    const [item] = await itensDe(contactAssets, contato);
    expect(item.slug.length).toBeGreaterThan(0);
  });

  it("o item repetido (o mesmo texto, com outras maiúsculas) é recusado com o código, e nada entra", async () => {
    await expect(acrescentarItemDaFicha(DONA, contato, "possui", "EXPORTAÇÃO DE CAFÉ"))
      .rejects.toMatchObject({ code: "CONFLICT", message: RECUSAS_DO_ITEM_DA_FICHA.repetido });
    expect(await itensDe(contactAssets, contato)).toHaveLength(1);
  });

  it("o texto sem letra nem número é recusado com o código", async () => {
    await expect(acrescentarItemDaFicha(DONA, contato, "procura", " — !!! "))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DO_ITEM_DA_FICHA.semTexto });
  });

  it("o contato de outra dona sai como NOT_FOUND, e nada é gravado nele", async () => {
    await expect(acrescentarItemDaFicha(OUTRA, contato, "possui", "Algo da outra")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const db = (await getDb())!;
    expect(await db.select({ id: contactAssets.id }).from(contactAssets).where(eq(contactAssets.ownerId, OUTRA))).toEqual([]);
  });

  it("corrige o texto do item, e o slug acompanha", async () => {
    const [antes] = await itensDe(contactNeeds, contato);
    await expect(editarItemDaFicha(DONA, antes.id, "procura", "Investidores para a vinícola")).resolves.toEqual({ id: antes.id, contactId: contato });
    const [depois] = await itensDe(contactNeeds, contato);
    expect(depois.label).toBe("Investidores para a vinícola");
    expect(depois.slug).not.toBe(antes.slug);
  });

  it("corrigir para o texto de outro item do mesmo contato é recusado; para o próprio texto, não", async () => {
    const outro = await acrescentarItemDaFicha(DONA, contato, "possui", "Armazém em Santos");
    await expect(editarItemDaFicha(DONA, outro.id, "possui", "Exportação de café"))
      .rejects.toMatchObject({ code: "CONFLICT", message: RECUSAS_DO_ITEM_DA_FICHA.repetido });
    await expect(editarItemDaFicha(DONA, outro.id, "possui", "Armazém em Santos")).resolves.toMatchObject({ id: outro.id });
  });

  it("o item de outra dona sai como NOT_FOUND, e não muda", async () => {
    const [item] = await itensDe(contactNeeds, contato);
    await expect(editarItemDaFicha(OUTRA, item.id, "procura", "Mudado pela outra")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await itensDe(contactNeeds, contato))[0].label).toBe("Investidores para a vinícola");
  });

  describe("camposPreenchidosDoContato: as perguntas do chat que a ficha já responde", () => {
    it("o telefone, a empresa, o possui, o procura e a anotação do relacionamento contam; o que falta, não", async () => {
      expect(new Set(await camposPreenchidosDoContato(DONA, contato))).toEqual(new Set(["phone", "company", "assets", "needs", "relationship_type"]));
    });

    it("o contato sem nada (o telefone só com espaços) não tem nada respondido", async () => {
      expect(await camposPreenchidosDoContato(DONA, vazio)).toEqual([]);
    });

    it("o contexto ligado ao contato responde 'como se conheceram'", async () => {
      const db = (await getDb())!;
      const agora = Date.now();
      await db.insert(contactContexts).values({ id: crypto.randomUUID(), ownerId: DONA, contactId: vazio, contextId: crypto.randomUUID(), createdAt: agora, updatedAt: agora } as never);
      try {
        expect(await camposPreenchidosDoContato(DONA, vazio)).toEqual(["how_met"]);
      } finally {
        await apagarPelaChave(db, contactContexts, and(eq(contactContexts.ownerId, DONA), inArray(contactContexts.contactId, [vazio])));
      }
    });

    it("o contato de outra dona não tem nada (nem revela o que tem)", async () => {
      expect(await camposPreenchidosDoContato(OUTRA, contato)).toEqual([]);
    });
  });
});
