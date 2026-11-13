import { describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A OFERTA GENÉRICA ATENDE A NECESSIDADE DA MESMA FAMÍLIA COM PÚBLICO — pela
 * nota da família, salvo o destinatário comum, que é o mesmo serviço.
 *
 * É a metade "60" do item 4 da revisão do Nicolas na #135 (15/09). O que havia
 * antes não era uma nota baixa: era ZERO com bloqueio, porque `cobrePublico`
 * percorre as especialidades da OFERTA e a oferta genérica não tem nenhuma —
 * `.some()` sobre lista vazia é falso. Duas consequências:
 *
 *   1. o mesmo fato com os lados trocados dava notas opostas: "Contabilidade
 *      para pequenas empresas" × "Contador" valia 100, e "Contabilidade" ×
 *      "Contador para pequenas empresas" valia 0;
 *   2. "Logística" × "preciso de logística para exportar meu café" tinha caído
 *      de 60 (main) para 0, que foi a regressão que ele apontou.
 *
 * A outra metade do item 4 foi decidida pelo Roberto em 16/09 (D2 e D4 da
 * validação da #135): quando o público é um dos `DESTINATARIOS_COMUNS` (MEI,
 * pequenas empresas, startups...), vale 100 dos dois lados, e manda e-mail. O
 * público que não é destinatário comum e a finalidade continuam em 60. Os casos
 * abaixo travam os três: 100, 60 e o que continua valendo 0.
 */

const { scoreMatch, slugifyMatchTag } = await import("./match-service");
const { mesmaFamiliaEEspecialidade, necessidadeGenericaNomeiaOServico } = await import("@shared/tipo-da-oferta");

const item = (label: string, category: string | null = null) =>
  ({ slug: slugifyMatchTag(label), label, category });

const nota = (oferta: string, necessidade: string) => scoreMatch(item(oferta), item(necessidade)).score;

describe("oferta genérica diante de necessidade com público ou finalidade", () => {
  it("'Contabilidade' × 'Contador para pequenas empresas' é o mesmo serviço: 100 (decisão de 16/09)", () => {
    expect(nota("Contabilidade", "Contador para pequenas empresas")).toBe(100);
    expect(mesmaFamiliaEEspecialidade("Contabilidade", null, "Contador para pequenas empresas")).toBe(true);
    expect(necessidadeGenericaNomeiaOServico("Contabilidade", null, "Contador para pequenas empresas")).toBe(false);
  });

  it("o destinatário comum vale 100 e o público incomum fica na nota da família", () => {
    expect(nota("Contabilidade", "Contador para MEI")).toBe(100);
    expect(nota("Contabilidade", "Contador para clínicas veterinárias")).toBe(60);
    expect(necessidadeGenericaNomeiaOServico("Contabilidade", null, "Contador para clínicas veterinárias")).toBe(true);
  });

  it("a regressão da logística desfeita: o par voltou a valer o que valia", () => {
    expect(nota("Logística", "Preciso de logística para exportar meu café")).toBe(60);
  });

  it("os lados trocados continuam coerentes: quem nomeia só a família dos dois lados vale 100", () => {
    expect(nota("Contabilidade", "Contador")).toBe(100);
    expect(nota("Contabilidade para pequenas empresas", "Contador")).toBe(100);
  });
});

describe("o que a regra NÃO passou a casar", () => {
  it("oferta com especialidade não atende público de outra: 'palavra igual não é serviço igual'", () => {
    expect(nota("Advocacia tributária", "Advogado para divórcio")).toBe(0);
    expect(nota("Consultoria trabalhista", "Consultoria para segurança do trabalho")).toBe(0);
    expect(nota("Engenharia civil", "Engenheiro para aviação civil")).toBe(0);
  });

  it("família diferente continua sem casar, com oferta genérica ou não", () => {
    expect(nota("Consultoria jurídica", "Advogado para startups")).toBe(0);
    expect(nota("Consultoria jurídica", "Consultoria para advogados")).toBe(0);
  });

  it("necessidade com ESPECIALIDADE (e não público) segue exigindo a especialidade na oferta", () => {
    expect(nota("Advocacia", "Advogado tributarista")).toBe(0);
  });
});
