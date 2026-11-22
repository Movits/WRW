import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Segmento } from "./transcricao-de-fatia";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.perguntar, pelo router, com a IA dublada. O resumo a pedido saiu na
 * H4c: o resumo é o guardado (resumo-da-reuniao.test.ts e
 * fila-do-resumo.integracao.test.ts). Prova:
 *
 * - a IA lê a transcrição rotulada INTEIRA, primeiro, e a pergunta por último;
 *   os nomes que a dona deu às vozes nem são lidos; acima de 400 mil
 *   caracteres a pergunta é recusada com código próprio (H6);
 * - de 1 a 3 citações, cada uma conferida na transcrição e com o segundo em que
 *   começa; inventada sai, negação fica; o campo antigo vem junto;
 * - a resposta só cita as vozes que a entrada rotulou (a de fala vazia, não);
 * - a resposta que não vai à tela fica no log com o motivo, sem a fala de ninguém;
 * - o tempo da chamada: 45 s até 100 mil caracteres, 80 s acima;
 * - o teto da dona: a pergunta sobre reunião longa gasta duas vagas;
 * - só a dona: o ownerId vai no WHERE das leituras, e reunião de outra dona é
 *   NOT_FOUND sem chamar a IA;
 * - reunião sem transcrição, ou que não está pronta, é recusada antes da IA;
 * - banco fora do ar é erro, nunca resposta vazia; IA fora do ar é
 *   SERVICE_UNAVAILABLE, que a tela traduz;
 * - nada é gravado no banco.
 */

const TRANSCRICAO = [
  "Ana: Bom dia a todos. Hoje vamos falar da exportação de café para a Alemanha.",
  "Bruno: O contêiner sai do porto de Santos no dia 12 de março.",
  "Ana: Então fica decidido que a Carla fecha o contrato com o importador até sexta-feira.",
  "Carla: Combinado. Decidimos não renovar o contrato com a transportadora antiga.",
].join("\n");

// A reunião gravada em partes: as falas com voz e tempo, e o texto delas.
const FALAS: Segmento[] = [
  { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia a todos." },
  { inicio: 4, fim: 9, falante: "F1", texto: "Hoje vamos falar da exportação de café para a Alemanha." },
  { inicio: 75, fim: 82, falante: "F2", texto: "O contêiner sai do porto de Santos no dia 12 de março." },
  { inicio: 82, fim: 90, falante: "", texto: "", lacuna: true },
  { inicio: 130, fim: 138, falante: "F1", texto: "O frete marítimo fica para sexta-feira." },
  { inicio: 138, fim: 146, falante: "F3", texto: "Combinado. Decidimos não renovar o contrato com a transportadora antiga." },
];
const TEXTO_DAS_FALAS = FALAS.filter(f => !f.lacuna).map(f => f.texto).join("\n");

const invokeLLM = vi.fn();
const escritas = vi.fn();

const banco = {
  dona: "dona-1",
  existe: true,
  status: "ready",
  transcricao: TRANSCRICAO as string | null,
  segmentos: [] as unknown,
  // Os nomes que a dona deu às vozes (meetings.speaker_names).
  nomes: null as Record<string, string> | null,
  indisponivel: false,
  erroNaConsulta: null as Error | null,
  leituras: [] as Array<{ tabela: unknown; sql: string; params: unknown[]; campos: string[] }>,
};

const schema = await import("../drizzle/schema");
const { BancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } = await import("./banco-indisponivel");
const dialeto = new MySqlDialect();

// Como o MySQL: só volta o que o SELECT pediu.
const soOPedido = (campos: Record<string, unknown>, linha: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(campos).map(campo => [campo, linha[campo]]));

// A guarda da lixeira (H7d) lê o banco antes do zod, em todo procedimento pelo id. Aqui o
// router é provado com o banco dublado; a guarda tem os testes dela (guarda-da-lixeira.test.ts
// e server/lixeira-de-reunioes.integracao.test.ts).
vi.mock("./guarda-da-lixeira", async () => ({ procedimentoDaReuniao: (await import("./_core/trpc")).protectedProcedure }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => {
    if (banco.indisponivel) throw new BancoIndisponivel();
    return {
      select: (campos: Record<string, unknown>) => ({ from: (tabela: unknown) => ({ where: (condicao: SQL) => {
        const { sql, params } = dialeto.sqlToQuery(condicao);
        banco.leituras.push({ tabela, sql, params, campos: Object.keys(campos) });
        return { limit: async () => {
          if (banco.erroNaConsulta) throw banco.erroNaConsulta;
          // Como o MySQL: a linha só volta se o WHERE pede a dona dela.
          if (!params.includes(banco.dona)) return [];
          if (tabela === schema.meetings) return banco.existe ? [soOPedido(campos, { status: banco.status, speakerNames: banco.nomes })] : [];
          if (tabela === schema.meetingTranscripts) {
            return banco.transcricao === null ? [] : [soOPedido(campos, { transcript: banco.transcricao, segments: banco.segmentos })];
          }
          return [];
        } };
      } }) }),
      insert: (...args: unknown[]) => escritas("insert", ...args),
      update: (...args: unknown[]) => escritas("update", ...args),
      delete: (...args: unknown[]) => escritas("delete", ...args),
    };
  },
  createPrivateContact: async () => 1,
}));
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));

