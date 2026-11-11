import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { CODIGOS, converterIdiomaDetectado, opcoesBase } from "./index";

/**
 * Detecção de idioma (reverificação de 04/09): o navegador informa código
 * regional (en-US, es-MX, zh-CN, ar-SA…) e só existem recursos no código
 * base. Com `load: "currentOnly"` e sem `supportedLngs`, a cadeia ficava
 * ["en-US", "pt-BR"] e toda usuária estrangeira recebia português — e o
 * "en-US" ainda ficava gravado no localStorage.
 *
 * Instância própria com os 10 JSONs e as MESMAS opções do app (opcoesBase):
 * o que se prova é a resolução de idioma, não a tela.
 */

async function instancia() {
  const i18n = i18next.createInstance();
  await i18n.init(opcoesBase());
  return i18n;
}

function navegadorEm(codigos: string[]) {
  Object.defineProperty(window.navigator, "languages", { value: codigos, configurable: true });
  Object.defineProperty(window.navigator, "language", { value: codigos[0], configurable: true });
}

describe("detecção de idioma — código regional cai no idioma base, não no português", () => {
  it.each([
    ["en-US", "en", "Opportunities"],
    ["zh-CN", "zh", "机会"],
    ["ar-SA", "ar", "فرص"],
    ["es-MX", "es", "Oportunidades"],
    ["fr-CA", "fr", "Opportunités"],
  ])("changeLanguage(%s) resolve %s", async (pedido, esperado, texto) => {
    const i18n = await instancia();
    await i18n.changeLanguage(pedido);
    expect(i18n.resolvedLanguage).toBe(esperado);
    expect(i18n.t("nav.opportunities")).toBe(texto);
    expect(i18n.t("dashboard.title")).not.toBe("Olá");
  });

  it("pt-PT (sem JSON próprio) cai no pt-BR, e pt-BR continua exato", async () => {
    const i18n = await instancia();
    await i18n.changeLanguage("pt-PT");
    expect(i18n.resolvedLanguage).toBe("pt-BR");
    expect(i18n.t("nav.opportunities")).toBe("Oportunidades");
    await i18n.changeLanguage("pt-BR");
    expect(i18n.resolvedLanguage).toBe("pt-BR");
  });

  it("código sem recurso nenhum cai no fallback pt-BR — o fallback continua vivo", async () => {
    const i18n = await instancia();
    await i18n.changeLanguage("xx-YY");
    expect(i18n.resolvedLanguage).toBe("pt-BR");
    expect(i18n.t("nav.opportunities")).toBe("Oportunidades");
  });

  it("converterIdiomaDetectado: exato fica, regional vira a base, base sem código próprio vira o irmão suportado, o resto passa como veio", () => {
    expect(CODIGOS).toContain("pt-BR");
    expect(converterIdiomaDetectado("es-MX")).toBe("es");
    expect(converterIdiomaDetectado("en-US")).toBe("en");
    expect(converterIdiomaDetectado("pt-BR")).toBe("pt-BR");
    expect(converterIdiomaDetectado("en")).toBe("en");
    // O português só existe como "pt-BR"; a base "pt" não é código nosso.
    // Devolver "pt-PT" cru dependia do casamento por prefixo do i18next, que
    // só roda numa 2ª passada e perdia para o "en" da lista do navegador.
    expect(converterIdiomaDetectado("pt-PT")).toBe("pt-BR");
    expect(converterIdiomaDetectado("pt-AO")).toBe("pt-BR");
    expect(converterIdiomaDetectado("pt")).toBe("pt-BR");
    // Base desconhecida continua passando como veio: quem decide é o fallback.
    expect(converterIdiomaDetectado("xx-YY")).toBe("xx-YY");
    // "cimode" (modo de depuração do i18next) não pode virar idioma.
    expect(converterIdiomaDetectado("cimode")).toBe("cimode");
  });
});

/**
 * Regressão da PR #69 (major 3 da reverificação de 04/09): navegador de
 * Portugal/Angola/Moçambique abria a interface em INGLÊS e ainda gravava
 * `i18nextLng="en"` no localStorage, repetindo o erro a cada visita.
 *
 * Por quê: `converterIdiomaDetectado` devolvia "pt-PT" cru contando com o
 * casamento por prefixo do i18next, mas `getBestMatchFromCodes` só faz esse
 * casamento numa SEGUNDA passada, depois de TODOS os códigos falharem no
 * casamento exato — e o "en" que o Chrome põe em 3º lugar ganha a primeira.
 * Pior: o detector `htmlTag` acrescenta o "pt-BR" do index.html ao fim da
 * lista, então a segunda passada nunca rodava no app real.
 *
 * Detector REAL (jsdom) e `<html lang="pt-BR">` como no index.html: é o
 * conjunto que produzia o defeito.
 */
