import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * "Reunião que falha na IA fica morta: não há como reprocessar" (cartão do
 * Nicolas, 13/09/2026). O conserto é meetings.reprocess, a partir do áudio que
 * ficou guardado no bucket. Aqui, o serviço:
 *
 * 1. Recusa sem tocar em bucket nem em IA: reunião alheia ou excluída
 *    (NOT_FOUND), que nunca recebeu áudio ou sem áudio utilizável
 *    (PRECONDITION_FAILED), pronta ou já processando (CONFLICT).
 * 2. Toma a reunião com um UPDATE condicional ('failed' → 'processing', com a
 *    ficha) e devolve antes de o trabalho terminar.
 * 3. Lê o áudio de volta do bucket, sem gravar áudio nem mexer na gravação e
 *    no prazo dela, e só apaga o resultado anterior DEPOIS de a IA dar certo.
 * 4. Falha de novo com a frase certa, sem apagar nada — e o trabalho nunca
 *    rejeita, nem com o banco caindo na hora de marcar a falha.
 * 5. Convive com a varredura de interrompidas, com a exclusão e com um segundo
 *    pedido: quem tomou a reunião por último decide.
 *
 * O banco é um fake que APLICA os UPDATEs de `meetings` avaliando o WHERE
 * renderizado pelo dialeto do MySQL (igualdades e `<>` em AND): a trava é
 * provada pelo predicado, não por um contador de linhas escolhido no teste.
 */

type Predicado = { sql: string; params: unknown[] };
const dialeto = new MySqlDialect();
const renderizar = (condicao?: SQL): Predicado => {
  if (!condicao) return { sql: "", params: [] };
  const { sql, params } = dialeto.sqlToQuery(condicao);
  return { sql, params };
};

type Operacao = Predicado & {
  tipo: "select" | "update" | "insert" | "delete" | "ia" | "bucket";
  tabela: unknown;
  valores?: Record<string, unknown>;
  linhas?: Record<string, unknown>[];
  ordenada?: boolean;
  ordem?: string;
};

const estado = {
  reuniao: null as Record<string, unknown> | null,
  gravacoes: [] as Record<string, unknown>[],
  operacoes: [] as Operacao[],
  aoLer: null as ((tabela: unknown) => void) | null,
  aoInserir: null as ((tabela: unknown) => void) | null,
  falharUpdate: null as ((valores: Record<string, unknown>) => Error | null) | null,
};

const COLUNAS: Record<string, string> = {
  id: "id", owner_id: "ownerId", status: "status", updated_at: "updatedAt", consent_granted: "consentGranted",
};

/** Avalia um WHERE de `meetings` feito só de `coluna = ?` e `coluna <> ?` em AND. */
function casa({ sql, params }: Predicado, linha: Record<string, unknown>): boolean {
  const termos = [...sql.matchAll(/`meetings`\.`(\w+)` (=|<>) \?/g)];
  if (/\bor\b/.test(sql) || termos.length !== params.length) throw new Error(`o fake não sabe avaliar: ${sql}`);
  return termos.every(([, coluna, operador], i) => {
    const valor = linha[COLUNAS[coluna]];
    const esperado = params[i];
    const igual = valor === esperado || (typeof valor === "boolean" && Number(valor) === Number(esperado));
    return operador === "=" ? igual : !igual;
  });
}

const schema = await import("../drizzle/schema");

vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => ({
    select: () => ({ from: (tabela: unknown) => ({ where: (condicao?: SQL) => {
      const operacao: Operacao = { tipo: "select", tabela, ...renderizar(condicao) };
      estado.operacoes.push(operacao);
      estado.aoLer?.(tabela);
      const linhas = () => {
        if (tabela === schema.meetings) return estado.reuniao ? [{ ...estado.reuniao }] : [];
        if (tabela === schema.meetingRecordings) {
          const gravacoes = estado.gravacoes.map(gravacao => ({ ...gravacao }));
          // A ordem pedida é aplicada de verdade: `desc` põe a mais recente primeiro.
          const sentido = operacao.ordem?.endsWith(" desc") ? -1 : 1;
          if (operacao.ordem) gravacoes.sort((a, b) => (Number(a.createdAt) - Number(b.createdAt)) * sentido);
          return gravacoes;
        }
        return [];
      };
      const consulta = {
        limit: async () => linhas(),
        orderBy: (ordem: SQL) => { operacao.ordenada = true; operacao.ordem = renderizar(ordem).sql; return consulta; },
        then: (resolver: (valor: unknown) => unknown) => resolver(linhas()),
      };
      return consulta;
    } }) }),
    update: (tabela: unknown) => ({ set: (valores: Record<string, unknown>) => ({ where: async (condicao?: SQL) => {
      const predicado = renderizar(condicao);
      estado.operacoes.push({ tipo: "update", tabela, valores, ...predicado });
      const erro = estado.falharUpdate?.(valores);
      if (erro) throw erro;
      if (tabela !== schema.meetings || !estado.reuniao || !casa(predicado, estado.reuniao)) return [{ affectedRows: 0 }];
      Object.assign(estado.reuniao, valores);
      return [{ affectedRows: 1 }];
    } }) }),
    insert: (tabela: unknown) => ({ values: async (valores: Record<string, unknown> | Record<string, unknown>[]) => {
      estado.operacoes.push({ tipo: "insert", tabela, linhas: Array.isArray(valores) ? valores : [valores], sql: "", params: [] });
      estado.aoInserir?.(tabela);
    } }),
    delete: (tabela: unknown) => ({ where: async (condicao?: SQL) => {
      estado.operacoes.push({ tipo: "delete", tabela, ...renderizar(condicao) });
    } }),
  }),
}));

const storageGetBytes = vi.fn();
const storagePut = vi.fn(async () => ({ key: "k", url: "/manus-storage/k" }));
const storageDelete = vi.fn(async () => {});
// O áudio de reunião sai do bucket com todas as versões (storageApagarTodasAsVersoes).
const apagarAudio = vi.fn(async (_chave: string) => {});
// As classes de erro e chaveDoStorageDaDona vêm do módulo real: o serviço faz
// instanceof e confere a chave com elas.
vi.mock("./storage", async importOriginal => ({
  ...await importOriginal<typeof import("./storage")>(),
  storagePut: (...args: unknown[]) => storagePut(...(args as [])),
  storageDelete: (...args: unknown[]) => storageDelete(...(args as [])),
  storageApagarTodasAsVersoes: (...args: unknown[]) => {
    estado.operacoes.push({ tipo: "bucket", tabela: "expurgo", sql: "", params: args });
    return apagarAudio(...(args as [string]));
  },
  storageGetBytes: (...args: unknown[]) => {
    estado.operacoes.push({ tipo: "bucket", tabela: "leitura", sql: "", params: args });
    return storageGetBytes(...(args as []));
  },
}));

const transcribeWithGemini = vi.fn();
vi.mock("./gemini", async importOriginal => ({
  ...await importOriginal<typeof import("./gemini")>(),
  transcribeWithGemini: (...args: unknown[]) => {
    estado.operacoes.push({ tipo: "ia", tabela: "gemini", sql: "", params: [] });
    return transcribeWithGemini(...(args as []));
  },
  embedWithGemini: async () => [],
  embedManyWithGemini: async () => [],
}));
const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({
  invokeLLM: (...args: unknown[]) => {
    estado.operacoes.push({ tipo: "ia", tabela: "llm", sql: "", params: [] });
    return invokeLLM(...(args as []));
  },
}));
// Os bytes daqui são texto, não áudio: a medição da duração é dublada.
vi.mock("./duracao-do-audio", () => ({ medirDuracaoDoAudio: () => 30 }));

const servico = await import("./meeting-service");
const { GeminiCotaEsgotadaError } = await import("./gemini");
const { ObjetoAusenteNoStorageError } = await import("./storage");

const AGORA = Date.now();
const DIA = 24 * 60 * 60 * 1000;
const DONA = "dona-1";
const REUNIAO = "reuniao-1";
const CHAVE = `meetings/${DONA}/${REUNIAO}/recording_abc12345.webm`;
const AUDIO = Buffer.from("áudio guardado da reunião");
const ana = { fullName: "Ana Souza", jobTitle: "Diretora", company: "Vinhos do Sul", phone: "+55 11 99999-9999", email: "ana@vinhosdosul.com", confidence: 0.9 };