const { meetingsRouter, tetoDaIADaReuniao, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const {
  LIMITE_DA_ENTRADA_DA_PERGUNTA,
  ENTRADA_LONGA_DA_PERGUNTA,
  MENSAGEM_IA_INDISPONIVEL,
  MENSAGEM_REUNIAO_LONGA_PARA_PERGUNTAR,
  MENSAGEM_SEM_TRANSCRICAO,
  perguntarAReuniao,
  trechoApareceNaTranscricao,
} = await import("./reuniao-com-ia");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = "dona-1") => meetingsRouter.createCaller(contexto(openId));
const respostaDaIA = (dados: unknown) => ({ choices: [{ message: { content: JSON.stringify(dados) } }] });
const NAO_RESPONDE = { respondida: false, resposta: "", citacoes: [] };
const respondeCom = (resposta: string, ...trechos: string[]) =>
  invokeLLM.mockResolvedValue(respostaDaIA({ respondida: true, resposta, citacoes: trechos.map(trecho => ({ trecho })) }));
const pedido = (i = 0) => invokeLLM.mock.calls[i][0] as { messages: Array<{ role: string; content: string }>; timeoutMs: number; orcamentoMs: number };
const mensagens = (i = 0) => pedido(i).messages;
const comFalas = () => Object.assign(banco, { transcricao: TEXTO_DAS_FALAS, segmentos: FALAS });
// O motivo da pergunta não respondida vai ao log: a IA que disse não em
// console.info, a resposta que a conferência derrubou em console.warn.
const logInfo = vi.spyOn(console, "info").mockImplementation(() => {});
const logAviso = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  // O teto de pedidos à IA da dona é estado de módulo: cada teste começa com ele vazio.
  tetoDaIADaReuniao.esquecer();
  invokeLLM.mockReset();
  escritas.mockReset();
  logInfo.mockClear();
  logAviso.mockClear();
  Object.assign(banco, {
    dona: "dona-1", existe: true, status: "ready", transcricao: TRANSCRICAO, segmentos: [], nomes: null,
    indisponivel: false, erroNaConsulta: null, leituras: [],
  });
});

