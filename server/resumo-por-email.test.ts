import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

const { comPrazo, destinatariasDoPedido, hashDoEmail, PRAZO_DA_RESEND_MS, separarPeloQueJaHa } = await import("./resumo-por-email");
type LinhaQueNaoSaiu = import("./resumo-por-email").LinhaQueNaoSaiu;
const {
  DESTINATARIAS_POR_ENVIO_MAX,
  EMAILS_DIGITADOS_POR_ENVIO_MAX,
  MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA,
  PENDENTE_PRESO_MS,
  TENTATIVAS_POR_EMAIL_MAX,
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

describe("comPrazo: a Resend que não responde não prende a dona", () => {
  it("a resposta que chega no prazo vale; a que não chega vira o valor do estouro", async () => {
    vi.useFakeTimers();
    try {
      await expect(comPrazo(Promise.resolve([true]), PRAZO_DA_RESEND_MS, () => [false])).resolves.toEqual([true]);
      const presa = comPrazo(new Promise<boolean[]>(() => {}), PRAZO_DA_RESEND_MS, () => [false]);
      await vi.advanceTimersByTimeAsync(PRAZO_DA_RESEND_MS - 1);
      let resolvida = false;
      void presa.then(() => { resolvida = true; });
      await Promise.resolve();
      expect(resolvida).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(presa).resolves.toEqual([false]);
      // Resolvida no prazo, o relógio sai: nada fica agendado.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hashDoEmail", () => {
  it("o mesmo hash para o mesmo endereço em qualquer caixa, e nada do endereço nele", () => {
    expect(hashDoEmail(" Ana@Exemplo.invalid ")).toBe(hashDoEmail("ana@exemplo.invalid"));
    expect(hashDoEmail("ana@exemplo.invalid")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoEmail("ana@exemplo.invalid")).not.toBe(hashDoEmail("bia@exemplo.invalid"));
  });
});

describe("separarPeloQueJaHa: o pedido novo diante do que não saiu nesta reunião", () => {
  const AGORA = 1_800_000_000_000;
  const linha = (extra: Partial<LinhaQueNaoSaiu> & Pick<LinhaQueNaoSaiu, "destinatario">): LinhaQueNaoSaiu => ({
    id: `linha-${extra.destinatario}`, origem: "digitado", idioma: "pt-BR", loteId: "lote-1", status: "falhou", tentativas: 1, updatedAt: AGORA - 60_000, ...extra,
  });
  const ana = { email: "Ana@Exemplo.invalid", origem: "participante" as const };
  const bia = { email: "bia@exemplo.invalid", origem: "digitado" as const };

  it("quem tem um e-mail que não saiu o recebe de novo pela mesma linha, sem diferença de caixa; quem não tem ganha linha nova", () => {
    const anterior = linha({ destinatario: "ana@exemplo.invalid" });
    expect(separarPeloQueJaHa([ana, bia], [anterior], AGORA)).toEqual({ novas: [bia], deNovo: [{ destinataria: ana, linha: anterior }], jaSaindo: [] });
  });

  it("a 'pendente' recente está saindo agora: fica de fora; a presa há mais de 5 minutos volta a sair pela mesma linha", () => {
    const saindo = linha({ destinatario: "ana@exemplo.invalid", status: "pendente", updatedAt: AGORA - 60_000 });
    expect(separarPeloQueJaHa([ana], [saindo], AGORA)).toEqual({ novas: [], deNovo: [], jaSaindo: [ana] });
    const presa = linha({ destinatario: "ana@exemplo.invalid", status: "pendente", updatedAt: AGORA - PENDENTE_PRESO_MS - 1 });
    expect(separarPeloQueJaHa([ana], [presa], AGORA).deNovo).toEqual([{ destinataria: ana, linha: presa }]);
  });

  it(`a que já foi tentada ${TENTATIVAS_POR_EMAIL_MAX} vezes não volta: o pedido novo da dona ganha linha nova`, () => {
    const esgotada = linha({ destinatario: "ana@exemplo.invalid", tentativas: TENTATIVAS_POR_EMAIL_MAX });
    expect(separarPeloQueJaHa([ana], [esgotada], AGORA)).toEqual({ novas: [ana], deNovo: [], jaSaindo: [] });
  });

  it("o e-mail da dona para ela mesma e o das outras pessoas são textos diferentes: um não reaproveita o outro", () => {
    const daDona = { email: "glenda@exemplo.invalid", origem: "dona" as const };
    const comoDigitado = linha({ destinatario: "glenda@exemplo.invalid", origem: "digitado" });
    expect(separarPeloQueJaHa([daDona], [comoDigitado], AGORA)).toEqual({ novas: [daDona], deNovo: [], jaSaindo: [] });
    // A participante que antes foi digitada recebe o mesmo texto: reaproveita.
    const digitadaAntes = linha({ destinatario: "ana@exemplo.invalid", origem: "digitado" });
    expect(separarPeloQueJaHa([ana], [digitadaAntes], AGORA).deNovo).toHaveLength(1);
  });
});
