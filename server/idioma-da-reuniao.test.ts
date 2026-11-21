import { describe, expect, it } from "vitest";
import {
  escolhaDoIdioma, escritoDaDireitaParaAEsquerda, IDIOMA_AUTOMATICO, IDIOMAS_DA_REUNIAO, IDIOMAS_FALADOS, idiomaDaReuniao, idiomaFalado,
  idiomaPredominante, idiomasDasFalas, nomeDoIdioma, nomeDoIdiomaEm,
} from "@shared/idioma-da-reuniao";

describe("idioma da reunião — a função única do contrato", () => {
  it("todo português vira pt-BR, inclusive o 'pt' das reuniões antigas", () => {
    for (const codigo of ["pt", "pt-BR", "pt-br", "PT", "pt_BR", "pt-PT", " pt-BR "]) expect(idiomaDaReuniao(codigo)).toBe("pt-BR");
  });

  it("código regional do navegador cai no código base da lista", () => {
    expect(idiomaDaReuniao("en-US")).toBe("en");
    expect(idiomaDaReuniao("zh-CN")).toBe("zh");
    expect(idiomaDaReuniao("es-MX")).toBe("es");
    expect(idiomaDaReuniao("ar")).toBe("ar");
  });

  it("fora dos 10, vazio ou ausente é null, sem chutar idioma", () => {
    for (const codigo of ["it", "ko", "", "  ", "x", "english", null, undefined]) expect(idiomaDaReuniao(codigo)).toBeNull();
  });

  it("cada um dos 10 volta a si mesmo e tem nome em português para o prompt", () => {
    expect(IDIOMAS_DA_REUNIAO).toHaveLength(10);
    for (const codigo of IDIOMAS_DA_REUNIAO) {
      expect(idiomaDaReuniao(codigo)).toBe(codigo);
      expect(nomeDoIdioma(codigo)).toMatch(/^\p{L}[\p{L} ]{3,}$/u);
    }
    expect(nomeDoIdioma("pt-BR")).toBe("português do Brasil");
    expect(nomeDoIdioma("en")).toBe("inglês");
  });
});

describe("G16: os idiomas que a IA transcreve e o \"Detectar sozinho\"", () => {
  it("a lista falada traz os 10 da tela na frente e os 109 códigos da documentação da Google, sem repetir", () => {
    expect(IDIOMAS_FALADOS.slice(0, 10)).toEqual([...IDIOMAS_DA_REUNIAO]);
    expect(IDIOMAS_FALADOS).toHaveLength(109);
    expect(new Set(IDIOMAS_FALADOS).size).toBe(109);
    // Cabem na coluna (meetings.language e meeting_transcripts.language, varchar 12).
    for (const codigo of IDIOMAS_FALADOS) expect(codigo.length).toBeLessThanOrEqual(12);
  });

  it("idiomaFalado aceita o que a IA transcreve, com a região e os códigos antigos", () => {
    expect(idiomaFalado("it")).toBe("it");
    expect(idiomaFalado("it-IT")).toBe("it");
    expect(idiomaFalado("KO")).toBe("ko");
    expect(idiomaFalado("zh-TW")).toBe("zh");
    expect(idiomaFalado("iw")).toBe("he");
    expect(idiomaFalado("he-IL")).toBe("he");
    expect(idiomaFalado("tl")).toBe("fil");
    expect(idiomaFalado("nb")).toBe("no");
    expect(idiomaFalado("mni-Mtei")).toBe("mni");
    for (const codigo of ["pt", "pt-PT", "pt_BR", " pt-br "]) expect(idiomaFalado(codigo)).toBe("pt-BR");
    for (const codigo of IDIOMAS_FALADOS) expect(idiomaFalado(codigo)).toBe(codigo);
  });

  it("idiomaFalado recusa o que não é idioma da lista, sem chutar, e \"auto\" não é idioma", () => {
    for (const codigo of ["auto", "xx", "klingon", "", "  ", "constructor", "toString", "__proto__", null, undefined]) expect(idiomaFalado(codigo)).toBeNull();
  });

  it("idiomaDaReuniao continua só com os 10 da tela", () => {
    expect(idiomaDaReuniao("it")).toBeNull();
    expect(idiomaDaReuniao("auto")).toBeNull();
  });

  it("escolhaDoIdioma aceita \"auto\" (em qualquer caixa) e todo idioma falado", () => {
    expect(escolhaDoIdioma("auto")).toBe(IDIOMA_AUTOMATICO);
    expect(escolhaDoIdioma(" AUTO ")).toBe(IDIOMA_AUTOMATICO);
    expect(escolhaDoIdioma("ko")).toBe("ko");
    expect(escolhaDoIdioma("pt")).toBe("pt-BR");
    expect(escolhaDoIdioma("automático")).toBeNull();
    expect(escolhaDoIdioma(undefined)).toBeNull();
  });

  it("nomeDoIdioma: os 10 mantêm o nome de sempre do prompt, e os outros vêm do CLDR em português", () => {
    expect(nomeDoIdioma("pt-BR")).toBe("português do Brasil");
    expect(nomeDoIdioma("zh")).toBe("chinês simplificado");
    expect(nomeDoIdioma("it")).toBe("italiano");
    expect(nomeDoIdioma("ko")).toBe("coreano");
    expect(nomeDoIdioma("he")).toBe("hebraico");
    // O CLDR não tem o krio: vai o nome de reserva, e nunca o código cru.
    expect(nomeDoIdioma("kri")).toBe("krio");
    for (const codigo of IDIOMAS_FALADOS) expect(nomeDoIdioma(codigo)).not.toBe(codigo);
  });

  it("nomeDoIdiomaEm escreve o nome no idioma de quem lê", () => {
    expect(nomeDoIdiomaEm("it", "en")).toBe("Italian");
    expect(nomeDoIdiomaEm("it", "de")).toBe("Italienisch");
    expect(nomeDoIdiomaEm("ko", "ja")).toBe("韓国語");
    expect(nomeDoIdiomaEm("kri", "pt-BR")).toBe("krio");
  });

  it("escrita da direita para a esquerda: árabe, hebraico, persa e urdu, e não o italiano", () => {
    for (const codigo of ["ar", "he", "iw", "fa", "ur"]) expect(escritoDaDireitaParaAEsquerda(codigo)).toBe(true);
    for (const codigo of ["it", "pt-BR", "zh", "auto", null]) expect(escritoDaDireitaParaAEsquerda(codigo)).toBe(false);
  });
});