describe("trechoApareceNaTranscricao", () => {
  it("caixa, espaços, aspas e pontuação não contam", () => {
    expect(trechoApareceNaTranscricao("“o contêiner   SAI do porto de Santos”", TRANSCRICAO)).toBe(true);
    expect(trechoApareceNaTranscricao("Combinado decidimos não renovar", TRANSCRICAO)).toBe(true);
  });

  it("com reticências, cada pedaço precisa estar", () => {
    expect(trechoApareceNaTranscricao("a Carla fecha o contrato … até sexta-feira", TRANSCRICAO)).toBe(true);
    expect(trechoApareceNaTranscricao("a Carla fecha o contrato ... até segunda-feira", TRANSCRICAO)).toBe(false);
    expect(trechoApareceNaTranscricao("… fecha o contrato com o importador …", TRANSCRICAO)).toBe(true);
  });

  it("com reticências, os pedaços vêm na ordem da transcrição", () => {
    expect(trechoApareceNaTranscricao("até sexta-feira … a Carla fecha o contrato", TRANSCRICAO)).toBe(false);
    expect(trechoApareceNaTranscricao("Decidimos não renovar ... vamos falar da exportação", TRANSCRICAO)).toBe(false);
  });

  it("pedaço curto entre reticências não junta letras soltas de qualquer ponto", () => {
    expect(trechoApareceNaTranscricao("a ... e ... i ... o ... u ... a ... e ... i", TRANSCRICAO)).toBe(false);
    expect(trechoApareceNaTranscricao("Bom dia ... sai do ... de", TRANSCRICAO)).toBe(false);
  });

  it("paráfrase, trecho curto demais e valor que não é texto saem", () => {
    expect(trechoApareceNaTranscricao("A Carla vai assinar o contrato", TRANSCRICAO)).toBe(false);
    expect(trechoApareceNaTranscricao("Ana", TRANSCRICAO)).toBe(false);
    expect(trechoApareceNaTranscricao(null, TRANSCRICAO)).toBe(false);
  });
});

