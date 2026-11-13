import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O cache do proxy de arquivos (F12) — e a prova de que ele não afrouxou a
 * trava de acesso.
 *
 * O problema era de FATURA, não de velocidade: cada abertura de tela recebia
 * uma URL assinada NOVA (assinatura e data diferentes), e para o navegador URL
 * diferente é arquivo diferente — ele baixava os mesmos bytes do bucket outra
 * vez. Com o Backblaze na conta gratuita (1 GB de download por dia), reabrir
 * Minha Rede algumas vezes já consome a cota do dia.
 *
 * O conserto tem duas partes, e a ordem importa: reaproveitar a MESMA URL por
 * 50 minutos (sem isso o cache do navegador não reconhece nada) e responder
 * `private, max-age=300` no 307. O que este teste exige, além do ganho:
 *
 *   - sessão e posse continuam conferidas em TODA requisição, antes do cache;
 *   - `no-store` permanece no que é sensível (Deal Room, SIVC, reunião), e o
 *     cache nunca é `public`;
 *   - o cofre não cresce sem limite na memória do processo.
 */

// A sessão é decidida pelo teste: o proxy chama sdk.authenticateRequest, e é
// ele que separa 401 (sem sessão) de 403 (arquivo de outra dona).
let sessao: { id: number; openId: string; role: string | null } | null = null;
vi.mock("./_core/sdk", () => ({
  sdk: {
    async authenticateRequest() {
      if (!sessao) throw new Error("Não autenticado");
      return sessao;
    },
  },
}));

// Nenhum teste aqui usa Deal Room com sala real; exigirDb lançaria se fosse
// chamado, o que já é a resposta certa (500/503, nunca liberar).
vi.mock("./db", () => ({
  exigirDb: async () => {
    throw new Error("banco não deve ser consultado nestes casos");
  },
}));

const {
  registerStorageProxy,
  politicaDeCacheDaChave,
  criarCofreDeUrls,
  SEGUNDOS_DE_CACHE_NO_NAVEGADOR,
} = await import("./_core/storageProxy");

// ─── Política por prefixo ────────────────────────────────────────────────────

describe("política de cache por prefixo de chave", () => {
  it("imagem de lista (contato, contexto, gerada): reaproveita a URL e deixa o navegador guardar 5 min", () => {
    for (const chave of [
      "contacts/email_dona/foto_ab12cd34.jpg",
      "contexts/email_dona/ctx-1/quadro_ab12cd34.webp",
      "generated/1700000000.png",
    ]) {
      expect(politicaDeCacheDaChave(chave)).toEqual({
        reaproveitarUrl: true,
        cacheControl: `private, max-age=${SEGUNDOS_DE_CACHE_NO_NAVEGADOR}`,
      });
    }
  });

  it("NDA da Deal Room, documento do SIVC e áudio de reunião seguem com no-store e URL nova", () => {
    for (const chave of [
      "deal-rooms/77/1700000000-contrato.pdf",
      "sivc/30/ver-1/1700000000-rg.png",
      "meetings/email_dona/m-1/recording.webm",
    ]) {
      expect(politicaDeCacheDaChave(chave)).toEqual({ reaproveitarUrl: false, cacheControl: "no-store" });
    }
  });

  it("nunca 'public': cache compartilhado não pode guardar arquivo de usuária", () => {
    for (const chave of ["contacts/x/foto.jpg", "contexts/x/y/z.webp", "generated/1.png", "deal-rooms/1/a.pdf", "qualquer/coisa"]) {
      expect(politicaDeCacheDaChave(chave).cacheControl).not.toMatch(/public/);
    }
  });

  it("prefixo desconhecido não ganha cache — e a posse já o nega antes disso", () => {
    expect(politicaDeCacheDaChave("outra-coisa/arquivo.pdf").reaproveitarUrl).toBe(false);
    expect(politicaDeCacheDaChave("").reaproveitarUrl).toBe(false);
  });
});

// ─── O cofre de URLs ─────────────────────────────────────────────────────────

const comCache = { reaproveitarUrl: true, cacheControl: "private, max-age=300" };
const semCache = { reaproveitarUrl: false, cacheControl: "no-store" };

