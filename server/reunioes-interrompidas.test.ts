import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CODIGO_ERRO_INTERROMPIDO } from "@shared/const";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Reunião presa em "processing" (reverificação de 04/09, etapa 3).
 *
 * O status só era revertido pela própria requisição: SIGTERM no meio do
 * Gemini (todo merge na main é deploy no Render) deixava a reunião
 * "Processando" para sempre, sem erro e sem saída além de excluir e gravar de
 * novo. A varredura marca como falha, com o CÓDIGO ERRO_INTERROMPIDO que a
 * tela traduz, o que está preso há mais de 15 min — e roda no boot e pelo
 * endpoint de cron.
 *
 * O banco é simulado por identidade de tabela; o fake não executa o
 * predicado, então o filtro (status + idade) só se prova olhando para o WHERE
 * renderizado pelo dialeto do MySQL — SQL e parâmetros. Uma lista de colunas
 * deixava passar `and`→`or`, `<`→`>`, o corte invertido (agora + 15 min) e um
 * `owner_id = ''` a mais.
 */

type Predicado = { sql: string; params: unknown[] };
const dialeto = new MySqlDialect();
const renderizar = (condicao?: SQL): Predicado => {
  const { sql, params } = condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] };
  return { sql, params };
};

const tabelas = new Map<unknown, Record<string, unknown>[]>();
const leituras: Array<{ tabela: unknown } & Predicado> = [];
const atualizacoes: Array<{ tabela: unknown; valores: Record<string, unknown> } & Predicado> = [];
// Linhas afetadas que o fake responde ao UPDATE; null = "quantas linhas a
// tabela simulada tem". Zero simula a reunião que terminou entre o SELECT e
// o UPDATE (o predicado repetido não a alcança mais).
let linhasAfetadasNoUpdate: number | null = null;
const fakeDb = {
  select: () => ({
    from: (tabela: unknown) => ({
      where: (condicao?: SQL) => {
        leituras.push({ tabela, ...renderizar(condicao) });
        const linhas = tabelas.get(tabela) ?? [];
        return { limit: async () => linhas, then: (resolver: (valor: unknown) => unknown) => resolver(linhas) };
      },
    }),
  }),
  update: (tabela: unknown) => ({
    set: (valores: Record<string, unknown>) => ({
      where: async (condicao?: SQL) => {
        atualizacoes.push({ tabela, valores, ...renderizar(condicao) });
        return [{ affectedRows: linhasAfetadasNoUpdate ?? (tabelas.get(tabela) ?? []).length }];
      },
    }),
  }),
};
vi.mock("./db", () => ({ exigirDb: async () => fakeDb as never, getDb: async () => fakeDb as never }));
vi.mock("./storage", async importOriginal => ({
  ...await importOriginal<typeof import("./storage")>(),
  storagePut: async () => ({ key: "k", url: "/k" }),
  storageDelete: async () => {},
}));
vi.mock("./_core/llm", () => ({ invokeLLM: async () => ({ choices: [] }) }));
// As classes de erro vêm do módulo real: meeting-service faz instanceof nelas.
vi.mock("./gemini", async importOriginal => ({
  ...await importOriginal<typeof import("./gemini")>(),
  transcribeWithGemini: async () => ({ text: "", segments: [] }),
}));

const schema = await import("../drizzle/schema");
const servico = await import("./meeting-service");

beforeEach(() => {
  tabelas.clear();
  leituras.length = 0;
  atualizacoes.length = 0;
  linhasAfetadasNoUpdate = null;
});

