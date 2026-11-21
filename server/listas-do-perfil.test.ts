import { describe, expect, it } from "vitest";
import {
  FORMATO_DA_VERSAO_DAS_LISTAS,
  mesclarOQueEntrouDepois,
  oQueEntrouDepois,
  versaoDasListas,
  type OQueEntrouDepois,
} from "./listas-do-perfil";

/**
 * O Perfil aberto e o que entrou nele depois (server/listas-do-perfil.ts): a
 * versão que a tela carregou, o que entrou no fim de cada lista e a mescla
 * com o que a tela manda. O caminho pelo banco, com a confirmação da reunião
 * de verdade, está em server/perfil-aberto-e-reuniao.integracao.test.ts.
 */

const DEMANDA = { id: "d1", category: "investidores", description: "Investidor anjo para a fábrica de cacau" };
const DA_REUNIAO = { id: "dr", category: "outra_necessidade", description: "Distribuidor no Chile" };
const PERFIL = { whatIHave: ["industria", "Exportar vinho"], whatINeed: ["investidores"], whatINeedDetails: [DEMANDA] };
const nada: OQueEntrouDepois = { whatIHave: [], whatINeed: [], whatINeedDetails: [] };

describe("versaoDasListas e oQueEntrouDepois", () => {
  it("a versão tem o formato que o profile.update aceita, e a mesma lista dá a mesma versão", () => {
    const versao = versaoDasListas(PERFIL);
    expect(versao).toMatch(FORMATO_DA_VERSAO_DAS_LISTAS);
    expect(versaoDasListas(JSON.parse(JSON.stringify(PERFIL)))).toBe(versao);
    expect(versaoDasListas({ ...PERFIL, whatIHave: ["industria"] })).not.toBe(versao);
  });

  it("perfil sem linha, coluna nula e lista vazia são a mesma versão (nenhum item)", () => {
    expect(versaoDasListas(null)).toBe(versaoDasListas({ whatIHave: [], whatINeed: null, whatINeedDetails: undefined }));
    expect(oQueEntrouDepois(versaoDasListas(null), { whatIHave: ["Exportar café"], whatINeed: null, whatINeedDetails: null }))
      .toEqual({ whatIHave: ["Exportar café"], whatINeed: [], whatINeedDetails: [] });
  });

  it("nada mudou: nada entrou", () => {
    expect(oQueEntrouDepois(versaoDasListas(PERFIL), PERFIL)).toEqual(nada);
  });

  it("a reunião acrescentou no fim (o 'tenho', e o 'preciso' com a categoria): é o que entrou", () => {
    const depois = {
      whatIHave: [...PERFIL.whatIHave, "Exportar café"],
      whatINeed: [...PERFIL.whatINeed, "outra_necessidade"],
      whatINeedDetails: [...PERFIL.whatINeedDetails, DA_REUNIAO],
    };
    expect(oQueEntrouDepois(versaoDasListas(PERFIL), depois))
      .toEqual({ whatIHave: ["Exportar café"], whatINeed: ["outra_necessidade"], whatINeedDetails: [DA_REUNIAO] });
  });

  it("a coluna gravada como texto (JSON antigo) é lida como a lista", () => {
    expect(oQueEntrouDepois(versaoDasListas(PERFIL), { ...PERFIL, whatIHave: JSON.stringify([...PERFIL.whatIHave, "Café"]) }))
      .toEqual({ ...nada, whatIHave: ["Café"] });
  });

  it("um item saiu, foi trocado ou mudou de lugar: não é acréscimo (null)", () => {
    const versao = versaoDasListas(PERFIL);
    expect(oQueEntrouDepois(versao, { ...PERFIL, whatIHave: ["industria"] })).toBeNull();
    expect(oQueEntrouDepois(versao, { ...PERFIL, whatIHave: ["Exportar vinho", "industria"] })).toBeNull();
    expect(oQueEntrouDepois(versao, { ...PERFIL, whatINeedDetails: [{ ...DEMANDA, description: "Outra descrição de demanda" }] })).toBeNull();
    // Trocou o primeiro e acrescentou um: o começo já não é o que a tela viu.
    expect(oQueEntrouDepois(versao, { ...PERFIL, whatIHave: ["fazenda", "Exportar vinho", "Café"] })).toBeNull();
  });

  it("versão fora do formato não confere com nada (null)", () => {
    expect(oQueEntrouDepois("v2", PERFIL)).toBeNull();
    expect(oQueEntrouDepois(versaoDasListas(PERFIL).replace("v2", "v3"), PERFIL)).toBeNull();
    // A versão de antes, só das listas, não vale mais: sem o resumo dos campos.
    expect(oQueEntrouDepois(versaoDasListas(PERFIL).replace(/^v2/, "v1").replace(/:[0-9a-f]{16}$/, ""), PERFIL)).toBeNull();
  });
});

/**
 * Revisão do pacote do match (20/11): a versão protegia só as três listas, e o
 * salvar de uma aba aberta antes regravava a bio que a outra aba tinha reescrito.
 * O Perfil manda todos os campos dele ao salvar: o que mudou no banco desde que
 * a edição abriu seria perdido.
 */
