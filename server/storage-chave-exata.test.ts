import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storagePut, CACHE_DE_ARQUIVO_PRIVADO } from "./storage";

/**
 * storagePut com a chave EXATA (G5): a parte da reunião gravada em partes grava
 * a linha que aponta para o objeto ANTES do upload, então o objeto tem de subir
 * na chave que a linha guardou. Os chamadores de sempre seguem com o sufixo
 * aleatório. Sem bucket real: STORAGE_* falsas e o `send` do S3 dublado.
 */
const VARIAVEIS = ["STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY", "STORAGE_ENDPOINT", "STORAGE_REGION"] as const;
const guardadas: Partial<Record<(typeof VARIAVEIS)[number], string | undefined>> = {};
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const nome of VARIAVEIS) guardadas[nome] = process.env[nome];
  process.env.STORAGE_BUCKET = "bucket-de-teste";
  process.env.STORAGE_ACCESS_KEY_ID = "id-de-teste";
  process.env.STORAGE_SECRET_ACCESS_KEY = "segredo-de-teste";
  process.env.STORAGE_ENDPOINT = "https://s3.exemplo.invalid";
  delete process.env.STORAGE_REGION;
  send = vi.fn(async () => ({}));
  vi.spyOn(S3Client.prototype, "send").mockImplementation(((...args: unknown[]) => send(...args)) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const nome of VARIAVEIS) {
    if (guardadas[nome] === undefined) delete process.env[nome];
    else process.env[nome] = guardadas[nome];
  }
});

const chaveEnviada = () => (send.mock.calls[0][0] as { input: { Key: string } }).input.Key;
const comandoEnviado = () => (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;

describe("storagePut — chave exata só quando pedida", () => {
  it("com chaveExata, o objeto sobe na chave pedida (sem sufixo) e a URL é a do proxy", async () => {
    const r = await storagePut("/meetings/dona/m-1/partes/0003-abcd1234.m4a", Buffer.from("a"), "audio/mp4", { chaveExata: true });
    expect(chaveEnviada()).toBe("meetings/dona/m-1/partes/0003-abcd1234.m4a");
    expect(r).toEqual({ key: "meetings/dona/m-1/partes/0003-abcd1234.m4a", url: "/manus-storage/meetings/dona/m-1/partes/0003-abcd1234.m4a" });
  });

  it("sem a opção, como sempre: sufixo aleatório antes da extensão, e dois envios não colidem", async () => {
    const a = await storagePut("meetings/dona/m-1/recording.m4a", Buffer.from("a"), "audio/mp4");
    const b = await storagePut("meetings/dona/m-1/recording.m4a", Buffer.from("a"), "audio/mp4");
    expect(a.key).toMatch(/^meetings\/dona\/m-1\/recording_[0-9a-f]{8}\.m4a$/);
    expect(a.key).not.toBe(b.key);
  });
});

/**
 * O Cache-Control gravado NO OBJETO (#149): é a metade do cache que viaja com os
 * bytes. Sem trava, ele some numa resolução de conflito do storagePut (a #149
 * resolveu um justamente aqui) ou vira `public` sem nenhum teste ver — e um
 * cache compartilhado passaria a guardar o cartão de visita, com telefone e
 * e-mail do contato.
 */
describe("storagePut — Cache-Control no objeto só quando pedido", () => {
  it("com cacheControl, o PutObjectCommand leva o cabeçalho exato", async () => {
    await storagePut("contacts/dona/foto.webp", Buffer.from("a"), "image/webp", { cacheControl: CACHE_DE_ARQUIVO_PRIVADO });
    expect(comandoEnviado().CacheControl).toBe("private, max-age=3000");
    expect(comandoEnviado().ContentType).toBe("image/webp");
  });

  it("sem a opção, o objeto sobe sem Cache-Control (áudio, documentos, partes)", async () => {
    await storagePut("meetings/dona/m-1/recording.m4a", Buffer.from("a"), "audio/mp4");
    expect(comandoEnviado()).not.toHaveProperty("CacheControl");
  });

  it("o cabeçalho dos arquivos de usuária é privado: nunca public", () => {
    expect(CACHE_DE_ARQUIVO_PRIVADO).toMatch(/^private,/);
    expect(CACHE_DE_ARQUIVO_PRIVADO).not.toMatch(/public/);
  });
});
