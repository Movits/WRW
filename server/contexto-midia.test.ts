import { describe, expect, it, vi, beforeEach } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Fotos e documentos de contexto (etapa 5) — o mesmo caminho da gravação de
 * reunião: base64 validado no servidor, storage S3 com a dona na chave, e o
 * registro no banco apontando para a URL servida pelo storageProxy.
 *
 * Estes testes exercitam o router de verdade (createCaller), com banco e
 * storage simulados — o que se trava aqui é o contrato: validação antes do
 * storage, posse antes de tudo, e remoção que não fica refém do bucket.
 */

const storagePut = vi.fn(async (key: string) => ({
  key: `${key}_ab12cd34`,
  url: `/manus-storage/${key}_ab12cd34`,
}));
const storageDelete = vi.fn(async () => {});

vi.mock("./storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("./storage")>();
  return {
    ...real,
    storagePut: (...args: unknown[]) => storagePut(...(args as [string])),
    storageDelete: (...args: unknown[]) => storageDelete(...(args as [])),
    storageGet: vi.fn(),
    storageGetSignedUrl: vi.fn(),
  };
});

const contextIsVisible = vi.fn(async () => true);
const addContextMedia = vi.fn(async () => "midia-1");
const getContextMediaById = vi.fn(async () => ({
  id: "midia-1", ownerId: "email_teste",
  storagePath: "/manus-storage/contexts/email_teste/ctx-1/foto_ab12cd34.jpg",
}));
const deleteContextMedia = vi.fn(async () => true);
const listContextMediaByContext = vi.fn(async () => [] as Array<{ id: string; storagePath: string }>);
const deleteContext = vi.fn(async () => true);

// Sem banco: getDb devolve null e exigirDb lança, como o db.ts real faz sem
// DATABASE_URL. Um caminho não coberto aqui que fosse ao banco falha alto, e
// não com "export não definido no mock".
vi.mock("./db", async () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new (await import("./banco-indisponivel")).BancoIndisponivel(); },
  listContextTypes: vi.fn(async () => []),
  listContexts: vi.fn(async () => ({ data: [], total: 0 })),
  createContext: vi.fn(),
  getContextById: vi.fn(async () => null),
  updateContext: vi.fn(),
  deleteContext: (...args: unknown[]) => deleteContext(...(args as [])),
  linkContactToContext: vi.fn(),
  unlinkContactFromContext: vi.fn(),
  addContextParticipant: vi.fn(),
  listContextsByContact: vi.fn(async () => []),
  getPrivateContactById: vi.fn(async () => null),
  contextIsVisible: (...args: unknown[]) => contextIsVisible(...(args as [])),
  addContextMedia: (...args: unknown[]) => addContextMedia(...(args as [])),
  getContextMediaById: (...args: unknown[]) => getContextMediaById(...(args as [])),
  deleteContextMedia: (...args: unknown[]) => deleteContextMedia(...(args as [])),
  listContextMediaByContext: (...args: unknown[]) => listContextMediaByContext(...(args as [])),
}));

const { contextsRouter } = await import("./routers/contexts");
const { decodeContextMedia, MAX_CONTEXT_MEDIA_BYTES } = await import("./context-media");
const { CACHE_DE_ARQUIVO_PRIVADO } = await import("./storage");

