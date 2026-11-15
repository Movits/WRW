import { describe, expect, it } from "vitest";
import { limparRotulos, localizarTrecho, ocorrenciasDoTrecho, trechoApareceNaTranscricao, vizinhanca } from "./trecho-da-transcricao";
import type { Segmento } from "./transcricao-de-fatia";

/**
 * Onde está o trecho que sustenta o que a IA disse da reunião: o segundo em
 * que ele começa (o "▶ mm:ss" da tela) e o que foi dito em volta (onde
 * responsável e prazo de um item do resumo precisam aparecer).
 */

const FALAS: Segmento[] = [
  { inicio: 0, fim: 6, falante: "F1", texto: "Bom dia. O Roberto vai cuidar da publicação nas lojas." },
  { inicio: 6, fim: 14, falante: "F2", texto: "Certo. O contêiner sai do porto de Santos no dia 12 de março." },
  { inicio: 14, fim: 21, falante: "F1", texto: "Então a Carla fecha o contrato com o importador" },
  { inicio: 21, fim: 25, falante: "F1", texto: "até sexta-feira, sem falta." },
  { inicio: 25, fim: 40, falante: "", texto: "", lacuna: true },
  { inicio: 40, fim: 47, falante: "F3", texto: "Decidimos não renovar o contrato com a transportadora antiga." },
  { inicio: 47, fim: 52, falante: "F2", texto: "Falta ver o seguro da carga." },
  { inicio: 52, fim: 58, falante: "F3", texto: "Vamos falar das feiras do ano que vem." },
  { inicio: 58, fim: 65, falante: "F1", texto: "A feira de Colônia é em fevereiro." },
  { inicio: 3725, fim: 3731, falante: "F2", texto: "Eu preparo a planilha de custos do frete." },
];
const TEXTO = FALAS.filter(f => !f.lacuna).map(f => f.texto).join("\n");

describe("limparRotulos", () => {
  it("tira o tempo e o rótulo de voz que a IA copiou junto da fala, em qualquer posição", () => {
    expect(limparRotulos("[00:14] {F1}: Então a Carla fecha o contrato")).toBe("Então a Carla fecha o contrato");
    expect(limparRotulos("F2: o contêiner sai [1:02:03] do porto")).toBe("o contêiner sai do porto");
    expect(limparRotulos("o contêiner sai do porto")).toBe("o contêiner sai do porto");
  });
});

describe("trechoApareceNaTranscricao (movida de reuniao-com-ia.ts)", () => {
  it("aceita negação, que é decisão legítima, e recusa trecho inventado", () => {
    expect(trechoApareceNaTranscricao("Decidimos não renovar o contrato", TEXTO)).toBe(true);
    expect(trechoApareceNaTranscricao("Decidimos renovar o contrato", TEXTO)).toBe(false);
  });
});

describe("localizarTrecho", () => {
  it("devolve o início da fala em que o trecho começa", () => {
    expect(localizarTrecho("o contêiner sai do porto de Santos", FALAS)).toBe(6);
    expect(localizarTrecho("Eu preparo a planilha de custos do frete", FALAS)).toBe(3725);
  });

  it("acha o trecho que cruza duas falas e devolve o início da primeira", () => {
    expect(localizarTrecho("fecha o contrato com o importador até sexta-feira", FALAS)).toBe(14);
  });

  it("aceita reticências e rótulos, mas não pedaços fora de ordem", () => {
    expect(localizarTrecho("a Carla fecha … até sexta-feira", FALAS)).toBe(14);
    expect(localizarTrecho("até sexta-feira … a Carla fecha", FALAS)).toBeNull();
  });

  it("null sem falas (envio único), com trecho que não está nelas ou curto demais", () => {
    expect(localizarTrecho("o contêiner sai do porto de Santos", [])).toBeNull();
    expect(localizarTrecho("o navio chega amanhã cedo", FALAS)).toBeNull();
    expect(localizarTrecho("sim", FALAS)).toBeNull();
  });
});

