import { describe, expect, it } from "vitest";
import { responsavelDeVolta, textoDeVolta, textoExibido, vozesCitadas } from "@shared/vozes-na-edicao";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * O caminho de volta dos rótulos de voz, quando a dona edita um item do resumo
 * (H4f): ela edita com os nomes (ou "Falante n") no lugar dos rótulos, e o que
 * ela salva volta a levar o {Fn} onde estava a voz — só quando não há dúvida.
 * O teste não depende do i18n: o "Falante n" vem de uma função qualquer, como
 * a tela passa o traduzido.
 */
const nomes: Record<string, string> = { F1: "Ana", F2: "Carla", F4: "Ana" };
const exibir = (falante: string) => vozesNoTexto(`{${falante}}`, nomes, n => `Falante ${n}`);

describe("textoExibido e vozesCitadas", () => {
  it("mostram o texto como a tela e as vozes citadas, uma vez cada, na ordem", () => {
    expect(textoExibido("{F2} manda a proposta para {F3} e {F2} confere", exibir)).toBe("Carla manda a proposta para Falante 3 e Carla confere");
    expect(vozesCitadas("{F2} manda a proposta para {F3} e {F2} confere")).toEqual(["F2", "F3"]);
    expect(vozesCitadas(null)).toEqual([]);
  });

  it("um nome com '$&' entra como está", () => {
    expect(textoExibido("{F1} pagou", () => "Ana $& $1")).toBe("Ana $& $1 pagou");
  });
});

describe("textoDeVolta (texto e assunto)", () => {
  it("sem mudança no que a tela mostrava, o original volta intacto, com os rótulos", () => {
    const original = "{F2} manda a proposta para {F3}";
    expect(textoDeVolta("  Carla manda a proposta para Falante 3  ", original, exibir)).toBe(original);
  });

  it("editado: as vozes que o item citava voltam a ser rótulo, onde quer que estejam", () => {
    expect(textoDeVolta("Carla manda a proposta revisada para Falante 3 até sexta; Carla avisa", "{F2} manda a proposta para {F3}", exibir))
      .toBe("{F2} manda a proposta revisada para {F3} até sexta; {F2} avisa");
  });

  it("um nome digitado à mão fica como texto, mesmo sendo o de uma voz que o item não citava", () => {
    // Pode ser outra Carla: o item original não falava dela.
    expect(textoDeVolta("Falante 3 liga para a Carla do financeiro", "{F3} liga para o financeiro", exibir))
      .toBe("{F3} liga para a Carla do financeiro");
    // No item novo (sem original), nada vira rótulo.
    expect(textoDeVolta("Carla manda a proposta", null, exibir)).toBe("Carla manda a proposta");
  });

  it("só a palavra inteira: 'Ana' não vira rótulo dentro de 'Anastácia', nem 'Falante 1' dentro de 'Falante 12'", () => {
    const nomesSemAna = { F2: "Ana" };
    const mostrar = (falante: string) => vozesNoTexto(`{${falante}}`, nomesSemAna, n => `Falante ${n}`);
    expect(textoDeVolta("Ana e Anastácia; Ana.", "{F2} fala", mostrar)).toBe("{F2} e Anastácia; {F2}.");
    expect(textoDeVolta("Falante 1 e Falante 12", "{F1} fala", mostrar)).toBe("{F1} e Falante 12");
    // Acento combinado (a + U+0301) e letra fora do plano básico contam como letra colada.
    expect(textoDeVolta("Aná e Ana𝐀 e Ana", "{F2} fala", mostrar)).toBe("Aná e Ana𝐀 e {F2}");
  });

  it("o nome mais longo vence: 'Ana Paula' não vira o rótulo de 'Ana'", () => {
    const duas = { F1: "Ana", F2: "Ana Paula" };
    const mostrar = (falante: string) => vozesNoTexto(`{${falante}}`, duas, n => `Falante ${n}`);
    expect(textoDeVolta("Ana Paula fala com Ana", "{F1} e {F2}", mostrar)).toBe("{F2} fala com {F1}");
  });

  it("duas vozes com o mesmo nome: a posição separa as duas no trecho que não mudou; no trecho mudado, ficam como texto", () => {
    // F1 e F4 se chamam "Ana".
    expect(textoDeVolta("Ana e Ana conversam com Carla", "{F1} e {F4} conversam", exibir)).toBe("{F1} e {F4} conversam com Carla");
    expect(textoDeVolta("Carla conversa com Ana", "{F1} e {F4} conversam", exibir)).toBe("Carla conversa com Ana");
    expect(textoDeVolta("Ana fala com Ana e Ana", "{F1} fala com {F4}", exibir)).toBe("{F1} fala com {F4} e Ana");
    // Sem mudança, o original volta com os dois rótulos.
    expect(textoDeVolta("Ana e Ana conversam", "{F1} e {F4} conversam", exibir)).toBe("{F1} e {F4} conversam");
  });

  it("chinês e japonês, sem espaço entre as palavras: a voz que a dona não tocou volta a rótulo, colada ou não", () => {
    const zh = { F1: "卡拉" };
    const mostrar = (falante: string) => vozesNoTexto(`{${falante}}`, zh, n => `发言人 ${n}`);
    expect(textoDeVolta("卡拉明天发送提案", "{F1}发送提案", mostrar)).toBe("{F1}明天发送提案");
    expect(textoDeVolta("卡拉，明天发送", "{F1}发送提案", mostrar)).toBe("{F1}，明天发送");
  });
});