const reuniaoComFalha = (extra: Record<string, unknown> = {}) => ({
  id: REUNIAO, ownerId: DONA, title: "Reunião com a vinícola", status: "failed", consentGranted: true, language: "pt",
  processingError: "Não foi possível transcrever o áudio.", createdAt: AGORA - DIA, updatedAt: AGORA - 60_000, ...extra,
});
const gravacaoGuardada = (extra: Record<string, unknown> = {}) => ({
  id: "gravacao-1", meetingId: REUNIAO, ownerId: DONA, storageKey: CHAVE, storageUrl: `/manus-storage/${CHAVE}`,
  mimeType: "audio/webm", sizeBytes: AUDIO.length, durationSeconds: 95, expiresAt: AGORA + 20 * DIA, createdAt: AGORA - DIA, ...extra,
});

const REUNIAO_DA_DONA = { sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ?)", params: [REUNIAO, DONA] };
const daReuniaoDaDona = (tabela: string) => ({ sql: `(\`${tabela}\`.\`meeting_id\` = ? and \`${tabela}\`.\`owner_id\` = ?)`, params: [REUNIAO, DONA] });
const soPredicado = ({ sql, params }: Predicado) => ({ sql, params });
const de = (tipo: Operacao["tipo"], tabela?: unknown) => estado.operacoes.filter(o => o.tipo === tipo && (tabela === undefined || o.tabela === tabela));
const primeira = (filtro: (o: Operacao) => boolean) => estado.operacoes.findIndex(filtro);
const ultima = (filtro: (o: Operacao) => boolean) => estado.operacoes.reduce((achada, o, i) => (filtro(o) ? i : achada), -1);
const linhasInseridas = (tabela: unknown) => de("insert", tabela).flatMap(o => o.linhas ?? []);
const falhasGravadas = () => de("update", schema.meetings).filter(o => o.valores?.status === "failed");
const TABELAS_DERIVADAS = ["meeting_contact_suggestions", "network_sugestoes", "meeting_entities", "meeting_transcripts", "meeting_transcript_translations", "meeting_summary_items", "meeting_summaries"];
const derivadas = () => [schema.meetingContactSuggestions, schema.networkSugestoes, schema.meetingEntities, schema.meetingTranscripts, schema.meetingTranscriptTranslations, schema.meetingSummaryItems, schema.meetingSummaries];

async function reprocessar() {
  const { trabalho } = await servico.iniciarReprocessamento(DONA, REUNIAO);
  await trabalho;
}

async function recusado(codigo: "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED") {
  await expect(servico.iniciarReprocessamento(DONA, REUNIAO)).rejects.toMatchObject({ name: "ReprocessamentoRecusado", codigo });
}

function nadaFoiTocado() {
  expect(de("update")).toEqual([]);
  expect(de("delete")).toEqual([]);
  expect(storageGetBytes).not.toHaveBeenCalled();
  expect(transcribeWithGemini).not.toHaveBeenCalled();
  expect(invokeLLM).not.toHaveBeenCalled();
}

