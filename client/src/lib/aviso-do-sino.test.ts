import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { horaDaReuniaoNoSino, textoDoAviso } from "./aviso-do-sino";

/**
 * O texto dos avisos do gravador no sino (H15): pelo tipo e pelos parâmetros,
 * no idioma de quem lê, com a data e a hora no formato dele. Os avisos antigos
 * saem como foram gravados, e o parâmetro estragado cai no título guardado.
 */

type Traduzir = (chave: string, opcoes?: Record<string, unknown>) => string;
const em = (idioma: string) => i18n.getFixedT(idioma) as unknown as Traduzir;
// "Agora" fixo em 2026: o ano do prazo só aparece quando não é o corrente.
const AGORA = new Date(2026, 10, 16, 10);
const INICIO = Date.UTC(2026, 10, 20, 17, 0); // 14h em Brasília, 2h do dia 21 em Tóquio

const lembreteDaAcao = (prazo = "2026-11-20", texto = "{F3} manda a proposta") => ({
  type: "lembrete", title: texto, body: null, parametros: { origem: "acao", texto, prazo },
});
const lembreteDaAgenda = (fuso = "America/Sao_Paulo") => ({
  type: "lembrete", title: "Com a Bia", body: null, parametros: { origem: "agenda", titulo: "Com a Bia", inicioEm: INICIO, fuso },
});
const pronta = (resumo: "pronto" | "falhou") => ({
  type: "reuniao_pronta", title: "Comitê de exportação", body: null, parametros: { titulo: "Comitê de exportação", resumo },
});

describe("o lembrete da próxima ação", () => {
  it("em português: o prazo no formato do idioma e o texto abaixo, com a voz sem nome como Falante n", () => {
    expect(textoDoAviso(lembreteDaAcao(), em("pt-BR"), "pt-BR", AGORA)).toEqual({
      titulo: "Lembrete: próxima ação para 20 de nov.",
      corpo: "Falante 3 manda a proposta",
    });
  });

  it("em inglês, sem nada de português", () => {
    expect(textoDoAviso(lembreteDaAcao(), em("en"), "en", AGORA)).toEqual({
      titulo: "Reminder: next action due Nov 20",
      corpo: "Speaker 3 manda a proposta",
    });
  });

  it("o prazo de outro ano diz o ano", () => {
    expect(textoDoAviso(lembreteDaAcao("2027-01-05"), em("pt-BR"), "pt-BR", AGORA).titulo).toBe("Lembrete: próxima ação para 5 de jan. de 2027");
  });
});

describe("o lembrete da reunião da agenda", () => {
  it("a hora é a do fuso em que ela foi marcada, com o nome do fuso; o título vai abaixo", () => {
    const { titulo, corpo } = textoDoAviso(lembreteDaAgenda(), em("pt-BR"), "pt-BR", AGORA);
    expect(titulo).toMatch(/^Lembrete de reunião: /);
    expect(titulo).toContain("14:00");
    expect(titulo).toContain("20 de nov.");
    expect(corpo).toBe("Com a Bia");
  });

  it("marcada em Tóquio, a hora sai a de Tóquio, e não a do aparelho", () => {
    expect(horaDaReuniaoNoSino(INICIO, "Asia/Tokyo", "pt-BR")).toContain("02:00");
    expect(horaDaReuniaoNoSino(INICIO, "Asia/Tokyo", "pt-BR")).toContain("21 de nov.");
  });

  it("em inglês, no formato inglês", () => {
    const { titulo } = textoDoAviso(lembreteDaAgenda(), em("en"), "en", AGORA);
    expect(titulo).toMatch(/^Meeting reminder: /);
    expect(titulo).toContain("Nov 20");
    // O ICU do Node 20 separa o AM/PM com um espaço estreito (U+202F); o do 24, com um comum.
    expect(titulo.replace(/s/g, " ")).toContain("02:00 PM");
  });

  it("fuso que o aparelho não conhece: sai na hora do aparelho, sem quebrar", () => {
    expect(horaDaReuniaoNoSino(INICIO, "Marte/Olympus", "pt-BR")).toMatch(/\d{2}:\d{2}/);
  });
});

describe("o aviso de reunião pronta", () => {
  it("pronta com o resumo, e pronta sem ele (com o convite a tentar de novo), em dois idiomas", () => {
    expect(textoDoAviso(pronta("pronto"), em("pt-BR"), "pt-BR")).toEqual({ titulo: "Sua reunião está pronta: transcrição e resumo", corpo: "Comitê de exportação" });
    expect(textoDoAviso(pronta("falhou"), em("pt-BR"), "pt-BR").titulo).toBe("Sua reunião está pronta, sem o resumo: abra para tentar de novo");
    expect(textoDoAviso(pronta("pronto"), em("es"), "es").titulo).toBe("Tu reunión está lista: transcripción y resumen");
  });
});

describe("o que não é do gravador, ou está fora da forma", () => {
  it("o aviso antigo sai como foi gravado", () => {
    expect(textoDoAviso({ type: "new_match", title: "Nova conexão", body: "Veja quem", parametros: null }, em("en"), "en"))
      .toEqual({ titulo: "Nova conexão", corpo: "Veja quem" });
  });

  it("parâmetros estragados: fica o título guardado, que é o da origem", () => {
    expect(textoDoAviso({ type: "lembrete", title: "Mandar o contrato", body: null, parametros: { origem: "acao" } }, em("en"), "en"))
      .toEqual({ titulo: "Mandar o contrato", corpo: null });
    expect(textoDoAviso({ type: "reuniao_pronta", title: "Comitê", body: null, parametros: "{quebrado" }, em("en"), "en"))
      .toEqual({ titulo: "Comitê", corpo: null });
  });

  it("os 10 idiomas têm as frases (nenhuma chave aparece crua)", () => {
    for (const idioma of ["pt-BR", "en", "es", "fr", "de", "ru", "hi", "ar", "zh", "ja"]) {
      const t = em(idioma);
      for (const aviso of [lembreteDaAcao(), lembreteDaAgenda(), pronta("pronto"), pronta("falhou")]) {
        expect(textoDoAviso(aviso, t, idioma, AGORA).titulo, idioma).not.toMatch(/notifications\.|meetingReady|reminder\./);
      }
    }
  });
});
