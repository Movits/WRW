import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { RECUSAS_DA_EQUIPE } from "@shared/espacos-de-equipe";
import { mensagemDeErroParaTela } from "./mensagem-de-erro";

/**
 * As recusas dos espaços de equipe (R2) saem do servidor como CÓDIGO
 * (shared/espacos-de-equipe.ts), e a tela as traduz no idioma de quem lê.
 * Com o i18n de verdade: cada código tem frase própria em pt-BR e em árabe,
 * nunca a chave nem o código cru.
 */
const t = (chave: string, opcoes?: Record<string, unknown>) => i18n.t(chave, opcoes);
const doServidor = (codigo: string) => ({ message: codigo, data: { code: "NOT_FOUND" } });

afterEach(async () => { await i18n.changeLanguage("pt-BR"); });

describe("as recusas da equipe viram frase traduzida", () => {
  for (const idioma of ["pt-BR", "ar"]) {
    it(`em ${idioma}, cada código tem a frase dele`, async () => {
      await i18n.changeLanguage(idioma);
      const frases = new Set<string>();
      for (const codigo of Object.values(RECUSAS_DA_EQUIPE)) {
        const frase = mensagemDeErroParaTela(doServidor(codigo), t);
        expect(frase, codigo).not.toContain(codigo);
        expect(frase, codigo).not.toMatch(/^teams\./);
        frases.add(frase);
      }
      expect(frases.size).toBe(Object.values(RECUSAS_DA_EQUIPE).length);
    });
  }

  it("a leitora que tenta escrever lê a frase do papel", () => {
    expect(mensagemDeErroParaTela(doServidor(RECUSAS_DA_EQUIPE.soLeitura), t)).toBe("Como leitora, você não muda as tarefas.");
  });
});