beforeEach(() => {
  estado.reuniao = reuniaoComFalha();
  estado.gravacoes = [gravacaoGuardada()];
  estado.operacoes = [];
  estado.aoLer = null;
  estado.aoInserir = null;
  estado.falharUpdate = null;
  storageGetBytes.mockReset();
  storageGetBytes.mockResolvedValue(AUDIO);
  storagePut.mockClear();
  storageDelete.mockClear();
  apagarAudio.mockReset();
  apagarAudio.mockImplementation(async () => {});
  transcribeWithGemini.mockReset();
  // O nome da sugestão precisa estar na fala (nomeSustentadoPelaTranscricao).
  transcribeWithGemini.mockResolvedValue({ text: "Transcrição nova da conversa com a Ana Souza.", segments: [], language: "pt" });
  invokeLLM.mockReset();
  invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    entities: [{ type: "person", value: "Ana", normalizedValue: null, confidence: 0.8 }],
    contacts: [ana],
  }) } }] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("reprocessar — as recusas não tocam em bucket nem em IA", () => {
  it.each(["processing", "ready"])("reunião %s: CONFLICT", async status => {
    estado.reuniao = reuniaoComFalha({ status });
    await recusado("CONFLICT");
    nadaFoiTocado();
  });

  it("reunião que nunca recebeu áudio ('recording'): PRECONDITION_FAILED, não CONFLICT", async () => {
    estado.reuniao = reuniaoComFalha({ status: "recording", processingError: null });
    estado.gravacoes = [];
    await recusado("PRECONDITION_FAILED");
    nadaFoiTocado();
  });

  it("reunião de outra dona, inexistente ou excluída: NOT_FOUND, sem distinguir — e a leitura já é da reunião DA dona", async () => {
    estado.reuniao = null;
    await recusado("NOT_FOUND");
    estado.reuniao = reuniaoComFalha({ status: "deleted" });
    await recusado("NOT_FOUND");
    nadaFoiTocado();
    expect(de("select", schema.meetings).map(soPredicado)).toEqual([REUNIAO_DA_DONA, REUNIAO_DA_DONA]);
  });

  it("sem consentimento: PRECONDITION_FAILED", async () => {
    estado.reuniao = reuniaoComFalha({ consentGranted: false });
    await recusado("PRECONDITION_FAILED");
    nadaFoiTocado();
  });

  it.each([
    ["sem gravação", () => { estado.gravacoes = []; }],
    ["gravação que vence em 10 minutos (a retenção a apagaria no meio)", () => { estado.gravacoes = [gravacaoGuardada({ expiresAt: AGORA + 10 * 60_000 })]; }],
    ["gravação já vencida", () => { estado.gravacoes = [gravacaoGuardada({ expiresAt: AGORA - 1 })]; }],
    ["chave no espaço de outra dona", () => { estado.gravacoes = [gravacaoGuardada({ storageKey: `meetings/outra-dona/${REUNIAO}/recording.webm` })]; }],
    ["chave de outra reunião da mesma dona", () => { estado.gravacoes = [gravacaoGuardada({ storageKey: `meetings/${DONA}/outra-reuniao/recording.webm` })]; }],
    ["chave fora de meetings/ (linha legada)", () => { estado.gravacoes = [gravacaoGuardada({ storageKey: `contacts/${DONA}/foto.jpg` })]; }],
    ["tipo fora da lista", () => { estado.gravacoes = [gravacaoGuardada({ mimeType: "video/mp4" })]; }],
    ["acima de 10 MB", () => { estado.gravacoes = [gravacaoGuardada({ sizeBytes: 10 * 1024 * 1024 + 1 })]; }],
  ])("%s: PRECONDITION_FAILED sem ler o bucket", async (_caso, preparar) => {
    preparar();
    await recusado("PRECONDITION_FAILED");
    nadaFoiTocado();
  });

  it("a gravação consultada é a da reunião DA dona, a mais recente (a mesma que o player toca)", async () => {
    estado.gravacoes = [];
    await recusado("PRECONDITION_FAILED");
    const [leitura] = de("select", schema.meetingRecordings);
    expect(soPredicado(leitura)).toEqual(daReuniaoDaDona("meeting_recordings"));
    expect(leitura.ordenada).toBe(true);
    expect(leitura.ordem).toBe("`meeting_recordings`.`created_at` desc");
  });

  it("outro pedido tomou a reunião entre a leitura e a tomada (0 linhas): CONFLICT, sem bucket nem IA", async () => {
    estado.aoLer = tabela => {
      if (tabela === schema.meetingRecordings) Object.assign(estado.reuniao!, { status: "processing", updatedAt: AGORA + 5 });
    };
    await recusado("CONFLICT");
    expect(de("update", schema.meetings)).toHaveLength(1);
    expect(estado.reuniao!.updatedAt).toBe(AGORA + 5);
    expect(storageGetBytes).not.toHaveBeenCalled();
    expect(transcribeWithGemini).not.toHaveBeenCalled();
  });

  it("…e se a reunião foi excluída nesse meio-tempo: NOT_FOUND", async () => {
    estado.aoLer = tabela => {
      if (tabela === schema.meetingRecordings) Object.assign(estado.reuniao!, { status: "deleted" });
    };
    await recusado("NOT_FOUND");
    expect(storageGetBytes).not.toHaveBeenCalled();
  });
});