describe("textoDeVolta: o trecho que a dona não mudou volta pela posição", () => {
  // O japonês e o chinês não separam as palavras, e o árabe e o alemão colam
  // partícula ao nome: a regra da palavra inteira perdia o rótulo.
  const comNomes = (nomesDasVozes: Record<string, string>, rotulo: (n: number) => string) =>
    (falante: string) => vozesNoTexto(`{${falante}}`, nomesDasVozes, rotulo);
  const ja = comNomes({ F1: "田中" }, n => `話者 ${n}`);
  const ar = comNomes({ F1: "سارة", F2: "علي" }, n => `المتحدث ${n}`);

  it("japonês e chinês: o nome colado à palavra seguinte volta a rótulo quando a dona muda outro trecho", () => {
    expect(textoDeVolta("田中さんが資料を送る（月曜）", "{F1}さんが資料を送る", ja)).toBe("{F1}さんが資料を送る（月曜）");
    expect(textoDeVolta("田中が資料を送る（月曜）", "{F1}が資料を送る", ja)).toBe("{F1}が資料を送る（月曜）");
    // A voz sem nome: o "話者 1" da tela volta a ser o rótulo, e não fica gravado no idioma da tela da dona.
    const jaSemNome = comNomes({}, n => `話者 ${n}`);
    expect(textoDeVolta("話者 1さんが資料を送る（月曜）", "{F1}さんが資料を送る", jaSemNome)).toBe("{F1}さんが資料を送る（月曜）");
    const zh = comNomes({ F1: "田中" }, n => `发言人 ${n}`);
    expect(textoDeVolta("田中负责发送提案（周一）", "{F1}负责发送提案", zh)).toBe("{F1}负责发送提案（周一）");
    expect(textoDeVolta("发言人 1负责发送提案（周一）", "{F1}负责发送提案", comNomes({}, n => `发言人 ${n}`))).toBe("{F1}负责发送提案（周一）");
  });

  it("árabe e alemão: a partícula colada ao nome não derruba o rótulo", () => {
    expect(textoDeVolta("سارة وعلي يرسلان العرض (الاثنين)", "{F1} و{F2} يرسلان العرض", ar)).toBe("{F1} و{F2} يرسلان العرض (الاثنين)");
    const de = comNomes({ F1: "Anna" }, n => `Sprecher ${n}`);
    expect(textoDeVolta("Annas Vorschlag (Montag)", "{F1}s Vorschlag", de)).toBe("{F1}s Vorschlag (Montag)");
  });

  it("a voz encostada no trecho mudado volta se o vizinho novo ainda a separa", () => {
    // Sem espaço entre as palavras, todo vizinho separa: tirar o "さん" mantém a voz.
    expect(textoDeVolta("田中が資料を送る", "{F1}さんが資料を送る", ja)).toBe("{F1}が資料を送る");
    // A partícula árabe nova, depois do espaço, também.
    expect(textoDeVolta("سارة وعلي يرسلان العرض", "{F1} {F2} يرسلان العرض", ar)).toBe("{F1} و{F2} يرسلان العرض");
    // A pontuação nova separa.
    const mostrar = comNomes({ F2: "Ana" }, n => `Falante ${n}`);
    expect(textoDeVolta("Ana, fala", "{F2} fala", mostrar)).toBe("{F2}, fala");
    // "Ana" que virou "Anabela" (ou "JoAna") é outro nome: fica como texto.
    expect(textoDeVolta("Anabela fala", "{F2} fala", mostrar)).toBe("Anabela fala");
    expect(textoDeVolta("JoAna fala", "{F2} fala", mostrar)).toBe("JoAna fala");
  });

  it("no trecho mudado vale a palavra inteira: o nome colado que a dona digitou fica como texto (pode ser outra palavra)", () => {
    const zh = comNomes({ F1: "卡拉" }, n => `发言人 ${n}`);
    expect(textoDeVolta("资料由卡拉发送", "{F1}发送提案", zh)).toBe("资料由卡拉发送");
  });

  it("o texto que era texto no original continua texto, mesmo igual ao nome de uma voz que o item cita", () => {
    // A "Carla do financeiro" não é a voz F2 (Carla): mudar o fim do item não as junta.
    expect(textoDeVolta("Carla fala com a Carla do financeiro amanhã", "{F2} fala com a Carla do financeiro", exibir))
      .toBe("{F2} fala com a Carla do financeiro amanhã");
  });

  it("a letra fora do plano básico não é partida ao comparar o começo e o fim", () => {
    const mostrar = comNomes({ F2: "Ana" }, n => `Falante ${n}`);
    // 𝐀 e 𝐁 começam pela mesma metade: o começo em comum para antes do par, e
    // a letra nova encostada na voz a deixa como texto.
    expect(textoDeVolta("Ana𝐁 fala", "{F2}𝐀 fala", mostrar)).toBe("Ana𝐁 fala");
    // 𝐀 e 𐐀 terminam pela mesma metade: o fim em comum começa depois do par.
    expect(textoDeVolta("fala 𐐀Ana", "fala 𝐀{F2}", mostrar)).toBe("fala 𐐀Ana");
  });
});

