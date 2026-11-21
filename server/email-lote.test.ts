/**
 * sendEmailBatch (server/_core/email.ts), o único caminho que manda e-mail a
 * terceiros: o resumo por e-mail (H22, server/resumo-por-email.ts). A API de
 * lote da Resend é dublê; o que se prova é a nossa parte: o .invalid que nunca
 * vai à Resend, a resposta na ordem da lista (o painel da dona marca cada
 * pessoa como enviado ou "não saiu" por ela), o corte em chamadas de 100, a
 * falha que vira false sem lançar e o log sem o endereço de ninguém.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ItemDoLote = { from: string; to: string; subject: string; html: string; text?: string };

const { lote } = vi.hoisted(() => ({ lote: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    batch = { send: lote };
    emails = { send: vi.fn() };
  },
}));

async function carregar() {
  vi.resetModules();
  return import("./_core/email");
}

const email = (to: string) => ({ to, subject: "Assunto do resumo", html: "<p>corpo</p>", text: "corpo" });
const aceitaTudo = async (itens: ItemDoLote[]) => ({ data: { data: itens.map((_, i) => ({ id: `id-${i}` })) }, error: null });
const enviados = (chamada: number) => (lote.mock.calls[chamada][0] as ItemDoLote[]).map(item => item.to);

describe("sendEmailBatch: o lote da Resend do resumo por e-mail", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_teste_falsa");
    vi.stubEnv("EMAIL_FROM", "no-reply@exemplo.test");
    lote.mockReset();
    lote.mockImplementation(aceitaTudo);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("o .invalid do meio não vai à Resend: uma chamada com os outros dois, e a resposta na ordem da lista", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmailBatch } = await carregar();
    expect(await sendEmailBatch([email("a@exemplo.com"), email("b@teste.invalid"), email("c@exemplo.org")])).toEqual([true, false, true]);
    expect(lote).toHaveBeenCalledTimes(1);
    expect(enviados(0)).toEqual(["a@exemplo.com", "c@exemplo.org"]);
    // Cada item com um destinatário só e o remetente com a marca.
    expect(lote.mock.calls[0][0][0]).toEqual({ from: "WRW <no-reply@exemplo.test>", to: "a@exemplo.com", subject: "Assunto do resumo", html: "<p>corpo</p>", text: "corpo" });
  });

  it("só .invalid: nenhuma chamada, todos false", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmailBatch } = await carregar();
    expect(await sendEmailBatch([email("qa@exame.invalid"), email("x@teste.INVALID")])).toEqual([false, false]);
    expect(lote).not.toHaveBeenCalled();
  });

  it("101 e-mails vão em duas chamadas, de 100 e de 1; a recusa da segunda deixa só o último sem sair", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    lote.mockImplementationOnce(aceitaTudo).mockImplementationOnce(async () => ({ data: null, error: { name: "validation_error", message: "recusado" } }));
    const { sendEmailBatch } = await carregar();
    const lista = Array.from({ length: 101 }, (_, i) => email(`pessoa${i}@exemplo.com`));
    const resultado = await sendEmailBatch(lista);
    expect(lote.mock.calls.map(chamada => (chamada[0] as ItemDoLote[]).length)).toEqual([100, 1]);
    expect(enviados(1)).toEqual(["pessoa100@exemplo.com"]);
    expect(resultado.slice(0, 100).every(aceito => aceito === true)).toBe(true);
    expect(resultado[100]).toBe(false);
  });

  it("o .invalid antes do corte não desalinha as posições: cada pessoa recebe a resposta da chamada dela", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    lote.mockImplementationOnce(async () => ({ data: null, error: { name: "validation_error", message: "recusado" } })).mockImplementationOnce(aceitaTudo);
    const { sendEmailBatch } = await carregar();
    // 1 .invalid e 101 de verdade: a primeira chamada leva as posições 1 a 100 (recusada); a segunda, a 101.
    const lista = [email("qa@exame.invalid"), ...Array.from({ length: 101 }, (_, i) => email(`pessoa${i}@exemplo.com`))];
    const resultado = await sendEmailBatch(lista);
    expect(enviados(1)).toEqual(["pessoa100@exemplo.com"]);
    expect(resultado.filter(aceito => aceito)).toHaveLength(1);
    expect(resultado[101]).toBe(true);
  });

  it("a Resend que lança: todos false, sem lançar, e o log leva o nome do erro, nunca o endereço", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    lote.mockRejectedValue(new TypeError("falhou ao mandar para a@exemplo.com"));
    const { sendEmailBatch } = await carregar();
    await expect(sendEmailBatch([email("a@exemplo.com"), email("b@exemplo.com")])).resolves.toEqual([false, false]);
    const linhas = log.mock.calls.map(chamada => chamada.map(String).join(" "));
    expect(linhas.some(linha => linha.includes("TypeError"))).toBe(true);
    for (const linha of linhas) expect(linha).not.toContain("@exemplo.com");
  });

  it("a recusa da Resend (o error da resposta): todos false, e o log leva o nome, não a mensagem, que pode trazer o endereço", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    lote.mockResolvedValue({ data: null, error: { name: "validation_error", message: "Invalid `to` field: a@exemplo.com" } });
    const { sendEmailBatch } = await carregar();
    expect(await sendEmailBatch([email("a@exemplo.com")])).toEqual([false]);
    const linhas = log.mock.calls.map(chamada => chamada.map(String).join(" "));
    expect(linhas.some(linha => linha.includes("validation_error"))).toBe(true);
    for (const linha of linhas) expect(linha).not.toContain("@exemplo.com");
  });

  it("sem RESEND_API_KEY ou sem EMAIL_FROM: todos false, sem chamar a Resend", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await (await carregar()).sendEmailBatch([email("a@exemplo.com")])).toEqual([false]);
    vi.stubEnv("RESEND_API_KEY", "re_teste_falsa");
    vi.stubEnv("EMAIL_FROM", "");
    expect(await (await carregar()).sendEmailBatch([email("a@exemplo.com")])).toEqual([false]);
    expect(lote).not.toHaveBeenCalled();
  });
});