describe("reprocessar — a tomada", () => {
  it("UPDATE condicional: 'failed' → 'processing' só na reunião da dona com consentimento, e devolve com o trabalho ainda rodando", async () => {
    const lido = Number(estado.reuniao!.updatedAt);
    storageGetBytes.mockImplementation(() => new Promise(() => {}));

    const { trabalho } = await servico.iniciarReprocessamento(DONA, REUNIAO);

    expect(trabalho).toBeInstanceOf(Promise);
    const [tomada] = de("update", schema.meetings);
    expect(tomada.sql).toBe("(`meetings`.`id` = ? and `meetings`.`owner_id` = ? and `meetings`.`status` = ? and `meetings`.`consent_granted` = ?)");
    expect(tomada.params.slice(0, 3)).toEqual([REUNIAO, DONA, "failed"]);
    expect([true, 1]).toContain(tomada.params[3]);
    expect(tomada.valores).toMatchObject({ status: "processing", processingError: null });
    expect(Number(tomada.valores!.updatedAt)).toBeGreaterThan(lido);
    expect(estado.reuniao).toMatchObject({ status: "processing", processingError: null });
    expect(transcribeWithGemini).not.toHaveBeenCalled();
  });

  it("a ficha é estritamente maior que o updated_at lido, mesmo com o relógio atrás dele", async () => {
    estado.reuniao = reuniaoComFalha({ updatedAt: AGORA + 60 * 60_000 });
    storageGetBytes.mockImplementation(() => new Promise(() => {}));
    await servico.iniciarReprocessamento(DONA, REUNIAO);
    expect(estado.reuniao!.updatedAt).toBe(AGORA + 60 * 60_000 + 1);
  });

  it("segundo pedido com o primeiro ainda rodando (duplo clique, outra aba): CONFLICT, sem segunda leitura do bucket", async () => {
    storageGetBytes.mockImplementation(() => new Promise(() => {}));
    await servico.iniciarReprocessamento(DONA, REUNIAO);
    await recusado("CONFLICT");
    expect(storageGetBytes).toHaveBeenCalledTimes(1);
  });
});

describe("reprocessar — com o áudio guardado", () => {
  it("com duas gravações, reprocessa a MAIS RECENTE (a que o player toca), não a antiga", async () => {
    estado.gravacoes = [
      gravacaoGuardada({ id: "antiga", storageKey: `meetings/${DONA}/${REUNIAO}/recording_antiga.webm`, createdAt: AGORA - 2 * DIA }),
      gravacaoGuardada({ id: "nova", createdAt: AGORA - DIA }),
    ];
    await reprocessar();
    expect(storageGetBytes).toHaveBeenCalledTimes(1);
    expect(storageGetBytes).toHaveBeenCalledWith(CHAVE, servico.MAX_MEETING_AUDIO_BYTES);
  });

  it("lê o áudio uma vez, com o teto de 10 MB, e não grava áudio nem mexe na gravação (nem no prazo dela)", async () => {
    await reprocessar();
    expect(storageGetBytes).toHaveBeenCalledTimes(1);
    expect(storageGetBytes).toHaveBeenCalledWith(CHAVE, servico.MAX_MEETING_AUDIO_BYTES);
    expect(storagePut).not.toHaveBeenCalled();
    for (const tipo of ["insert", "update", "delete"] as const) expect(de(tipo, schema.meetingRecordings)).toEqual([]);
    expect(transcribeWithGemini).toHaveBeenCalledWith({ audio: AUDIO, mimeType: "audio/webm", language: "pt" });
  });

  it("o resultado anterior sai DEPOIS de a IA dar certo e ANTES de gravar o novo, sempre por meeting_id e owner_id", async () => {
    await reprocessar();
    const ultimaChamadaDeIA = ultima(o => o.tipo === "ia");
    expect(ultimaChamadaDeIA).toBeGreaterThanOrEqual(0);
    expect(primeira(o => o.tipo === "delete")).toBeGreaterThan(ultimaChamadaDeIA);
    expect(primeira(o => o.tipo === "insert")).toBeGreaterThan(ultima(o => o.tipo === "delete"));
    expect(de("delete").map(o => o.tabela)).toEqual(derivadas());
    expect(de("delete").map(soPredicado)).toEqual(TABELAS_DERIVADAS.map(daReuniaoDaDona));
  });

  it("promove a 'ready' só com a ficha da tomada; a transcrição nova leva a duração MEDIDA nos bytes, não a guardada na gravação", async () => {
    await reprocessar();
    const [tomada, pronta] = de("update", schema.meetings);
    expect(pronta.valores).toMatchObject({ status: "ready", processingError: null });
    expect(soPredicado(pronta)).toEqual({
      sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ? and `meetings`.`status` = ? and `meetings`.`updated_at` = ?)",
      params: [REUNIAO, DONA, "processing", tomada.valores!.updatedAt],
    });
    expect(estado.reuniao).toMatchObject({ status: "ready", processingError: null });
    const [transcricao] = linhasInseridas(schema.meetingTranscripts);
    expect(transcricao).toMatchObject({ meetingId: REUNIAO, ownerId: DONA, transcript: "Transcrição nova da conversa com a Ana Souza.", durationSeconds: 30 });
    expect(linhasInseridas(schema.meetingContactSuggestions).map(sugestao => sugestao.fullName)).toEqual(["Ana Souza"]);
    expect(falhasGravadas()).toEqual([]);
  });
});