describe("os outros campos da edição entram na versão", () => {
  const COMPLETO = { ...PERFIL, bio: "Bio da edição aberta", city: "Lisboa", company: "Vinícola", interestSectors: ["agribusiness"] };

  it("a bio, a cidade, a empresa ou os setores mudaram no banco: null (CONFLICT), mesmo com as listas iguais", () => {
    const versao = versaoDasListas(COMPLETO);
    expect(oQueEntrouDepois(versao, { ...COMPLETO, bio: "Bio reescrita na outra aba" })).toBeNull();
    expect(oQueEntrouDepois(versao, { ...COMPLETO, city: "Porto" })).toBeNull();
    expect(oQueEntrouDepois(versao, { ...COMPLETO, company: null })).toBeNull();
    expect(oQueEntrouDepois(versao, { ...COMPLETO, interestSectors: ["agribusiness", "retail"] })).toBeNull();
  });

  it("os campos iguais e o item que a reunião acrescentou no fim: entra, como antes", () => {
    expect(oQueEntrouDepois(versaoDasListas(COMPLETO), { ...COMPLETO, whatIHave: [...COMPLETO.whatIHave, "Café"] }))
      .toEqual({ ...nada, whatIHave: ["Café"] });
  });

  it("campo ausente e campo nulo são o mesmo (a linha antiga sem a coluna preenchida)", () => {
    expect(oQueEntrouDepois(versaoDasListas({ ...COMPLETO, gender: null }), COMPLETO)).toEqual(nada);
  });

  it("o que não é campo da edição (a completude, a última análise) não mexe na versão", () => {
    expect(versaoDasListas({ ...COMPLETO, profileCompleteness: 80, lastAiAnalysisAt: new Date() } as never)).toBe(versaoDasListas(COMPLETO));
  });
});

describe("mesclarOQueEntrouDepois", () => {
  it("o que entrou vai para o fim do que a tela manda, e a edição da tela vale (tirou um, pôs outro)", () => {
    const entrou = { whatIHave: ["Exportar café"], whatINeed: ["outra_necessidade"], whatINeedDetails: [DA_REUNIAO] };
    const recebidas = { whatIHave: ["Exportar vinho", "fazenda"], whatINeed: ["investidores"], whatINeedDetails: [DEMANDA] };
    expect(mesclarOQueEntrouDepois(recebidas, entrou)).toEqual({
      whatIHave: ["Exportar vinho", "fazenda", "Exportar café"],
      whatINeed: ["investidores", "outra_necessidade"],
      whatINeedDetails: [DEMANDA, DA_REUNIAO],
    });
  });

  it("não repete: o 'tenho' pelo slug, a demanda pelo id ou pela descrição, a categoria pelo valor", () => {
    const entrou = {
      whatIHave: ["exportar CAFÉ"],
      whatINeed: ["investidores"],
      whatINeedDetails: [{ ...DA_REUNIAO, id: "outro-id" }, { ...DEMANDA, description: "Texto diferente, mesmo id" }],
    };
    const recebidas = { whatIHave: ["Exportar café"], whatINeed: ["investidores", "outra_necessidade"], whatINeedDetails: [DEMANDA, DA_REUNIAO] };
    expect(mesclarOQueEntrouDepois(recebidas, entrou)).toEqual(recebidas);
  });

  it("a demanda que entrou leva a categoria dela, mesmo a que a tela desmarcou (a dona não viu essa demanda)", () => {
    const entrou = { ...nada, whatINeedDetails: [DA_REUNIAO] };
    expect(mesclarOQueEntrouDepois({ whatINeed: [], whatINeedDetails: [] }, entrou))
      .toEqual({ whatINeed: ["outra_necessidade"], whatINeedDetails: [DA_REUNIAO] });
  });

  it("só mexe nas listas que o pedido traz", () => {
    const entrou = { whatIHave: ["Exportar café"], whatINeed: ["outra_necessidade"], whatINeedDetails: [DA_REUNIAO] };
    expect(mesclarOQueEntrouDepois({}, entrou)).toEqual({});
    expect(mesclarOQueEntrouDepois({ whatIHave: ["industria"] }, entrou)).toEqual({ whatIHave: ["industria", "Exportar café"] });
    // Sem as demandas no pedido, a da reunião fica gravada; a categoria dela não pode sair.
    expect(mesclarOQueEntrouDepois({ whatINeed: [] }, entrou)).toEqual({ whatINeed: ["outra_necessidade"] });
  });

  it("nada entrou: devolve o que a tela mandou", () => {
    const recebidas = { whatIHave: ["fazenda"], whatINeed: [], whatINeedDetails: [] };
    expect(mesclarOQueEntrouDepois(recebidas, nada)).toEqual(recebidas);
  });

  it("a mescla que passaria de um teto devolve null (a dona decide, com a tela recarregada)", () => {
    const cheio = Array.from({ length: 50 }, (_, i) => `Item ${i + 1}`);
    expect(mesclarOQueEntrouDepois({ whatIHave: cheio }, { ...nada, whatIHave: ["Exportar café"] })).toBeNull();
    expect(mesclarOQueEntrouDepois({ whatIHave: cheio.slice(1) }, { ...nada, whatIHave: ["Exportar café"] })).toMatchObject({ whatIHave: expect.any(Array) });

    const dez = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, category: "outra_necessidade", description: `Demanda número ${i + 1} da categoria` }));
    expect(mesclarOQueEntrouDepois({ whatINeedDetails: dez }, { ...nada, whatINeedDetails: [DA_REUNIAO] })).toBeNull();
    const cinquenta = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, category: `categoria-${i % 6}`, description: `Demanda número ${i + 1}` }));
    expect(mesclarOQueEntrouDepois({ whatINeedDetails: cinquenta.slice(0, 50) }, { ...nada, whatINeedDetails: [DA_REUNIAO] })).toBeNull();
    const categorias = Array.from({ length: 50 }, (_, i) => `categoria-${i}`);
    expect(mesclarOQueEntrouDepois({ whatINeed: categorias }, { ...nada, whatINeed: ["outra_necessidade"] })).toBeNull();
  });
});
