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
  MS_DE_REUSO_DA_URL,
  MS_DE_FOLGA_ANTES_DE_VENCER,
  TETO_DE_URLS_GUARDADAS,
} = await import("./_core/storageProxy");
const { SEGUNDOS_DA_URL_ASSINADA, CACHE_DE_ARQUIVO_PRIVADO } = await import("./storage");
// O exame de produção é .mjs sem declaração de tipos (ver exame-de-producao.test.ts).
// @ts-expect-error módulo .mjs sem tipos
const { CACHE_DO_307_DE_IMAGEM_DA_DONA } = await import("../scripts/exame/relatorio.mjs");

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

  it("PDF anexado ao contexto NÃO ganha cache: não aparece em lista, e o preço do max-age seria só custo", () => {
    for (const chave of ["contexts/x/ctx-1/doc_ab12cd34.pdf", "contexts/x/ctx-1/proposta_ab12cd34.PDF", "contexts/x/ctx-1/sem-extensao"]) {
      expect(politicaDeCacheDaChave(chave), chave).toEqual({ reaproveitarUrl: false, cacheControl: "no-store" });
    }
  });

  it("imagem de contexto ganha cache em qualquer das extensões que o upload grava, maiúscula ou não", () => {
    for (const chave of ["contexts/x/ctx-1/a_ab12cd34.jpg", "contexts/x/ctx-1/b_ab12cd34.JPEG", "contexts/x/ctx-1/c_ab12cd34.png", "contexts/x/ctx-1/d_ab12cd34.webp"]) {
      expect(politicaDeCacheDaChave(chave).reaproveitarUrl, chave).toBe(true);
    }
  });

  it("o exame de produção exige exatamente o cabeçalho que o proxy grava para a imagem dele", () => {
    // O exame sobe exame.png por contexts.uploadMedia; a chave sai assim.
    expect(politicaDeCacheDaChave("contexts/qa_exame_p/ctx-1/exame_ab12cd34.png").cacheControl).toBe(CACHE_DO_307_DE_IMAGEM_DA_DONA);
  });
});

describe("a janela do cofre sai do prazo da assinatura", () => {
  it("a URL guardada, mais o cache do 307, mais a folga, cabem no prazo da assinatura", () => {
    expect(MS_DE_REUSO_DA_URL).toBeGreaterThan(0);
    expect(MS_DE_REUSO_DA_URL + SEGUNDOS_DE_CACHE_NO_NAVEGADOR * 1000 + MS_DE_FOLGA_ANTES_DE_VENCER)
      .toBeLessThanOrEqual(SEGUNDOS_DA_URL_ASSINADA * 1000);
    // Com a assinatura de 1 hora, a janela é a de sempre: 50 minutos.
    expect(MS_DE_REUSO_DA_URL).toBe(50 * 60 * 1000);
  });

  it("o cache gravado no objeto casa com a janela do cofre, e é privado", () => {
    expect(CACHE_DE_ARQUIVO_PRIVADO).toBe(`private, max-age=${MS_DE_REUSO_DA_URL / 1000}`);
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

  it("quem sai pelo teto é a MENOS USADA: a foto aberta de novo não perde a URL", async () => {
    const assinar = vi.fn(async (chave: string) => `https://bucket/${chave}`);
    const cofre = criarCofreDeUrls(assinar, () => 1_000_000, 50 * 60 * 1000, 3);

    for (const chave of ["contacts/a.jpg", "contacts/b.jpg", "contacts/c.jpg"]) await cofre.obter(chave, comCache);
    await cofre.obter("contacts/a.jpg", comCache); // acerto: a passa a ser a mais recente
    await cofre.obter("contacts/d.jpg", comCache); // teto: sai b, não a
    expect(assinar).toHaveBeenCalledTimes(4);

    await cofre.obter("contacts/a.jpg", comCache);
    expect(assinar).toHaveBeenCalledTimes(4);
    await cofre.obter("contacts/b.jpg", comCache);
    expect(assinar).toHaveBeenCalledTimes(5);
  });

  it("o teto padrão aguenta um dia de evento (30 usuárias, 20 fotos cada) sem expulsar URL em uso", async () => {
    const assinar = vi.fn(async (chave: string) => `https://bucket/${chave}`);
    const cofre = criarCofreDeUrls(assinar, () => 1_000_000);
    expect(TETO_DE_URLS_GUARDADAS).toBeGreaterThanOrEqual(600);

    for (let i = 0; i < 600; i++) await cofre.obter(`contacts/dona-${i % 30}/foto-${i}.jpg`, comCache);
    await cofre.obter("contacts/dona-0/foto-0.jpg", comCache);
    expect(assinar).toHaveBeenCalledTimes(600);
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