describe("reprocessar — quando falha de novo", () => {
  it("cota do Gemini esgotada: 'failed' com a frase de cota, só na reunião ainda desta execução, e o resultado anterior fica", async () => {
    transcribeWithGemini.mockRejectedValue(new GeminiCotaEsgotadaError());
    await reprocessar();
    const [tomada] = de("update", schema.meetings);
    const [falha] = falhasGravadas();
    expect(String(falha.valores!.processingError)).toMatch(/^O limite de uso gratuito do serviço de IA foi atingido/);
    expect(soPredicado(falha)).toEqual({
      sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ? and `meetings`.`status` = ? and `meetings`.`updated_at` = ?)",
      params: [REUNIAO, DONA, "processing", tomada.valores!.updatedAt],
    });
    expect(de("delete")).toEqual([]);
    expect(de("insert")).toEqual([]);
    expect(estado.reuniao!.status).toBe("failed");
  });

  it("o áudio sumiu do bucket: frase neutra na tela, a chave só no log, e nada de IA", async () => {
    storageGetBytes.mockRejectedValue(new ObjetoAusenteNoStorageError(CHAVE));
    await reprocessar();
    expect(estado.reuniao!.processingError).toBe(servico.MENSAGEM_AUDIO_GUARDADO_AUSENTE);
    // é a MESMA frase que a tela reconhece para traduzir e esconder o botão
    expect(servico.MENSAGEM_AUDIO_GUARDADO_AUSENTE).toBe((await import("../shared/const")).MENSAGEM_AUDIO_GUARDADO_AUSENTE);
    expect(String(estado.reuniao!.processingError)).not.toContain(CHAVE);
    expect(transcribeWithGemini).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain(CHAVE);
  });

  it("bucket sem configuração ou fora do ar: 'Não foi possível ler o áudio guardado.', sem STORAGE_ na tela", async () => {
    storageGetBytes.mockRejectedValue(new Error("Storage não configurado: defina STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID e STORAGE_SECRET_ACCESS_KEY."));
    await reprocessar();
    expect(estado.reuniao!.processingError).toBe(servico.MENSAGEM_AUDIO_GUARDADO_ILEGIVEL);
    expect(String(estado.reuniao!.processingError)).not.toContain("STORAGE_");
  });

  it("o banco cai justo ao marcar a falha: o trabalho NÃO rejeita (rejeição solta derrubaria o servidor) e o motivo vai para o log", async () => {
    transcribeWithGemini.mockRejectedValue(new Error("qualquer"));
    estado.falharUpdate = valores => valores.status === "failed"
      ? Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" })
      : null;
    const { trabalho } = await servico.iniciarReprocessamento(DONA, REUNIAO);
    await expect(trabalho).resolves.toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("ECONNREFUSED");
    // fica 'processing', para a varredura de interrompidas assumir
    expect(estado.reuniao!.status).toBe("processing");
  });
});

