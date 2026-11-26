// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` (não `??=`) garante um valor mesmo no CI.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMIAR_SEMANTICO_ESTREITO, scoreMatch, semanticoEstreitoPodeValer, slugifyMatchTag } from "./match-service";
import { cosineSimilarity } from "./memory-service";
import { calculateCompatibilityScore } from "./matching";
import type { UserProfile } from "../drizzle/schema";
import rede from "../scripts/rede-de-teste/rede-com-armadilhas.json";
// @ts-expect-error -- .mjs sem tipos; o teste só confere que dá o mesmo slug do servidor.
import { slugDaTag } from "../scripts/rede-de-teste/slug.mjs";

/**
 * N8 — a rede de teste com armadilhas MEDE os motores de match (o privado e o de perfis) contra um gabarito.
 * Sem banco: chama as funções puras de cada motor, par a par. Como ler a medida: docs/medir-o-match.md.
 *
 * O teste só FALHA nas armadilhas que a regra do projeto proíbe (concorrente, palavra solta, serviço sem demanda
 * declarada) e que não estejam em LACUNAS_CONHECIDAS. Paráfrase, sinônimo e erro de digitação que o motor ainda não
 * casa saem como "esperado, ainda não coberto": é a régua que o N7 vai usar, não regressão.
 */

type Item = { contato: string; rotulo: string; categoria: string };
type Par = { id: string; armadilha: string; esperado: "casa" | "nao-casa"; oferta: Item; procura: Item; porque: string };

const PARES = rede.pares as Par[];
const PROIBIDAS = new Set(["concorrente", "palavra-solta", "servico-sem-demanda"]);

/** Corte de gravação do motor privado (SAVE_THRESHOLD de match-service.ts). */
const CORTE_PRIVADO = 50;
/** Corte de gravação do motor de perfis (generateMatchesForUser: overall >= 40). */
const CORTE_PERFIS = 40;

type Motor = "privado" | "perfis";

/**
 * Violações de regra que JÁ existem e têm dono fora deste teste. Cada uma diz por quê. O teste também falha se uma
 * delas deixar de acontecer, para a lista não envelhecer: corrigiu, tire daqui.
 *
 * Vazia desde o N7: o C06 ("Exportamos frutas") saiu com o verbo conjugado em shared/direcao-do-termo.ts, e o C01,
 * C02, C03 e C05 do motor de perfis saíram com o N6 (a regra dos concorrentes em `satisfaz`).
 */
const LACUNAS_CONHECIDAS: Record<Motor, Record<string, string>> = { privado: {}, perfis: {} };

const itens = (par: Par) => ({
  asset: { slug: slugifyMatchTag(par.oferta.rotulo), label: par.oferta.rotulo, category: par.oferta.categoria },
  need: { slug: slugifyMatchTag(par.procura.rotulo), label: par.procura.rotulo, category: par.procura.categoria },
});

/**
 * `similaridade` simula o recálculo com o critério semântico estreito ligado: o motor só mede (e só manda o texto ao
 * provedor) quando nenhuma regra casou e as guardas passam. Sem `similaridade`, o motor como está em produção.
 */
function casaNoPrivado(par: Par, similaridade?: (par: Par) => number): boolean {
  const { asset, need } = itens(par);
  const r = scoreMatch(asset, need);
  if (r.score || !similaridade || !semanticoEstreitoPodeValer(asset, need)) return r.score >= CORTE_PRIVADO;
  return scoreMatch(asset, need, similaridade(par)).score >= CORTE_PRIVADO;
}

/**
 * Perfis mínimos (só o estratégico): A tem a oferta, B procura. Com o resto nulo, as outras cinco dimensões ficam
 * nos padrões e a nota é 0,30 × complementaridade + 25,5 — passa do corte de 40 só quando a oferta atende a procura
 * (complementaridade 60) e o portão da demanda expressa não bloqueia. O motor de perfis não lê categoria.
 */
function casaNoDePerfis(par: Par): boolean {
  const a = { whatIHave: [par.oferta.rotulo], whatINeed: [] } as unknown as UserProfile;
  const b = { whatIHave: [], whatINeed: [par.procura.rotulo] } as unknown as UserProfile;
  const r = calculateCompatibilityScore(a, b);
  return !r.bloqueio && r.overall >= CORTE_PERFIS;
}

type Medida = {
  motor: Motor;
  acertosCasa: Par[];
  faltas: Par[];
  falsosCasa: Par[];
  acertosNaoCasa: Par[];
  violacoes: Par[];
};

