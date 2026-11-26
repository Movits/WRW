import { describe, expect, it } from "vitest";
import { ASSOCIADOS_MAX_POR_ENTIDADE, linhasComProblema, ordenarProblemas, passaDoTeto, type ProblemaDaLinha } from "../shared/entidades";

/**
 * O relatório da importação na tela da entidade (conferência de tela, 25/11):
 * o resumo conta LINHAS, não mensagens (a linha 308 tinha 6 avisos), a lista
 * sai em ordem de linha (a 307 aparecia depois da 310) e o ensaio sabe que a
 * base passaria do teto.
 */
const P = (linha: number, codigo: ProblemaDaLinha["codigo"]): ProblemaDaLinha => ({ linha, codigo });

describe("relatório da importação", () => {
  it("conta linhas distintas, não mensagens", () => {
    const problemas = [P(308, "UF_INVALIDA"), P(308, "TELEFONE_INVALIDO"), P(308, "EMAIL_INVALIDO"), P(310, "CNAE_INVALIDO"), P(307, "DOCUMENTO_INVALIDO")];
    expect(linhasComProblema(problemas)).toBe(3);
  });

  it("ordena por linha e guarda a ordem das mensagens da mesma linha", () => {
    const problemas = [P(308, "UF_INVALIDA"), P(310, "CNAE_INVALIDO"), P(308, "EMAIL_INVALIDO"), P(307, "MEMBRO_ATIVADO_NAO_ALTERADO")];
    expect(ordenarProblemas(problemas).map(p => `${p.linha}:${p.codigo}`)).toEqual([
      "307:MEMBRO_ATIVADO_NAO_ALTERADO", "308:UF_INVALIDA", "308:EMAIL_INVALIDO", "310:CNAE_INVALIDO",
    ]);
  });

  it("o teto: até ASSOCIADOS_MAX_POR_ENTIDADE entra; um a mais passa", () => {
    expect(passaDoTeto(ASSOCIADOS_MAX_POR_ENTIDADE - 10, 10)).toBe(false);
    expect(passaDoTeto(ASSOCIADOS_MAX_POR_ENTIDADE - 10, 11)).toBe(true);
    // N4b: o teto subiu de 1000 para 50 mil por entidade (a meta é 50 mil associados no app inteiro, e uma
    // entidade grande pode ter dezenas de milhares). A base de 30 mil da reunião de 11/11 cabe inteira.
    expect(ASSOCIADOS_MAX_POR_ENTIDADE).toBe(50_000);
    expect(passaDoTeto(0, 30_000)).toBe(false);
    expect(passaDoTeto(0, 50_001)).toBe(true);
  });
});
