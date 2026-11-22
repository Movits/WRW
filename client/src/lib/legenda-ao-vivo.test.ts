import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAVE_DO_TAMANHO_DA_LETRA, construtorDoReconhecimento, destinoDoErro, ehCelularOuTablet, esperaParaReligar, guardarTamanhoDaLetra,
  idiomaDaLegenda, juntarLinhas, legendaDisponivel, lerResultados, lerTamanhoDaLetra, LEGENDA_NO_CELULAR, LINHAS_DA_LEGENDA_MAX,
  separadorDoIdioma, TAMANHO_DA_LETRA_PADRAO, TAMANHOS_DA_LETRA, type ConstrutorDoReconhecimento, type ListaDeResultados,
} from "./legenda-ao-vivo";

/**
 * As partes puras da legenda ao vivo (G15b): o reconhecimento que o navegador
 * tem, se o botão aparece, o idioma em que a legenda ouve, os resultados em
 * linhas, o destino de cada erro, a espera para religar e a letra guardada.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const lista = (trechos: Array<[string, boolean]>): ListaDeResultados =>
  Object.assign(trechos.map(([texto, final]) => ({ isFinal: final, length: 1, 0: { transcript: texto } })), { length: trechos.length }) as unknown as ListaDeResultados;

const CHROME_NO_COMPUTADOR = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", maxTouchPoints: 0 };
const SAFARI_NO_MAC = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", maxTouchPoints: 0 };
const CHROME_NO_ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", maxTouchPoints: 5 };
const TABLET_ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", maxTouchPoints: 5 };
const IPHONE = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 };
// O iPad do iPadOS 13 em diante se diz Mac: só o toque o entrega.
const IPAD = { userAgent: SAFARI_NO_MAC.userAgent, maxTouchPoints: 5 };
const Construtor = function () {} as unknown as ConstrutorDoReconhecimento;

describe("construtorDoReconhecimento", () => {
  it("sem nenhum (o Firefox), null", () => {
    expect(construtorDoReconhecimento()).toBeNull();
  });

  it("o webkitSpeechRecognition do Chrome, do Edge e do Safari", () => {
    vi.stubGlobal("webkitSpeechRecognition", Construtor);
    expect(construtorDoReconhecimento()).toBe(Construtor);
  });

  it("o sem prefixo, quando há, vem antes", () => {
    const semPrefixo = function () {} as unknown as ConstrutorDoReconhecimento;
    vi.stubGlobal("webkitSpeechRecognition", Construtor);
    vi.stubGlobal("SpeechRecognition", semPrefixo);
    expect(construtorDoReconhecimento()).toBe(semPrefixo);
  });

  it("o que não é função não conta", () => {
    vi.stubGlobal("webkitSpeechRecognition", { nada: true });
    expect(construtorDoReconhecimento()).toBeNull();
  });
});

describe("ehCelularOuTablet", () => {
  it.each([
    ["o Chrome no computador", CHROME_NO_COMPUTADOR, false],
    ["o Safari no Mac", SAFARI_NO_MAC, false],
    ["o Chrome no Android", CHROME_NO_ANDROID, true],
    ["o tablet Android (sem Mobile no agente)", TABLET_ANDROID, true],
    ["o iPhone", IPHONE, true],
    ["o iPad, que se diz Mac", IPAD, true],
    ["o navegador que diz que é móvel", { userAgent: CHROME_NO_COMPUTADOR.userAgent, userAgentData: { mobile: true } }, true],
    ["sem navegador (o servidor)", undefined, false],
  ])("%s", (_nome, navegador, esperado) => {
    expect(ehCelularOuTablet(navegador)).toBe(esperado);
  });
});

describe("legendaDisponivel", () => {
  it("sem o reconhecimento, o botão não aparece, nem no computador", () => {
    expect(legendaDisponivel(null, CHROME_NO_COMPUTADOR)).toBe(false);
  });

  it("com o reconhecimento no computador, aparece", () => {
    expect(legendaDisponivel(Construtor, CHROME_NO_COMPUTADOR)).toBe(true);
    expect(legendaDisponivel(Construtor, SAFARI_NO_MAC)).toBe(true);
  });

  it("no celular e no tablet, não aparece até o teste no aparelho (decisão vetável)", () => {
    expect(LEGENDA_NO_CELULAR).toBe(false);
    for (const aparelho of [CHROME_NO_ANDROID, TABLET_ANDROID, IPHONE, IPAD]) expect(legendaDisponivel(Construtor, aparelho)).toBe(false);
  });

  it("com a legenda liberada no celular, aparece também lá, e só com o reconhecimento", () => {
    expect(legendaDisponivel(Construtor, IPHONE, true)).toBe(true);
    expect(legendaDisponivel(null, IPHONE, true)).toBe(false);
  });
});

describe("idiomaDaLegenda", () => {
  it("o idioma da reunião, com a região padrão quando o navegador não prefere nenhuma", () => {
    expect(idiomaDaLegenda("pt-BR", "en", [])).toEqual({ idioma: "pt-BR", etiqueta: "pt-BR", automatico: false });
    expect(idiomaDaLegenda("en", "pt-BR", [])).toEqual({ idioma: "en", etiqueta: "en-US", automatico: false });
    expect(idiomaDaLegenda("zh", "pt-BR", [])).toEqual({ idioma: "zh", etiqueta: "zh-CN", automatico: false });
  });

  it("a região que o navegador prefere para o mesmo idioma ganha da padrão", () => {
    expect(idiomaDaLegenda("es", "pt-BR", ["pt-BR", "es-MX", "en-US"]).etiqueta).toBe("es-MX");
    // Todo português é o pt-BR da reunião, e o navegador de Portugal ouve em pt-PT.
    expect(idiomaDaLegenda("pt-BR", "pt-BR", ["pt-PT"]).etiqueta).toBe("pt-PT");
    expect(idiomaDaLegenda("zh", "pt-BR", ["zh-TW"]).etiqueta).toBe("zh-TW");
  });

  it("idioma fora dos 10 da tela: o código dele, ou a região preferida", () => {
    expect(idiomaDaLegenda("it", "pt-BR", [])).toEqual({ idioma: "it", etiqueta: "it", automatico: false });
    expect(idiomaDaLegenda("it", "pt-BR", ["it-CH"]).etiqueta).toBe("it-CH");
  });

  it("no “Detectar sozinho”, o idioma da tela, e a tela sabe disso", () => {
    expect(idiomaDaLegenda("auto", "ja", [])).toEqual({ idioma: "ja", etiqueta: "ja-JP", automatico: true });
    expect(idiomaDaLegenda("auto", "pt-BR", ["pt-BR"])).toEqual({ idioma: "pt-BR", etiqueta: "pt-BR", automatico: true });
  });

  it("etiqueta estranha do navegador não vai ao reconhecimento", () => {
    expect(idiomaDaLegenda("en", "pt-BR", ["en_US<script>", "", "x"]).etiqueta).toBe("en-US");
  });
});

describe("separadorDoIdioma", () => {
  it("o chinês e o japonês juntam os trechos sem espaço; os outros, com", () => {
    expect(separadorDoIdioma("zh")).toBe("");
    expect(separadorDoIdioma("ja")).toBe("");
    expect(separadorDoIdioma("pt-BR")).toBe(" ");
    expect(separadorDoIdioma("ar")).toBe(" ");
  });
});

describe("lerResultados", () => {
  it("cada resultado final é uma linha; os provisórios viram o texto provisório", () => {
    expect(lerResultados(lista([["Bom dia a todas.", true], ["Vamos começar", false], ["pela pauta", false]]))).toEqual({
      finais: ["Bom dia a todas."],
      provisorio: "Vamos começar pela pauta",
    });
  });

  it("a lista inteira a cada evento: o resultado que o navegador reescreve não entra duas vezes", () => {
    const primeiro = lerResultados(lista([["Bom dia", false]]));
    const depois = lerResultados(lista([["Bom dia a todas.", true]]));
    expect(primeiro).toEqual({ finais: [], provisorio: "Bom dia" });
    expect(depois).toEqual({ finais: ["Bom dia a todas."], provisorio: "" });
  });

  it("tira os espaços das pontas e pula o resultado vazio ou sem alternativa", () => {
    const comBuraco = Object.assign([{ isFinal: true, length: 1, 0: { transcript: "  olá  " } }, { isFinal: true, length: 0 }, { isFinal: false, length: 1, 0: { transcript: "   " } }], { length: 3 }) as unknown as ListaDeResultados;
    expect(lerResultados(comBuraco)).toEqual({ finais: ["olá"], provisorio: "" });
  });

  it("o separador do idioma junta os provisórios", () => {
    expect(lerResultados(lista([["我们", false], ["开始吧", false]]), "").provisorio).toBe("我们开始吧");
  });
});

describe("juntarLinhas", () => {
  it("junta as novas depois das de antes", () => {
    expect(juntarLinhas(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it(`guarda no máximo ${LINHAS_DA_LEGENDA_MAX} linhas, as mais novas`, () => {
    const antigas = Array.from({ length: LINHAS_DA_LEGENDA_MAX }, (_, i) => `linha ${i}`);
    const juntas = juntarLinhas(antigas, ["nova"]);
    expect(juntas).toHaveLength(LINHAS_DA_LEGENDA_MAX);
    expect(juntas[0]).toBe("linha 1");
    expect(juntas[juntas.length - 1]).toBe("nova");
  });
});

describe("destinoDoErro", () => {
  it.each([
    ["not-allowed", "semPermissao"],
    ["service-not-allowed", "servicoRecusado"],
    ["audio-capture", "semMicrofone"],
    ["language-not-supported", "idiomaSemSuporte"],
  ])("%s desliga com a falha %s", (erro, falha) => {
    expect(destinoDoErro(erro)).toEqual({ tipo: "desligar", falha });
  });

  it.each(["no-speech", "aborted", "network", "algo-novo"])("%s segue: o fim da sessão religa, contando as falhas", erro => {
    expect(destinoDoErro(erro)).toEqual({ tipo: "seguir" });
  });
});

describe("esperaParaReligar", () => {
  it("cresce com as falhas seguidas, até 8 s", () => {
    expect([0, 1, 2, 3, 4, 10].map(esperaParaReligar)).toEqual([250, 500, 1000, 2000, 4000, 8000]);
    expect(esperaParaReligar(-1)).toBe(250);
  });
});

describe("o tamanho da letra no aparelho", () => {
  const armazenamento = (valor: string | null) => ({ getItem: vi.fn(() => valor), setItem: vi.fn() });

  it("sem nada guardado, o padrão (e não a primeira posição)", () => {
    expect(lerTamanhoDaLetra(armazenamento(null))).toBe(TAMANHO_DA_LETRA_PADRAO);
    expect(TAMANHO_DA_LETRA_PADRAO).not.toBe(0);
  });

  it("o guardado, se for uma posição de verdade", () => {
    expect(lerTamanhoDaLetra(armazenamento("0"))).toBe(0);
    expect(lerTamanhoDaLetra(armazenamento(String(TAMANHOS_DA_LETRA.length - 1)))).toBe(TAMANHOS_DA_LETRA.length - 1);
  });

  it.each(["", " ", "abc", "1.5", "-1", "1e0", String(TAMANHOS_DA_LETRA.length)])("o valor estranho %j volta ao padrão", valor => {
    expect(lerTamanhoDaLetra(armazenamento(valor))).toBe(TAMANHO_DA_LETRA_PADRAO);
  });

  it("o acesso recusado (janela anônima) volta ao padrão e guardar não quebra", () => {
    const recusado = { getItem: () => { throw new DOMException("negado", "SecurityError"); }, setItem: () => { throw new DOMException("negado", "SecurityError"); } };
    expect(lerTamanhoDaLetra(recusado)).toBe(TAMANHO_DA_LETRA_PADRAO);
    expect(() => guardarTamanhoDaLetra(3, recusado)).not.toThrow();
    expect(lerTamanhoDaLetra(null)).toBe(TAMANHO_DA_LETRA_PADRAO);
  });

  it("guarda a posição na marca do app", () => {
    const destino = armazenamento(null);
    guardarTamanhoDaLetra(3, destino);
    expect(destino.setItem).toHaveBeenCalledWith(CHAVE_DO_TAMANHO_DA_LETRA, "3");
  });
});
