import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A leitura do documento (H12 e H12b) sem banco e sem IA: a chamada ao Gemini é
 * dublê, com as classes de erro reais, e o banco de processarDocumento é um
 * objeto que guarda o que se gravou. O caminho no banco de verdade está em
 * documento-da-reuniao.integracao.test.ts, e os prazos da leitura, com o
 * geminiPost real e o relógio falso, em documento-da-reuniao-prazo.test.ts.
 */
const gerarComArquivoNoGemini = vi.hoisted(() => vi.fn());
vi.mock("./gemini", async original => ({
  ...(await original<typeof import("./gemini")>()),
  gerarComArquivoNoGemini: (...a: unknown[]) => gerarComArquivoNoGemini(...a),
}));
const extrairDadosDaReuniao = vi.hoisted(() => vi.fn());
const gravarResultadoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./meeting-service", async original => ({
  ...(await original<typeof import("./meeting-service")>()),
  extrairDadosDaReuniao: (...a: unknown[]) => extrairDadosDaReuniao(...a),
  gravarResultadoDaReuniao: (...a: unknown[]) => gravarResultadoDaReuniao(...a),
}));

const {
  codigoDaFalha, FalhaDoDocumento, lerDocumentoComAIA, nomesDaCadeia, paginasDaResposta, PIOR_CASO_DA_LEITURA_MS, processarDocumento,
} = await import("./documento-da-reuniao");
const {
  ArquivoForaDoTetoDoGeminiError, GeminiCotaEsgotadaError, GeminiIndisponivelError, GeminiRecusouChamadaError, GeminiRespostaCortadaError,
  GeminiSemTextoError,
} = await import("./gemini");
const { ReuniaoTomadaPorOutraExecucao } = await import("./meeting-service");
const { MENSAGEM_ERRO_DE_CONSULTA } = await import("./banco-indisponivel");
const { LIMITE_PROCESSAMENTO_MS } = await import("@shared/const");
const { falhaDoDocumentoSeRepete } = await import("@shared/documento-da-reuniao");

const PDF = Buffer.from("%PDF-1.4\n% teste\n%%EOF\n");
const leituraDa = (corpo: unknown) => ({ texto: typeof corpo === "string" ? corpo : JSON.stringify(corpo), modelo: "gemini-teste-1" });

