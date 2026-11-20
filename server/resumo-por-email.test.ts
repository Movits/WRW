import { describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

const { destinatariasDoPedido, hashDoEmail } = await import("./resumo-por-email");
const {
  DESTINATARIAS_POR_ENVIO_MAX,
  EMAILS_DIGITADOS_POR_ENVIO_MAX,
  MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA,
} = await import("@shared/resumo-por-email");

/**
 * Quem recebe o resumo por e-mail (H22), sem banco: a regra que junta a dona,
 * as participantes da agenda e os e-mails digitados. O banco, a Resend dublada,
 * os tetos e a auditoria estão em resumo-por-email.integracao.test.ts.
 */

const AGENDA = ["Ana@Exemplo.invalid", "caio@exemplo.invalid"];
const contexto = { emailDaDona: "glenda@exemplo.invalid", daAgenda: AGENDA };
const pedido = (extra: Partial<{ paraMim: boolean; participantes: string[]; outros: string[] }> = {}) => ({
  paraMim: false, participantes: [] as string[], outros: [] as string[], ...extra,
});
const recusa = (funcao: () => unknown) => {
  try {
    funcao();
  } catch (erro) {
    return erro as { code?: string; message?: string };
  }
  throw new Error("era para recusar");
};

describe("destinatariasDoPedido", () => {
  it("a dona pelo e-mail da conta, a participante com a grafia da agenda, o digitado aparado", () => {
    expect(destinatariasDoPedido(pedido({ paraMim: true, participantes: ["ana@exemplo.INVALID"], outros: ["  zeca@exemplo.invalid "] }), contexto)).toEqual([
      { email: "glenda@exemplo.invalid", origem: "dona" },
      { email: "Ana@Exemplo.invalid", origem: "participante" },
      { email: "zeca@exemplo.invalid", origem: "digitado" },
    ]);
  });

  it("ninguém recebe duas vezes: a primeira origem vence, sem diferença de caixa", () => {
    const lista = destinatariasDoPedido(pedido({
      paraMim: true, participantes: ["caio@exemplo.invalid", "CAIO@exemplo.invalid"], outros: ["GLENDA@exemplo.invalid", "Caio@Exemplo.invalid", "zeca@exemplo.invalid", "Zeca@exemplo.invalid"],
    }), contexto);
    expect(lista).toEqual([
      { email: "glenda@exemplo.invalid", origem: "dona" },
      { email: "caio@exemplo.invalid", origem: "participante" },
      { email: "zeca@exemplo.invalid", origem: "digitado" },
    ]);
  });

  it("participante fora da agenda é recusada: a tela não põe e-mail solto pelo caminho das participantes", () => {
    expect(recusa(() => destinatariasDoPedido(pedido({ participantes: ["intrusa@exemplo.invalid"] }), contexto)))
      .toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA });
  });

  it.each([
    ["sem o @", "zeca.exemplo.invalid"],
    ["com acento", "joão@exemplo.com.br"],
    ["com ponto no fim (o teclado do iPhone)", "ana@exemplo.com."],
    ["com vírgula (dois e-mails num campo)", "a@exemplo.invalid,b@exemplo.invalid"],
    ["com quebra de linha (cabeçalho injetado)", "a@exemplo.invalid\nbcc: b@exemplo.invalid"],
  ])("e-mail digitado inválido (%s): BAD_REQUEST", (_caso, email) => {
    expect(recusa(() => destinatariasDoPedido(pedido({ outros: [email] }), contexto)))
      .toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO });
  });

  it(`até ${EMAILS_DIGITADOS_POR_ENVIO_MAX} e-mails digitados por envio, contando sem repetir`, () => {
    const dez = Array.from({ length: EMAILS_DIGITADOS_POR_ENVIO_MAX }, (_, i) => `d${i}@exemplo.invalid`);
    expect(destinatariasDoPedido(pedido({ outros: [...dez, dez[0].toUpperCase()] }), contexto)).toHaveLength(EMAILS_DIGITADOS_POR_ENVIO_MAX);
    expect(recusa(() => destinatariasDoPedido(pedido({ outros: [...dez, "mais@exemplo.invalid"] }), contexto)))
      .toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_DEMAIS });
  });

  it(`até ${DESTINATARIAS_POR_ENVIO_MAX} pessoas por envio, somando as três origens`, () => {
    const agenda = Array.from({ length: DESTINATARIAS_POR_ENVIO_MAX }, (_, i) => `p${i}@exemplo.invalid`);
    expect(destinatariasDoPedido(pedido({ participantes: agenda }), { ...contexto, daAgenda: agenda })).toHaveLength(DESTINATARIAS_POR_ENVIO_MAX);
    expect(recusa(() => destinatariasDoPedido(pedido({ paraMim: true, participantes: agenda }), { ...contexto, daAgenda: agenda })))
      .toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_DEMAIS });
  });

  it("ninguém escolhido (e campo digitado só com espaços): BAD_REQUEST", () => {
    expect(recusa(() => destinatariasDoPedido(pedido({ outros: ["   "] }), contexto)))
      .toMatchObject({ code: "BAD_REQUEST", message: MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA });
  });

  it("'para mim' com a conta sem e-mail: PRECONDITION_FAILED", () => {
    expect(recusa(() => destinatariasDoPedido(pedido({ paraMim: true }), { ...contexto, emailDaDona: null })))
      .toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA });
  });
});

describe("hashDoEmail", () => {
  it("o mesmo hash para o mesmo endereço em qualquer caixa, e nada do endereço nele", () => {
    expect(hashDoEmail(" Ana@Exemplo.invalid ")).toBe(hashDoEmail("ana@exemplo.invalid"));
    expect(hashDoEmail("ana@exemplo.invalid")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoEmail("ana@exemplo.invalid")).not.toBe(hashDoEmail("bia@exemplo.invalid"));
  });
});