describe("marcarReunioesInterrompidas — o que está preso vira falha explicável", () => {
  it("reunião presa vira 'failed' com o código ERRO_INTERROMPIDO e updated_at novo", async () => {
    tabelas.set(schema.meetings, [{ id: "reuniao-presa" }]);
    const antes = Date.now();

    const resultado = await servico.marcarReunioesInterrompidas();

    expect(resultado).toEqual({ encontradas: 1, marcadas: 1 });
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0].tabela).toBe(schema.meetings);
    expect(atualizacoes[0].valores).toMatchObject({ status: "failed", processingError: servico.CODIGO_ERRO_INTERROMPIDO });
    expect(Number(atualizacoes[0].valores.updatedAt)).toBeGreaterThanOrEqual(antes);
  });

  it("é um CÓDIGO, não uma frase: a tela compara com a MESMA constante (shared) e traduz nos dez idiomas", () => {
    expect(servico.CODIGO_ERRO_INTERROMPIDO).toBe("ERRO_INTERROMPIDO");
    expect(servico.CODIGO_ERRO_INTERROMPIDO).toBe(CODIGO_ERRO_INTERROMPIDO);
    // Literal duplicado na tela seria o jeito de o código mudar de um lado só
    // e a caixa vermelha passar a mostrar "ERRO_INTERROMPIDO" cru.
    const tela = readFileSync(join(__dirname, "..", "client", "src", "pages", "Meetings.tsx"), "utf8");
    expect(tela).toMatch(/import \{[^}]*\bCODIGO_ERRO_INTERROMPIDO\b[^}]*\} from "@shared\/const"/);
    expect(tela).toContain("processingError === CODIGO_ERRO_INTERROMPIDO");
    expect(tela).toContain('t("meetings.processingInterrupted")');
  });

  it("filtra por status = 'processing' E updated_at < (agora − 15 min) — no SELECT e de novo no UPDATE, pelos ids achados", async () => {
    tabelas.set(schema.meetings, [{ id: "reuniao-presa" }]);
    const antes = Date.now();

    await servico.marcarReunioesInterrompidas();

    const depois = Date.now();
    // Varredura de SISTEMA: só status e idade, em AND, sem owner_id — `or`
    // marcaria toda reunião velha; `>` ou o corte invertido marcariam as
    // que acabaram de entrar em processamento.
    const leitura = leituras.find(operacao => operacao.tabela === schema.meetings)!;
    // Só o envio único: a reunião em partes em 'processing' é da fila (G7).
    expect(leitura.sql).toBe("(`meetings`.`status` = ? and `meetings`.`audio_pipeline` = ? and `meetings`.`updated_at` < ?)");
    expect(leitura.params).toHaveLength(3);
    expect(leitura.params.slice(0, 2)).toEqual(["processing", "single"]);
    const corte = Number(leitura.params[2]);
    expect(corte).toBeGreaterThanOrEqual(antes - servico.LIMITE_PROCESSAMENTO_MS);
    expect(corte).toBeLessThanOrEqual(depois - servico.LIMITE_PROCESSAMENTO_MS);

    // O UPDATE repete o predicado, restrito aos ids do SELECT, com o MESMO
    // corte: uma reunião que terminou no meio (updated_at novo, status
    // 'ready') não é marcada.
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0].sql).toBe("(`meetings`.`id` in (?) and `meetings`.`status` = ? and `meetings`.`audio_pipeline` = ? and `meetings`.`updated_at` < ?)");
    expect(atualizacoes[0].params).toEqual(["reuniao-presa", "processing", "single", corte]);
    // e o updated_at gravado é o "agora" de que o corte foi subtraído
    expect(Number(atualizacoes[0].valores.updatedAt) - corte).toBe(servico.LIMITE_PROCESSAMENTO_MS);
  });

  it("com várias presas, o UPDATE leva TODOS os ids do SELECT", async () => {
    tabelas.set(schema.meetings, [{ id: "presa-1" }, { id: "presa-2" }, { id: "presa-3" }]);

    const resultado = await servico.marcarReunioesInterrompidas();

    expect(resultado).toEqual({ encontradas: 3, marcadas: 3 });
    expect(atualizacoes[0].sql).toBe("(`meetings`.`id` in (?, ?, ?) and `meetings`.`status` = ? and `meetings`.`audio_pipeline` = ? and `meetings`.`updated_at` < ?)");
    expect(atualizacoes[0].params.slice(0, 3)).toEqual(["presa-1", "presa-2", "presa-3"]);
  });

  it("um limite diferente entra no corte: marcarReunioesInterrompidas(60_000) só pega o que passou de 1 min", async () => {
    tabelas.set(schema.meetings, [{ id: "reuniao-presa" }]);
    const antes = Date.now();

    await servico.marcarReunioesInterrompidas(60_000);

    const corte = Number(leituras[0].params[2]);
    expect(corte).toBeGreaterThanOrEqual(antes - 60_000);
    expect(corte).toBeLessThanOrEqual(Date.now() - 60_000);
  });

  it("'marcadas' é o que o UPDATE afetou, não o que o SELECT achou: zero linhas quando a reunião terminou entre os dois", async () => {
    tabelas.set(schema.meetings, [{ id: "reuniao-presa" }]);
    linhasAfetadasNoUpdate = 0;

    const resultado = await servico.marcarReunioesInterrompidas();

    expect(resultado).toEqual({ encontradas: 1, marcadas: 0 });
    expect(atualizacoes).toHaveLength(1);
  });

  it("sem reunião vencida, nenhum UPDATE sai", async () => {
    tabelas.set(schema.meetings, []);

    const resultado = await servico.marcarReunioesInterrompidas();

    expect(resultado).toEqual({ encontradas: 0, marcadas: 0 });
    expect(atualizacoes).toHaveLength(0);
  });

  it("o limite padrão é 15 minutos: folga para um pico sem marcar reunião que ainda vai terminar", () => {
    expect(servico.LIMITE_PROCESSAMENTO_MS).toBe(15 * 60 * 1000);
  });
});