describe("meetings.perguntar — a transcrição pronta da dona, e só ela, vai à IA", () => {
  const perguntar = (openId = "dona-1") => rota(openId).perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Quando sai o contêiner?" });
  const naoRespondida = () => invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));

  it("pede JSON estruturado, com as citações no schema", async () => {
    naoRespondida();
    await expect(perguntar()).resolves.toEqual({ respondida: false });
    expect(invokeLLM.mock.calls[0][0]).toMatchObject({
      response_format: { type: "json_schema", json_schema: { name: "resposta_da_reuniao", strict: true, schema: { required: ["respondida", "resposta", "citacoes"] } } },
    });
    // A função escolhe o modelo do Pergunte (LLM_MODEL_PERGUNTA; sem ela, o LLM_MODEL).
    expect(invokeLLM.mock.calls[0][0]).toMatchObject({ funcao: "pergunta" });
  });

  it("só a dona: o ownerId vai no WHERE das duas leituras", async () => {
    naoRespondida();
    await perguntar();
    const [daReuniao, daTranscricao] = banco.leituras;
    expect(daReuniao).toMatchObject({ tabela: schema.meetings, sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ?)", params: [ID, "dona-1"] });
    expect(daTranscricao).toMatchObject({ tabela: schema.meetingTranscripts, params: [ID, "dona-1"] });
    expect(daTranscricao.sql).toContain("`meeting_transcripts`.`owner_id` = ?");
  });

  it("reunião de outra dona: NOT_FOUND, sem ler a transcrição nem chamar a IA", async () => {
    await expect(perguntar("outra-dona")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(banco.leituras).toHaveLength(1);
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("transcrição em branco é recusada antes da IA, com a frase que a tela traduz", async () => {
    banco.transcricao = "   ";
    await expect(perguntar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_SEM_TRANSCRICAO });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it.each(["processing", "failed", "recording"])("reunião em '%s' é recusada antes da IA", async status => {
    banco.status = status;
    await expect(perguntar()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("a conexão do banco recusada no meio da consulta também é erro, nunca resposta vazia", async () => {
    banco.erroNaConsulta = new Error("Failed query: select ...", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    await expect(perguntar()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("JSON inválido da IA: SERVICE_UNAVAILABLE com a frase que a tela traduz", async () => {
    invokeLLM.mockResolvedValueOnce({ choices: [{ message: { content: "isto não é JSON" } }] });
    await expect(perguntar()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_IA_INDISPONIVEL });
  });

  it("idioma fora dos dez e id que não é uuid: BAD_REQUEST, sem ler o banco", async () => {
    await expect(rota().perguntar({ meetingId: ID, idioma: "it" as never, pergunta: "Quando sai?" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(rota().perguntar({ meetingId: "reuniao-1", idioma: "pt-BR", pergunta: "Quando sai?" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(banco.leituras).toHaveLength(0);
  });
});

describe("meetings.perguntar", () => {
  it("responde com a citação conferida, no idioma da tela, mandando a pergunta à IA", async () => {
    respondeCom("The container leaves Santos on March 12.", "O contêiner sai do porto de Santos no dia 12 de março.");

    const resposta = await rota().perguntar({ meetingId: ID, idioma: "en", pergunta: "  Quando sai o contêiner?  " });

    const trecho = "O contêiner sai do porto de Santos no dia 12 de março.";
    expect(resposta).toEqual({ respondida: true, resposta: "The container leaves Santos on March 12.", citacoes: [{ trecho, inicioSegundos: null }], trecho });
    const [, usuario] = mensagens();
    expect(usuario.content).toContain("Responda em inglês.");
    expect(usuario.content).toContain("Pergunta: Quando sai o contêiner?");
    expect(escritas).not.toHaveBeenCalled();
  });

  it("resposta com trecho que não está na transcrição vale como não respondida", async () => {
    respondeCom("Custa 10 mil reais.", "o frete custa dez mil reais");
    await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Quanto custa o frete?" })).resolves.toEqual({ respondida: false });
  });

  it("a transcrição não responde: diz isso", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Qual é o CNPJ do importador?" })).resolves.toEqual({ respondida: false });
  });

  it("pergunta acima de 500 caracteres: BAD_REQUEST, sem ler o banco", async () => {
    await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "a".repeat(501) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(banco.leituras).toHaveLength(0);
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("só a dona, só com transcrição, banco fora do ar é erro", async () => {
    await expect(rota("outra-dona").perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Quando sai?" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    banco.transcricao = null;
    await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Quando sai?" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    banco.indisponivel = true;
    await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Quando sai?" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: MENSAGEM_BANCO_INDISPONIVEL });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("IA fora do ar: SERVICE_UNAVAILABLE", async () => {
    invokeLLM.mockRejectedValue(new Error("LLM sem resposta em 45s"));
    await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Quando sai?" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_IA_INDISPONIVEL });
  });
});

describe("o que vai à IA (H6): a transcrição rotulada inteira primeiro, a pergunta por último", () => {
  const perguntar = (idioma: "pt-BR" | "en" | "ja" = "pt-BR", pergunta = "Quando sai o contêiner?") => rota().perguntar({ meetingId: ID, idioma, pergunta });

  it("com as falas, a IA lê a transcrição rotulada como no resumo ({F1}: fala), e o idioma e a pergunta vêm no fim", async () => {
    comFalas();
    invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await perguntar("en");
    const [sistema, usuario] = mensagens();
    expect(usuario.content).toBe([
      "Transcrição:",
      "",
      "{F1}: Bom dia a todos. Hoje vamos falar da exportação de café para a Alemanha.",
      "{F2}: O contêiner sai do porto de Santos no dia 12 de março.",
      "{F1}: O frete marítimo fica para sexta-feira.",
      "{F3}: Combinado. Decidimos não renovar o contrato com a transportadora antiga.",
      "",
      "Responda em inglês.",
      "Pergunta: Quando sai o contêiner?",
    ].join("\n"));
    expect(sistema.content).toContain("rótulo de quem fala ({F1}, {F2}...)");
  });

  it("o começo do pedido (instruções e transcrição) é o mesmo em toda pergunta, em qualquer idioma: o cache do Gemini o reaproveita", async () => {
    comFalas();
    invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await perguntar("pt-BR", "Quem decidiu não renovar?");
    await perguntar("ja", "コンテナはいつ出ますか?");
    const [sistema1, usuario1] = mensagens(0);
    const [sistema2, usuario2] = mensagens(1);
    expect(sistema1.content).toBe(sistema2.content);
    const fimDaTranscricao = usuario1.content.indexOf("transportadora antiga.") + "transportadora antiga.".length;
    expect(usuario2.content.slice(0, fimDaTranscricao)).toBe(usuario1.content.slice(0, fimDaTranscricao));
    expect(usuario1.content.endsWith("Responda em português do Brasil.\nPergunta: Quem decidiu não renovar?")).toBe(true);
    expect(usuario2.content.endsWith("Pergunta: コンテナはいつ出ますか?")).toBe(true);
    for (const idioma of ["português", "japonês"]) expect(sistema1.content).not.toContain(idioma);
  });

  it("os nomes que a dona deu às vozes nunca vão à IA: a leitura da reunião nem os pede", async () => {
    comFalas();
    banco.nomes = { F1: "Glória Mendes", F2: "Otávio Prado" };
    invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await perguntar();
    const prompt = mensagens().map(m => m.content).join("\n");
    expect(prompt).toContain("{F1}: Bom dia a todos.");
    expect(prompt).not.toContain("Glória");
    expect(prompt).not.toContain("Otávio");
    const daReuniao = banco.leituras.find(leitura => leitura.tabela === schema.meetings)!;
    // O status e a lixeira (H7d), nada dos nomes.
    expect(daReuniao.campos).toEqual(["status", "trashedAt"]);
  });

  it("sem as falas (envio único), vai o texto corrido, sem rótulo, e a IA é avisada de que não há vozes", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await perguntar();
    const [sistema, usuario] = mensagens();
    expect(usuario.content.startsWith(`Transcrição:\n\n${TRANSCRICAO}\n\nResponda em`)).toBe(true);
    expect(sistema.content).toContain("não use rótulos de voz");
  });

  it(`a transcrição vai INTEIRA até ${LIMITE_DA_ENTRADA_DA_PERGUNTA} caracteres: sai o corte de 24 mil`, async () => {
    const fim = " e o fim da reunião.";
    const longa = "a fala segue sem pressa ".repeat(20_000).slice(0, LIMITE_DA_ENTRADA_DA_PERGUNTA - fim.length) + fim;
    expect(longa).toHaveLength(LIMITE_DA_ENTRADA_DA_PERGUNTA);
    banco.transcricao = longa;
    invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await expect(perguntar()).resolves.toEqual({ respondida: false });
    const [, usuario] = mensagens();
    expect(usuario.content).toContain(longa);
    expect(usuario.content).toContain("e o fim da reunião.\n\nResponda em");
  });

  it(`acima de ${LIMITE_DA_ENTRADA_DA_PERGUNTA} caracteres: PAYLOAD_TOO_LARGE, com o código só dela, sem chamar a IA`, async () => {
    banco.transcricao = "b".repeat(LIMITE_DA_ENTRADA_DA_PERGUNTA + 1);
    await expect(perguntar()).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: MENSAGEM_REUNIAO_LONGA_PARA_PERGUNTAR });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("o limite vale para o que vai à IA, com os rótulos: o texto cabe, mas a entrada rotulada passa e é recusada", async () => {
    // 4 falas de 99.999 letras: o texto corrido tem 399.999 caracteres; com os
    // 4 rótulos ("{F1}: "), a entrada da IA tem 400.023.
    const falas = Array.from({ length: 4 }, (_, i) => ({ inicio: i * 3600, fim: i * 3600 + 3000, falante: `F${(i % 2) + 1}`, texto: `${i}${"c".repeat(99_998)}` }));
    const texto = falas.map(f => f.texto).join("\n");
    expect(texto.length).toBeLessThanOrEqual(LIMITE_DA_ENTRADA_DA_PERGUNTA);
    Object.assign(banco, { transcricao: texto, segmentos: falas });
    await expect(perguntar()).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it(`o tempo da chamada: 45 s até ${ENTRADA_LONGA_DA_PERGUNTA} caracteres, 80 s acima; o orçamento da longa fica em 85 s, longe dos 100 s em que um proxy corta a requisição`, async () => {
    invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    banco.transcricao = "d".repeat(ENTRADA_LONGA_DA_PERGUNTA);
    await perguntar();
    banco.transcricao = "d".repeat(ENTRADA_LONGA_DA_PERGUNTA + 1);
    await perguntar();
    // Nova tentativa só depois de uma falha rápida: até 15 s na curta, até 5 s na longa.
    expect(pedido(0)).toMatchObject({ timeoutMs: 45_000, orcamentoMs: 60_000 });
    expect(pedido(1)).toMatchObject({ timeoutMs: 80_000, orcamentoMs: 85_000 });
  });

  it("antesDeChamarAIA roda antes da IA, dizendo se a reunião é longa; na recusa, não roda", async () => {
    const ordem: string[] = [];
    invokeLLM.mockImplementation(async () => { ordem.push("IA"); return respostaDaIA(NAO_RESPONDE); });
    const antes = vi.fn((custo: { longa: boolean }) => { ordem.push(`antes:${custo.longa}`); });

    await perguntarAReuniao("dona-1", ID, "Quando sai?", "pt-BR", antes);
    banco.transcricao = "e".repeat(ENTRADA_LONGA_DA_PERGUNTA + 1);
    await perguntarAReuniao("dona-1", ID, "Quando sai?", "pt-BR", antes);
    expect(ordem).toEqual(["antes:false", "IA", "antes:true", "IA"]);

    banco.transcricao = "e".repeat(LIMITE_DA_ENTRADA_DA_PERGUNTA + 1);
    await expect(perguntarAReuniao("dona-1", ID, "Quando sai?", "pt-BR", antes)).rejects.toMatchObject({ codigo: "PAYLOAD_TOO_LARGE" });
    banco.status = "processing";
    await expect(perguntarAReuniao("dona-1", ID, "Quando sai?", "pt-BR", antes)).rejects.toMatchObject({ codigo: "PRECONDITION_FAILED" });
    expect(antes).toHaveBeenCalledTimes(2);
  });
});

describe("as citações (H6): de 1 a 3, conferidas na transcrição, com o segundo em que começam", () => {
  const perguntar = () => rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "O que ficou combinado?" });

  it("cada citação vem com o segundo da fala em que começa; o trecho que cruza duas falas também acha o tempo, e o rótulo copiado junto sai", async () => {
    comFalas();
    respondeCom(
      "O contêiner sai dia 12, o frete fica para sexta e {F3} decidiu não renovar.",
      "O contêiner sai do porto de Santos no dia 12 de março",
      "fica para sexta-feira. {F3}: Combinado. Decidimos não renovar",
    );
    await expect(perguntar()).resolves.toEqual({
      respondida: true,
      resposta: "O contêiner sai dia 12, o frete fica para sexta e {F3} decidiu não renovar.",
      citacoes: [
        { trecho: "O contêiner sai do porto de Santos no dia 12 de março", inicioSegundos: 75 },
        { trecho: "fica para sexta-feira. Combinado. Decidimos não renovar", inicioSegundos: 130 },
      ],
      trecho: "O contêiner sai do porto de Santos no dia 12 de março",
    });
  });

  it("a citação inventada sai e as outras ficam; todas inventadas, a resposta vale como não respondida", async () => {
    comFalas();
    respondeCom("O frete fica para sexta.", "o frete custa dez mil reais por contêiner", "O frete marítimo fica para sexta-feira");
    await expect(perguntar()).resolves.toMatchObject({ respondida: true, citacoes: [{ trecho: "O frete marítimo fica para sexta-feira", inicioSegundos: 130 }] });

    respondeCom("O frete custa 10 mil.", "o frete custa dez mil reais por contêiner", "pagamos o frete à vista na entrega");
    await expect(perguntar()).resolves.toEqual({ respondida: false });
  });

  it("trecho com negação fica: \"decidimos não renovar\" é uma decisão, não um trecho suspeito", async () => {
    comFalas();
    respondeCom("Decidiram não renovar com a transportadora.", "Decidimos não renovar o contrato com a transportadora antiga");
    await expect(perguntar()).resolves.toMatchObject({
      respondida: true,
      citacoes: [{ trecho: "Decidimos não renovar o contrato com a transportadora antiga", inicioSegundos: 138 }],
    });
  });

  it("no máximo 3 citações, sem repetir a mesma fala", async () => {
    comFalas();
    respondeCom(
      "Falaram de café, contêiner, frete e contrato.",
      "Hoje vamos falar da exportação de café",
      "hoje vamos falar da exportação de café!",
      "O contêiner sai do porto de Santos",
      "O frete marítimo fica para sexta-feira",
      "Decidimos não renovar o contrato",
    );
    const resposta = await perguntar();
    expect(resposta.respondida && resposta.citacoes).toEqual([
      { trecho: "Hoje vamos falar da exportação de café", inicioSegundos: 4 },
      { trecho: "O contêiner sai do porto de Santos", inicioSegundos: 75 },
      { trecho: "O frete marítimo fica para sexta-feira", inicioSegundos: 130 },
    ]);
  });

  it("sem as falas (envio único), a citação vem sem o segundo", async () => {
    respondeCom("A Carla fecha o contrato até sexta.", "a Carla fecha o contrato com o importador até sexta-feira");
    await expect(perguntar()).resolves.toMatchObject({ citacoes: [{ trecho: "a Carla fecha o contrato com o importador até sexta-feira", inicioSegundos: null }] });
  });

  it("o campo antigo (trecho) vem junto, igual ao da primeira citação, para a aba aberta antes do deploy", async () => {
    comFalas();
    respondeCom("O frete fica para sexta.", "O frete marítimo fica para sexta-feira", "O contêiner sai do porto de Santos");
    const resposta = await perguntar();
    expect(resposta).toMatchObject({ respondida: true, trecho: "O frete marítimo fica para sexta-feira" });
  });

  it("a voz citada na resposta fica como rótulo (quem troca pelo nome é a tela); voz que a reunião não tem derruba a resposta", async () => {
    comFalas();
    respondeCom("{F2} disse que o contêiner sai dia 12.", "O contêiner sai do porto de Santos no dia 12 de março");
    await expect(perguntar()).resolves.toMatchObject({ respondida: true, resposta: "{F2} disse que o contêiner sai dia 12." });

    respondeCom("{F7} disse que o contêiner sai dia 12.", "O contêiner sai do porto de Santos no dia 12 de março");
    await expect(perguntar()).resolves.toEqual({ respondida: false });
  });

  it("sem as falas, rótulo de voz na resposta também derruba: a transcrição não separa quem fala", async () => {
    respondeCom("{F1} disse que o contêiner sai dia 12.", "O contêiner sai do porto de Santos no dia 12 de março");
    await expect(perguntar()).resolves.toEqual({ respondida: false });
  });

  it("a voz que só tem fala vazia não vai ao prompt, e a resposta que a cita vale como não respondida; a voz que foi segue valendo", async () => {
    const falas: Segmento[] = [
      { inicio: 0, fim: 9, falante: "F1", texto: "O contêiner sai do porto de Santos no dia 12 de março." },
      { inicio: 9, fim: 12, falante: "F2", texto: "   " },
    ];
    Object.assign(banco, { transcricao: falas[0].texto, segmentos: falas });
    respondeCom("{F2} disse que o contêiner sai dia 12.", "O contêiner sai do porto de Santos no dia 12 de março");
    await expect(perguntar()).resolves.toEqual({ respondida: false });
    expect(mensagens()[1].content).not.toContain("{F2}");

    respondeCom("{F1} disse que o contêiner sai dia 12.", "O contêiner sai do porto de Santos no dia 12 de março");
    await expect(perguntar()).resolves.toMatchObject({ respondida: true, resposta: "{F1} disse que o contêiner sai dia 12." });
  });

  it("só falas de texto vazio: a entrada vai sem rótulos, a IA é avisada disso, e o rótulo na resposta derruba", async () => {
    const falas: Segmento[] = [{ inicio: 0, fim: 9, falante: "F1", texto: "" }];
    Object.assign(banco, { transcricao: TRANSCRICAO, segmentos: falas });
    respondeCom("{F1} disse que o contêiner sai dia 12.", "O contêiner sai do porto de Santos no dia 12 de março");
    await expect(perguntar()).resolves.toEqual({ respondida: false });
    expect(mensagens()[0].content).toContain("não use rótulos de voz");
  });
});

describe("a resposta que não vai à tela fica no log com o motivo, sem a fala de ninguém (H6)", () => {
  const perguntar = () => rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "O que o Bruno disse do contêiner?" });
  const linhas = (espiao: typeof logInfo) => espiao.mock.calls.map(chamada => chamada.join(" "));

  it("cada motivo tem o código dele: a IA disse não, resposta vazia, nenhuma citação conferida, voz que a reunião não tem; a resposta que vai à tela não vai ao log", async () => {
    comFalas();
    const SANTOS = "O contêiner sai do porto de Santos no dia 12 de março";
    invokeLLM
      .mockResolvedValueOnce(respostaDaIA(NAO_RESPONDE))
      .mockResolvedValueOnce(respostaDaIA({ respondida: true, resposta: "  ", citacoes: [{ trecho: SANTOS }] }))
      .mockResolvedValueOnce(respostaDaIA({ respondida: true, resposta: "O frete custa 10 mil.", citacoes: [{ trecho: "o frete custa dez mil reais por contêiner" }, { trecho: "pagamos o frete à vista na entrega" }] }))
      .mockResolvedValueOnce(respostaDaIA({ respondida: true, resposta: "{F7} disse que o contêiner sai dia 12.", citacoes: [{ trecho: SANTOS }] }))
      .mockResolvedValueOnce(respostaDaIA({ respondida: true, resposta: "{F2} disse que o contêiner sai dia 12.", citacoes: [{ trecho: SANTOS }] }));
    for (let i = 0; i < 4; i++) await expect(perguntar()).resolves.toEqual({ respondida: false });
    await expect(perguntar()).resolves.toMatchObject({ respondida: true });

    expect(linhas(logInfo)).toEqual(["[Pergunte] não respondida (ia_disse_que_nao)"]);
    expect(linhas(logAviso)).toEqual([
      "[Pergunte] não respondida (resposta_vazia)",
      "[Pergunte] não respondida (sem_citacao_conferida): nenhuma de 2 citações está na transcrição",
      "[Pergunte] não respondida (voz_inexistente): F7 fora das 3 vozes da entrada",
    ]);
    // Nem a pergunta, nem a resposta, nem os trechos: são a fala das pessoas.
    for (const linha of [...linhas(logInfo), ...linhas(logAviso)]) {
      for (const dito of ["Bruno", "contêiner", "frete", "Santos"]) expect(linha).not.toContain(dito);
    }
  });
});

describe(`o teto da dona pesa a reunião longa (H6): a pergunta acima de ${ENTRADA_LONGA_DA_PERGUNTA} caracteres gasta 2 das ${PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA} vagas`, () => {
  // O serviço e o router de verdade: o tamanho medido na entrada da IA decide a segunda vaga.
  const perguntar = () => rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "O que ficou combinado?" });
  const longa = () => { banco.transcricao = "f".repeat(ENTRADA_LONGA_DA_PERGUNTA + 1); };
  const curta = () => { banco.transcricao = TRANSCRICAO; };
  beforeEach(() => { invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE)); });

  it(`${PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA / 2} perguntas longas enchem o teto; depois, nem a longa nem a curta passam, e a IA não é chamada`, async () => {
    longa();
    const longas = PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA / 2;
    for (let i = 0; i < longas; i++) await expect(perguntar()).resolves.toEqual({ respondida: false });
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    curta();
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(invokeLLM).toHaveBeenCalledTimes(longas);
  });

  it("recusada a segunda vaga, a primeira volta, sem chamar a IA; a pergunta curta segue gastando uma só", async () => {
    longa();
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA / 2 - 1; i++) await perguntar();
    // A curta toma uma vaga só: sobra uma.
    curta();
    await expect(perguntar()).resolves.toEqual({ respondida: false });
    // A longa toma a vaga que sobra, esbarra na segunda e a devolve.
    longa();
    const chamadas = invokeLLM.mock.calls.length;
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(invokeLLM).toHaveBeenCalledTimes(chamadas);
    // A vaga devolvida serve à curta; depois dela, o teto está cheio.
    curta();
    await expect(perguntar()).resolves.toEqual({ respondida: false });
    await expect(perguntar()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
