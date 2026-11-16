import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * meetings.perguntar, pelo router, com a IA dublada. O resumo a pedido saiu na
 * H4c: o resumo é o guardado (resumo-da-reuniao.test.ts e
 * fila-do-resumo.integracao.test.ts). Prova:
 *
 * - a resposta cujo trecho não está na transcrição vale como não respondida
 *   (caixa, espaços e pontuação não contam);
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

const invokeLLM = vi.fn();
const escritas = vi.fn();

const banco = {
  dona: "dona-1",
  existe: true,
  status: "ready",
  transcricao: TRANSCRICAO as string | null,
  indisponivel: false,
  erroNaConsulta: null as Error | null,
  leituras: [] as Array<{ tabela: unknown; sql: string; params: unknown[] }>,
};

const schema = await import("../drizzle/schema");
const { BancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } = await import("./banco-indisponivel");
const dialeto = new MySqlDialect();

vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => {
    if (banco.indisponivel) throw new BancoIndisponivel();
    return {
      select: () => ({ from: (tabela: unknown) => ({ where: (condicao: SQL) => {
        const { sql, params } = dialeto.sqlToQuery(condicao);
        banco.leituras.push({ tabela, sql, params });
        return { limit: async () => {
          if (banco.erroNaConsulta) throw banco.erroNaConsulta;
          // Como o MySQL: a linha só volta se o WHERE pede a dona dela.
          if (!params.includes(banco.dona)) return [];
          if (tabela === schema.meetings) return banco.existe ? [{ status: banco.status }] : [];
          if (tabela === schema.meetingTranscripts) return banco.transcricao === null ? [] : [{ transcript: banco.transcricao }];
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

const { meetingsRouter } = await import("./routers/meetings");
const { LIMITE_DA_TRANSCRICAO_PARA_IA, MENSAGEM_IA_INDISPONIVEL, MENSAGEM_SEM_TRANSCRICAO, trechoApareceNaTranscricao } = await import("./reuniao-com-ia");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const contexto = (openId: string) => ({
  user: { id: 7, openId, email: `${openId}@local`, role: "silver", onboardingCompleted: true },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const rota = (openId = "dona-1") => meetingsRouter.createCaller(contexto(openId));
const respostaDaIA = (dados: unknown) => ({ choices: [{ message: { content: JSON.stringify(dados) } }] });
const mensagens = () => (invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> }).messages;

beforeEach(() => {
  invokeLLM.mockReset();
  escritas.mockReset();
  Object.assign(banco, { dona: "dona-1", existe: true, status: "ready", transcricao: TRANSCRICAO, indisponivel: false, erroNaConsulta: null, leituras: [] });
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
  const naoRespondida = () => invokeLLM.mockResolvedValue(respostaDaIA({ respondida: false, resposta: "", trecho: "" }));

  it("pede JSON estruturado, com a transcrição cortada no teto da extração", async () => {
    banco.transcricao = `${TRANSCRICAO}\n${"blá ".repeat(10_000)}`;
    naoRespondida();
    await expect(perguntar()).resolves.toEqual({ respondida: false });
    const [, usuario] = mensagens();
    expect(usuario.content.length).toBeLessThanOrEqual(LIMITE_DA_TRANSCRICAO_PARA_IA + 100);
    expect(invokeLLM.mock.calls[0][0]).toMatchObject({ response_format: { type: "json_schema", json_schema: { name: "resposta_da_reuniao", strict: true } } });
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
  it("responde com o trecho citado, no idioma da tela, mandando a pergunta à IA", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ respondida: true, resposta: "The container leaves Santos on March 12.", trecho: "O contêiner sai do porto de Santos no dia 12 de março." }));

    const resposta = await rota().perguntar({ meetingId: ID, idioma: "en", pergunta: "  Quando sai o contêiner?  " });

    expect(resposta).toEqual({ respondida: true, resposta: "The container leaves Santos on March 12.", trecho: "O contêiner sai do porto de Santos no dia 12 de março." });
    const [sistema, usuario] = mensagens();
    expect(sistema.content).toContain("inglês");
    expect(usuario.content).toContain("Pergunta: Quando sai o contêiner?");
    expect(escritas).not.toHaveBeenCalled();
  });

  it("resposta com trecho que não está na transcrição vale como não respondida", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ respondida: true, resposta: "Custa 10 mil reais.", trecho: "o frete custa dez mil reais" }));
    await expect(rota().perguntar({ meetingId: ID, idioma: "pt-BR", pergunta: "Quanto custa o frete?" })).resolves.toEqual({ respondida: false });
  });

  it("a transcrição não responde: diz isso", async () => {
    invokeLLM.mockResolvedValue(respostaDaIA({ respondida: false, resposta: "", trecho: "" }));
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
