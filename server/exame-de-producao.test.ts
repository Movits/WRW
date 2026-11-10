import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Os dois módulos são .mjs sem declaração de tipos. O tsconfig exclui *.test.ts
// do `pnpm check` e o Vitest só transpila, então o import funciona em tempo de
// execução; o editor pode marcar TS7016, e a diretiva abaixo existe para isso.
// @ts-expect-error módulo .mjs sem tipos (ver comentário acima)
import * as relatorioMod from "../scripts/exame/relatorio.mjs";
// @ts-expect-error módulo .mjs sem tipos (ver comentário acima)
import * as limpezaMod from "../scripts/exame/limpeza.mjs";

/**
 * Regras do exame de produção (scripts/checar-producao.mjs), provadas sem I/O
 * sobre os módulos puros scripts/exame/relatorio.mjs e scripts/exame/limpeza.mjs.
 *
 * Por que cada regra existe (auditoria de 02/09/2026):
 *
 * 1. Veredito honesto. O exame antigo capturava a exceção, imprimia "produção
 *    saudável" e saía com código 0. Aqui exceção, limpeza com erro, ALERTA e
 *    LIMITE (429 persistente) reprovam; PULADO é contado à parte e repetido no
 *    resumo como NÃO PROVADO, para "passou" nunca se confundir com "não testei".
 *
 * 2. Status 200 antes do conteúdo. A checagem de isolamento lia a resposta de um
 *    401, 403 ou 429 como "lista vazia" e concluía "a outra usuária não vê nada":
 *    passava com o servidor quebrado. `avaliar` exige 200 e distingue 400 (o
 *    EXAME chamou errado) de falha de produção; `avaliarNegativa` só aceita o
 *    status fechado que o exame pediu, e 401 vira "barrado por motivo errado".
 *
 * 3. Ritmo obedece ao servidor. O apiLimiter é 100 req/min por IP; duas execuções
 *    seguidas estouravam. A janela local (85/60 s) é rede de segurança; o
 *    cabeçalho RateLimit (draft-7) e o Retry-After mandam. Relógio e sono são
 *    injetáveis para o teste não esperar de verdade.
 *
 * 4. Limpeza conferida contra o schema nas DUAS direções. A limpeza antiga
 *    apagava em `gold_access_grants WHERE userId` (colunas reais grantedTo,
 *    grantedBy, revokedBy) e em `notifications` (tabela real
 *    platform_notifications): "Unknown column" engolido, dado QA sobrando em
 *    produção para sempre, e nenhuma FOREIGN KEY para cascatear. Direção A: todo
 *    par do plano existe em drizzle/schema.ts. Direção B: toda coluna de usuária
 *    do schema está no plano ou numa exceção justificada, então tabela nova com
 *    owner_id deixa este arquivo vermelho até alguém decidir o que fazer com ela.
 *
 * 5. SQL sem LIKE global em `planejarLimpeza`. Três limpezas antigas eram
 *    `LIKE 'Exame%'` sem dona e podiam apagar dado de gente; agora toda chave é id,
 *    openId, e-mail ou id da oportunidade, e `users` fecha a lista exigindo id E
 *    prefixo qa_exame. As duas exceções vivem em `planejarFaxinaDuravel`, onde a
 *    chave durável é o título do exame e o sufixo `@exame.invalid`, porque a linha
 *    pode estar em conta real; os dois comandos estão fixados por valor no caso
 *    de planejarFaxinaDuravel abaixo.
 *
 * 6. Pureza e sintaxe. Os módulos não podem importar mysql2, dotenv nem fs, nem
 *    ler process.env (senão o teste vira integração e o script principal perde
 *    a única fronteira testável). O texto dos módulos MENCIONA "process.env" em
 *    comentário para explicar a regra, por isso a checagem tira os comentários
 *    antes de procurar. `node --check` nos três .mjs pega erro de sintaxe que o
 *    CI não veria (o tsc não olha scripts/).
 */

const { Relatorio, PREFIXO, avaliar, avaliarNegativa, resumirErro, analisarRateLimit, Ritmo } =
  relatorioMod as any;
const {
  PLANO_DE_LIMPEZA,
  EXCECOES,
  COLUNAS_DE_USUARIA,
  ACOES_DE_AUDITORIA_PRESERVADAS,
  CHAVES,
  planejarLimpeza,
  planejarFaxinaDuravel,
  planejarColetaDeConexoes,
} = limpezaMod as any;

const AQUI: string = (import.meta as any).dirname ?? path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..");

// ───────────────────────── parse de drizzle/schema.ts ─────────────────────────
// O "\n\}" do RE_TABELA fecha o objeto de colunas ANTES de "}, (table) => ({":
// sem ele os nomes de índice ("gold_grantedTo_idx") entrariam como coluna.
const RE_TABELA = /mysqlTable\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\n\}/g;
// Grupo 1: o construtor do drizzle (int, bigint, varchar...); grupo 2: o nome SQL.
const RE_COLUNA = /^[ \t]+[A-Za-z_$][\w$]*:\s*([A-Za-z_$][\w$]*)(?:<[^>]*>)?\(\s*"([^"]+)"/gm;

type Tabelas = Record<string, Set<string>>;
const FONTE_SCHEMA = readFileSync(path.resolve(AQUI, "..", "drizzle", "schema.ts"), "utf8");
/** "tabela.coluna" -> construtor do drizzle, para fixar o TIPO de cada chave do plano. */
const tipos = new Map<string, string>();

function lerTabelasDoSchema(): Tabelas {
  const tabelas: Tabelas = {};
  for (const tabela of FONTE_SCHEMA.matchAll(RE_TABELA)) {
    const colunas = new Set<string>();
    for (const coluna of tabela[2].matchAll(RE_COLUNA)) {
      colunas.add(coluna[2]);
      tipos.set(`${tabela[1]}.${coluna[2]}`, coluna[1]);
    }
    tabelas[tabela[1]] = colunas;
  }
  return tabelas;
}

const tabelas = lerTabelasDoSchema();

function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(linha => !linha.trim().startsWith("//"))
    .join("\n");
}

function contarInterrogacoes(sql: string): number {
  return (sql.match(/\?/g) || []).length;
}

function ritmoDeTeste(opcoes: Record<string, unknown> = {}) {
  const relogio = { t: 1_000_000 };
  const esperas: number[] = [];
  const ritmo = new Ritmo({
    agora: () => relogio.t,
    dormir: async (ms: number) => {
      esperas.push(ms);
    },
    ...opcoes,
  });
  return { ritmo, relogio, esperas };
}

