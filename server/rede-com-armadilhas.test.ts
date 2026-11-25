// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` (não `??=`) garante um valor mesmo no CI.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";

import { describe, expect, it } from "vitest";
import { scoreMatch, slugifyMatchTag } from "./match-service";
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
 */
const LACUNAS_CONHECIDAS: Record<Motor, Record<string, string>> = {
  privado: {
    // Achado da própria rede (N8, 25/11): "exportamos" não está na lista de verbos de shared/direcao-do-termo.ts,
    // então a oferta fica neutra, saoConcorrentes não barra e a categoria em comum ("Frutas") dá 60. Corrigir é
    // mexer no analisador de termo (verbo conjugado), com teste negativo e positivo: fica para o N7.
    C06: "verbo conjugado ('Exportamos frutas') não é lido como direção; a categoria em comum casa as concorrentes",
  },
  perfis: {
    // server/CLAUDE.md, "Os três motores de match": o motor de perfis NÃO aplica a regra dos concorrentes
    // (satisfaz devolve true no have === need e no mesmo objeto). Uniformizar é decisão de produto, não ajuste local.
    C01: "motor de perfis não aplica a regra dos concorrentes (decisão de produto em aberto)",
    C02: "motor de perfis não aplica a regra dos concorrentes (decisão de produto em aberto)",
    C03: "motor de perfis não aplica a regra dos concorrentes (decisão de produto em aberto)",
    C05: "motor de perfis não aplica a regra dos concorrentes (decisão de produto em aberto)",
  },
};

function casaNoPrivado(par: Par): boolean {
  const asset = { slug: slugifyMatchTag(par.oferta.rotulo), label: par.oferta.rotulo, category: par.oferta.categoria };
  const need = { slug: slugifyMatchTag(par.procura.rotulo), label: par.procura.rotulo, category: par.procura.categoria };
  return scoreMatch(asset, need).score >= CORTE_PRIVADO;
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

function medir(motor: Motor): Medida {
  const casa = motor === "privado" ? casaNoPrivado : casaNoDePerfis;
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
