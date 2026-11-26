import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chavesDoContato, chavesDoItem, podemCasar } from "../shared/chaves-de-cruzamento";
import { scoreMatch, slugifyMatchTag } from "./match-service";
import { ofertaDoCnae } from "./cnae";

/**
 * O índice de cruzamento (N4b) só acha candidatos; quem decide é scoreMatch.
 * A garantia que importa: TODO par que scoreMatch aceitaria (50 ou mais) tem
 * uma chave em comum. Se uma chave faltar, o par some do cruzamento sem erro,
 * então o teste confere sobre o vocabulário de verdade: os termos escritos nos
 * testes dos motores (os casos que cada regra já protege, em todos os idiomas)
 * e as ofertas da tabela da CNAE diante desses termos como necessidade.
 */
const ARQUIVOS_DO_VOCABULARIO = [
  "demanda-expressa-exemplos-da-spec.test.ts", "direcao-do-termo.test.ts", "match-escritas-nao-latinas.test.ts",
  "match-etapa7.test.ts", "match-qualificador-de-lugar.test.ts", "match-service.test.ts",
  "match-servico-demanda-expressa.test.ts", "matching-demanda-expressa.test.ts", "o-que-busca-na-demanda-expressa.test.ts",
  "tipo-da-oferta.test.ts", "network-rede-global.test.ts", "rede-possui-procura.test.ts",
  // N7: a outra grafia (acento, singular, erro de digitação), o verbo conjugado e a oferta escrita como necessidade.
  "match-n7-grafia-verbo-e-oferta.test.ts", "oferta-generica-e-publico.test.ts", "motor-de-perfis-concorrentes.test.ts",
];

function vocabulario(): string[] {
  const termos = new Set<string>();
  for (const arquivo of ARQUIVOS_DO_VOCABULARIO) {
    const texto = fs.readFileSync(path.join(import.meta.dirname, arquivo), "utf8");
    for (const [, termo] of Array.from(texto.matchAll(/"([^"\\\n]{2,90})"/g))) {
      if (/\p{L}/u.test(termo) && !/[{}<>=]|\.ts$|^[a-z]+:/.test(termo)) termos.add(termo);
    }
  }
  return Array.from(termos);
}

const razao = (label: string, category: string | null = null) => ({ slug: slugifyMatchTag(label), label, category });

/**
 * O par a par inteiro (mais de 1 milhão de pares no vocabulário e 1,7 milhão na CNAE) leva uns 7 minutos:
 * roda com CHAVES_DE_CRUZAMENTO_COMPLETO=1 (rodado na N4b, 26/11: nenhum par perdido). Na suíte comum, uma
 * amostra fixa (um termo a cada N), para o CI não pagar os 7 minutos a cada PR.
 */
const COMPLETO = process.env.CHAVES_DE_CRUZAMENTO_COMPLETO === "1";
const amostra = <T>(lista: T[], quantos: number) => (COMPLETO || lista.length <= quantos ? lista : lista.filter((_, i) => i % Math.ceil(lista.length / quantos) === 0));