// ═══════════════════════════ 1. Relatorio ═══════════════════════════════════
describe("Relatorio: o veredito só é 'produção saudável' sem nada reprovando", () => {
  it("exceção no meio: código 1, resumo com 'interrompido' e SEM 'produção saudável'", () => {
    const r = new Relatorio();
    r.ok("site no ar", true);
    r.excecao(new Error("ECONNREFUSED"));
    expect(r.houveExcecao).toBe(true);
    expect(r.codigoDeSaida()).toBe(1);
    expect(r.resumo()).toContain("interrompido");
    expect(r.resumo()).not.toContain("produção saudável");
    // A exceção ocupa mais de uma linha desde 12/09 (cabeçalho + pilha); quem
    // carrega a mensagem é a primeira delas.
    const daExcecao = r.linhas.filter(l => l.tipo === "excecao");
    expect(daExcecao.length).toBeGreaterThan(0);
    expect(daExcecao[0].texto.startsWith(PREFIXO.excecao)).toBe(true);
    expect(daExcecao[0].texto).toContain("ECONNREFUSED");
    expect(r.linhas.at(-1).tipo).toBe("excecao");
  });

  it("exceção vence LIMITE no veredito", () => {
    const r = new Relatorio();
    r.limite("network.list");
    r.excecao("x".repeat(300));
    expect(r.resumo()).toContain("interrompido");
    expect(r.resumo()).not.toContain("incompleto");
  });

  // Em 09/09 o exame parou em 58 OK dizendo só "interrompido por exceção", com a
  // mensagem cortada em 200 caracteres e sem pilha nem contexto: não havia o que
  // investigar. As três checagens abaixo são o que faltava naquele dia.
  it("a exceção diz O QUE foi: tipo, mensagem inteira e código do driver", () => {
    const r = new Relatorio();
    const erro: Error & { code?: string } = new TypeError("a".repeat(300));
    erro.code = "ECONNRESET";
    r.excecao(erro);
    const linha = r.linhas.find(l => l.tipo === "excecao")!;
    expect(linha.nome).toContain("TypeError");
    expect(linha.nome).toContain("[ECONNRESET]");
    // A mensagem inteira, não um pedaço dela.
    expect(linha.nome).toContain("a".repeat(300));
  });

  it("a exceção diz ONDE parou: a última checagem anunciada antes dela", () => {
    const r = new Relatorio();
    r.ok("site no ar", true);
    r.ok("login da conta prata", true);
    r.excecao(new Error("timeout"));
    const linha = r.linhas.find(l => l.tipo === "excecao")!;
    expect(linha.nome).toContain("parou depois de: login da conta prata");
  });

  it("exceção antes de qualquer checagem diz isso em vez de mentir um lugar", () => {
    const r = new Relatorio();
    r.excecao(new Error("falhou ao conectar"));
    expect(r.linhas[0].nome).toContain("parou antes da primeira checagem");
  });

  it("a pilha vem junto, em linhas próprias e limitada", () => {
    const r = new Relatorio();
    r.ok("site no ar", true);
    r.excecao(new Error("estourou"));
    const daExcecao = r.linhas.filter(l => l.tipo === "excecao");
    // Uma linha de cabeçalho e as demais de pilha; o corte evita despejar 80 quadros.
    expect(daExcecao.length).toBeGreaterThan(1);
    expect(daExcecao.length).toBeLessThanOrEqual(6);
    expect(daExcecao[1].nome.trim().startsWith("at ")).toBe(true);
  });

  it("limpeza com erro reprova mesmo com todas as checagens OK", () => {
    const r = new Relatorio();
    r.ok("a", true);
    r.ok("b", true);
    r.limpezaComErro("DELETE FROM `x` falhou: Unknown column");
    expect(r.houveErroDeLimpeza).toBe(true);
    expect(r.contagens()).toEqual({ ok: 2, falhas: 1, pulados: 0 });
    expect(r.codigoDeSaida()).toBe(1);
    expect(r.resumo()).toContain("limpeza incompleta");
    expect(r.resumo()).not.toContain("produção saudável");
    expect(r.linhas.at(-1).texto.startsWith(PREFIXO.limpeza)).toBe(true);
  });

  it("ALERTA conta como falha e derruba o código de saída", () => {
    const r = new Relatorio();
    r.ok("a", true);
    expect(r.alerta("alerta assíncrono em voo", "pode restar notificação")).toBe(false);
    expect(r.contagens()).toEqual({ ok: 1, falhas: 1, pulados: 0 });
    expect(r.codigoDeSaida()).toBe(1);
    expect(r.resumo()).toContain("1 falha(s)");
    expect(r.resumo()).toContain("investigue as FALHAs");
    expect(r.linhas.at(-1).texto.startsWith(PREFIXO.alerta)).toBe(true);
  });

  it("LIMITE: código 1 e resumo com 'incompleto'", () => {
    const r = new Relatorio();
    r.ok("a", true);
    expect(r.limite("matches.list", "429 persistiu")).toBe(false);
    expect(r.houveLimite).toBe(true);
    expect(r.contagens().falhas).toBe(1);
    expect(r.codigoDeSaida()).toBe(1);
    expect(r.resumo()).toContain("incompleto");
    expect(r.resumo()).not.toContain("produção saudável");
    expect(r.linhas.at(-1).texto.startsWith(PREFIXO.limite)).toBe(true);
  });

  it("PULADO não é OK nem falha: contado à parte e repetido como NÃO PROVADO (1): nome", () => {
    const r = new Relatorio();
    r.ok("a", true);
    expect(r.pulado("trava do Smart Match", "sem termo publicado")).toBe(false);
    expect(r.contagens()).toEqual({ ok: 1, falhas: 0, pulados: 1 });
    expect(r.codigoDeSaida()).toBe(0);
    const resumo = r.resumo();
    expect(resumo).toContain("1 OK, 0 falha(s), 1 pulado(s)");
    expect(resumo).toContain("NÃO PROVADO (1): trava do Smart Match");
    expect(r.linhas.at(-1).texto.startsWith(PREFIXO.pulado)).toBe(true);
    expect(r.linhas.at(-1).texto).toContain("sem termo publicado");
  });

  it("dois PULADOs saem listados juntos, na ordem, separados por ponto e vírgula", () => {
    const r = new Relatorio();
    r.pulado("vitrine", "teto de 200");
    r.pulado("termo Ouro", "sem versão");
    expect(r.resumo()).toContain("NÃO PROVADO (2): vitrine; termo Ouro");
  });

  it("só OKs: código 0 e 'produção saudável'; ok() devolve a condição", () => {
    const r = new Relatorio();
    expect(r.ok("a", true)).toBe(true);
    expect(r.ok("b", 3 > 2, "extra")).toBe(true);
    expect(r.contagens()).toEqual({ ok: 2, falhas: 0, pulados: 0 });
    expect(r.codigoDeSaida()).toBe(0);
    expect(r.resumo()).toBe("2 OK, 0 falha(s), 0 pulado(s) | produção saudável");
    expect(r.linhas[1].texto).toBe(`${PREFIXO.ok} b | extra`);
  });

  it("ok() com condição falsa vira FALHA e devolve false", () => {
    const r = new Relatorio();
    expect(r.ok("asset immutable", false, "Cache-Control ausente")).toBe(false);
    expect(r.linhas[0].tipo).toBe("falha");
    expect(r.linhas[0].texto.startsWith(PREFIXO.falha)).toBe(true);
    expect(r.codigoDeSaida()).toBe(1);
  });

  it("naoExecutada conta como falha, com o motivo na linha", () => {
    const r = new Relatorio();
    expect(r.naoExecutada("auth.me", "sem sessão")).toBe(false);
    expect(r.contagens()).toEqual({ ok: 0, falhas: 1, pulados: 0 });
    expect(r.codigoDeSaida()).toBe(1);
    expect(r.linhas[0].texto.startsWith(PREFIXO.falha)).toBe(true);
    expect(r.linhas[0].texto).toContain("NÃO EXECUTADA (sem sessão)");
  });

  it("INFO não entra em nenhuma contagem", () => {
    const r = new Relatorio();
    r.info("instância acordou em 12 s");
    expect(r.contagens()).toEqual({ ok: 0, falhas: 0, pulados: 0 });
    expect(r.codigoDeSaida()).toBe(0);
    expect(r.linhas[0].texto.startsWith(PREFIXO.info)).toBe(true);
  });

  it("texto() lista as linhas na ordem e termina com o resumo", () => {
    const r = new Relatorio();
    r.ok("primeira", true);
    r.falha("segunda", "detalhe");
    r.info("terceira");
    const texto = r.texto();
    expect(texto.endsWith(r.resumo())).toBe(true);
    expect(texto.startsWith(`${PREFIXO.ok} primeira`)).toBe(true);
    expect(texto.indexOf("primeira")).toBeLessThan(texto.indexOf("segunda"));
    expect(texto.indexOf("segunda")).toBeLessThan(texto.indexOf("terceira"));
    expect(texto).toContain(`${PREFIXO.falha} segunda | detalhe`);
  });

  it("cada tipo de linha começa com o próprio PREFIXO, e todos os prefixos são distintos", () => {
    const r = new Relatorio();
    r.ok("a", true);
    r.ok("b", false);
    r.falha("c");
    r.pulado("d", "motivo");
    r.alerta("e", "x");
    r.limite("f");
    r.info("g");
    r.excecao(new Error("h"));
    r.limpezaComErro("i");
    r.naoExecutada("j", "k");
    for (const linha of r.linhas) {
      expect(linha.texto.startsWith(PREFIXO[linha.tipo]), `linha "${linha.texto}"`).toBe(true);
    }
    const tiposVistos = new Set(r.linhas.map((l: any) => l.tipo));
    expect([...tiposVistos].sort()).toEqual(Object.keys(PREFIXO).sort());
    expect(new Set(Object.values(PREFIXO)).size).toBe(Object.keys(PREFIXO).length);
  });
});