describe("cofre de URLs assinadas", () => {
  it("dentro da janela devolve a MESMA URL e assina uma vez só — é isso que evita o download novo", async () => {
    let n = 0;
    const assinar = vi.fn(async (chave: string) => `https://bucket/${chave}?assinatura=${++n}`);
    const cofre = criarCofreDeUrls(assinar, () => 1_000_000);

    const a = await cofre.obter("contacts/x/foto.jpg", comCache);
    const b = await cofre.obter("contacts/x/foto.jpg", comCache);

    expect(a).toBe(b);
    expect(assinar).toHaveBeenCalledTimes(1);
  });

  it("chaves diferentes não se misturam", async () => {
    const assinar = vi.fn(async (chave: string) => `https://bucket/${chave}?a=1`);
    const cofre = criarCofreDeUrls(assinar, () => 1_000_000);

    const a = await cofre.obter("contacts/x/foto.jpg", comCache);
    const b = await cofre.obter("contacts/x/cartao.jpg", comCache);

    expect(a).not.toBe(b);
    expect(assinar).toHaveBeenCalledTimes(2);
  });

  it("passados os 50 minutos, assina de novo — a assinatura do bucket vale 60, e entregar uma quase vencida travaria o download", async () => {
    let n = 0;
    const assinar = vi.fn(async () => `https://bucket/foto.jpg?assinatura=${++n}`);
    let agora = 0;
    const cofre = criarCofreDeUrls(assinar, () => agora, 50 * 60 * 1000);

    const primeira = await cofre.obter("contacts/x/foto.jpg", comCache);
    agora = 49 * 60 * 1000;
    expect(await cofre.obter("contacts/x/foto.jpg", comCache)).toBe(primeira);

    agora = 50 * 60 * 1000 + 1;
    const segunda = await cofre.obter("contacts/x/foto.jpg", comCache);
    expect(segunda).not.toBe(primeira);
    expect(assinar).toHaveBeenCalledTimes(2);
  });

  it("prefixo sem cache assina toda vez e não ocupa o cofre", async () => {
    let n = 0;
    const assinar = vi.fn(async () => `https://bucket/recording.webm?assinatura=${++n}`);
    const cofre = criarCofreDeUrls(assinar, () => 1_000_000);

    const a = await cofre.obter("meetings/x/m-1/recording.webm", semCache);
    const b = await cofre.obter("meetings/x/m-1/recording.webm", semCache);

    expect(a).not.toBe(b);
    expect(cofre.tamanho()).toBe(0);
  });

  it("não cresce sem limite: chegando ao teto, sai a entrada mais antiga", async () => {
    const assinar = vi.fn(async (chave: string) => `https://bucket/${chave}`);
    const cofre = criarCofreDeUrls(assinar, () => 1_000_000, 50 * 60 * 1000, 3);

    for (const chave of ["contacts/a.jpg", "contacts/b.jpg", "contacts/c.jpg", "contacts/d.jpg"]) {
      await cofre.obter(chave, comCache);
    }
    expect(cofre.tamanho()).toBe(3);

    // A mais antiga saiu, então ela é assinada de novo (5 assinaturas em 4 chaves).
    await cofre.obter("contacts/a.jpg", comCache);
    expect(assinar).toHaveBeenCalledTimes(5);
    // E a mais nova continua guardada.
    await cofre.obter("contacts/d.jpg", comCache);
    expect(assinar).toHaveBeenCalledTimes(5);
  });
});

// ─── A rota, de ponta a ponta ────────────────────────────────────────────────

let servidor: Server;
let base = "";
let assinaturas = 0;

const app = express();
registerStorageProxy(
  app,
  criarCofreDeUrls(async chave => `https://bucket.exemplo/${chave}?assinatura=${++assinaturas}`),
);
servidor = createServer(app);
await new Promise<void>(pronto => servidor.listen(0, "127.0.0.1", pronto));
base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

afterAll(() => {
  servidor.close();
});

beforeEach(() => {
  sessao = null;
});

const pedir = (caminho: string) => fetch(`${base}${caminho}`, { redirect: "manual" });

describe("rota /manus-storage — o cache não afrouxou a trava", () => {
  it("SEM sessão: 401, e nem chega a assinar", async () => {
    const antes = assinaturas;
    const r = await pedir("/manus-storage/contacts/email_dona/foto_ab12cd34.jpg");

    expect(r.status).toBe(401);
    expect(assinaturas).toBe(antes);
  });

  it("arquivo de OUTRA dona: 403, mesmo com o arquivo já no cofre", async () => {
    const chave = "contacts/email_dona/foto_403.jpg";

    sessao = { id: 30, openId: "email_dona", role: "silver" };
    expect((await pedir(`/manus-storage/${chave}`)).status).toBe(307);

    // Agora a chave está guardada. Uma estranha continua levando 403: a posse é
    // conferida ANTES de o cofre ser consultado.
    sessao = { id: 10, openId: "email_bronze", role: "bronze" };
    const r = await pedir(`/manus-storage/${chave}`);
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
  });

  it("a dona abrindo a tela duas vezes recebe a MESMA URL, com private e max-age", async () => {
    sessao = { id: 30, openId: "email_dona", role: "silver" };
    const chave = "contacts/email_dona/foto_igual.jpg";

    const primeira = await pedir(`/manus-storage/${chave}`);
    const segunda = await pedir(`/manus-storage/${chave}`);

    expect(primeira.status).toBe(307);
    expect(segunda.headers.get("location")).toBe(primeira.headers.get("location"));
    expect(primeira.headers.get("cache-control")).toBe(`private, max-age=${SEGUNDOS_DE_CACHE_NO_NAVEGADOR}`);
    expect(primeira.headers.get("cache-control")).not.toMatch(/public/);
  });

  it("áudio de reunião: no-store e URL nova a cada pedido", async () => {
    sessao = { id: 30, openId: "email_dona", role: "silver" };
    const chave = "meetings/email_dona/m-1/recording.webm";

    const primeira = await pedir(`/manus-storage/${chave}`);
    const segunda = await pedir(`/manus-storage/${chave}`);

    expect(primeira.headers.get("cache-control")).toBe("no-store");
    expect(segunda.headers.get("location")).not.toBe(primeira.headers.get("location"));
  });

  it("chave vazia: 400", async () => {
    sessao = { id: 30, openId: "email_dona", role: "silver" };
    expect((await pedir("/manus-storage/")).status).toBe(400);
  });
});
