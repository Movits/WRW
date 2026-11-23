import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Os anexos do resumo (H4g e H4h, server/anexos-do-resumo.ts), sem banco: a
 * conferência da imagem pelo conteúdo, a retirada dos metadados (o GPS da foto
 * do celular não pode sair pelo link aberto) e a rota da imagem do link. O
 * caminho no banco está em anexos-do-resumo.integracao.test.ts.
 */

const { formatoDoConteudo, prepararImagemDoAnexo, registrarRotaDoAnexoDoLink, tirarMetadados } = await import("./anexos-do-resumo");
const { cookiesDoPedido } = await import("./senha-do-link-aberto");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { MENSAGEM_BANCO_INDISPONIVEL } = await import("@shared/const");
const { ANEXO_BYTES_MAX, RECUSAS_DOS_ANEXOS } = await import("@shared/anexos-do-resumo");

// ── Imagens sintéticas, montadas byte a byte (nenhuma foto de verdade). ──
const segmento = (marcador: number, corpo: Buffer) => {
  const cabecalho = Buffer.alloc(4);
  cabecalho[0] = 0xff; cabecalho[1] = marcador; cabecalho.writeUInt16BE(corpo.length + 2, 2);
  return Buffer.concat([cabecalho, corpo]);
};
const GPS = Buffer.from("Exif\0\0GPS-LATITUDE-23.5505-LONGITUDE-46.6333", "latin1");
function jpegComExif() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segmento(0xe0, Buffer.from("JFIF\0\x01\x01", "latin1")),
    segmento(0xe1, GPS),
    segmento(0xfe, Buffer.from("comentario do aparelho", "latin1")),
    segmento(0xdb, Buffer.alloc(65, 1)),
    segmento(0xda, Buffer.from([1, 2, 3])),
    Buffer.from([9, 9, 9, 0xff, 0xd9]),
  ]);
}
const pedacoPng = (tipo: string, corpo: Buffer) => {
  const tamanho = Buffer.alloc(4); tamanho.writeUInt32BE(corpo.length);
  return Buffer.concat([tamanho, Buffer.from(tipo, "latin1"), corpo, Buffer.alloc(4, 7)]);
};
const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngComTexto() {
  return Buffer.concat([
    ASSINATURA_PNG,
    pedacoPng("IHDR", Buffer.alloc(13, 1)),
    pedacoPng("tEXt", Buffer.from("Author\0Fulana", "latin1")),
    pedacoPng("eXIf", GPS),
    pedacoPng("IDAT", Buffer.alloc(10, 2)),
    pedacoPng("IEND", Buffer.alloc(0)),
  ]);
}
const pedacoWebp = (tipo: string, corpo: Buffer) => {
  const tamanho = Buffer.alloc(4); tamanho.writeUInt32LE(corpo.length);
  return Buffer.concat([Buffer.from(tipo, "latin1"), tamanho, corpo, corpo.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
function webpComExif() {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04 | 0x10;
  const corpo = Buffer.concat([pedacoWebp("VP8X", vp8x), pedacoWebp("VP8L", Buffer.alloc(7, 3)), pedacoWebp("EXIF", GPS), pedacoWebp("XMP ", Buffer.from("<x/>"))]);
  const cabecalho = Buffer.alloc(12);
  cabecalho.write("RIFF", 0, "latin1"); cabecalho.writeUInt32LE(corpo.length + 4, 4); cabecalho.write("WEBP", 8, "latin1");
  return Buffer.concat([cabecalho, corpo]);
}

describe("a imagem conferida pelo conteúdo", () => {
  it("reconhece JPEG, PNG e WebP pelos primeiros bytes; o resto (PDF, GIF, texto) não é imagem do anexo", () => {
    expect(formatoDoConteudo(jpegComExif())).toBe("image/jpeg");
    expect(formatoDoConteudo(pngComTexto())).toBe("image/png");
    expect(formatoDoConteudo(webpComExif())).toBe("image/webp");
    expect(formatoDoConteudo(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(formatoDoConteudo(Buffer.from("GIF89a......"))).toBeNull();
    expect(formatoDoConteudo(Buffer.from("<svg/>"))).toBeNull();
  });
});

describe("os metadados saem (o GPS da foto não vai ao bucket nem ao link)", () => {
  it("JPEG: o APP1 (EXIF) e o comentário saem; o JFIF, a tabela e os dados da imagem ficam como estavam", () => {
    const original = jpegComExif();
    const limpo = tirarMetadados(original, "image/jpeg")!;
    expect(limpo.includes(Buffer.from("GPS-LATITUDE"))).toBe(false);
    expect(limpo.includes(Buffer.from("comentario do aparelho"))).toBe(false);
    expect(limpo.includes(Buffer.from("JFIF"))).toBe(true);
    expect(limpo.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(limpo.subarray(-5)).toEqual(Buffer.from([9, 9, 9, 0xff, 0xd9]));
    expect(limpo.length).toBe(original.length - (GPS.length + 4) - ("comentario do aparelho".length + 4));
  });

  it("JPEG quebrado (o segmento diz um tamanho além do arquivo) não se lê: null", () => {
    const quebrado = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00]), Buffer.alloc(10)]);
    expect(tirarMetadados(quebrado, "image/jpeg")).toBeNull();
  });

  it("PNG: tEXt e eXIf saem; IHDR, IDAT e IEND ficam", () => {
    const limpo = tirarMetadados(pngComTexto(), "image/png")!;
    expect(limpo.includes(Buffer.from("Fulana"))).toBe(false);
    expect(limpo.includes(Buffer.from("GPS-LATITUDE"))).toBe(false);
    for (const tipo of ["IHDR", "IDAT", "IEND"]) expect(limpo.includes(Buffer.from(tipo))).toBe(true);
  });

  it("WebP: EXIF e XMP saem, o tamanho do RIFF é refeito e o VP8X deixa de anunciá-los (o bit da transparência fica)", () => {
    const limpo = tirarMetadados(webpComExif(), "image/webp")!;
    expect(limpo.includes(Buffer.from("GPS-LATITUDE"))).toBe(false);
    expect(limpo.includes(Buffer.from("XMP "))).toBe(false);
    expect(limpo.readUInt32LE(4)).toBe(limpo.length - 8);
    expect(limpo[20] & 0x0c).toBe(0);
    expect(limpo[20] & 0x10).toBe(0x10);
    expect(formatoDoConteudo(limpo)).toBe("image/webp");
  });
});

describe("prepararImagemDoAnexo", () => {
  it("aceita o data: URL que a tela manda e devolve a imagem sem metadados, pelo formato do conteúdo", () => {
    const { bytes, formato } = prepararImagemDoAnexo(`data:image/png;base64,${jpegComExif().toString("base64")}`);
    // O tipo declarado (png) não conta: vale o conteúdo.
    expect(formato).toBe("image/jpeg");
    expect(bytes.includes(Buffer.from("GPS-LATITUDE"))).toBe(false);
  });

  it("recusa com o código: o que não é imagem, o base64 inválido, o vazio e o grande demais", () => {
    const codigo = (base64: string) => { try { prepararImagemDoAnexo(base64); return null; } catch (erro) { return (erro as { codigo?: string }).codigo; } };
    expect(codigo(Buffer.from("%PDF-1.7 ...").toString("base64"))).toBe(RECUSAS_DOS_ANEXOS.formato);
    expect(codigo("não é base64!")).toBe(RECUSAS_DOS_ANEXOS.formato);
    expect(codigo("")).toBe(RECUSAS_DOS_ANEXOS.formato);
    const grande = Buffer.concat([jpegComExif(), Buffer.alloc(ANEXO_BYTES_MAX)]);
    expect(codigo(grande.toString("base64"))).toBe(RECUSAS_DOS_ANEXOS.grandeDemais);
  });
});

describe("GET /reuniao-aberta/{token}/anexo/{id}", () => {
  const acharChave = vi.fn<(token: string, anexoId: string) => Promise<string | null>>();
  const assinar = vi.fn<(chave: string) => Promise<string>>();
  let servidor: Server;
  let base = "";
  const TOKEN = "A".repeat(32);
  const ANEXO = "11111111-2222-4333-8444-555555555555";

  beforeAll(async () => {
    const app = express();
    registrarRotaDoAnexoDoLink(app, { acharChave, assinar });
    await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise(fim => servidor.close(fim)); });
  beforeEach(() => {
    acharChave.mockReset();
    assinar.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  const pedir = (caminho: string, cookie?: string) => fetch(`${base}${caminho}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

  it("anexo do link: 307 para a URL assinada, sem cache e fora dos buscadores; os cookies do pedido chegam a quem confere a senha", async () => {
    let cookiesVistos: unknown = null;
    acharChave.mockImplementation(async () => { cookiesVistos = cookiesDoPedido(); return "meetings/dona/m-1/anexo-x.webp"; });
    assinar.mockResolvedValue("https://bucket.exemplo/img?x=1");
    const resposta = await pedir(`/reuniao-aberta/${TOKEN}/anexo/${ANEXO}`, "wrw_link_entrada=abc");
    expect(resposta.status).toBe(307);
    expect(resposta.headers.get("location")).toBe("https://bucket.exemplo/img?x=1");
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(resposta.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(acharChave).toHaveBeenCalledWith(TOKEN, ANEXO);
    expect(JSON.stringify(cookiesVistos)).toContain("abc");
  });

  it("sem chave (link desligado, senha sem a entrada, anexo de outra reunião ou vencido): 404, sem assinar nada", async () => {
    acharChave.mockResolvedValue(null);
    const resposta = await pedir(`/reuniao-aberta/${TOKEN}/anexo/${ANEXO}`);
    expect(resposta.status).toBe(404);
    expect(assinar).not.toHaveBeenCalled();
  });

  it("banco fora do ar é 503 com a frase do banco, nunca 404 (a imagem não sumiu)", async () => {
    acharChave.mockRejectedValue(new BancoIndisponivel());
    const resposta = await pedir(`/reuniao-aberta/${TOKEN}/anexo/${ANEXO}`);
    expect(resposta.status).toBe(503);
    expect(await resposta.text()).toBe(MENSAGEM_BANCO_INDISPONIVEL);
  });

  it("outra falha é 500, e a assinatura que falha é 503", async () => {
    acharChave.mockRejectedValueOnce(new Error("quebrou"));
    expect((await pedir(`/reuniao-aberta/${TOKEN}/anexo/${ANEXO}`)).status).toBe(500);
    acharChave.mockResolvedValue("meetings/dona/m-1/anexo-x.webp");
    assinar.mockRejectedValue(new Error("sem bucket"));
    expect((await pedir(`/reuniao-aberta/${TOKEN}/anexo/${ANEXO}`)).status).toBe(503);
  });
});