// ═══════════════════════════ 2. avaliar ═════════════════════════════════════
describe("avaliar: exige status 200 antes de olhar o conteúdo", () => {
  it("429 → motivo 'limite'", () => {
    const j = avaliar({ status: 429 }, () => true);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("limite");
    expect(j.detalhe).toContain("429");
  });

  it("400 → motivo 'zod' com detalhe começando por 'input do exame inválido'", () => {
    const j = avaliar({ status: 400, codigo: "BAD_REQUEST", erro: "Required" });
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("zod");
    expect(j.detalhe.startsWith("input do exame inválido")).toBe(true);
    expect(j.detalhe).toContain("BAD_REQUEST");
  });

  it("403 → motivo 'status' com 'status 403' e no máximo 40 caracteres da mensagem", () => {
    const j = avaliar({ status: 403, codigo: "FORBIDDEN", erro: "M".repeat(60) });
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("status");
    expect(j.detalhe).toContain("status 403");
    expect(j.detalhe).toContain("FORBIDDEN");
    expect(j.detalhe).toContain("M".repeat(40));
    expect(j.detalhe).not.toContain("M".repeat(41));
  });

  it("lista vazia vinda de um 401 NÃO passa (o furo do isolamento antigo)", () => {
    const j = avaliar({ status: 401, dado: [] }, (d: unknown[]) => Array.isArray(d) && d.length === 0);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("status");
    expect(j.detalhe).toContain("status 401");
  });

  it("200 com erro no envelope → motivo 'status'", () => {
    const j = avaliar({ status: 200, erro: "algo", dado: [] }, () => true);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("status");
    expect(j.detalhe).toContain("200 com erro no envelope");
  });

  it("200 e predicado falso → motivo 'predicado'", () => {
    const j = avaliar({ status: 200, dado: { itens: [] } }, (d: any) => d.itens.length > 0);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("predicado");
  });

  it("200 e predicado que lança → motivo 'predicado' com 'predicado lançou'", () => {
    const j = avaliar({ status: 200, dado: null }, (d: any) => d.itens.length > 0);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("predicado");
    expect(j.detalhe).toContain("predicado lançou");
  });

  it("200 e predicado verdadeiro → ok, sem motivo", () => {
    const j = avaliar({ status: 200, dado: [1] }, (d: unknown[]) => d.length === 1);
    expect(j).toEqual({ ok: true, motivo: "", detalhe: "" });
  });

  it("resposta ausente não lança: vira 'status'", () => {
    const j = avaliar(undefined);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("status");
  });
});