describe("responsavelDeVolta", () => {
  const vozesDaReuniao = ["F1", "F2", "F3", "F4"];

  it("o campo inteiro igual ao de uma voz só vira o rótulo dela, mesmo que o item não a citasse", () => {
    expect(responsavelDeVolta(" Carla ", null, vozesDaReuniao, exibir)).toBe("{F2}");
    expect(responsavelDeVolta("Falante 3", "{F2}", vozesDaReuniao, exibir)).toBe("{F3}");
  });

  it("sem mudança, o original volta; vazio vira nulo", () => {
    expect(responsavelDeVolta("Ana", "{F4}", vozesDaReuniao, exibir)).toBe("{F4}");
    expect(responsavelDeVolta("   ", "{F2}", vozesDaReuniao, exibir)).toBeNull();
  });

  it("o nome de duas vozes ('Ana') e o nome que não é de voz ficam como texto", () => {
    expect(responsavelDeVolta("Ana", null, vozesDaReuniao, exibir)).toBe("Ana");
    expect(responsavelDeVolta("Maria do jurídico", "{F2}", vozesDaReuniao, exibir)).toBe("Maria do jurídico");
  });

  it("vários nomes no campo: só a voz que o original citava volta a rótulo", () => {
    expect(responsavelDeVolta("Carla e Falante 3", "{F2}", vozesDaReuniao, exibir)).toBe("{F2} e Falante 3");
  });

  it("a voz que o original citava conta no campo inteiro, mesmo fora da lista da reunião", () => {
    expect(responsavelDeVolta("Falante 7", "{F7} e {F2}", [], exibir)).toBe("{F7}");
  });
});