describe("G16: o idioma que mais aparece nas falas", () => {
  const fala = (inicio: number, fim: number, idioma: string | undefined, texto = "uma fala") => ({ inicio, fim, falante: "F1", texto, ...(idioma ? { idioma } : {}) });

  it("pesa pelo tempo de fala: 7 min em inglês ganham de 3 min em português", () => {
    const falas = [fala(0, 120, "pt"), fala(120, 540, "en"), fala(540, 600, "pt-BR")];
    expect(idiomaPredominante(falas)).toBe("en");
    const partes = idiomasDasFalas(falas);
    expect(partes.map(p => p.idioma)).toEqual(["en", "pt-BR"]);
    expect(partes[0].fracao).toBeCloseTo(0.7);
    expect(partes[1].fracao).toBeCloseTo(0.3);
  });

  it("a escrita não decide: pouco texto em chinês por muito tempo ganha de muito texto em inglês por pouco tempo", () => {
    const falas = [fala(0, 500, "zh", "我们下周签合同"), fala(500, 560, "en", "Okay, so the contract must be signed before the end of the month, right?")];
    expect(idiomaPredominante(falas)).toBe("zh");
  });

  it("sem tempo em nenhuma fala (as páginas de um documento), pesa pelo tamanho do texto", () => {
    expect(idiomaPredominante([{ texto: "Um parágrafo curto.", idioma: "pt" }, { texto: "A much longer paragraph written entirely in English, page after page.", idioma: "en" }])).toBe("en");
  });

  it("a lacuna, a fala vazia e a fala sem idioma (ou com um que não é da lista) não contam", () => {
    const falas = [
      { inicio: 0, fim: 600, falante: "", texto: "", lacuna: true as const, idioma: "en" },
      fala(600, 900, undefined),
      fala(900, 1000, "xx"),
      fala(1000, 1010, "es"),
      fala(1010, 1020, "es", "   "),
    ];
    expect(idiomasDasFalas(falas)).toEqual([{ idioma: "es", fracao: 1 }]);
  });

  it("nenhum idioma reconhecido: null, e quem grava fica com o padrão", () => {
    expect(idiomaPredominante([fala(0, 10, undefined)])).toBeNull();
    expect(idiomaPredominante([])).toBeNull();
  });

  it("no empate, vale o idioma que apareceu primeiro", () => {
    expect(idiomaPredominante([fala(0, 10, "fr"), fala(10, 20, "de")])).toBe("fr");
    expect(idiomaPredominante([fala(0, 10, "de"), fala(10, 20, "fr")])).toBe("de");
  });
});
