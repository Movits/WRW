import { describe, expect, it } from "vitest";
import { escreveTarefas, FORMATO_DO_CONVITE_DA_EQUIPE, PAPEIS_DA_EQUIPE, RECUSAS_DA_EQUIPE } from "@shared/espacos-de-equipe";
import { appRouter } from "./routers";

/**
 * As regras puras dos espaços de equipe (R2) e a forma do router. O que
 * depende do banco (papéis, anonimato, leitura das reuniões, tarefas e
 * agenda) está em server/espacos-de-equipe.integracao.test.ts.
 */
describe("espaços de equipe: as regras puras", () => {
  it("quem escreve tarefas: a dona e o membro; a leitora não", () => {
    expect(escreveTarefas("owner")).toBe(true);
    expect(escreveTarefas("member")).toBe(true);
    expect(escreveTarefas("reader")).toBe(false);
  });

  it("os papéis que a dona dá são só dois: a dona não é papel de convite", () => {
    expect([...PAPEIS_DA_EQUIPE]).toEqual(["member", "reader"]);
  });

  it("o convite tem 32 caracteres de base64url (192 bits), e nada além", () => {
    expect(FORMATO_DO_CONVITE_DA_EQUIPE.test("A".repeat(32))).toBe(true);
    expect(FORMATO_DO_CONVITE_DA_EQUIPE.test("A".repeat(31))).toBe(false);
    expect(FORMATO_DO_CONVITE_DA_EQUIPE.test(`${"A".repeat(31)}=`)).toBe(false);
    expect(FORMATO_DO_CONVITE_DA_EQUIPE.test("participante:00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("os códigos das recusas são únicos e começam por EQUIPE_", () => {
    const codigos = Object.values(RECUSAS_DA_EQUIPE);
    expect(new Set(codigos).size).toBe(codigos.length);
    for (const codigo of codigos) expect(codigo).toMatch(/^EQUIPE_[A-Z_]+$/);
  });
});

describe("o router das equipes", () => {
  it("nenhum procedimento é público, e nenhum recebe o id de uma reunião (a leitura é a da participante)", () => {
    const procedimentos = (appRouter._def.procedures as Record<string, { _def: { inputs?: Array<{ shape?: Record<string, unknown> }>; meta?: unknown } }>);
    const daEquipe = Object.entries(procedimentos).filter(([caminho]) => caminho.startsWith("equipes."));
    expect(daEquipe.length).toBeGreaterThanOrEqual(19);
    for (const [caminho, procedimento] of daEquipe) {
      const campos = (procedimento._def.inputs ?? []).flatMap(entrada => Object.keys(entrada.shape ?? {}));
      expect(campos, caminho).not.toContain("meetingId");
    }
  });
});
