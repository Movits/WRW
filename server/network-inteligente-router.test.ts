import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Meu Network Inteligente — as rotas novas do router (spec da Glenda de 14/09,
 * prompt 7). Drizzle de verdade sobre um cliente mysql2 falso; consentimento,
 * Gemini, LLM e storage são dublês.
 *
 * O que se trava:
 * 1. O termo do Smart Match decide o cruzamento: sem ele, nem as conexões
 *    registradas nem a rede global.
 * 2. Contato de outra dona é NOT_FOUND antes de qualquer IA ou escrita.
 * 3. Completar por voz: gravar → transcrever → interpretar → pendência. O
 *    áudio não vai ao bucket; os segundos entram no contador (só depois de a
 *    interpretação dar certo); 2 minutos no máximo. A falha da IA sai em frase
 *    neutra, sem o erro cru do provedor.
 * 4. A lista e a apuração de comissões da plataforma exigem staff (admin ou
 *    presidente; Ouro não), a lista não leva a chave do par e a leitura é auditada.
 * 5. A linha do tempo junta tudo em ordem, do mais recente ao mais antigo.
 */

type Resposta = unknown[][] | { affectedRows: number };
const estado = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  responder: (_sql: string, _params: unknown[]): unknown => undefined,
}));

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      estado.consultas.push({ sql: config.sql, params });
      const resposta = estado.responder(config.sql, params) as Resposta | undefined;
      if (resposta && !Array.isArray(resposta)) return [resposta, []];
      if (/^\s*(insert|update|delete)/i.test(config.sql)) return [{ affectedRows: 1 }, []];
      return [resposta ?? [], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const hasValidConsent = vi.hoisted(() => vi.fn(async (_userId: number, _tipo: string) => true));
vi.mock("./routers/consent", () => ({ hasValidConsent, usersComConsentimento: async (ids: number[]) => new Set(ids) }));

const transcribeWithGemini = vi.hoisted(() => vi.fn());
vi.mock("./gemini", async importOriginal => ({
  ...await importOriginal<typeof import("./gemini")>(),
  transcribeWithGemini: (...args: unknown[]) => transcribeWithGemini(...args),
}));
const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM }));
const storagePut = vi.hoisted(() => vi.fn());
vi.mock("./storage", async importOriginal => ({ ...await importOriginal<typeof import("./storage")>(), storagePut }));
const createAuditLog = vi.hoisted(() => vi.fn(async (_registro: Record<string, unknown>) => {}));
vi.mock("./security", async importOriginal => ({ ...await importOriginal<typeof import("./security")>(), createAuditLog }));

const { networkInteligenteRouter, esquecerComplementos } = await import("./routers/networkInteligente");
const { montarLinhaDoTempo } = await import("./network-perfil-do-contato");