const ctx = {
  user: { id: 1, openId: "email_teste", email: "t@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never;

const caller = contextsRouter.createCaller(ctx);
const umPng = Buffer.from("conteudo-de-teste").toString("base64");

describe("Mídia de contexto — upload e remoção pelo caminho do storage", () => {
  beforeEach(() => {
    storagePut.mockClear(); storageDelete.mockClear();
    contextIsVisible.mockClear(); addContextMedia.mockClear();
    getContextMediaById.mockClear(); deleteContextMedia.mockClear();
    contextIsVisible.mockResolvedValue(true);
    deleteContextMedia.mockResolvedValue(true);
  });

  it("anexo válido vai para contexts/{dona}/{contexto}/ e o registro guarda a URL servida", async () => {
    const r = await caller.uploadMedia({
      contextId: "ctx-1", fileName: "Foto da Feira.png",
      mimeType: "image/png", dataBase64: `data:image/png;base64,${umPng}`,
    });

    expect(storagePut).toHaveBeenCalledTimes(1);
    const [chave, dados, mime, opcoes] = storagePut.mock.calls[0] as unknown as [string, Buffer, string, unknown];
    expect(chave).toBe("contexts/email_teste/ctx-1/Foto-da-Feira.png");
    expect(Buffer.isBuffer(dados)).toBe(true);
    expect(mime).toBe("image/png");
    // Imagem leva o cache gravado no objeto (#149), o par do 307 do proxy.
    expect(opcoes).toEqual({ cacheControl: CACHE_DE_ARQUIVO_PRIVADO });

    const registro = addContextMedia.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(registro[0]).toBe("email_teste");
    expect(registro[1].storagePath).toBe("/manus-storage/contexts/email_teste/ctx-1/Foto-da-Feira.png_ab12cd34");
    expect(registro[1].originalName).toBe("Foto da Feira.png");
    expect(r.id).toBe("midia-1");
  });

  it("PDF sobe SEM cache no objeto: não aparece em lista, e o proxy também o serve com no-store", async () => {
    await caller.uploadMedia({
      contextId: "ctx-1", fileName: "Proposta.pdf",
      mimeType: "application/pdf", dataBase64: `data:application/pdf;base64,${umPng}`,
    });

    const [chave, , mime, opcoes] = storagePut.mock.calls[0] as unknown as [string, Buffer, string, unknown];
    expect(chave).toBe("contexts/email_teste/ctx-1/Proposta.pdf");
    expect(mime).toBe("application/pdf");
    expect(opcoes).toEqual({});
  });

  it("contexto invisível para a dona: nega antes de tocar o storage", async () => {
    contextIsVisible.mockResolvedValue(false);
    await expect(caller.uploadMedia({
      contextId: "ctx-da-outra", fileName: "foto.png",
      mimeType: "image/png", dataBase64: umPng,
    })).rejects.toThrow("NOT_FOUND");
    expect(storagePut).not.toHaveBeenCalled();
  });

  it("formato fora da lista é recusado na entrada", async () => {
    await expect(caller.uploadMedia({
      contextId: "ctx-1", fileName: "virus.exe",
      mimeType: "application/x-msdownload" as never, dataBase64: umPng,
    })).rejects.toThrow();
    expect(storagePut).not.toHaveBeenCalled();
  });

  it("remover apaga o registro e pede a exclusão no bucket com a chave crua", async () => {
    const r = await caller.deleteMedia({ mediaId: "midia-1" });

    expect(r.success).toBe(true);
    expect(storageDelete).toHaveBeenCalledWith("contexts/email_teste/ctx-1/foto_ab12cd34.jpg");
    expect(deleteContextMedia).toHaveBeenCalled();
  });

  it("bucket fora do ar não impede a remoção do registro", async () => {
    storageDelete.mockRejectedValueOnce(new Error("Storage não configurado"));
    const r = await caller.deleteMedia({ mediaId: "midia-1" });

    expect(r.success).toBe(true);
    expect(deleteContextMedia).toHaveBeenCalled();
  });

  it("mídia de outra dona não aparece nem para apagar", async () => {
    getContextMediaById.mockResolvedValueOnce(null as never);
    await expect(caller.deleteMedia({ mediaId: "midia-alheia" })).rejects.toThrow("NOT_FOUND");
    expect(storageDelete).not.toHaveBeenCalled();
  });

  it("storagePath fora do espaço da dona não vira delete no bucket — só o registro sai", async () => {
    // Defesa em profundidade: dado legado/corrompido apontando para outro
    // prefixo não pode apagar objeto alheio.
    getContextMediaById.mockResolvedValueOnce({
      id: "midia-1", ownerId: "email_teste",
      storagePath: "meetings/outra-dona/m-1/recording.webm",
    } as never);
    const r = await caller.deleteMedia({ mediaId: "midia-1" });

    expect(r.success).toBe(true);
    expect(storageDelete).not.toHaveBeenCalled();
    expect(deleteContextMedia).toHaveBeenCalled();
  });

  it("excluir o contexto leva os anexos junto: objetos no bucket e registros — o banco confirma a posse ANTES do bucket", async () => {
    deleteContext.mockClear();
    listContextMediaByContext.mockResolvedValueOnce([
      { id: "m-1", storagePath: "/manus-storage/contexts/email_teste/ctx-1/foto_a1.jpg" },
      { id: "m-2", storagePath: "meetings/outra-dona/m-1/recording.webm" }, // fora do espaço: fica
    ]);
    const r = await caller.delete({ id: "ctx-1" });

    expect(r.success).toBe(true);
    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith("contexts/email_teste/ctx-1/foto_a1.jpg");
    expect(deleteContext).toHaveBeenCalledWith("email_teste", "ctx-1");
    // ordem: se o DELETE no banco falhar, o bucket ainda está intacto
    expect(deleteContext.mock.invocationCallOrder[0]).toBeLessThan(storageDelete.mock.invocationCallOrder[0]);
  });

  it("contexto que não é dela (catálogo ou inexistente): NOT_FOUND e o bucket NÃO é tocado", async () => {
    // Reverificação de 04/09 (etapa 5): a dona pode anexar mídia a um contexto
    // do catálogo (uploadMedia aceita owner_id NULL); excluir esse id apagava
    // os objetos dela no bucket e só depois respondia NOT_FOUND.
    listContextMediaByContext.mockResolvedValueOnce([
      { id: "m-1", storagePath: "/manus-storage/contexts/email_teste/ctx-catalogo/foto_a1.jpg" },
      { id: "m-2", storagePath: "/manus-storage/contexts/email_teste/ctx-catalogo/nda_b2.pdf" },
    ]);
    deleteContext.mockResolvedValueOnce(false);

    await expect(caller.delete({ id: "ctx-catalogo" })).rejects.toThrow("NOT_FOUND");

    expect(storageDelete).not.toHaveBeenCalled();
  });
});

describe("decodeContextMedia — a validação que roda antes do storage", () => {
  it("tira o cabeçalho data: e devolve os bytes", () => {
    const dados = decodeContextMedia(`data:application/pdf;base64,${umPng}`, "application/pdf");
    expect(dados.toString()).toBe("conteudo-de-teste");
  });

  it("recusa arquivo acima de 10 MB", () => {
    const grande = Buffer.alloc(MAX_CONTEXT_MEDIA_BYTES + 1).toString("base64");
    expect(() => decodeContextMedia(grande, "image/jpeg")).toThrow(/10 MB/);
  });

  it("recusa base64 corrompido e conteúdo vazio", () => {
    expect(() => decodeContextMedia("%%%não-é-base64%%%", "image/png")).toThrow(/inválido/i);
    expect(() => decodeContextMedia("", "image/png")).toThrow(/inválido/i);
  });
});
