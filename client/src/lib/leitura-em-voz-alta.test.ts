import { describe, expect, it } from "vitest";
import { escolherVoz, falasCurtas, type VozDoAparelho } from "./leitura-em-voz-alta";

/**
 * As partes puras de "Ouvir o resumo" (H19): qual voz do aparelho lê o idioma
 * do resumo e como o texto vira falas curtas. O tocar, pausar e continuar
 * está em components/OuvirOResumo.test.tsx.
 */

const voz = (name: string, lang: string, padrao = false): VozDoAparelho => ({ name, lang, default: padrao, localService: true });
// A voz de rede do navegador: o texto vai a um servidor do Google ou da Microsoft para virar som.
const deRede = (name: string, lang: string, padrao = false): VozDoAparelho => ({ name, lang, default: padrao, localService: false });

describe("escolherVoz", () => {
  it("só serve voz do idioma do resumo: sem nenhuma, null (a tela explica em vez de ler com outra pronúncia)", () => {
    const vozes = [voz("Microsoft David", "en-US", true), voz("Microsoft Hedda", "de-DE")];
    expect(escolherVoz(vozes, "pt-BR")).toBeNull();
    expect(escolherVoz([], "en")).toBeNull();
    expect(escolherVoz(vozes, "de")?.name).toBe("Microsoft Hedda");
  });

  it("a voz de rede (as \"Google …\" do Chrome, as \"Online (Natural)\" do Edge) nunca serve: o idioma que só tem ela fica sem voz", () => {
    // O Chrome num Windows em português: a Maria é local, as do Google são de rede.
    const doChrome = [voz("Microsoft Maria", "pt-BR", true), deRede("Google 日本語", "ja-JP"), deRede("Google Deutsch", "de-DE"), deRede("Google US English", "en-US")];
    expect(escolherVoz(doChrome, "ja")).toBeNull();
    expect(escolherVoz(doChrome, "de")).toBeNull();
    expect(escolherVoz(doChrome, "pt-BR")?.name).toBe("Microsoft Maria");
    // Mesmo da região preferida e marcada como padrão, a de rede perde para a local.
    const doEdge = [deRede("Microsoft Francisca Online (Natural) - Portuguese (Brazil)", "pt-BR", true), voz("Microsoft Helia", "pt-PT")];
    expect(escolherVoz(doEdge, "pt-BR")?.name).toBe("Microsoft Helia");
    // Sem a informação (navegador antigo), a voz conta como local.
    expect(escolherVoz([{ name: "Antiga", lang: "en-US", default: false }], "en")?.name).toBe("Antiga");
  });

  it("o português do resumo prefere a voz do Brasil, mesmo depois de uma de Portugal ou de uma padrão", () => {
    const vozes = [voz("Joana", "pt-PT", true), voz("Luciana", "pt-BR")];
    expect(escolherVoz(vozes, "pt-BR")?.name).toBe("Luciana");
    // Sem voz do Brasil, a de Portugal serve.
    expect(escolherVoz([voz("Joana", "pt-PT")], "pt-BR")?.name).toBe("Joana");
  });

  it("a etiqueta do aparelho vale em qualquer grafia: 'pt_BR' (Android), 'PT-br' e só 'pt'", () => {
    expect(escolherVoz([voz("Android", "pt_BR")], "pt-BR")?.name).toBe("Android");
    expect(escolherVoz([voz("Maiúscula", "PT-br")], "pt-BR")?.name).toBe("Maiúscula");
    expect(escolherVoz([voz("Seca", "pt")], "pt-BR")?.name).toBe("Seca");
    expect(escolherVoz([voz("Inglês", "en_GB")], "en")?.name).toBe("Inglês");
  });

  it("chinês: o mandarim da China continental primeiro, o cantonês de Hong Kong por último, e o 'cmn' também é chinês", () => {
    const vozes = [voz("Sin-ji", "zh-HK", true), voz("Mei-Jia", "zh-TW"), voz("Ting-Ting", "zh-CN")];
    expect(escolherVoz(vozes, "zh")?.name).toBe("Ting-Ting");
    expect(escolherVoz([voz("Sin-ji", "zh-HK", true), voz("Mei-Jia", "zh-TW")], "zh")?.name).toBe("Mei-Jia");
    expect(escolherVoz([voz("Sin-ji", "zh-HK")], "zh")?.name).toBe("Sin-ji");
    expect(escolherVoz([voz("Android", "cmn-CN")], "zh")?.name).toBe("Android");
  });

  it("entre as do idioma: a padrão do aparelho e, sem ela, a primeira da lista; as de brincadeira do macOS nunca na frente", () => {
    expect(escolherVoz([voz("Daniel", "en-GB"), voz("Samantha", "en-US", true)], "en")?.name).toBe("Samantha");
    expect(escolherVoz([voz("Daniel", "en-GB"), voz("Samantha", "en-US")], "en")?.name).toBe("Daniel");
    // O Safari do Mac lista "Albert" e "Bad News" antes, e uma delas pode até ser a padrão.
    expect(escolherVoz([voz("Albert", "en-US"), voz("Bad News", "en-US", true), voz("Samantha", "en-US")], "en")?.name).toBe("Samantha");
    // Só as de brincadeira: lê com elas, em vez de dizer que não há voz.
    expect(escolherVoz([voz("Albert", "en-US")], "en")?.name).toBe("Albert");
  });

  it("no Mac, as vozes robóticas da Eloquence vêm antes na lista e o Safari marca todas como padrão: a voz de verdade ganha", () => {
    const doSafari = [
      voz("Eddy (Português (Brasil))", "pt-BR", true),
      voz("Flo (Português (Brasil))", "pt-BR", true),
      voz("Luciana", "pt-BR", true),
      voz("Shelley (Português (Brasil))", "pt-BR", true),
    ];
    expect(escolherVoz(doSafari, "pt-BR")?.name).toBe("Luciana");
    // O nome que o Chrome do Mac mostra, em inglês, também.
    expect(escolherVoz([voz("Grandma (English (US))", "en-US"), voz("Samantha", "en-US")], "en")?.name).toBe("Samantha");
    // Só a Eloquence: lê com ela, em vez de dizer que não há voz.
    expect(escolherVoz([voz("Eddy (Português (Brasil))", "pt-BR", true)], "pt-BR")?.name).toBe("Eddy (Português (Brasil))");
  });
});