describe("avaliarNegativa: só o status fechado que o exame pediu", () => {
  const regras = [(s: number, e: string) => s === 500 && e === "NOT_FOUND", (s: number) => s === 404];

  it("aceita quando alguma regra casa (500 + NOT_FOUND cru do router)", () => {
    const j = avaliarNegativa({ status: 500, erro: "NOT_FOUND", codigo: "INTERNAL_SERVER_ERROR" }, regras);
    expect(j.ok).toBe(true);
    expect(j.motivo).toBe("");
    expect(j.detalhe).toBe("status 500");
  });

  it("recusa 401 com 'barrado por motivo errado'", () => {
    const j = avaliarNegativa({ status: 401, erro: "UNAUTHORIZED", codigo: "UNAUTHORIZED" }, regras);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("status");
    expect(j.detalhe).toContain("barrado por motivo errado");
    expect(j.detalhe).toContain("status 401");
  });

  it("429 → 'limite', sem consultar as regras", () => {
    const j = avaliarNegativa({ status: 429 }, [() => true]);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("limite");
  });

  it("a regra recebe (status, erro, codigo) e pode filtrar pelo código do tRPC", () => {
    const soCodigo = [(s: number, _e: string, c: string) => s === 403 && c === "FORBIDDEN"];
    expect(avaliarNegativa({ status: 403, codigo: "FORBIDDEN" }, soCodigo).ok).toBe(true);
    expect(avaliarNegativa({ status: 403, codigo: "UNAUTHORIZED" }, soCodigo).ok).toBe(false);
  });

  it("resposta ausente não lança: vira 'status' (como em avaliar)", () => {
    const j = avaliarNegativa(undefined, [(s: number) => s === 404]);
    expect(j.ok).toBe(false);
    expect(j.motivo).toBe("status");
  });
});

describe("resumirErro: nunca mais de 40 caracteres da mensagem do servidor", () => {
  it("corta a mensagem em 40", () => {
    expect(resumirErro({ erro: "y".repeat(100) })).toBe("y".repeat(40));
  });

  it("código + mensagem, com separador só quando há algo", () => {
    const r = resumirErro({ codigo: "FORBIDDEN", erro: "z".repeat(100) }, " ");
    expect(r.startsWith(" FORBIDDEN ")).toBe(true);
    expect(r.length).toBe(" FORBIDDEN ".length + 40);
    expect(resumirErro({}, " ")).toBe("");
    expect(resumirErro(undefined, " ")).toBe("");
  });
});

// ═══════════════════════════ 3. analisarRateLimit ═══════════════════════════
describe("analisarRateLimit: cabeçalho combinado RateLimit (draft-7)", () => {
  it("lê limit, remaining e reset", () => {
    expect(analisarRateLimit("limit=100, remaining=87, reset=42")).toEqual({ limit: 100, remaining: 87, reset: 42 });
  });

  it("sem remaining → null; não string → null", () => {
    expect(analisarRateLimit("limit=100, reset=42")).toBeNull();
    expect(analisarRateLimit(undefined)).toBeNull();
    expect(analisarRateLimit(null)).toBeNull();
    expect(analisarRateLimit("")).toBeNull();
    expect(analisarRateLimit(100)).toBeNull();
  });

  it("remaining não numérico é descartado, e sem ele o cabeçalho não vale", () => {
    expect(analisarRateLimit("limit=100, remaining=abc, reset=42")).toBeNull();
  });
});

// ═══════════════════════════ 4. Ritmo ═══════════════════════════════════════
describe("Ritmo: janela local de 85/60 s mais o orçamento que o servidor informa", () => {
  it("85 chamadas com relógio parado passam sem esperar; a 86ª pede exatamente 60000", async () => {
    const { ritmo, esperas } = ritmoDeTeste();
    for (let i = 0; i < 85; i++) {
      expect(ritmo.esperaNecessaria(), `chamada ${i + 1}`).toBe(0);
      await ritmo.antes();
    }
    expect(esperas).toEqual([]);
    expect(ritmo.esperasMs).toBe(0);
    expect(ritmo.esperaNecessaria()).toBe(60000);
  });

  it("a 59999 ms ainda falta 1 ms; a 60000 ms a janela esvazia e volta a 0", async () => {
    const { ritmo, relogio } = ritmoDeTeste();
    for (let i = 0; i < 85; i++) await ritmo.antes();
    relogio.t += 59999;
    expect(ritmo.esperaNecessaria()).toBe(1);
    relogio.t += 1;
    expect(ritmo.esperaNecessaria()).toBe(0);
  });

  it("antes() dorme exatamente o necessário e acumula esperasMs", async () => {
    const { ritmo, esperas } = ritmoDeTeste();
    for (let i = 0; i < 85; i++) await ritmo.antes();
    await ritmo.antes();
    expect(esperas).toEqual([60000]);
    expect(ritmo.esperasMs).toBe(60000);
  });

  it("depois(headers) com remaining=5 e reset=30 → esperaNecessaria() 30000 (relógio parado)", () => {
    const { ritmo, relogio } = ritmoDeTeste();
    ritmo.depois(new Headers({ ratelimit: "limit=100, remaining=5, reset=30" }));
    expect(ritmo.esperaNecessaria()).toBe(30000);
    relogio.t += 30000;
    expect(ritmo.esperaNecessaria()).toBe(0);
  });

  it("remaining acima da folga (10) não faz esperar; o nome do cabeçalho é lido sem distinguir caixa", () => {
    const { ritmo } = ritmoDeTeste();
    ritmo.depois(new Headers({ RateLimit: "limit=100, remaining=50, reset=30" }));
    expect(ritmo.servidor).toEqual({ remaining: 50, resetEm: 1_000_000 + 30_000 });
    expect(ritmo.esperaNecessaria()).toBe(0);
  });

  it("Retry-After: 7 → esperaAposLimite() 7000; sem cabeçalho → janelaMs", () => {
    const { ritmo } = ritmoDeTeste();
    expect(ritmo.esperaAposLimite()).toBe(60000);
    ritmo.depois(new Headers({ "retry-after": "7" }));
    expect(ritmo.esperaAposLimite()).toBe(7000);
  });

  it("429 real da produção: RateLimit e Retry-After juntos, o Retry-After manda", () => {
    const { ritmo } = ritmoDeTeste();
    ritmo.depois(new Headers({ ratelimit: "limit=100, remaining=0, reset=30", "retry-after": "7" }));
    expect(ritmo.servidor).toEqual({ remaining: 0, resetEm: 1_007_000 });
    expect(ritmo.esperaAposLimite()).toBe(7000);
  });

  it("RateLimit sem reset cai na janela de 60 s", () => {
    const { ritmo } = ritmoDeTeste();
    ritmo.depois(new Headers({ ratelimit: "limit=100, remaining=0" }));
    expect(ritmo.esperaNecessaria()).toBe(60000);
  });

  it("depois() sem Headers de verdade não lança nem muda nada", () => {
    const { ritmo } = ritmoDeTeste();
    ritmo.depois(undefined);
    ritmo.depois({});
    expect(ritmo.servidor).toBeNull();
    expect(ritmo.esperaNecessaria()).toBe(0);
  });

  it("limite e janela são configuráveis", async () => {
    const { ritmo } = ritmoDeTeste({ limite: 2, janelaMs: 1000 });
    await ritmo.antes();
    await ritmo.antes();
    expect(ritmo.esperaNecessaria()).toBe(1000);
    expect(ritmo.esperaAposLimite()).toBe(1000);
  });
});