describe("navegador em português europeu/africano abre em pt-BR, não em inglês", () => {
  const langAntes = document.documentElement.lang;

  beforeEach(() => {
    localStorage.removeItem("i18nextLng");
    document.documentElement.lang = "pt-BR"; // o index.html real
  });

  afterEach(() => {
    localStorage.removeItem("i18nextLng");
    document.documentElement.lang = langAntes;
  });

  async function comDetector(codigos: string[]) {
    navegadorEm(codigos);
    const i18n = i18next.createInstance().use(LanguageDetector);
    await i18n.init(opcoesBase());
    return i18n;
  }

  it.each([
    [["pt-PT", "pt", "en-US", "en"], "Chrome com interface em português de Portugal (lista padrão)"],
    [["pt-AO", "pt", "en-US", "en"], "Angola"],
    [["pt-MZ", "pt", "es-ES", "es"], "Moçambique, com espanhol na lista"],
    [["pt-PT", "en"], "Portugal, sem o 'pt' seco na lista"],
  ])("%s → pt-BR (%s)", async (codigos) => {
    const i18n = await comDetector(codigos as string[]);
    expect(i18n.resolvedLanguage).toBe("pt-BR");
    expect(i18n.t("nav.opportunities")).toBe("Oportunidades");
    // E o cache não pode perpetuar um código sem recurso.
    expect(localStorage.getItem("i18nextLng")).toBe("pt-BR");
  });

  it("cache 'pt-PT' gravado antes, com navegador de Portugal: lido como pt-BR", async () => {
    localStorage.setItem("i18nextLng", "pt-PT");
    const i18n = await comDetector(["pt-PT", "pt", "en-US", "en"]);
    expect(i18n.resolvedLanguage).toBe("pt-BR");
    expect(i18n.t("nav.opportunities")).toBe("Oportunidades");
  });

  it("o inglês continua inteiro: ['en-GB','en','pt-BR'] → en, porque a base 'en' é suportada", async () => {
    const i18n = await comDetector(["en-GB", "en", "pt-BR"]);
    expect(i18n.resolvedLanguage).toBe("en");
    expect(i18n.t("nav.opportunities")).toBe("Opportunities");
    expect(localStorage.getItem("i18nextLng")).toBe("en");
  });
});

describe("detecção no navegador (detector real, jsdom)", () => {
  afterEach(() => {
    localStorage.removeItem("i18nextLng");
  });

  it("Chrome em English (US), sem cache: interface em inglês e o cache guarda 'en', não 'en-US'", async () => {
    localStorage.removeItem("i18nextLng");
    navegadorEm(["en-US", "en"]);
    const i18n = i18next.createInstance().use(LanguageDetector);
    await i18n.init(opcoesBase());
    expect(i18n.resolvedLanguage).toBe("en");
    expect(i18n.t("nav.opportunities")).toBe("Opportunities");
    expect(localStorage.getItem("i18nextLng")).toBe("en");
  });

  it("navegador só com zh-CN (sem o 'zh' seco na lista) chega ao chinês", async () => {
    localStorage.removeItem("i18nextLng");
    navegadorEm(["zh-CN"]);
    const i18n = i18next.createInstance().use(LanguageDetector);
    await i18n.init(opcoesBase());
    expect(i18n.resolvedLanguage).toBe("zh");
    expect(i18n.t("nav.opportunities")).toBe("机会");
  });

  it("cache 'en-US' gravado pelo defeito antigo passa a ser lido como 'en'", async () => {
    localStorage.setItem("i18nextLng", "en-US");
    navegadorEm(["pt-BR"]);
    const i18n = i18next.createInstance().use(LanguageDetector);
    await i18n.init(opcoesBase());
    expect(i18n.resolvedLanguage).toBe("en");
  });
});

/**
 * Direção e idioma do <html> na CARGA. Com os recursos embutidos, o i18next
 * resolve o idioma e emite `languageChanged` DENTRO do init, de forma
 * síncrona. O handler que aplica dir/lang estava registrado DEPOIS do init e
 * perdia esse primeiro evento: um navegador em ar-SA carregava o árabe em LTR
 * com <html lang="pt-BR">, e só acertava na troca manual de idioma.
 *
 * Aqui não vale instância própria: o que se prova é o MÓDULO do app
 * (client/src/i18n/index.ts), avaliado do zero com o navegador em cada idioma,
 * lendo o <html> logo depois da carga.
 */
describe("direção e idioma do documento na carga (módulo real, avaliado do zero)", () => {
  const htmlAntes = { dir: document.documentElement.dir, lang: document.documentElement.lang };

  afterEach(async () => {
    localStorage.removeItem("i18nextLng");
    document.documentElement.dir = htmlAntes.dir;
    document.documentElement.lang = htmlAntes.lang;
    navegadorEm(["pt-BR"]);
    // O singleton volta ao pt-BR: o setup do projeto client fixa esse idioma
    // para os demais testes.
    const { default: i18n } = await import("@/i18n");
    await i18n.changeLanguage("pt-BR");
  });

  async function carregarAppCom(codigos: string[], html: { dir: string; lang: string }) {
    localStorage.removeItem("i18nextLng");
    navegadorEm(codigos);
    document.documentElement.dir = html.dir;
    document.documentElement.lang = html.lang;
    // O i18next é um singleton: handlers deixados por avaliações anteriores
    // do módulo (o setup do projeto importa "@/i18n") continuariam pendurados
    // e mascarariam o defeito — o handler "velho" já existiria quando o init
    // novo emitisse o evento. Saem todos; só vale o que o módulo fresco
    // registrar.
    i18next.off("languageChanged");
    vi.resetModules();
    await import("@/i18n");
  }

  it("navegador em ar-SA: a página já nasce em RTL com lang 'ar'", async () => {
    await carregarAppCom(["ar-SA"], { dir: "ltr", lang: "" });
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });

  it("navegador em en-US: a página nasce em LTR com lang 'en' — mesmo que o <html> estivesse em RTL", async () => {
    await carregarAppCom(["en-US", "en"], { dir: "rtl", lang: "ar" });
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });
});