describe("falasCurtas", () => {
  it("uma fala por frase, sem cortar número com ponto nem deixar fala vazia", () => {
    expect(falasCurtas("Ana envia a proposta. Bia liga para o fornecedor! E o seguro?  ", "pt-BR"))
      .toEqual(["Ana envia a proposta.", "Bia liga para o fornecedor!", "E o seguro?"]);
    expect(falasCurtas("O frete subiu 3.5% em março. Fim", "pt-BR")).toEqual(["O frete subiu 3.5% em março.", "Fim"]);
    expect(falasCurtas("   ", "pt-BR")).toEqual([]);
    expect(falasCurtas("Ações", "pt-BR")).toEqual(["Ações"]);
  });

  it("chinês, japonês, árabe e hindi: o final da frase dispensa o espaço", () => {
    expect(falasCurtas("我们决定续约。谁来付保险？", "zh")).toEqual(["我们决定续约。", "谁来付保险？"]);
    expect(falasCurtas("契約を更新します。保険は誰が払いますか？", "ja")).toEqual(["契約を更新します。", "保険は誰が払いますか？"]);
    expect(falasCurtas("هل نجدد العقد؟ نعم", "ar")).toEqual(["هل نجدد العقد؟", "نعم"]);
    expect(falasCurtas("हम अनुबंध नवीनीकृत करेंगे। बीमा कौन देगा?", "hi")).toEqual(["हम अनुबंध नवीनीकृत करेंगे।", "बीमा कौन देगा?"]);
  });

  it("frase longa é cortada numa pausa antes do teto de 160 caracteres, e nada se perde", () => {
    const frase = `${"a reunião tratou do frete marítimo ".repeat(3).trim()}, ${"do seguro da carga e da licença ".repeat(4).trim()}.`;
    expect(frase.length).toBeGreaterThan(160);
    const falas = falasCurtas(frase, "pt-BR");
    expect(falas.length).toBeGreaterThan(1);
    for (const fala of falas) expect(fala.length).toBeLessThanOrEqual(160);
    expect(falas[0].endsWith(",")).toBe(true);
    expect(falas.join(" ")).toBe(frase);
  });

  it("sem pausa, corta no último espaço; sem espaço, corta seco no teto, sem partir um emoji ao meio", () => {
    const palavras = "palavra ".repeat(30).trim();
    const falas = falasCurtas(palavras, "pt-BR");
    for (const fala of falas) {
      expect(fala.length).toBeLessThanOrEqual(160);
      expect(fala.startsWith("palavra") && fala.endsWith("palavra")).toBe(true);
    }
    expect(falas.join(" ")).toBe(palavras);

    // 159 letras e um emoji (dois caracteres de UTF-16) cruzando o teto.
    const seco = `${"a".repeat(159)}😀${"b".repeat(20)}`;
    const cortado = falasCurtas(seco, "pt-BR");
    expect(cortado).toEqual(["a".repeat(159), `😀${"b".repeat(20)}`]);
  });

  it("no chinês e no japonês o teto é menor (60): cada caractere leva mais tempo para ser lido", () => {
    const longo = `${"会议讨论了海运费用和货物保险，".repeat(6)}结束。`;
    const falas = falasCurtas(longo, "zh");
    expect(falas.length).toBeGreaterThan(1);
    for (const fala of falas) expect(fala.length).toBeLessThanOrEqual(60);
    expect(falas.join("")).toBe(longo);
  });
});