function medir(motor: Motor, similaridade?: (par: Par) => number): Medida {
  const casa = motor === "privado" ? (par: Par) => casaNoPrivado(par, similaridade) : casaNoDePerfis;
  const m: Medida = { motor, acertosCasa: [], faltas: [], falsosCasa: [], acertosNaoCasa: [], violacoes: [] };
  for (const par of PARES) {
    const casou = casa(par);
    if (par.esperado === "casa") (casou ? m.acertosCasa : m.faltas).push(par);
    else {
      (casou ? m.falsosCasa : m.acertosNaoCasa).push(par);
      if (casou && PROIBIDAS.has(par.armadilha)) m.violacoes.push(par);
    }
  }
  return m;
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((100 * a) / b)}%`);

const precisao = (m: Medida) => m.acertosCasa.length / Math.max(1, m.acertosCasa.length + m.falsosCasa.length);

/**
 * A fixture dos vetores do gabarito (N7): gerada UMA vez por scripts/rede-de-teste/gerar-embeddings-da-rede.mjs, com a
 * chave do Gemini no ambiente de quem roda, e gravada no repositório para o teste rodar sem rede. Cada vetor é
 * normalizado e quantizado em int8 (base64) com a escala dele; o cosseno sai com erro da ordem de 0,001.
 */
const CAMINHO_DA_FIXTURE = path.resolve(__dirname, "../scripts/rede-de-teste/embeddings-da-rede.json");
type Fixture = { modelo: string; tarefa: string; vetores: Record<string, { escala: number; int8: string }> };

function carregarFixture(): Map<string, number[]> | null {
  if (!fs.existsSync(CAMINHO_DA_FIXTURE)) return null;
  const fixture = JSON.parse(fs.readFileSync(CAMINHO_DA_FIXTURE, "utf8")) as Fixture;
  const vetores = new Map<string, number[]>();
  for (const [texto, { escala, int8 }] of Object.entries(fixture.vetores)) {
    vetores.set(texto, Array.from(new Int8Array(Buffer.from(int8, "base64"))).map(v => v * escala));
  }
  return vetores;
}

function relatorio(m: Medida): string {
  const casados = m.acertosCasa.length + m.falsosCasa.length;
  const esperados = m.acertosCasa.length + m.faltas.length;
  const linhas = [
    `Motor ${m.motor}: precisão ${pct(m.acertosCasa.length, casados)} (${m.acertosCasa.length}/${casados}), ` +
      `cobertura ${pct(m.acertosCasa.length, esperados)} (${m.acertosCasa.length}/${esperados}), ` +
      `armadilhas proibidas violadas ${m.violacoes.length}`,
    ...m.faltas.map(p => `  esperado, ainda não coberto: ${p.id} [${p.armadilha}] "${p.oferta.rotulo}" × "${p.procura.rotulo}"`),
    ...m.falsosCasa.map(p => `  casou sem dever: ${p.id} [${p.armadilha}] "${p.oferta.rotulo}" × "${p.procura.rotulo}"`),
  ];
  return linhas.join("\n");
}

describe("N8 — rede de teste com armadilhas", () => {
  it("o gabarito é coerente: ids únicos, contatos que existem, só nomes fictícios", () => {
    const ids = PARES.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const contatos = rede.contatos as Record<string, unknown>;
    for (const par of PARES) {
      expect(contatos[par.oferta.contato], par.id).toBeDefined();
      expect(contatos[par.procura.contato], par.id).toBeDefined();
      expect(par.oferta.contato, `${par.id}: oferta e procura do mesmo contato`).not.toBe(par.procura.contato);
    }
    // Tem de haver de tudo: positivos e cada uma das armadilhas proibidas.
    expect(PARES.some(p => p.esperado === "casa")).toBe(true);
    for (const armadilha of PROIBIDAS) expect(PARES.some(p => p.armadilha === armadilha), armadilha).toBe(true);
  });

  it("o slug do script de semear é o mesmo do servidor", () => {
    for (const par of PARES) {
      for (const item of [par.oferta, par.procura]) expect(slugDaTag(item.rotulo), item.rotulo).toBe(slugifyMatchTag(item.rotulo));
    }
  });

  it("N7: a necessidade que na verdade OFERECE o serviço não casa com ele, e o pedido com 'disponível' segue casando", () => {
    const porId = new Map(PARES.map(par => [par.id, par]));
    for (const id of ["S06", "S07", "S08"]) {
      const par = porId.get(id)!;
      expect(casaNoPrivado(par), `${id} privado`).toBe(false);
      expect(casaNoDePerfis(par), `${id} perfis`).toBe(false);
    }
    expect(casaNoPrivado(porId.get("P21")!)).toBe(true);
    expect(casaNoDePerfis(porId.get("P21")!)).toBe(true);
  });

  for (const motor of ["privado", "perfis"] as const) {
    it(`motor ${motor}: nenhuma armadilha proibida casa (fora as lacunas conhecidas)`, () => {
      const m = medir(motor);
      console.log(relatorio(m));
      const conhecidas = LACUNAS_CONHECIDAS[motor];
      const novas = m.violacoes.filter(p => !(p.id in conhecidas)).map(p => `${p.id} [${p.armadilha}] "${p.oferta.rotulo}" × "${p.procura.rotulo}"`);
      expect(novas, "armadilha proibida casou").toEqual([]);
      const resolvidas = Object.keys(conhecidas).filter(id => !m.violacoes.some(p => p.id === id));
      expect(resolvidas, "lacuna conhecida não acontece mais: tire de LACUNAS_CONHECIDAS").toEqual([]);
    });
  }
});

describe("N7 — o critério semântico estreito, medido no gabarito", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("desligado por padrão: nem a similaridade máxima muda a medida", () => {
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "");
    const sem = medir("privado");
    const comUm = medir("privado", () => 1);
    expect(comUm.acertosCasa.map(p => p.id)).toEqual(sem.acertosCasa.map(p => p.id));
    expect(comUm.falsosCasa.map(p => p.id)).toEqual(sem.falsosCasa.map(p => p.id));
  });

  it("as guardas recusam TODA armadilha proibida, seja qual for o vetor", () => {
    // O pior caso: o provedor devolve similaridade 1 para qualquer par. Nenhuma armadilha proibida (concorrente,
    // palavra solta, serviço sem demanda) pode casar: quem as barra são as guardas, não o limiar.
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "1");
    for (const par of PARES.filter(p => PROIBIDAS.has(p.armadilha))) {
      const { asset, need } = itens(par);
      expect(semanticoEstreitoPodeValer(asset, need), `${par.id} ${par.oferta.rotulo} × ${par.procura.rotulo}`).toBe(false);
    }
    expect(medir("privado", () => 1).violacoes.map(p => p.id)).toEqual([]);
  });

  it("as guardas deixam passar as paráfrases sem palavra em comum e recusam a que repete uma palavra", () => {
    const elegiveis = PARES.filter(par => {
      const { asset, need } = itens(par);
      return !casaNoPrivado(par) && semanticoEstreitoPodeValer(asset, need);
    }).map(par => par.id);
    // P08, P09, P14 e P15 são as paráfrases que só o sentido casa; N01 e N02 (sem relação) ficam com o limiar.
    // P19 repete "água" dos dois lados: a guarda da palavra em comum a recusa (o custo aceito).
    expect(elegiveis).toEqual(["P08", "P09", "P14", "P15", "N01", "N02"]);
  });

  const vetores = carregarFixture();
  it.skipIf(!vetores)("com os vetores do gabarito: a precisão não cai e nenhuma armadilha proibida casa", () => {
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "1");
    const similaridade = (par: Par) => {
      const a = vetores!.get(par.oferta.rotulo);
      const b = vetores!.get(par.procura.rotulo);
      return a && b ? cosineSimilarity(a, b) : 0;
    };
    // A calibração: a similaridade de cada par que as guardas deixam chegar ao limiar.
    const elegiveis = PARES.filter(par => {
      const { asset, need } = itens(par);
      return !casaNoPrivado(par) && semanticoEstreitoPodeValer(asset, need);
    });
    const maiorNaoCasa = Math.max(0, ...elegiveis.filter(p => p.esperado === "nao-casa").map(similaridade));
    console.log([
      `Calibração (limiar atual ${LIMIAR_SEMANTICO_ESTREITO}; o limiar seguro passa de ${maiorNaoCasa.toFixed(3)}):`,
      ...elegiveis.map(p => `  ${p.id} [${p.esperado}] ${similaridade(p).toFixed(3)} "${p.oferta.rotulo}" × "${p.procura.rotulo}"`),
    ].join("\n"));
    const antes = medir("privado");
    const depois = medir("privado", similaridade);
    console.log(`Com o semântico estreito ligado — ${relatorio(depois)}`);
    expect(depois.violacoes.map(p => p.id), "armadilha proibida casou").toEqual([]);
    expect(precisao(depois)).toBeGreaterThanOrEqual(precisao(antes));
    expect(maiorNaoCasa, "o limiar tem de ficar acima do par sem relação mais parecido").toBeLessThan(LIMIAR_SEMANTICO_ESTREITO);
  });
});
