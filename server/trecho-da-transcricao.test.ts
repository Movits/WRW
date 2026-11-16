import { describe, expect, it } from "vitest";
import { FALAS_DA_REUNIAO_SINTETICA, TRANSCRICAO_DA_REUNIAO_SINTETICA } from "./test/reuniao-sintetica";
import { limparRotulos, localizarTrecho, ocorrenciasDoTrecho, trechoApareceNaTranscricao, trechoDentroDaRegra, vizinhanca } from "./trecho-da-transcricao";
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

/**
 * A regra do prompt, "5 a 30 palavras seguidas", com as falas da reunião
 * sintética da bancada de 16/11 (inventada; achado 9: um "[...]" emendava a
 * fala 33 à 60 e esticava a vizinhança do item até lá).
 */
describe("trecho com reticências: 30 palavras seguidas", () => {
  const FALAS = FALAS_DA_REUNIAO_SINTETICA;
  const TEXTO = TRANSCRICAO_DA_REUNIAO_SINTETICA;
  const KIT = "Fica decidido então: o kit de Natal vai ter 200 unidades, e não 500.";
  const LONGE = `${KIT} [...] a embalagem do kit vai ser o saquinho de algodão da Tecelagem Aurora, e o acetato sai.`;
  // 43 palavras.
  const MEIO = "porque antes eu preciso conversar com o pessoal do financeiro, revisar os números do trimestre, ver o que mudou no frete, confirmar o desconto com o fornecedor e ainda alinhar com a equipe de vendas o que cada um vai fazer, então eu";

  it("pedaços que só aparecem longe uns dos outros não são uma ocorrência, com falas ou no texto corrido", () => {
    // Os dois pedaços estão na reunião, na ordem, mas a mais de 200 palavras e
    // em turnos diferentes (falas 33 e 60).
    expect(ocorrenciasDoTrecho(LONGE, TEXTO, FALAS)).toEqual([]);
    expect(ocorrenciasDoTrecho(LONGE, TEXTO, [])).toEqual([]);
  });

  it("o Pergunte, que aceita a citação só pela presença, segue com o ▶ no começo dela", () => {
    // A citação do Pergunte não passa pela regra (trechoApareceNaTranscricao):
    // o ▶ vai para a fala 33, onde ela começa, em vez de sumir.
    expect(trechoApareceNaTranscricao(LONGE, TEXTO)).toBe(true);
    expect(localizarTrecho(LONGE, FALAS)).toBe(409);
    // Com uma vez dentro da regra, vale ela: "Eu te apresento" (fala 42).
    expect(localizarTrecho("Eu te apresento … até sexta", FALAS)).toBe(489);
  });

  it("no mesmo turno os pedaços contam, por mais palavras que haja entre eles; no envio único, sem falas, vale a conta", () => {
    // A fala 2 tem 46 palavras entre os dois pedaços, numa fala só: a
    // vizinhança, medida em turnos, é a mesma, e o trecho fica como veio.
    const fala2 = "Eu tenho a Tecelagem Aurora. [...] alguém que entenda de certificação orgânica para exportação.";
    expect(trechoDentroDaRegra(fala2, TEXTO, FALAS)).toBe(fala2);
    expect(ocorrenciasDoTrecho(fala2, TEXTO, FALAS).map(o => o.inicio)).toEqual([44]);
    expect(localizarTrecho(fala2, FALAS)).toBe(44);
    expect(trechoDentroDaRegra(fala2, TEXTO, [])).toBe("Eu tenho a Tecelagem Aurora.");
    // Falas seguidas da mesma voz são um turno só, como a IA as lê.
    const turno: Segmento[] = [
      { inicio: 0, fim: 4, falante: "F1", texto: "Eu mando a proposta." },
      { inicio: 4, fim: 25, falante: "F1", texto: `Mas ${MEIO}` },
      { inicio: 25, fim: 28, falante: "F1", texto: "entrego até sexta-feira." },
      { inicio: 28, fim: 31, falante: "F2", texto: "Combinado, fico esperando." },
    ];
    const trecho = "Eu mando a proposta [...] até sexta-feira.";
    expect(ocorrenciasDoTrecho(trecho, "", turno).map(o => [o.inicio, [...o.falantes].sort()])).toEqual([[0, ["F1", "F2"]]]);
    expect(trechoDentroDaRegra(trecho, turno.map(f => f.texto).join("\n"), turno)).toBe(trecho);
  });

  it("dentro de 30 palavras seguidas, mesmo cruzando falas, segue achado", () => {
    expect(localizarTrecho("Eu te apresento … até sexta", FALAS)).toBe(489);
    // Fala 41 ("Eu não conheço a Sônia.") e começo da 42: 12 palavras.
    expect(localizarTrecho("Eu não conheço a Sônia … Mando um e-mail", FALAS)).toBe(487);
  });

  it("trechoDentroDaRegra corta antes das reticências que saem da regra, sem o resto do [...]", () => {
    expect(trechoDentroDaRegra(LONGE, TEXTO, FALAS)).toBe(KIT);
    expect(trechoDentroDaRegra(LONGE, TEXTO, [])).toBe(KIT);
    // Três pedaços: os dois primeiros cabem (fala 42); o terceiro é a fala 117.
    expect(trechoDentroDaRegra("Eu te apresento … até sexta … Faço isso até o fim do mês", TEXTO, FALAS)).toBe("Eu te apresento … até sexta");
  });

  it("trechoDentroDaRegra devolve como veio o trecho sem reticências (mesmo acima de 30 palavras), o que cabe e o que nem aparece", () => {
    // A pauta (fala 1) tem 39 palavras seguidas: é cópia literal, não emenda nada.
    const pauta = "A pauta de hoje tem quatro pontos. Primeiro, os números da Cacau Tupinã e o kit de Natal para empresas. Segundo, a embalagem desse kit. Terceiro, a venda para São Paulo. E por último, os eventos do primeiro semestre.";
    expect(trechoDentroDaRegra(pauta, TEXTO, FALAS)).toBe(pauta);
    expect(trechoDentroDaRegra("Eu te apresento … até sexta", TEXTO, FALAS)).toBe("Eu te apresento … até sexta");
    // Quem chama recusa o que nem aparece (trechoApareceNaTranscricao).
    expect(trechoDentroDaRegra("o kit vai ter 300 unidades … e o acetato fica", TEXTO, FALAS)).toBe("o kit vai ter 300 unidades … e o acetato fica");
  });

  it("trechoDentroDaRegra: com o começo abaixo de 5 palavras, fica a maior das outras partes; sem nenhuma de 5, null", () => {
    // "Eu sei." é a fala 84; "Faço isso até o fim do mês.", a 117; "Coloco, sim.", a 119.
    expect(trechoDentroDaRegra("Eu sei. [...] Faço isso até o fim do mês.", TEXTO, FALAS)).toBe("Faço isso até o fim do mês.");
    expect(trechoDentroDaRegra("Eu sei. [...] Coloco, sim.", TEXTO, FALAS)).toBeNull();
  });

  it("em chinês e japonês, cada caractere conta como uma palavra", () => {
    const falas: Segmento[] = [
      { inicio: 0, fim: 6, falante: "F1", texto: "我们下周五之前完成报告。" },
      { inicio: 6, fim: 9, falante: "F2", texto: "好的,我来负责。" },
      { inicio: 9, fim: 20, falante: "F1", texto: "然后我们讨论一下明年的展会计划和预算安排以及参展人员名单和时间表的问题。" },
      { inicio: 20, fim: 25, falante: "F2", texto: "我完全同意这个计划。" },
    ];
    const texto = falas.map(f => f.texto).join("\n");
    // 11 + 2 + 4 caracteres: cabe.
    expect(ocorrenciasDoTrecho("我们下周五之前完成报告……我来负责", texto, falas).map(o => o.inicio)).toEqual([0]);
    // Passa a fala de 35 caracteres: está na reunião, mas não em 30 seguidas.
    expect(trechoApareceNaTranscricao("我们下周五之前完成报告……我完全同意", texto)).toBe(true);
    expect(ocorrenciasDoTrecho("我们下周五之前完成报告……我完全同意", texto, falas)).toEqual([]);
    expect(trechoDentroDaRegra("我们下周五之前完成报告……我完全同意", texto, falas)).toBe("我们下周五之前完成报告");
  });

  it("a parte cortada sai sem a sobra das reticências de largura total e sem a aspa que ficou sozinha", () => {
    const falas: Segmento[] = [
      { inicio: 0, fim: 6, falante: "F1", texto: "我们下周五之前完成报告。" },
      { inicio: 6, fim: 9, falante: "F2", texto: "好的,我来负责。" },
      { inicio: 9, fim: 20, falante: "F1", texto: "然后我们讨论一下明年的展会计划和预算安排以及参展人员名单和时间表的问题。" },
      { inicio: 20, fim: 25, falante: "F2", texto: "我完全同意这个计划。" },
    ];
    const texto = falas.map(f => f.texto).join("\n");
    expect(trechoDentroDaRegra("我们下周五之前完成报告（……）我完全同意这个计划", texto, falas)).toBe("我们下周五之前完成报告");
    expect(trechoDentroDaRegra("我们下周五之前完成报告。【…】我完全同意这个计划", texto, falas)).toBe("我们下周五之前完成报告。");
    // O começo ("好的,我来") não chega a 5 palavras: fica a outra parte, sem o "）".
    expect(trechoDentroDaRegra("好的,我来（……）我完全同意这个计划", texto, falas)).toBe("我完全同意这个计划");
    // As aspas em volta do trecho: a parte que fica levava só a de abertura.
    expect(trechoDentroDaRegra(`“${KIT} […] a embalagem do kit vai ser o saquinho de algodão da Tecelagem Aurora, e o acetato sai.”`, TEXTO, FALAS)).toBe(KIT);
    // Aspas que fecham dentro da parte ficam.
    expect(trechoDentroDaRegra(`“${KIT}” [...] “a embalagem do kit vai ser o saquinho de algodão da Tecelagem Aurora, e o acetato sai.”`, TEXTO, FALAS)).toBe(`“${KIT}”`);
  });
});