// ═══════════════════ 5. limpeza, direção A: plano → schema ══════════════════
describe("limpeza, direção A: todo par do plano existe em drizzle/schema.ts", () => {
  it("o parse enxerga TODAS as tabelas e não confunde índice com coluna", () => {
    // Igualdade, não piso: se RE_TABELA parar de casar uma tabela, a direção B
    // encolheria em silêncio e este é o único caso que acusaria.
    expect(Object.keys(tabelas).length).toBe((FONTE_SCHEMA.match(/mysqlTable\(/g) || []).length);
    expect(tipos.get("users.id")).toBe("int");
    expect(tipos.get("private_contacts.ownerId")).toBe("varchar");
    expect(tabelas.users.has("openId")).toBe(true);
    expect(tabelas.gold_access_grants.has("grantedTo")).toBe(true);
    expect(tabelas.gold_access_grants.has("gold_grantedTo_idx")).toBe(false);
    expect(tabelas.private_contacts.has("ownerId")).toBe(true);
    expect(tabelas.contexts.has("owner_id")).toBe(true);
  });

  it.each(PLANO_DE_LIMPEZA)("$tabela.$coluna existe naquela tabela", ({ tabela, coluna }: any) => {
    expect(tabelas[tabela], `tabela "${tabela}" não existe no schema`).toBeDefined();
    expect(tabelas[tabela].has(coluna), `coluna "${coluna}" não existe em "${tabela}"`).toBe(true);
  });

  // Chave "id"/"opp" só cabe em coluna inteira; "openId"/"email" só em varchar. Uma
  // chave trocada gera `WHERE owner_id IN (1, 2)` contra varchar: zero linhas, em
  // silêncio. É o defeito 5 da auditoria com outra roupa.
  const TIPO_POR_CHAVE: Record<string, string[]> = { id: ["int", "bigint"], opp: ["int", "bigint"], openId: ["varchar"], email: ["varchar"], conexao: ["varchar"] };

  it("cada par tem chave conhecida E do tipo certo, ação apagar/alertar e aparece uma vez só", () => {
    const vistos = new Set<string>();
    for (const par of PLANO_DE_LIMPEZA) {
      expect(CHAVES).toContain(par.chave);
      expect(["apagar", "alertar"]).toContain(par.acao);
      const id = `${par.tabela}.${par.coluna}`;
      expect(TIPO_POR_CHAVE[par.chave], `${id} declarada como chave "${par.chave}" mas a coluna é ${tipos.get(id)}`).toContain(tipos.get(id));
      expect(vistos.has(id), `par repetido: ${id}`).toBe(false);
      vistos.add(id);
    }
  });

  it("a lista de colunas que só ALERTAM está fixada (mudar exige decisão escrita)", () => {
    expect(PLANO_DE_LIMPEZA.filter((p: any) => p.acao === "alertar").map((p: any) => `${p.tabela}.${p.coluna}`)).toEqual([
      "opportunity_interests.opportunityId", "saved_opportunities.opportunityId", "deal_rooms.opportunityId",
      "national_leaders.nominatedBy", "national_leaders.revokedBy", "president_validations.validatedBy",
      "connections.moderatedBy", "security_events.resolvedBy", "opportunities.moderatedBy", "gold_access_grants.grantedBy", "gold_access_grants.revokedBy",
    ]);
  });

  it("toda EXCECAO aponta para coluna que existe, traz motivo escrito e não mascara par do plano", () => {
    for (const ex of EXCECOES) {
      expect(tabelas[ex.tabela], `exceção órfã: tabela "${ex.tabela}"`).toBeDefined();
      expect(tabelas[ex.tabela].has(ex.coluna), `exceção órfã: ${ex.tabela}.${ex.coluna}`).toBe(true);
      expect(typeof ex.motivo).toBe("string");
      expect(ex.motivo.trim().length).toBeGreaterThan(0);
      const noPlano = PLANO_DE_LIMPEZA.find((p: any) => p.tabela === ex.tabela && p.coluna === ex.coluna);
      if (ex.cobertaComFiltro) {
        // A exceção só explica um par que ESTÁ no plano com filtro (audit_logs).
        expect(noPlano, `${ex.tabela}.${ex.coluna} diz estar coberta pelo plano e não está`).toBeDefined();
        expect(noPlano.filtroExtra, `${ex.tabela}.${ex.coluna} sem filtroExtra`).toBeTruthy();
      } else {
        expect(noPlano, `${ex.tabela}.${ex.coluna} está no plano E nas exceções`).toBeUndefined();
      }
    }
  });
});

// ═══════════════════ 6. limpeza, direção B: schema → plano ══════════════════
const paresDeUsuariaNoSchema = Object.entries(tabelas)
  .filter(([tabela]) => tabela !== "users")
  .flatMap(([tabela, colunas]) => [...colunas].filter(c => COLUNAS_DE_USUARIA.test(c)).map(coluna => ({ tabela, coluna })));

describe("limpeza, direção B: tabela nova com coluna de usuária (owner_id, userId...) deixa este teste vermelho até entrar no plano ou nas EXCECOES", () => {
  it("o schema tem pares de usuária a conferir", () => {
    // Igualdade de propósito: subir é normal ao criar tabela; baixar exige explicar
    // qual coluna de usuária sumiu do parse.
    // 57: a etapa 13 somou nda_acceptances.userId (trilha de aceite do NDA).
    // 58: o distribuidor do Smart Match somou connections.moderatedBy.
    // 63: o Meu Network Inteligente somou network_sugestoes.owner_id,
    // conexoes_participantes.owner_id e .userId, consumo_de_minutos.owner_id e
    // assinaturas_de_minutos.userId.
    // 64: as partes do áudio da gravação longa somaram meeting_audio_slices.owner_id.
    expect(paresDeUsuariaNoSchema).toHaveLength(64);
    expect(paresDeUsuariaNoSchema).toContainEqual({ tabela: "meeting_audio_slices", coluna: "owner_id" });
    expect(paresDeUsuariaNoSchema).toContainEqual({ tabela: "private_contacts", coluna: "ownerId" });
    expect(paresDeUsuariaNoSchema).toContainEqual({ tabela: "gold_access_grants", coluna: "revokedBy" });
    expect(paresDeUsuariaNoSchema).toContainEqual({ tabela: "nda_acceptances", coluna: "userId" });
  });

  it.each(paresDeUsuariaNoSchema)(
    "$tabela.$coluna está no PLANO_DE_LIMPEZA ou em EXCECOES com motivo",
    ({ tabela, coluna }) => {
      const noPlano = PLANO_DE_LIMPEZA.some((p: any) => p.tabela === tabela && p.coluna === coluna);
      const excecao = EXCECOES.find((e: any) => e.tabela === tabela && e.coluna === coluna);
      const justificada = Boolean(excecao && typeof excecao.motivo === "string" && excecao.motivo.trim());
      expect(
        noPlano || justificada,
        `${tabela}.${coluna} aponta para usuária e não está nem no plano nem nas exceções: decida apagar, alertar ou justificar`,
      ).toBe(true);
    },
  );
});

// ═══════════════════════════ 7. planejarLimpeza ═════════════════════════════
describe("planejarLimpeza: SQL parametrizado, sem LIKE global, users por último", () => {
  const ids = [1, 2];
  const openIds = ["qa_exame_presidente", "qa_exame_prata"];
  const conexaoIds = ["conexao-1", "conexao-2"];
  const comandos = planejarLimpeza({ ids, openIds, emails: ["A@Exame.invalid"], oppIds: [77], conexaoIds });
  const todosOsParams: unknown[] = comandos.flatMap((c: any) => c.params);

  it("um comando por par do plano mais os três de oportunidade/usuárias", () => {
    expect(comandos.length).toBe(PLANO_DE_LIMPEZA.length + 3);
  });

  it("todo 'apagar' começa com DELETE FROM e todo 'alertar' com SELECT COUNT(*)", () => {
    expect(comandos.some((c: any) => c.acao === "apagar")).toBe(true);
    expect(comandos.some((c: any) => c.acao === "alertar")).toBe(true);
    for (const c of comandos) {
      expect(["apagar", "alertar"]).toContain(c.acao);
      if (c.acao === "apagar") expect(c.sql.startsWith("DELETE FROM `"), c.sql).toBe(true);
      else expect(c.sql.startsWith("SELECT COUNT(*)"), c.sql).toBe(true);
    }
  });

  it("número de '?' bate com o número de params em todos os comandos, e nenhum param é undefined", () => {
    for (const c of comandos) {
      expect(contarInterrogacoes(c.sql), c.sql).toBe(c.params.length);
      expect(c.params.includes(undefined), c.sql).toBe(false);
    }
  });

  it("nenhum SQL tem LIKE 'Exame%' global: o único LIKE é o de users com prefixo qa_exame%", () => {
    const comLike = comandos.filter((c: any) => /\bLIKE\b/i.test(c.sql));
    expect(comLike).toHaveLength(1);
    expect(comLike[0].sql.startsWith("DELETE FROM `users`")).toBe(true);
    for (const c of comandos) expect(c.sql).not.toMatch(/Exame%/);
    expect(todosOsParams.some(p => typeof p === "string" && p.startsWith("Exame"))).toBe(false);
    expect(todosOsParams.filter(p => typeof p === "string" && p.includes("%"))).toEqual(["qa_exame%"]);
  });

  it("users é o ÚLTIMO comando, exige id E openId LIKE 'qa_exame%'", () => {
    const ultimo = comandos.at(-1);
    expect(ultimo.sql).toBe("DELETE FROM `users` WHERE `id` IN (?, ?) AND `openId` LIKE ?");
    expect(ultimo.params).toEqual([1, 2, "qa_exame%"]);
    // Só UM comando apaga em users; a subconsulta `publishedBy NOT IN (SELECT id FROM users)` só lê.
    expect(comandos.filter((c: any) => c.sql.startsWith("DELETE FROM `users`"))).toHaveLength(1);
  });

  it("audit_logs leva `action` NOT IN com as duas ações preservadas nos params", () => {
    const audit = comandos.filter((c: any) => c.sql.startsWith("DELETE FROM `audit_logs`"));
    expect(audit).toHaveLength(1);
    expect(audit[0].sql).toContain("`action` NOT IN (?, ?)");
    expect(ACOES_DE_AUDITORIA_PRESERVADAS).toEqual(["GOLD_ACERVO_READ", "REVOKED_SESSION_ACCESS_ATTEMPT"]);
    expect(audit[0].params).toEqual([1, 2, ...ACOES_DE_AUDITORIA_PRESERVADAS]);
    expect(audit[0].sql).not.toMatch(/UPDATE/i);
  });

  it("login_attempts recebe o e-mail em minúsculas", () => {
    const login = comandos.filter((c: any) => c.sql.startsWith("DELETE FROM `login_attempts`"));
    expect(login).toHaveLength(1);
    expect(login[0].sql).toContain("`identifier` IN (?)");
    expect(login[0].params).toEqual(["a@exame.invalid"]);
  });

  it("platform_notifications por actionUrl leva '/opportunities/77'", () => {
    const porUrl = comandos.filter((c: any) => c.sql.includes("`actionUrl` IN"));
    expect(porUrl).toHaveLength(1);
    expect(porUrl[0].acao).toBe("apagar");
    expect(porUrl[0].sql.startsWith("DELETE FROM `platform_notifications`")).toBe(true);
    expect(porUrl[0].params).toEqual(["/opportunities/77"]);
  });

  it("opportunities por id exige autoria QA ou publicadora já apagada (órfã), nunca conta real", () => {
    const porId = comandos.filter((c: any) => c.sql.startsWith("DELETE FROM `opportunities` WHERE `id` IN"));
    expect(porId).toHaveLength(1);
    expect(porId[0].sql).toBe(
      "DELETE FROM `opportunities` WHERE `id` IN (?) AND (`publishedBy` IN (?, ?) OR `publishedBy` NOT IN (SELECT `id` FROM `users`))",
    );
    expect(porId[0].params).toEqual([77, 1, 2]);
    // Sem ids (conta já apagada por execução anterior), só a órfã sai.
    const soOrfa = planejarLimpeza({ openIds, oppIds: [77] }).filter((c: any) => c.sql.startsWith("DELETE FROM `opportunities` WHERE `id` IN"));
    expect(soOrfa).toHaveLength(1);
    expect(soOrfa[0].sql).toBe("DELETE FROM `opportunities` WHERE `id` IN (?) AND `publishedBy` NOT IN (SELECT `id` FROM `users`)");
    expect(soOrfa[0].params).toEqual([77]);
  });

  it("alertar não conta linha cuja dona principal é QA (grant da QA para a QA sai na passada de apagar)", () => {
    const alertaGrant = comandos.find((c: any) => c.descricao === "gold_access_grants.grantedBy (id)");
    expect(alertaGrant.acao).toBe("alertar");
    expect(alertaGrant.sql).toBe("SELECT COUNT(*) AS n FROM `gold_access_grants` WHERE `grantedBy` IN (?, ?) AND `grantedTo` NOT IN (?, ?)");
    expect(alertaGrant.params).toEqual([1, 2, 1, 2]);
    const alertaSala = comandos.find((c: any) => c.descricao === "deal_rooms.opportunityId (opp)");
    expect(alertaSala.sql).toBe("SELECT COUNT(*) AS n FROM `deal_rooms` WHERE `opportunityId` IN (?) AND `interestedId` NOT IN (?, ?)");
    expect(alertaSala.params).toEqual([77, 1, 2]);
    // Todo par que só alerta precisa dizer quem é a dona principal, senão conta a própria QA.
    for (const par of PLANO_DE_LIMPEZA.filter((p: any) => p.acao === "alertar")) {
      expect(par.excetoSe, `${par.tabela}.${par.coluna} sem excetoSe`).toBeDefined();
      expect(tabelas[par.tabela].has(par.excetoSe.coluna), `${par.tabela}.${par.excetoSe.coluna} não existe`).toBe(true);
    }
  });

  it("deal_rooms só sai quando as DUAS pontas são QA (sala de conta real na oportunidade QA fica)", () => {
    const salas = comandos.filter((c: any) => c.sql.startsWith("DELETE FROM `deal_rooms`"));
    expect(salas.map((c: any) => c.sql)).toEqual([
      "DELETE FROM `deal_rooms` WHERE `ownerId` IN (?, ?) AND `interestedId` IN (?, ?)",
      "DELETE FROM `deal_rooms` WHERE `interestedId` IN (?, ?) AND `ownerId` IN (?, ?)",
    ]);
    for (const c of salas) expect(c.params).toEqual([1, 2, 1, 2]);
  });

  it("os pares de chave openId usam os openIds, os de chave id usam os ids", () => {
    const contatos = comandos.find((c: any) => c.sql.startsWith("DELETE FROM `private_contacts`"));
    expect(contatos.sql).toBe("DELETE FROM `private_contacts` WHERE `ownerId` IN (?, ?)");
    expect(contatos.params).toEqual(openIds);
    const perfis = comandos.find((c: any) => c.sql.startsWith("DELETE FROM `user_profiles`"));
    expect(perfis.params).toEqual(ids);
  });

  it("sem oppIds não há comando com chave opp", () => {
    const semOpp = planejarLimpeza({ ids, openIds, emails: ["a@exame.invalid"] });
    expect(semOpp.some((c: any) => /\(opp\b/.test(c.descricao))).toBe(false);
    expect(semOpp.some((c: any) => c.sql.includes("`opportunityId`"))).toBe(false);
    expect(semOpp.some((c: any) => c.sql.includes("`actionUrl`"))).toBe(false);
    expect(semOpp.some((c: any) => c.sql.startsWith("DELETE FROM `opportunities` WHERE `id`"))).toBe(false);
    expect(semOpp.at(-1).sql.startsWith("DELETE FROM `users`")).toBe(true);
  });

  it("sem ids não há comando de users; com tudo vazio devolve []", () => {
    const soOpenIds = planejarLimpeza({ openIds });
    expect(soOpenIds.length).toBeGreaterThan(0);
    expect(soOpenIds.some((c: any) => c.sql.includes("`users`"))).toBe(false);
    expect(planejarLimpeza({})).toEqual([]);
    expect(planejarLimpeza()).toEqual([]);
  });

  it("conexoes_registradas (sem coluna de usuária, fora da direção B) está no plano e sai por id ANTES dos participantes", () => {
    // O recálculo do motor privado grava um cabeçalho PRIVATE_NETWORK_MATCH por par
    // do exame; sem este par ele ficava órfão, com `lados: []`, a cada execução.
    expect(PLANO_DE_LIMPEZA).toContainEqual({ tabela: "conexoes_registradas", coluna: "id", chave: "conexao", acao: "apagar" });
    const descricoes = comandos.map((c: any) => c.descricao);
    const cabecalho = descricoes.indexOf("conexoes_registradas.id (conexao)");
    expect(cabecalho).toBeGreaterThanOrEqual(0);
    expect(comandos[cabecalho].sql).toBe("DELETE FROM `conexoes_registradas` WHERE `id` IN (?, ?)");
    expect(comandos[cabecalho].params).toEqual(conexaoIds);
    // Participante apagado primeiro = cabeçalho impossível de achar se a execução morrer no meio.
    expect(cabecalho).toBeLessThan(descricoes.indexOf("conexoes_participantes.owner_id (openId)"));
    expect(cabecalho).toBeLessThan(descricoes.indexOf("conexoes_participantes.userId (id)"));
    // Sem coleta, nenhum DELETE no cabeçalho: nunca um DELETE sem WHERE de id.
    expect(planejarLimpeza({ ids, openIds }).some((c: any) => c.sql.includes("`conexoes_registradas`"))).toBe(false);
  });

  it("planejarColetaDeConexoes: só conexão sem participante de fora das QA, com NULL tratado como 'não é QA'", () => {
    const coleta = planejarColetaDeConexoes({ ids, openIds });
    expect(coleta.sql).toBe(
      "SELECT DISTINCT `conexao_id` AS id FROM `conexoes_participantes` WHERE (`owner_id` IN (?, ?) OR `userId` IN (?, ?))" +
      " AND `conexao_id` NOT IN (SELECT `conexao_id` FROM `conexoes_participantes` WHERE (`owner_id` IS NULL OR `owner_id` NOT IN (?, ?)) AND (`userId` IS NULL OR `userId` NOT IN (?, ?)))",
    );
    expect(coleta.params).toEqual([...openIds, ...ids, ...openIds, ...ids]);
    expect(contarInterrogacoes(coleta.sql)).toBe(coleta.params.length);
    expect(coleta.sql).not.toMatch(/\bLIKE\b|DELETE|UPDATE/i);

    // Conta QA já apagada (sem ids): a coleta segue pelos openIds.
    const soOpenIds = planejarColetaDeConexoes({ openIds });
    expect(soOpenIds.sql).toBe(
      "SELECT DISTINCT `conexao_id` AS id FROM `conexoes_participantes` WHERE (`owner_id` IN (?, ?))" +
      " AND `conexao_id` NOT IN (SELECT `conexao_id` FROM `conexoes_participantes` WHERE (`owner_id` IS NULL OR `owner_id` NOT IN (?, ?)))",
    );
    expect(soOpenIds.params).toEqual([...openIds, ...openIds]);
    expect(planejarColetaDeConexoes({})).toBeNull();
    expect(planejarColetaDeConexoes()).toBeNull();
  });

  it("planejarFaxinaDuravel: 2 DELETEs, o primeiro por body com aspas + título", () => {
    const faxina = planejarFaxinaDuravel({ tituloDaOportunidade: "X" });
    expect(faxina).toHaveLength(2);
    for (const c of faxina) {
      expect(c.acao).toBe("apagar");
      expect(c.sql.startsWith("DELETE FROM `")).toBe(true);
      expect(contarInterrogacoes(c.sql)).toBe(c.params.length);
    }
    expect(faxina[0].sql).toContain("`platform_notifications`");
    expect(faxina[0].params).toEqual(['"X%']);
    expect(faxina[1].sql).toContain("`security_events`");
    expect(faxina[1].sql).toContain("`userId` IS NULL");
    expect(faxina[1].params).toEqual(["%@exame.invalid"]);
  });
});

// ═══════════════════════════ 8. Pureza ══════════════════════════════════════
const MODULOS_PUROS = ["scripts/exame/relatorio.mjs", "scripts/exame/limpeza.mjs"];

describe("pureza: scripts/exame/*.mjs não abrem banco, não leem .env nem process.env", () => {
  it.each(MODULOS_PUROS)("%s", arquivo => {
    const fonte = readFileSync(path.resolve(RAIZ, arquivo), "utf8");
    const imports = fonte.split("\n").filter(l => l.startsWith("import"));
    for (const linha of imports) {
      expect(linha, linha).not.toMatch(/mysql2|dotenv|node:fs|["']fs["']/);
      // Só módulos irmãos de scripts/exame/ podem ser importados.
      expect(linha, linha).toMatch(/["']\.\/[^"']+["']/);
    }
    const codigo = semComentarios(fonte);
    expect(codigo).not.toContain("process.env");
    expect(codigo).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});

// ═══════════════════════════ 9. Sintaxe ═════════════════════════════════════
const SCRIPTS_DO_EXAME = [...MODULOS_PUROS, "scripts/checar-producao.mjs"];

function checarSintaxe(caminho: string): string {
  try {
    execFileSync(process.execPath, ["--check", caminho], { stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (erro: any) {
    return String((erro.stderr && erro.stderr.toString()) || erro.message);
  }
}

describe("sintaxe: node --check nos três .mjs do exame (arquivo ausente também reprova)", () => {
  it.each(SCRIPTS_DO_EXAME)("%s", arquivo => {
    const caminho = path.resolve(RAIZ, arquivo);
    expect(existsSync(caminho), `${arquivo} não existe`).toBe(true);
    expect(checarSintaxe(caminho)).toBe("");
  });
});

// ═══════════════════════════ 10. Termo Geral de Uso vigente ═════════════════
// Sem versão vigente, profile.completeOnboarding barra todo cadastro novo, e a
// 0013 só abre o enum: o exame pós-deploy saía verde com o cadastro travado.
describe("Termo Geral de Uso vigente: o exame reprova sem exatamente uma versão", () => {
  const { avaliarTermoGeralVigente, COMANDO_PUBLICAR_TERMO_GERAL } = relatorioMod as any;

  it("uma versão vigente passa", () => {
    expect(avaliarTermoGeralVigente(1)).toEqual({ ok: true, detalhe: "1 versão vigente" });
  });

  it("nenhuma versão reprova e diz como publicar (arquivo que existe, sem aviso, com confirmação)", () => {
    const r = avaliarTermoGeralVigente(0);
    expect(r.ok).toBe(false);
    expect(r.detalhe).toContain("NENHUMA");
    expect(r.detalhe).toContain(COMANDO_PUBLICAR_TERMO_GERAL);
    expect(COMANDO_PUBLICAR_TERMO_GERAL).toContain("termo_geral_de_uso docs/termos/termo-geral-de-uso.md");
    expect(COMANDO_PUBLICAR_TERMO_GERAL).toContain("--sem-aviso");
    expect(COMANDO_PUBLICAR_TERMO_GERAL).toContain("--confirmo-producao");
    expect(existsSync(path.resolve(RAIZ, "docs", "termos", "termo-geral-de-uso.md"))).toBe(true);
  });

  it("mais de uma versão vigente também reprova", () => {
    expect(avaliarTermoGeralVigente(2).ok).toBe(false);
    expect(avaliarTermoGeralVigente(2).detalhe).toContain("2 versões vigentes");
  });

  it("dentro de uma FALHA de verdade: o relatório reprova com código 1", () => {
    const r = new Relatorio();
    const t = avaliarTermoGeralVigente(0);
    r.ok("Termo Geral de Uso vigente", t.ok, t.detalhe);
    expect(r.codigoDeSaida()).toBe(1);
    expect(r.linhas.at(-1).tipo).toBe("falha");
  });

  it("checar-producao.mjs roda a checagem contra o tipo certo", () => {
    const fonte = readFileSync(path.resolve(RAIZ, "scripts", "checar-producao.mjs"), "utf8");
    expect(fonte).toMatch(
      /avaliarTermoGeralVigente\(\s*await contar\("SELECT COUNT\(\*\) n FROM `document_versions` WHERE `type` = \? AND `isCurrent` = 1", \["termo_geral_de_uso"\]\)/,
    );
  });
});