describe("chaves de cruzamento", () => {
  it("a mesma coisa escrita dos dois lados tem chave em comum; palavra solta, não", () => {
    const tem = chavesDoContato({ tenho: [{ label: "Exportação de café" }], preciso: [] });
    const precisa = chavesDoContato({ tenho: [], preciso: [{ label: "Importação de café do Brasil" }] });
    expect(podemCasar(tem, precisa)).toBe(true);
    // "Exportar vinho" × "Exportar café": só a palavra "exportar" em comum, nenhuma chave.
    expect(podemCasar(
      chavesDoContato({ tenho: [{ label: "Exportar vinho" }], preciso: [] }),
      chavesDoContato({ tenho: [], preciso: [{ label: "Exportar café" }] }),
    )).toBe(false);
  });

  it("o serviço escrito de outro jeito e o apoio que nomeia a profissão têm chave em comum", () => {
    const comum = (oferta: string, necessidade: string) =>
      chavesDoItem({ label: oferta }, "tem").some(chave => chavesDoItem({ label: necessidade }, "precisa").includes(chave));
    expect(comum("Advocacia tributária", "Advogado tributarista")).toBe(true);
    expect(comum("Contabilidade", "Contador")).toBe(true);
    expect(comum("Advocacia tributária", "Assessoria tributária")).toBe(true);
    expect(comum("Consultoria em internacionalização", "Apoio para estruturar a entrada da minha empresa no Paraguai")).toBe(true);
    // O público da oferta cobre o lema pedido; a oferta genérica entra pela curinga da família.
    expect(comum("Contabilidade tributária para MEI", "Contador de MEI")).toBe(true);
    expect(comum("Escritório de contabilidade", "Contador de MEI")).toBe(true);
    // A especialidade pedida que a oferta não tem não traz a oferta específica.
    expect(comum("Advocacia trabalhista", "Advogado tributarista")).toBe(false);
  });

  it("a categoria em comum é chave (o motor privado dá 60 fora do serviço)", () => {
    expect(chavesDoItem({ label: "Soja", category: "Agronegócio" }, "tem")).toContain("c:agronegocio");
  });

  it("a rede com armadilhas (N8): todo par que scoreMatch aceita, com a categoria, tem chave em comum", () => {
    const rede = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "rede-de-teste", "rede-com-armadilhas.json"), "utf8")) as {
      pares: Array<{ id: string; oferta: { rotulo: string; categoria: string | null }; procura: { rotulo: string; categoria: string | null } }>;
    };
    const perdidos = rede.pares.filter(par => {
      if (scoreMatch(razao(par.oferta.rotulo, par.oferta.categoria), razao(par.procura.rotulo, par.procura.categoria)).score < 50) return false;
      const tem = chavesDoItem({ label: par.oferta.rotulo, category: par.oferta.categoria }, "tem");
      const precisa = new Set(chavesDoItem({ label: par.procura.rotulo, category: par.procura.categoria }, "precisa"));
      return !tem.some(chave => precisa.has(chave));
    }).map(par => par.id);
    expect(perdidos).toEqual([]);
  });

  it("todo par que scoreMatch aceita tem uma chave em comum (vocabulário dos testes dos motores)", () => {
    const todos = vocabulario();
    expect(todos.length).toBeGreaterThan(300);
    const termos = amostra(todos, 260);
    const tem = termos.map(termo => new Set(chavesDoItem({ label: termo, slug: slugifyMatchTag(termo) }, "tem")));
    const precisa = termos.map(termo => new Set(chavesDoItem({ label: termo, slug: slugifyMatchTag(termo) }, "precisa")));
    const perdidos: string[] = [];
    let aceitos = 0;
    for (let i = 0; i < termos.length; i += 1) {
      for (let j = 0; j < termos.length; j += 1) {
        if (scoreMatch(razao(termos[i]), razao(termos[j])).score < 50) continue;
        aceitos += 1;
        if (!Array.from(tem[i]).some(chave => precisa[j].has(chave))) perdidos.push(`${termos[i]} × ${termos[j]}`);
      }
    }
    expect(aceitos).toBeGreaterThan(COMPLETO ? 100 : 10);
    expect(perdidos).toEqual([]);
  }, 300_000);

  it("toda oferta da CNAE que scoreMatch casa com um termo procurado tem chave em comum com ele", () => {
    const cnae = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "cnae", "cnae-2-3.json"), "utf8")) as { subclasses: Record<string, string> };
    const ofertas = Array.from(new Set(Object.keys(cnae.subclasses).map(ofertaDoCnae).filter((o): o is string => !!o)));
    const necessidades = COMPLETO ? [...vocabulario(), ...ofertas.slice(0, 400)] : [...amostra(vocabulario(), 50), ...amostra(ofertas, 20)];
    const chavesDaNecessidade = necessidades.map(termo => new Set(chavesDoItem({ label: termo }, "precisa")));
    const perdidos: string[] = [];
    for (const oferta of ofertas) {
      const chaves = chavesDoItem({ label: oferta }, "tem");
      necessidades.forEach((necessidade, j) => {
        if (scoreMatch(razao(oferta), razao(necessidade)).score < 50) return;
        if (!chaves.some(chave => chavesDaNecessidade[j].has(chave))) perdidos.push(`${oferta} × ${necessidade}`);
      });
    }
    expect(perdidos).toEqual([]);
  }, 600_000);
});