beforeEach(() => {
  vi.restoreAllMocks();
  gerarComArquivoNoGemini.mockReset();
  extrairDadosDaReuniao.mockReset();
  extrairDadosDaReuniao.mockResolvedValue({ entities: [], contacts: [] });
  gravarResultadoDaReuniao.mockReset();
  gravarResultadoDaReuniao.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** O código da falha de uma leitura que lança. */
async function codigoDaLeitura(): Promise<string> {
  const erro = await lerDocumentoComAIA(PDF, "pt-BR").then(() => null, falha => falha);
  if (!(erro instanceof FalhaDoDocumento)) throw new Error(`era para falhar com FalhaDoDocumento, e veio ${String(erro)}`);
  return erro.codigo;
}

/** Tudo o que foi ao console, numa linha só, para conferir o que NÃO pode sair no log. */
const tudoQueFoiAoLog = () => [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().map(String).join("\n");

describe("lerDocumentoComAIA: cada erro da IA vira o código que a tela traduz", () => {
  // A ordem dos `if` decide: GeminiRecusouChamadaError e GeminiCotaEsgotadaError
  // são subclasses de GeminiIndisponivelError, e o 504 chega como recusa.
  it.each([
    { caso: "a resposta cortada em MAX_TOKENS", erro: () => new GeminiRespostaCortadaError("MAX_TOKENS"), codigo: "DOCUMENTO_LONGO_DEMAIS" },
    { caso: "a resposta parada por segurança", erro: () => new GeminiRespostaCortadaError("SAFETY"), codigo: "DOCUMENTO_RECUSADO" },
    { caso: "a resposta parada por recitação", erro: () => new GeminiRespostaCortadaError("RECITATION"), codigo: "DOCUMENTO_RECUSADO" },
    { caso: "STOP sem texto", erro: () => new GeminiSemTextoError(), codigo: "DOCUMENTO_SEM_TEXTO" },
    { caso: "a chave recusada (403)", erro: () => new GeminiRecusouChamadaError(403, "API key not valid. Please pass a valid API key."), codigo: "DOCUMENTO_RECUSADO" },
    { caso: "o pedido recusado (400)", erro: () => new GeminiRecusouChamadaError(400, "Request contains an invalid argument."), codigo: "DOCUMENTO_RECUSADO" },
    {
      caso: "o prazo esgotado do lado do Gemini (504)",
      erro: () => new GeminiRecusouChamadaError(504, '{"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}'),
      codigo: "IA_INDISPONIVEL",
    },
    { caso: "a cota esgotada no principal e na reserva", erro: () => new GeminiCotaEsgotadaError(), codigo: "IA_INDISPONIVEL" },
    { caso: "o Gemini lotado (ou sem resposta no prazo da chamada)", erro: () => new GeminiIndisponivelError(503), codigo: "IA_INDISPONIVEL" },
    { caso: "o arquivo fora do teto da chamada", erro: () => new ArquivoForaDoTetoDoGeminiError(20_000_000, 15_000_000), codigo: "DOCUMENTO_RECUSADO" },
    { caso: "um erro que ninguém previu", erro: () => new Error("socket hang up"), codigo: "DOCUMENTO_FALHOU" },
  ])("$caso: $codigo", async ({ erro, codigo }) => {
    gerarComArquivoNoGemini.mockRejectedValue(erro());
    expect(await codigoDaLeitura()).toBe(codigo);
  });

  it("a causa fica presa à falha, para o log", async () => {
    const recusa = new GeminiRecusouChamadaError(403, "API key not valid.");
    gerarComArquivoNoGemini.mockRejectedValue(recusa);
    const erro = await lerDocumentoComAIA(PDF, "pt-BR").catch(falha => falha);
    expect(erro.cause).toBe(recusa);
  });

  it("pede a leitura do PDF inteiro, com o teto do documento e prazos que cabem antes da varredura de interrompidas", async () => {
    gerarComArquivoNoGemini.mockResolvedValue(leituraDa({ paginas: [{ pagina: 1, texto: "Proposta." }] }));
    expect(await lerDocumentoComAIA(PDF, "pt-BR")).toEqual([{ pagina: 1, texto: "Proposta." }]);
    expect(gerarComArquivoNoGemini.mock.calls[0][0]).toMatchObject({
      bytes: PDF, mimeType: "application/pdf", tetoInlineBytes: 15_000_000, saidaMaxima: 65_536,
      timeoutMs: 10 * 60_000, orcamentoMs: 2 * 60_000, reservaSoAteMs: 2 * 60_000,
    });
    // O pior caso da leitura (falha aos 2 min, as esperas e a chamada seguinte
    // estourando o prazo) deixa folga para o PDF que o reprocesso lê do bucket.
    expect(PIOR_CASO_DA_LEITURA_MS).toBeLessThanOrEqual(LIMITE_PROCESSAMENTO_MS - 2 * 60_000);
  });

  it("JSON inválido e resposta sem a lista de páginas: DOCUMENTO_FALHOU", async () => {
    gerarComArquivoNoGemini.mockResolvedValueOnce(leituraDa('{"paginas": [{"pagina": 1, "texto": "corta'));
    expect(await codigoDaLeitura()).toBe("DOCUMENTO_FALHOU");
    gerarComArquivoNoGemini.mockResolvedValueOnce(leituraDa({ outra: [] }));
    expect(await codigoDaLeitura()).toBe("DOCUMENTO_FALHOU");
    gerarComArquivoNoGemini.mockResolvedValueOnce(leituraDa("null"));
    expect(await codigoDaLeitura()).toBe("DOCUMENTO_FALHOU");
  });

  it("nenhuma página no formato é DOCUMENTO_FALHOU, e não 'sem texto': o documento podia ter texto, a resposta é que veio errada", async () => {
    gerarComArquivoNoGemini.mockResolvedValue(leituraDa({ paginas: [{ pagina: "um", texto: "Contrato" }, { numero: 2, texto: "Cláusula" }] }));
    expect(await codigoDaLeitura()).toBe("DOCUMENTO_FALHOU");
  });

  it("a lista vazia e as páginas só com espaços: DOCUMENTO_SEM_TEXTO", async () => {
    gerarComArquivoNoGemini.mockResolvedValueOnce(leituraDa({ paginas: [] }));
    expect(await codigoDaLeitura()).toBe("DOCUMENTO_SEM_TEXTO");
    gerarComArquivoNoGemini.mockResolvedValueOnce(leituraDa({ paginas: [{ pagina: 1, texto: "  " }, { pagina: 2, texto: "\n" }] }));
    expect(await codigoDaLeitura()).toBe("DOCUMENTO_SEM_TEXTO");
  });
});

describe("paginasDaResposta: o que o modelo erra sem perder texto é consertado, e nada sai em silêncio", () => {
  const paginas = (lista: unknown[]) => paginasDaResposta(JSON.stringify({ paginas: lista }));

  it("a numeração que começa em 0 sobe 1 em todas: a capa não some", () => {
    expect(paginas([
      { pagina: 0, texto: "CONTRATO entre Ana Souza e Exportadora X" },
      { pagina: 1, texto: "Cláusula 1: preço" },
    ])).toEqual([
      { pagina: 1, texto: "CONTRATO entre Ana Souza e Exportadora X" },
      { pagina: 2, texto: "Cláusula 1: preço" },
    ]);
    expect(console.warn).toHaveBeenCalledWith("[Documento] a leitura numerou as páginas a partir de 0; todas subiram 1");
  });

  it("a mesma página em duas entradas junta os textos, na ordem: a segunda metade não some", () => {
    expect(paginas([
      { pagina: 1, texto: "Proposta de exportação de café." },
      { pagina: 2, texto: "Prazo: março." },
      { pagina: 1, texto: "Contato: (11) 4000-0000" },
    ])).toEqual([
      { pagina: 1, texto: "Proposta de exportação de café.\n\nContato: (11) 4000-0000" },
      { pagina: 2, texto: "Prazo: março." },
    ]);
    expect(console.warn).toHaveBeenCalledWith("[Documento] 1 páginas da leitura repetiram o número de outra; os textos foram juntados, na ordem");
  });

  it("páginas fora de ordem saem na ordem, e o número escrito como texto vale", () => {
    expect(paginas([
      { pagina: 3, texto: "c" },
      { pagina: "1", texto: " a " },
      { pagina: 2, texto: "b" },
    ])).toEqual([{ pagina: 1, texto: "a" }, { pagina: 2, texto: "b" }, { pagina: 3, texto: "c" }]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("a página sem texto fica, vazia, para a numeração bater com a do PDF", () => {
    expect(paginas([{ pagina: 1, texto: "a" }, { pagina: 2, texto: "" }, { pagina: 3, texto: "c" }]))
      .toEqual([{ pagina: 1, texto: "a" }, { pagina: 2, texto: "" }, { pagina: 3, texto: "c" }]);
  });

  it("o item fora do formato fica de fora com um aviso que conta quantos, sem o texto de nenhum", () => {
    expect(paginas([
      { pagina: 1, texto: "Proposta." },
      { pagina: "dois", texto: "Ana Souza" },
      { pagina: 2 },
      null,
      "Página solta",
      { pagina: 1.5, texto: "meia página" },
      { pagina: -1, texto: "negativa" },
    ])).toEqual([{ pagina: 1, texto: "Proposta." }]);
    expect(console.warn).toHaveBeenCalledWith("[Documento] 6 de 7 páginas da leitura vieram fora do formato (sem número de página ou sem texto) e ficaram de fora");
    expect(tudoQueFoiAoLog()).not.toMatch(/Ana Souza|Página solta|meia página|negativa/);
  });

  it("todas fora do formato: falha (DOCUMENTO_FALHOU); lista vazia: nenhuma página", () => {
    const erro = (() => { try { return paginas([{ pagina: "x", texto: "a" }]); } catch (falha) { return falha; } })();
    expect(erro).toBeInstanceOf(FalhaDoDocumento);
    expect((erro as InstanceType<typeof FalhaDoDocumento>).codigo).toBe("DOCUMENTO_FALHOU");
    expect(paginas([])).toEqual([]);
  });
});

describe("codigoDaFalha: o que vai para processing_error", () => {
  it("a falha do documento grava o código dela; o erro comum, DOCUMENTO_FALHOU", () => {
    expect(codigoDaFalha(new FalhaDoDocumento("DOCUMENTO_SEM_TEXTO", "x"))).toBe("DOCUMENTO_SEM_TEXTO");
    expect(codigoDaFalha(new Error("qualquer coisa"))).toBe("DOCUMENTO_FALHOU");
  });

  it("o erro do driver do banco vira a frase do erro de consulta, que a tela traduz, e o detalhe vai ao log sem os parâmetros", () => {
    const doDriver = Object.assign(new Error("Duplicate entry 'Ana Souza' for key 'PRIMARY'"), { code: "ER_DUP_ENTRY", sqlState: "23000" });
    expect(codigoDaFalha(doDriver)).toBe(MENSAGEM_ERRO_DE_CONSULTA);
    expect(console.error).toHaveBeenCalledWith("[Documento] falha de banco na leitura:", expect.stringContaining("ER_DUP_ENTRY"));
  });
});

describe("nomesDaCadeia: o log da falha leva os nomes, nunca as mensagens", () => {
  it("cada elo com o código, o status e o motivo, e nada do texto", () => {
    const cadeia = new FalhaDoDocumento("DOCUMENTO_RECUSADO", "A IA não leu o documento.", { cause: new GeminiRecusouChamadaError(403, "API key not valid.") });
    expect(nomesDaCadeia(cadeia)).toBe("FalhaDoDocumento(DOCUMENTO_RECUSADO) <- GeminiRecusouChamadaError(403)");
    expect(nomesDaCadeia(new GeminiRespostaCortadaError("MAX_TOKENS"))).toBe("GeminiRespostaCortadaError(MAX_TOKENS)");
    let sintaxe: unknown;
    try { JSON.parse("Ana Souza, telefone (11) 4000-0000"); } catch (erro) { sintaxe = erro; }
    expect(nomesDaCadeia(new FalhaDoDocumento("DOCUMENTO_FALHOU", "x", { cause: sintaxe }))).toBe("FalhaDoDocumento(DOCUMENTO_FALHOU) <- SyntaxError");
  });
});

/** O banco de processarDocumento: guarda cada UPDATE, e a renovação da ficha alcança `linhasDaRenovacao`. */
function bancoFalso(opcoes: { linhasDaRenovacao?: number; statusRelido?: string } = {}) {
  const gravacoes: Array<Record<string, unknown>> = [];
  const banco = {
    update: () => ({
      set: (valores: Record<string, unknown>) => ({
        where: async () => {
          gravacoes.push(valores);
          const renovacao = !("status" in valores);
          return [{ affectedRows: renovacao ? opcoes.linhasDaRenovacao ?? 1 : 1 }];
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: opcoes.statusRelido ?? "failed" }] }) }) }),
  };
  return { banco: banco as never, gravacoes };
}

const execucao = (ficha: number) => ({ ownerId: "dona-1", meetingId: "0b6f2c1e-1111-4222-8333-944445555666", ficha, bytes: PDF, idioma: "pt-BR", limparAntes: false });

describe("processarDocumento", () => {
  it("lido o documento, a ficha se renova, e a extração e a gravação seguem com a ficha nova", async () => {
    gerarComArquivoNoGemini.mockResolvedValue(leituraDa({ paginas: [{ pagina: 1, texto: "Proposta." }] }));
    const { banco, gravacoes } = bancoFalso();
    const fichaVelha = Date.now() - 14 * 60_000;
    await processarDocumento(banco, execucao(fichaVelha));
    expect(gravacoes).toHaveLength(1);
    const fichaNova = gravacoes[0].updatedAt as number;
    expect(fichaNova).toBeGreaterThan(fichaVelha);
    expect(gravarResultadoDaReuniao).toHaveBeenCalledWith(banco, expect.objectContaining({ ficha: fichaNova }));
  });

  it("a leitura com JSON inválido deixa a reunião 'failed' com DOCUMENTO_FALHOU, e o log diz o código e a cadeia, sem o texto lido", async () => {
    gerarComArquivoNoGemini.mockResolvedValue(leituraDa("Ana Souza, telefone (11) 4000-0000, não é JSON"));
    const { banco, gravacoes } = bancoFalso();
    await processarDocumento(banco, execucao(Date.now()));
    expect(gravacoes).toEqual([expect.objectContaining({ status: "failed", processingError: "DOCUMENTO_FALHOU" })]);
    expect(console.error).toHaveBeenCalledWith("[Documento] a leitura falhou (DOCUMENTO_FALHOU):", "FalhaDoDocumento(DOCUMENTO_FALHOU) <- SyntaxError");
    expect(tudoQueFoiAoLog()).not.toMatch(/Ana Souza|4000-0000/);
    expect(extrairDadosDaReuniao).not.toHaveBeenCalled();
  });

  it("a recusa da IA vai ao log com o status, sem o detalhe do Google", async () => {
    gerarComArquivoNoGemini.mockRejectedValue(new GeminiRecusouChamadaError(403, "API key not valid. Please pass a valid API key."));
    const { banco, gravacoes } = bancoFalso();
    await processarDocumento(banco, execucao(Date.now()));
    expect(gravacoes).toEqual([expect.objectContaining({ status: "failed", processingError: "DOCUMENTO_RECUSADO" })]);
    expect(console.error).toHaveBeenCalledWith("[Documento] a leitura falhou (DOCUMENTO_RECUSADO):", "FalhaDoDocumento(DOCUMENTO_RECUSADO) <- GeminiRecusouChamadaError(403)");
    expect(tudoQueFoiAoLog()).not.toContain("API key");
  });

  it("outra execução tomou a reunião durante a extração: sai sem escrever, e o log diz que o resultado foi descartado", async () => {
    gerarComArquivoNoGemini.mockResolvedValue(leituraDa({ paginas: [{ pagina: 1, texto: "Proposta." }] }));
    gravarResultadoDaReuniao.mockRejectedValue(new ReuniaoTomadaPorOutraExecucao());
    const { banco, gravacoes } = bancoFalso();
    await processarDocumento(banco, execucao(Date.now()));
    expect(gravacoes.filter(valores => "status" in valores)).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[Documento] outra execução tomou a reunião"));
  });

  it("a ficha que já não é desta execução na renovação: sai sem extrair nem escrever", async () => {
    gerarComArquivoNoGemini.mockResolvedValue(leituraDa({ paginas: [{ pagina: 1, texto: "Proposta." }] }));
    const { banco, gravacoes } = bancoFalso({ linhasDaRenovacao: 0, statusRelido: "failed" });
    await processarDocumento(banco, execucao(Date.now()));
    expect(extrairDadosDaReuniao).not.toHaveBeenCalled();
    expect(gravarResultadoDaReuniao).not.toHaveBeenCalled();
    expect(gravacoes.filter(valores => "status" in valores)).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[Documento] outra execução tomou a reunião"));
  });
});

describe("falhaDoDocumentoSeRepete", () => {
  it("só o texto que não cabe numa resposta: o resto pode dar certo numa leitura nova", () => {
    expect(falhaDoDocumentoSeRepete("DOCUMENTO_LONGO_DEMAIS")).toBe(true);
    for (const codigo of ["DOCUMENTO_SEM_TEXTO", "DOCUMENTO_RECUSADO", "IA_INDISPONIVEL", "DOCUMENTO_AUSENTE", "DOCUMENTO_FALHOU", "ERRO_INTERROMPIDO", null, undefined]) {
      expect(falhaDoDocumentoSeRepete(codigo)).toBe(false);
    }
  });
});
