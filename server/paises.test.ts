import { describe, expect, it } from "vitest";
import { CODIGO_OUTRO, listarPaises, nomeDoPais } from "@shared/paises";
import { PAISES_GERADOS } from "@shared/paises-gerados";

/**
 * O que a usuária LÊ no seletor de país.
 *
 * A lista de códigos vem do GeoNames, mas o nome de cada país sai traduzido pelo
 * navegador (`Intl.DisplayNames`). Estas conferências existem porque essa
 * escolha tem duas consequências que ninguém veria de olho: rótulo repetido (dois
 * códigos que o navegador chama pelo mesmo nome) e rótulo ausente (código que ele
 * não conhece). As duas quebram um seletor sem quebrar nenhum teste de tela.
 */

const IDIOMAS_DO_SITE = [
  "pt-BR",
  "en",
  "es",
  "fr",
  "de",
  "ru",
  "ar",
  "hi",
  "zh",
  "ja",
];

describe("nomeDoPais", () => {
  it("traduz para o idioma da tela", () => {
    expect(nomeDoPais("DE", "pt-BR")).toBe("Alemanha");
    expect(nomeDoPais("DE", "en")).toBe("Germany");
    expect(nomeDoPais("DE", "es")).toBe("Alemania");
    expect(nomeDoPais("JP", "ja")).toBe("日本");
  });

  it("aceita o código em minúscula e com espaço em volta", () => {
    expect(nomeDoPais(" br ", "pt-BR")).toBe("Brasil");
  });

  it("devolve o próprio código quando ninguém conhece o país", () => {
    // "XX" é o "Outro" do cadastro antigo: não é código ISO, não está na lista
    // gerada e o navegador não o traduz. Ainda assim o perfil continua
    // exibível, em vez de mostrar um campo vazio que parece dado perdido.
    expect(nomeDoPais(CODIGO_OUTRO, "pt-BR")).toBe(CODIGO_OUTRO);
  });

  it("cai no nome de reserva quando o ambiente não sabe traduzir região", () => {
    // Idioma inválido faz `Intl.DisplayNames` lançar, que é o mesmo caminho de
    // um navegador antigo ou de um Node com ICU reduzido: a lista inteira passa
    // a mostrar o nome em inglês publicado pelo GeoNames, em vez de ficar vazia.
    expect(nomeDoPais("DE", "idioma-que-não-existe")).toBe("Germany");
    expect(nomeDoPais("BR", "idioma-que-não-existe")).toBe("Brazil");
  });

  it("não devolve vazio para código preenchido, nem quebra com lixo", () => {
    expect(nomeDoPais("", "pt-BR")).toBe("");
    expect(nomeDoPais("BRA", "pt-BR")).toBe("BRA");
    expect(nomeDoPais("1", "pt-BR")).toBe("1");
  });
});

describe("listarPaises", () => {
  it("oferece o mundo inteiro, e não o recorte de 17 países de antes", () => {
    const lista = listarPaises("pt-BR");
    expect(lista).toHaveLength(PAISES_GERADOS.length);
    const codigos = new Set(lista.map(p => p.codigo));
    for (const codigo of ["AO", "PY", "QA", "MZ", "CV"]) {
      expect(codigos.has(codigo)).toBe(true);
    }
  });

  it("ordena pelo alfabeto do idioma da tela", () => {
    const pt = listarPaises("pt-BR").map(p => p.rotulo);
    expect([...pt]).toEqual(
      [...pt].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }))
    );
    // A ordem depende mesmo do idioma: "Alemanha" abre a lista em português,
    // "Germany" fica no meio em inglês.
    expect(listarPaises("pt-BR")[0].rotulo).not.toBe(listarPaises("en")[0].rotulo);
  });

  it("põe o 'Outro' por último, fora da ordenação", () => {
    const lista = listarPaises("pt-BR", "Outro");
    expect(lista[lista.length - 1]).toEqual({
      codigo: CODIGO_OUTRO,
      rotulo: "Outro",
    });
    expect(lista).toHaveLength(PAISES_GERADOS.length + 1);
  });

  it("não traz 'Outro' quando a tela não pede", () => {
    expect(listarPaises("pt-BR").some(p => p.codigo === CODIGO_OUTRO)).toBe(false);
  });

  it("dá rótulo ÚNICO a cada país, nos 10 idiomas do site", () => {
    for (const idioma of IDIOMAS_DO_SITE) {
      const porRotulo = new Map<string, string>();
      const repetidos: string[] = [];
      for (const { codigo, rotulo } of listarPaises(idioma)) {
        const anterior = porRotulo.get(rotulo);
        if (anterior) repetidos.push(`${idioma}: ${rotulo} (${anterior} e ${codigo})`);
        else porRotulo.set(rotulo, codigo);
      }
      expect(repetidos).toEqual([]);
    }
  });

  it("nunca mostra o código cru em lugar do nome, nos 10 idiomas", () => {
    for (const idioma of IDIOMAS_DO_SITE) {
      const crus = listarPaises(idioma)
        .filter(p => p.rotulo === p.codigo)
        .map(p => `${idioma}: ${p.codigo}`);
      expect(crus).toEqual([]);
    }
  });

  it("devolve a mesma lista na segunda chamada, sem remontar", () => {
    expect(listarPaises("pt-BR")).toBe(listarPaises("pt-BR"));
    expect(listarPaises("pt-BR", "Outro")).not.toBe(listarPaises("pt-BR"));
  });
});