const contexto = (role = "silver") => ({
  user: { id: 9, openId: "dona-9", email: "dona@local", role },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;
const chamar = (role?: string) => networkInteligenteRouter.createCaller(contexto(role));

/** Contato 5 é da dona; qualquer outro id não existe para ela. */
function contatoDaDona() {
  estado.responder = (sql, params) => {
    if (/from `private_contacts`/.test(sql)) {
      // id, fullName, phone, whatsapp, email, tipoPessoa
      return params.includes(5) ? [[5, "Maria Silva", null, null, null, null]] : [];
    }
    return undefined;
  };
}

beforeEach(() => {
  estado.consultas = [];
  estado.responder = () => undefined;
  hasValidConsent.mockReset();
  hasValidConsent.mockResolvedValue(true);
  transcribeWithGemini.mockReset();
  invokeLLM.mockReset();
  storagePut.mockReset();
  createAuditLog.mockClear();
  esquecerComplementos();
});

describe("o termo do Smart Match decide o cruzamento", () => {
  it("sem o termo: conexões registradas não são lidas nem sincronizadas", async () => {
    hasValidConsent.mockResolvedValue(false);
    expect(await chamar().conexoes()).toEqual({ termoAceito: false });
    expect(estado.consultas).toEqual([]);
    expect(hasValidConsent).toHaveBeenCalledWith(9, "termo_smart_match");
  });

  it("sem o termo: procurar na rede global é recusado antes de ler qualquer contato", async () => {
    hasValidConsent.mockResolvedValue(false);
    await expect(chamar().procurarNaRedeGlobal()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(estado.consultas).toEqual([]);
  });

  it("com o termo: sincroniza as internas e devolve contagens e lista", async () => {
    const r = await chamar().conexoes();
    expect(r).toMatchObject({ termoAceito: true, contagem: { internas: 0, comRedeGlobal: 0 }, lista: [] });
    expect(estado.consultas.some(c => /from `ai_match_suggestions`/.test(c.sql))).toBe(true);
  });
});

describe("a rede é da dona", () => {
  it("perfil de contato de outra dona: NOT_FOUND com uma leitura só, com o owner no WHERE", async () => {
    contatoDaDona();
    await expect(chamar().contato({ contactId: 77 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(estado.consultas).toHaveLength(1);
    expect(estado.consultas[0].sql).toContain("`private_contacts`.`ownerId` = ?");
    expect(estado.consultas[0].params).toEqual(expect.arrayContaining([77, "dona-9"]));
  });

  it("disponibilizar contato de outra dona: NOT_FOUND", async () => {
    estado.responder = sql => (/^update `private_contacts`/.test(sql) ? { affectedRows: 0 } : undefined);
    await expect(chamar().definirDisponibilidade({ contactId: 77, disponivel: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("completar por texto um contato alheio: NOT_FOUND e nenhuma IA chamada", async () => {
    contatoDaDona();
    await expect(chamar().complementarPorTexto({ contactId: 77, texto: "Ela distribui medicamentos." })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(invokeLLM).not.toHaveBeenCalled();
  });
});

describe("completar por voz — gravar, transcrever, interpretar, sugerir", () => {
  const audio = `data:audio/webm;base64,${Buffer.from("fala curta").toString("base64")}`;

  it("mais de 2 minutos é recusado antes de qualquer leitura", async () => {
    await expect(chamar().complementarPorVoz({ contactId: 5, audioBase64: audio, mimeType: "audio/webm", durationSeconds: 121 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(transcribeWithGemini).not.toHaveBeenCalled();
    expect(estado.consultas).toEqual([]);
  });

  it("transcreve na memória, não guarda o áudio, conta os segundos e cria pendências de origem 'voz'", async () => {
    contatoDaDona();
    transcribeWithGemini.mockResolvedValue({ text: "A Maria tem uma distribuidora de medicamentos e procura fornecedores na Índia.", segments: [], language: "pt" });
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      quemSou: { tipoPessoa: "nao_informado", nome: null, telefone: "(11) 90000-0000", email: null },
      oQueTenho: [{ texto: "Distribuidora de medicamentos", categoria: null, trecho: "tem uma distribuidora de medicamentos", confianca: 0.9 }],
      oQuePreciso: [{ texto: "Fornecedores na Índia", categoria: null, trecho: "procura fornecedores na Índia", confianca: 0.9 }],
    }) } }] });

    const r = await chamar().complementarPorVoz({ contactId: 5, audioBase64: audio, mimeType: "audio/webm", durationSeconds: 42, idioma: "es-MX" });

    expect(r).toEqual({ transcricao: "A Maria tem uma distribuidora de medicamentos e procura fornecedores na Índia.", pendenciasCriadas: 2 });
    // O idioma da tela de quem grava vai à transcrição, que o normaliza (G1b).
    expect(transcribeWithGemini).toHaveBeenCalledWith(expect.objectContaining({ language: "es-MX" }));
    expect(storagePut).not.toHaveBeenCalled();
    const consumo = estado.consultas.find(c => /^insert into `consumo_de_minutos`/.test(c.sql))!;
    expect(consumo.params).toEqual(expect.arrayContaining(["dona-9", "voz", 42]));
    const pendencias = estado.consultas.find(c => /^insert into `network_sugestoes`/.test(c.sql))!;
    expect(pendencias.params).toEqual(expect.arrayContaining(["voz", "tenho", "Distribuidora de medicamentos", "preciso", "Fornecedores na Índia", "pendente"]));
    // o telefone inventado pelo modelo não chegou à pendência
    expect(pendencias.params).not.toContain("(11) 90000-0000");
    // nada foi gravado direto no contato
    expect(estado.consultas.some(c => /^(update `private_contacts`|insert into `contact_assets`|insert into `contact_needs`)/.test(c.sql))).toBe(false);
  });

  it("duração declarada menor que a fala (áudio longo a bitrate baixo, 1 s informado): recusa, sem IA, pendência nem consumo", async () => {
    contatoDaDona();
    // ~25 minutos de fala: cabe em 2 MB a 8 kbps, e o navegador disse 1 segundo.
    const falaLonga = Array.from({ length: 4000 }, () => "fornecedores").join(" ");
    transcribeWithGemini.mockResolvedValue({ text: falaLonga, segments: [], language: "pt" });
    const erro = await chamar().complementarPorVoz({ contactId: 5, audioBase64: audio, mimeType: "audio/webm", durationSeconds: 1 }).catch(e => e);
    expect(erro).toMatchObject({ code: "BAD_REQUEST" });
    expect(String(erro.message)).not.toContain("fornecedores");
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(estado.consultas.some(c => /^insert/.test(c.sql))).toBe(false);
  });

  it("transcrição indisponível no Gemini: erro dito, sem pendência nem consumo", async () => {
    contatoDaDona();
    const { GeminiIndisponivelError } = await import("./gemini");
    transcribeWithGemini.mockRejectedValue(new GeminiIndisponivelError());
    await expect(chamar().complementarPorVoz({ contactId: 5, audioBase64: audio, mimeType: "audio/webm", durationSeconds: 10 }))
      .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(estado.consultas.some(c => /^insert/.test(c.sql))).toBe(false);
  });

  it("teto brando: a 11ª interpretação em 10 minutos é recusada", async () => {
    contatoDaDona();
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ quemSou: { tipoPessoa: "nao_informado", nome: null, telefone: null, email: null }, oQueTenho: [], oQuePreciso: [] }) } }] });
    for (let i = 0; i < 10; i += 1) await chamar().complementarPorTexto({ contactId: 5, texto: "Nada de novo por aqui." });
    await expect(chamar().complementarPorTexto({ contactId: 5, texto: "Nada de novo por aqui." })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("a IA falhou na interpretação — frase neutra, nada do provedor", () => {
  const audio = `data:audio/webm;base64,${Buffer.from("fala curta").toString("base64")}`;
  const erroDoProvedor = new Error('LLM invoke failed: 429 Too Many Requests – {"error":{"code":429,"message":"Quota exceeded for project 1234"}}');
  const silenciar = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("por texto: SERVICE_UNAVAILABLE com a frase neutra, sem status nem corpo do provedor, e nenhuma pendência", async () => {
    contatoDaDona();
    const aviso = silenciar();
    invokeLLM.mockRejectedValue(erroDoProvedor);
    const { MENSAGEM_INTERPRETACAO_FALHOU } = await import("./routers/networkInteligente");

    const erro = await chamar().complementarPorTexto({ contactId: 5, texto: "Ela distribui medicamentos." }).catch(e => e);

    expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_INTERPRETACAO_FALHOU });
    expect(erro.message).not.toMatch(/429|Quota|LLM/);
    expect(estado.consultas.some(c => /^insert/.test(c.sql))).toBe(false);
    // o detalhe fica no log, truncado
    expect(String(aviso.mock.calls[0]?.[1])).toContain("429");
    aviso.mockRestore();
  });

  it("chave do LLM ausente: a instrução do .env não chega ao navegador", async () => {
    contatoDaDona();
    const aviso = silenciar();
    invokeLLM.mockRejectedValue(new Error("Nenhuma chave de LLM configurada. Defina LLM_API_KEY (ou GOOGLE_API_KEY) no .env"));
    const erro = await chamar().complementarPorTexto({ contactId: 5, texto: "Ela distribui medicamentos." }).catch(e => e);
    expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(erro.message).not.toMatch(/LLM_API_KEY|\.env/);
    aviso.mockRestore();
  });

  it("por voz: transcreveu mas a interpretação falhou — os segundos NÃO entram no contador", async () => {
    contatoDaDona();
    const aviso = silenciar();
    transcribeWithGemini.mockResolvedValue({ text: "A Maria tem uma distribuidora de medicamentos.", segments: [], language: "pt" });
    invokeLLM.mockRejectedValue(erroDoProvedor);

    const erro = await chamar().complementarPorVoz({ contactId: 5, audioBase64: audio, mimeType: "audio/webm", durationSeconds: 42 }).catch(e => e);

    expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(erro.message).not.toMatch(/429|Quota|LLM/);
    expect(transcribeWithGemini).toHaveBeenCalledTimes(1);
    expect(estado.consultas.some(c => /^insert into `consumo_de_minutos`/.test(c.sql))).toBe(false);
    expect(estado.consultas.some(c => /^insert into `network_sugestoes`/.test(c.sql))).toBe(false);
    aviso.mockRestore();
  });

  it("fetch ao provedor recusado (ECONNREFUSED na causa) é falha da IA, não 'banco indisponível'", async () => {
    contatoDaDona();
    const aviso = silenciar();
    invokeLLM.mockRejectedValue(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 142.250.0.1:443"), { code: "ECONNREFUSED" }) }));
    const { MENSAGEM_INTERPRETACAO_FALHOU } = await import("./routers/networkInteligente");
    const erro = await chamar().complementarPorTexto({ contactId: 5, texto: "Ela distribui medicamentos." }).catch(e => e);
    expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_INTERPRETACAO_FALHOU });
    aviso.mockRestore();
  });
});

describe("a rastreabilidade da plataforma exige administradora", () => {
  it("prata não lista as conexões da plataforma nem apura comissão", async () => {
    await expect(chamar("silver").admin.conexoes()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(chamar("silver").admin.definirComissao({ conexaoId: "0b3f0e4e-0000-4000-8000-000000000001", status: "devida" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Ouro sem cargo também não: a lista atravessa a rede de todas as donas e é só da staff", async () => {
    await expect(chamar("gold").admin.conexoes()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(chamar("gold").admin.definirComissao({ conexaoId: "0b3f0e4e-0000-4000-8000-000000000001", status: "devida" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(estado.consultas).toEqual([]);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  /** A lista da staff com um lado de cada dona, para a auditoria ter de quem era o que saiu. */
  const conexaoDeDuasDonas = () => {
    estado.responder = sql => {
      if (/from `conexoes_registradas`/.test(sql)) {
        // id, origem, motivo, itens, pontuacao, status, apresentacao_em, negociacao_em, fechamento_em, descartada_em, status_comissao, created_at
        return [["c-1", "PRIVATE_NETWORK_MATCH", "NW-AAAAAA tem Vinho, que NW-BBBBBB procura.", "[]", 100, "identificada", null, null, null, null, "sem_negocio", 1000]];
      }
      if (/from `conexoes_participantes`/.test(sql)) {
        // id, conexao_id, lado, tipo, owner_id, userId, contact_id, codigo_anonimo, originador, status_comissao_originador, created_at, updated_at, descartada_em, fechamento_confirmado_em
        return [
          [1, "c-1", "a", "contato", "dona-1", null, 11, "NW-AAAAAA", true, "sem_negocio", 1000, 1000, null, null],
          [2, "c-1", "b", "contato", "dona-2", null, 99, "NW-BBBBBB", true, "sem_negocio", 1000, 1000, null, null],
        ];
      }
      if (/from `users`/.test(sql)) return [[31, "dona-1", "Ana"], [32, "dona-2", "Bia"]];
      return undefined;
    };
  };

  it("presidente lista, sem a chave do par (ids crus), e a leitura fica na auditoria", async () => {
    conexaoDeDuasDonas();
    const lista = await chamar("president").admin.conexoes({ origem: "PRIVATE_NETWORK_MATCH" });
    expect(lista).toHaveLength(1);
    expect(lista[0]).not.toHaveProperty("chaveDoPar");
    expect(lista[0]).not.toHaveProperty("updatedAt");
    const leitura = estado.consultas.find(c => /from `conexoes_registradas`/.test(c.sql))!;
    expect(leitura.sql).not.toContain("chave_do_par");
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: 9, action: "NETWORK_CONNECTIONS_READ", resource: "conexoes_registradas",
      details: { origem: "PRIVATE_NETWORK_MATCH", status: null, conexoes: 1, donas: [31, 32], ladosSemConta: 0 },
    }));
  });

  /**
   * Item 12 da revisão da #135: a leitura da staff é decisão de produto, mas a
   * trilha precisa responder "quem viu as conexões do MEU network?". Com a
   * contagem sozinha, a dona 31 não consegue saber que a conexão dela saiu
   * nesta leitura — a resposta depende de a trilha dizer de quem era.
   */
  it("o telefone escrito dentro do rótulo do contato não chega à lista da staff", async () => {
    // O rótulo é texto livre da dona e fica gravado inteiro (ela é quem lê o
    // cartão do outro lado). Quem atravessa as redes de todas as donas é esta
    // leitura, e é aqui que a máscara entra — sem estragar o dado no banco.
    estado.responder = sql => {
      if (/from `conexoes_registradas`/.test(sql)) {
        return [[
          "c-1", "PRIVATE_NETWORK_MATCH",
          "NW-AAAAAA tem Vinho Malbec — chamar no (11) 98888-7777, que NW-BBBBBB procura.",
          JSON.stringify([{ tem: "Vinho Malbec — chamar no (11) 98888-7777", precisa: "Vinho — ana.souza@vinhos.com.br", deCodigo: "NW-AAAAAA", paraCodigo: "NW-BBBBBB" }]),
          100, "identificada", null, null, null, null, "sem_negocio", 1000,
        ]];
      }
      return undefined;
    };

    const lista = await chamar("president").admin.conexoes();

    const texto = JSON.stringify(lista);
    expect(texto).not.toContain("98888-7777");
    expect(texto).not.toContain("ana.souza@vinhos.com.br");
    // O que a conexão diz continua legível para a staff.
    expect(texto).toContain("Vinho Malbec");
    expect(texto).toContain("NW-AAAAAA");
  });

  it("a trilha diz de QUEM eram as conexões lidas, sem nada de contato", async () => {
    conexaoDeDuasDonas();
    await chamar("admin").admin.conexoes();

    const registro = createAuditLog.mock.calls.at(-1)![0] as { details: { donas: number[]; conexoes: number; ladosSemConta: number } };
    expect(registro.details.donas).toEqual([31, 32]);
    expect(registro.details.conexoes).toBe(1);
    expect(registro.details.ladosSemConta).toBe(0);
    const trilha = JSON.stringify(registro.details);
    expect(trilha).not.toContain("NW-AAAAAA");
    expect(trilha).not.toContain("dona-1");
    expect(trilha).not.toContain("Ana");
  });

  it("lado cuja conta não resolve é contado, não sumido em silêncio", () => {
    // Linha legada ou conta apagada: `lado.conta` vem null. Sem contar, a
    // leitura pareceria ter coberto todas as donas envolvidas.
    estado.responder = sql => {
      if (/from `conexoes_registradas`/.test(sql)) {
        return [["c-1", "PRIVATE_NETWORK_MATCH", "NW-AAAAAA tem Vinho, que NW-BBBBBB procura.", "[]", 100, "identificada", null, null, null, null, "sem_negocio", 1000]];
      }
      if (/from `conexoes_participantes`/.test(sql)) {
        return [
          [1, "c-1", "a", "contato", "dona-1", null, 11, "NW-AAAAAA", true, "sem_negocio", 1000, 1000, null, null],
          [2, "c-1", "b", "contato", "dona-sumida", null, 99, "NW-BBBBBB", true, "sem_negocio", 1000, 1000, null, null],
        ];
      }
      if (/from `users`/.test(sql)) return [[31, "dona-1", "Ana"]];
      return undefined;
    };

    return chamar("admin").admin.conexoes().then(() => {
      const registro = createAuditLog.mock.calls.at(-1)![0] as { details: { donas: number[]; ladosSemConta: number } };
      expect(registro.details.donas).toEqual([31]);
      expect(registro.details.ladosSemConta).toBe(1);
    });
  });

  it("administradora lista; apurar antes do fechamento é conflito", async () => {
    expect(await chamar("admin").admin.conexoes()).toEqual([]);
    estado.responder = sql => (/from `conexoes_registradas`/.test(sql) ? [["negociacao"]] : undefined);
    await expect(chamar("admin").admin.definirComissao({ conexaoId: "0b3f0e4e-0000-4000-8000-000000000001", status: "devida" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("memória de relacionamento — a linha do tempo", () => {
  it("junta reuniões, contextos, itens, confirmações, disponibilização e etapas, do mais recente ao mais antigo", () => {
    const eventos = montarLinhaDoTempo({
      contato: { createdAt: 100, disponivelRedeGlobal: true, disponibilidadeAlteradaEm: 700 },
      reunioes: [{ id: "m-1", title: "Café na feira", createdAt: 300, assuntos: ["Distribuição"] }],
      contextos: [{ nome: "Missão Lagos", data: "2026-05-02", createdAt: 200 }],
      tenho: [{ label: "Distribuição de medicamentos", createdAt: 400 }],
      preciso: [{ label: "Fornecedores", createdAt: 450 }],
      confirmacoes: [
        { campo: "telefone", valor: "+55 11 98765-4321", origem: "voz", decididaEm: 500 },
        { campo: "tenho", valor: "Distribuição de medicamentos", origem: "reuniao", decididaEm: 400 },
      ],
      conexoes: [{
        id: "c-1", origem: "PRIVATE_NETWORK_MATCH", motivo: "", itens: [], pontuacao: 100, status: "negociacao",
        apresentacaoEm: 800, negociacaoEm: 900, fechamentoEm: null, descartadaEm: null, statusComissao: "sem_negocio", criadaEm: 600, lados: [],
      }],
      acoes: [],
    });
    expect(eventos.map(e => e.tipo)).toEqual([
      "conexao_etapa", "conexao_etapa", "disponibilidade", "conexao_registrada", "quem_sou_confirmado",
      "preciso_adicionado", "tenho_adicionado", "reuniao", "contexto", "contato_criado",
    ]);
    // a confirmação de "tenho" não duplica o item que ela gravou
    expect(eventos.filter(e => e.tipo === "tenho_adicionado")).toHaveLength(1);
  });

  const semNada = {
    contato: { createdAt: 100, disponivelRedeGlobal: false, disponibilidadeAlteradaEm: null },
    reunioes: [], contextos: [], tenho: [], preciso: [], confirmacoes: [], conexoes: [],
  };

  it("as próximas ações ligadas ao contato (H5b): a anotada na criação e a feita na hora da caixa, com os rótulos e os nomes das vozes", () => {
    const eventos = montarLinhaDoTempo({
      ...semNada,
      acoes: [
        { id: "aberta", texto: "{F2} envia a proposta", vozes: { F2: "Carla" }, createdAt: 300, feita: false, feitaEm: null },
        { id: "feita", texto: "Mandar o catálogo", vozes: {}, createdAt: 200, feita: true, feitaEm: 500 },
      ],
    });
    expect(eventos).toEqual([
      { tipo: "proxima_acao_feita", em: 500, acaoId: "feita", texto: "Mandar o catálogo", vozes: {} },
      // O servidor não troca o rótulo pelo nome: manda os dois, e a tela troca.
      { tipo: "proxima_acao", em: 300, acaoId: "aberta", texto: "{F2} envia a proposta", vozes: { F2: "Carla" } },
      { tipo: "proxima_acao", em: 200, acaoId: "feita", texto: "Mandar o catálogo", vozes: {} },
      { tipo: "contato_criado", em: 100 },
    ]);
  });

  it("a ação que nasceu já feita (a caixa marcada no resumo antes de virar ação) não fica anotada depois de feita", () => {
    const eventos = montarLinhaDoTempo({
      ...semNada,
      acoes: [{ id: "antiga", texto: "Reservar a sala", vozes: {}, createdAt: 900, feita: true, feitaEm: 400 }],
    });
    // Mesma hora: a feita fica acima da anotada, e as duas na hora real da caixa.
    expect(eventos.map(e => [e.tipo, e.em])).toEqual([["proxima_acao_feita", 400], ["proxima_acao", 400], ["contato_criado", 100]]);
  });

  it("desmarcada (feita false) não tem evento de feita, mesmo com uma data velha", () => {
    const eventos = montarLinhaDoTempo({ ...semNada, acoes: [{ id: "a", texto: "Ligar", vozes: {}, createdAt: 300, feita: false, feitaEm: 250 }] });
    expect(eventos.map(e => e.tipo)).toEqual(["proxima_acao", "contato_criado"]);
    expect(eventos[0].em).toBe(300);
  });
});

describe("o perfil do contato lê as próximas ações ligadas a ele (H5b)", () => {
  it("a seção e a linha do tempo vêm das ações da dona com este contato, numa leitura com a dona e o contato no WHERE", async () => {
    hasValidConsent.mockResolvedValue(false);
    estado.responder = sql => {
      if (/from `private_contacts`/.test(sql)) {
        // A conferência de posse (id e código) e o Quem Sou (11 colunas).
        return /`fullName`/.test(sql)
          ? [[5, "Maria Silva", null, null, null, null, null, "NW-1", 0, null, 100]]
          : [[5, "NW-1"]];
      }
      if (/from `proximas_acoes`/.test(sql)) {
        // id, texto, detalhe, responsavel, prazo, prazoDito, origem, feita, feitaEm, trecho, createdAt,
        // meetingId, contactId, tituloDaReuniao, vozesDaReuniao, itemVivo, nomeDoContato
        return [
          ["acao-1", "{F2} envia a proposta", null, "{F2}", "2026-11-20", "até sexta", "reuniao", 0, null, "eu mando", 300,
            "reuniao-1", 5, "Café na feira", JSON.stringify({ F2: "Carla" }), "item-1", "Maria Silva"],
          ["acao-2", "Mandar o catálogo", null, null, null, null, "manual", 1, 500, null, 200, null, 5, null, null, null, "Maria Silva"],
        ];
      }
      return [];
    };
    const perfil = await chamar().contato({ contactId: 5 });

    const leitura = estado.consultas.find(c => /from `proximas_acoes`/.test(c.sql))!;
    expect(leitura.sql).toContain("where (`proximas_acoes`.`owner_id` = ? and `proximas_acoes`.`contact_id` = ?)");
    expect(leitura.params).toEqual(expect.arrayContaining(["dona-9", 5]));
    // Só lê: nenhuma escrita, e nada da lista inteira da dona (o backfill dos itens).
    expect(estado.consultas.filter(c => /^\s*(insert|update|delete)/i.test(c.sql))).toEqual([]);
    expect(estado.consultas.filter(c => /from `meeting_summary_items`/.test(c.sql))).toEqual([]);

    expect(perfil.proximasAcoes.limite).toBe(100);
    expect(perfil.proximasAcoes.lista.map(a => [a.id, a.feita, a.contato])).toEqual([
      ["acao-1", false, { id: 5, nome: "Maria Silva" }],
      ["acao-2", true, { id: 5, nome: "Maria Silva" }],
    ]);
    expect(perfil.proximasAcoes.lista[0]).toMatchObject({
      reuniao: { id: "reuniao-1", titulo: "Café na feira", itemId: "item-1" }, vozes: { F2: "Carla" }, prazo: "2026-11-20",
    });
    expect(perfil.linhaDoTempo.map(e => [e.tipo, e.em])).toEqual([
      ["proxima_acao_feita", 500], ["proxima_acao", 300], ["proxima_acao", 200], ["contato_criado", 100],
    ]);
    expect(perfil.linhaDoTempo[1]).toMatchObject({ acaoId: "acao-1", texto: "{F2} envia a proposta", vozes: { F2: "Carla" } });
  });
});