describe("reprocessar — quem tomou a reunião por último decide", () => {
  it("a varredura de interrompidas marcou a reunião no meio (updated_at novo): a execução sai sem gravar, sem apagar e sem 'failed' próprio", async () => {
    transcribeWithGemini.mockImplementation(async () => {
      Object.assign(estado.reuniao!, { status: "failed", processingError: "ERRO_INTERROMPIDO", updatedAt: Date.now() + 1_000 });
      return { text: "Transcrição nova.", segments: [], language: "pt" };
    });
    await reprocessar();
    expect(de("insert")).toEqual([]);
    expect(de("delete")).toEqual([]);
    expect(falhasGravadas()).toEqual([]);
    expect(estado.reuniao).toMatchObject({ status: "failed", processingError: "ERRO_INTERROMPIDO" });
  });

  it("a dona excluiu a reunião durante o reprocessamento: tudo sai, com o áudio, e nada ressuscita", async () => {
    transcribeWithGemini.mockImplementation(async () => {
      estado.reuniao = null;
      return { text: "Transcrição nova.", segments: [], language: "pt" };
    });
    await reprocessar();
    expect(de("insert")).toEqual([]);
    // O arquivo sai do bucket com todas as versões, e só então a linha da
    // gravação, pelo id; sem partes, não há DELETE de partes.
    expect(apagarAudio).toHaveBeenCalledWith(CHAVE);
    expect(storageDelete).not.toHaveBeenCalled();
    expect(de("delete").map(o => o.tabela)).toEqual([...derivadas(), schema.meetingRecordings]);
    expect(soPredicado(de("delete", schema.meetingRecordings)[0])).toEqual({
      sql: "(`meeting_recordings`.`owner_id` = ? and `meeting_recordings`.`id` in (?))", params: [DONA, "gravacao-1"],
    });
    expect(primeira(o => o.tipo === "bucket" && o.tabela === "expurgo")).toBeLessThan(primeira(o => o.tipo === "delete"));
    expect(falhasGravadas()).toEqual([]);
  });

  it("outra execução tomou a reunião entre as escritas e o 'ready': nada é apagado nem marcado — quem tem a ficha nova limpa antes de gravar", async () => {
    estado.aoInserir = tabela => {
      if (tabela === schema.meetingTranscripts) Object.assign(estado.reuniao!, { updatedAt: Date.now() + 5_000 });
    };
    await reprocessar();
    const depoisDasEscritas = estado.operacoes.slice(primeira(o => o.tipo === "insert"));
    expect(depoisDasEscritas.filter(o => o.tipo === "delete")).toEqual([]);
    expect(apagarAudio).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
    expect(falhasGravadas()).toEqual([]);
    expect(estado.reuniao!.status).toBe("processing");
    expect(vi.mocked(console.warn)).toHaveBeenCalled();
  });
});

describe("envio original — a mesma trava da ficha", () => {
  const envio = (audioBase64 = AUDIO.toString("base64")) => ({
    meetingId: REUNIAO, ownerId: DONA, audioBase64, mimeType: "audio/webm", durationSeconds: 30, language: "pt",
  });

  it("submitRecording numa reunião já pronta: ReuniaoForaDoEstado, sem upload e sem IA, e ela continua pronta", async () => {
    estado.reuniao = reuniaoComFalha({ status: "ready", processingError: null });
    await expect(servico.processMeetingRecording(envio())).rejects.toBeInstanceOf(servico.ReuniaoForaDoEstado);
    expect(storagePut).not.toHaveBeenCalled();
    expect(transcribeWithGemini).not.toHaveBeenCalled();
    expect(estado.reuniao!.status).toBe("ready");
  });

  it("áudio ruim reenviado a uma reunião pronta não a rebaixa para 'failed'", async () => {
    estado.reuniao = reuniaoComFalha({ status: "ready", processingError: null });
    await expect(servico.processMeetingRecording(envio("isto não é base64!"))).rejects.toThrow("Arquivo de áudio inválido.");
    expect(estado.reuniao!.status).toBe("ready");
  });

  it("com a reunião esperando áudio: toma, guarda a gravação uma vez, não limpa nada e fica pronta", async () => {
    estado.reuniao = reuniaoComFalha({ status: "recording", processingError: null });
    estado.gravacoes = [];
    await servico.processMeetingRecording(envio());
    expect(storagePut).toHaveBeenCalledTimes(1);
    expect(linhasInseridas(schema.meetingRecordings)).toHaveLength(1);
    expect(de("delete")).toEqual([]);
    expect(estado.reuniao!.status).toBe("ready");
  });
});