describe("marcarReunioesInterrompidas — quem a dispara", () => {
  const boot = readFileSync(join(__dirname, "_core", "index.ts"), "utf8");
  const inicioDoServidor = boot.slice(boot.indexOf("async function startServer"));
  // Com o ponto e vírgula: é a INSTRUÇÃO, não a menção a ela no comentário
  // da varredura — sem isso, mover a varredura para antes do app passava.
  const posicaoDoApp = inicioDoServidor.indexOf("const app = express();");

  it("o boot varre DEPOIS das migrações e de `const app = express()`, em try/catch, só com DATABASE_URL", () => {
    const antesDoApp = inicioDoServidor.slice(0, posicaoDoApp);
    const depoisDoApp = inicioDoServidor.slice(posicaoDoApp);
    expect(antesDoApp).not.toContain("marcarReunioesInterrompidas");
    expect(depoisDoApp).toContain("marcarReunioesInterrompidas");
    const trecho = depoisDoApp.slice(0, depoisDoApp.indexOf("marcarReunioesInterrompidas()"));
    expect(trecho).toContain("if (process.env.DATABASE_URL)");
    expect(trecho).toContain("try {");
    // a varredura vem antes de o servidor aceitar tráfego
    expect(depoisDoApp.indexOf("marcarReunioesInterrompidas")).toBeLessThan(depoisDoApp.indexOf("server.listen("));
  });

  it("além do boot, uma varredura a cada 5 min (com unref), na MESMA guarda de DATABASE_URL: o endpoint de cron não tem chamador", () => {
    // Sem isto, uma reunião derrubada ENTRE deploys (proxy do Render
    // encerrando a requisição) ficava presa até o próximo restart — e, com o
    // botão Excluir desabilitado em processing, presa E inexcluível.
    const guarda = inicioDoServidor.slice(inicioDoServidor.indexOf("if (process.env.DATABASE_URL) {", posicaoDoApp));
    const bloco = guarda.slice(0, guarda.indexOf("app.set("));
    expect(bloco).toContain('varrerReunioesPresas("Boot")');
    expect(bloco).toContain("setInterval(");
    expect(bloco).toContain("5 * 60_000");
    expect(bloco).toContain(".unref()");
    expect(bloco.indexOf('varrerReunioesPresas("Boot")')).toBeLessThan(bloco.indexOf("setInterval("));
    // a passada periódica também não pode derrubar o processo: tudo dentro do try do helper
    expect(bloco.indexOf("try {")).toBeLessThan(bloco.indexOf("marcarReunioesInterrompidas()"));
  });

  it("há o endpoint de cron ao lado da limpeza de gravações, com a mesma autenticação e auditoria", () => {
    const endpoint = boot.slice(boot.indexOf('app.post("/api/scheduled/mark-interrupted-meetings"'));
    expect(endpoint.length).toBeGreaterThan(0);
    const corpo = endpoint.slice(0, endpoint.indexOf("app.use("));
    // A autenticação é o helper de server/_core/cron.ts (401 sem sessão, 403
    // sem ser cron) — o mesmo das outras duas rotas; agendados-autenticacao.test.ts o prova.
    expect(corpo).toContain("const user = await autenticarCron(req, res);");
    expect(corpo).toContain("if (!user) return;");
    expect(corpo).toContain("marcarReunioesInterrompidas()");
    expect(corpo).toContain('action: "CRON_MARK_INTERRUPTED_MEETINGS"');
  });
});
