import { describe, expect, it, vi } from "vitest";
import { buscarDocumentoGuardado, enviarDocumento, FalhaAoBuscarODocumento } from "./envio-do-documento";

/**
 * O envio do PDF da reunião de documento (H12 e H12b) e a busca do PDF guardado
 * para a aba das páginas, contra a rota binária do servidor
 * (server/_core/rota-do-documento.ts, provada pelo HTTP em
 * server/rota-do-documento.test.ts). O servidor responde só o código, e a tela
 * o traduz; aqui se prova que o código chega inteiro, e que rede fora e
 * resposta sem JSON viram REDE e ERRO, nunca texto do servidor.
 */
const REUNIAO = "0b6f2c1e-1111-4222-8333-944445555666";
const resposta = (status: number, corpo?: unknown) =>
  new Response(corpo === undefined ? "<html>502 Bad Gateway</html>" : JSON.stringify(corpo), { status, headers: { "Content-Type": corpo === undefined ? "text/html" : "application/json" } });
const PDF = new Blob(["%PDF-1.4\n%%EOF\n"], { type: "application/pdf" });

describe("enviarDocumento", () => {
  it("manda o PDF cru, como application/pdf, ao endereço da reunião, com o cookie da sessão", async () => {
    const buscar = vi.fn(async () => resposta(202, { codigo: "RECEBIDO", repetido: false }));
    expect(await enviarDocumento(REUNIAO, PDF, buscar as typeof fetch)).toEqual({ tipo: "recebido", repetido: false });
    expect(buscar).toHaveBeenCalledWith(`/api/reunioes/${REUNIAO}/documento`, {
      method: "POST", headers: { "Content-Type": "application/pdf" }, body: PDF, credentials: "same-origin",
    });
  });

  it("200: o mesmo arquivo já tinha chegado (a resposta do primeiro envio se perdeu)", async () => {
    expect(await enviarDocumento(REUNIAO, PDF, (async () => resposta(200, { codigo: "RECEBIDO", repetido: true })) as typeof fetch))
      .toEqual({ tipo: "recebido", repetido: true });
  });

  it.each([
    [413, "GRANDE_DEMAIS"], [415, "FORMATO"], [429, "MUITOS_PEDIDOS"], [401, "SEM_SESSAO"], [503, "BANCO_INDISPONIVEL"], [409, "FORA_DO_ESTADO"],
  ])("%i: o código do servidor volta inteiro (%s)", async (status, codigo) => {
    expect(await enviarDocumento(REUNIAO, PDF, (async () => resposta(status, { codigo })) as typeof fetch))
      .toEqual({ tipo: "recusado", status, codigo });
  });

  it("a resposta sem JSON (o 502 do proxy) é ERRO, e a rede fora é REDE", async () => {
    expect(await enviarDocumento(REUNIAO, PDF, (async () => resposta(502)) as typeof fetch)).toEqual({ tipo: "recusado", status: 502, codigo: "ERRO" });
    expect(await enviarDocumento(REUNIAO, PDF, (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch))
      .toEqual({ tipo: "recusado", status: 0, codigo: "REDE" });
  });
});

describe("buscarDocumentoGuardado", () => {
  it("200: os bytes do PDF, pela mesma rota, com o cookie da sessão", async () => {
    // O corpo em bytes: o Response do Node não lê o Blob do jsdom.
    const buscar = vi.fn(async () => new Response(new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), { status: 200, headers: { "Content-Type": "application/pdf" } }));
    const bytes = await buscarDocumentoGuardado(REUNIAO, buscar as typeof fetch);
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4\n%%EOF\n");
    expect(buscar).toHaveBeenCalledWith(`/api/reunioes/${REUNIAO}/documento`, { credentials: "same-origin" });
  });

  it("404: FalhaAoBuscarODocumento com o status e o código (o arquivo saiu)", async () => {
    const erro = await buscarDocumentoGuardado(REUNIAO, (async () => resposta(404, { codigo: "SEM_DOCUMENTO" })) as typeof fetch).catch(e => e);
    expect(erro).toBeInstanceOf(FalhaAoBuscarODocumento);
    expect(erro).toMatchObject({ status: 404, codigo: "SEM_DOCUMENTO" });
  });

  it("rede fora: REDE, com status 0; resposta sem JSON: ERRO", async () => {
    expect(await buscarDocumentoGuardado(REUNIAO, (async () => { throw new TypeError("x"); }) as typeof fetch).catch(e => e)).toMatchObject({ status: 0, codigo: "REDE" });
    expect(await buscarDocumentoGuardado(REUNIAO, (async () => resposta(502)) as typeof fetch).catch(e => e)).toMatchObject({ status: 502, codigo: "ERRO" });
  });
});