describe("vizinhanca", () => {
  it("as falas do trecho e as de até 3 turnos de cada lado, com quem falou nelas", () => {
    // Turnos: F1 | F2 | F1 (2 falas) | F3 | F2 | F3 | F1 | F2. A planilha é o
    // último turno: vão os 3 anteriores, e a decisão (F3) fica de fora.
    const emVolta = vizinhanca("Eu preparo a planilha de custos do frete", TEXTO, FALAS)!;
    expect(emVolta.texto).toContain("seguro da carga");
    expect(emVolta.texto).toContain("feira de Colônia");
    expect(emVolta.texto).not.toContain("Decidimos");
    expect([...emVolta.falantes].sort()).toEqual(["F1", "F2", "F3"]);
  });

  it("falas seguidas da mesma voz são um turno só, como a IA as lê; a lacuna não conta", () => {
    // A decisão é o 4º turno: as duas falas seguidas da F1 contam como um, e o
    // 1º turno (o Roberto) entra nos 3 anteriores.
    const emVolta = vizinhanca("Decidimos não renovar o contrato", TEXTO, FALAS)!;
    expect(emVolta.texto).toContain("Roberto");
    expect(emVolta.texto).toContain("feira de Colônia");
    expect(emVolta.texto).not.toContain("planilha");
  });

  it("no envio único, sem falas, 400 letras de cada lado no texto corrido", () => {
    const longo = `${"palavra ".repeat(100)}o contrato foi assinado hoje${" outra".repeat(200)}`;
    const emVolta = vizinhanca("o contrato foi assinado hoje", longo, [])!;
    expect(emVolta.falantes.size).toBe(0);
    expect(emVolta.texto).toContain("o contrato foi assinado hoje");
    expect(emVolta.texto.length).toBeLessThan(longo.length);
    expect(emVolta.texto.length).toBeGreaterThan(800);
  });

  it("null quando o trecho não está na transcrição", () => {
    expect(vizinhanca("o navio chega amanhã cedo", TEXTO, FALAS)).toBeNull();
    expect(vizinhanca("o navio chega amanhã cedo", TEXTO, [])).toBeNull();
  });
});

describe("ocorrenciasDoTrecho", () => {
  it("a frase dita mais de uma vez dá uma ocorrência por vez, cada uma com o seu tempo e o seu entorno", () => {
    const repetida: Segmento[] = [
      { inicio: 0, fim: 5, falante: "F1", texto: "Eu vou mandar a proposta amanhã cedo." },
      { inicio: 5, fim: 9, falante: "F3", texto: "Combinado." },
      { inicio: 300, fim: 306, falante: "F2", texto: "Eu vou mandar a proposta amanhã cedo, sem falta." },
    ];
    const ocorrencias = ocorrenciasDoTrecho("vou mandar a proposta amanhã cedo", "", repetida);
    expect(ocorrencias.map(o => o.inicio)).toEqual([0, 300]);
    expect(ocorrencias[1].falantes.has("F2")).toBe(true);
  });

  it("fala só com pontuação no meio não impede achar o trecho que a atravessa", () => {
    const comPausa: Segmento[] = [
      { inicio: 0, fim: 4, falante: "F1", texto: "Então a gente fecha o contrato" },
      { inicio: 4, fim: 5, falante: "F2", texto: "..." },
      { inicio: 5, fim: 9, falante: "F1", texto: "até sexta-feira." },
    ];
    expect(ocorrenciasDoTrecho("fecha o contrato até sexta-feira", "", comPausa).map(o => o.inicio)).toEqual([0]);
  });

  it("no envio único, sem falas, sem tempo", () => {
    expect(ocorrenciasDoTrecho("Decidimos não renovar o contrato", TEXTO, []).map(o => o.inicio)).toEqual([null]);
  });
});
