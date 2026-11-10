import { getTableColumns } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Tarefa do quadro: "Tocar a gravação da reunião no app (playback do áudio)".
 *
 * O áudio já subia, transcrevia e ficava no bucket — mas a API nunca devolvia
 * a gravação, então não havia como ouvir de volta. Junto vinham duas dívidas
 * que só apareciam quando existisse um player:
 *
 *  1. O prazo de 30 dias era decorativo: `expiresAt` era escrito e nunca lido,
 *     e nada apagava o arquivo. A tela prometia "expira automaticamente após
 *     30 dias" enquanto o áudio ficava para sempre.
 *  2. Apagar a reunião não apagava o áudio do bucket — e sem a linha do banco,
 *     ninguém saberia que o objeto continuava lá.
 */

const storageDelete = vi.fn(async () => {});
vi.mock("./storage", async importOriginal => ({
  ...await importOriginal<typeof import("./storage")>(),
  storagePut: async () => ({ key: "k", url: "/manus-storage/k" }),
  storageDelete: (...args: unknown[]) => storageDelete(...(args as [string])),
}));
vi.mock("./_core/llm", () => ({ invokeLLM: async () => ({ choices: [{ message: { content: "{}" } }] }) }));
// As classes de erro vêm do módulo real: meeting-service faz instanceof nelas.
vi.mock("./gemini", async importOriginal => ({
  ...await importOriginal<typeof import("./gemini")>(),
  transcribeWithGemini: async () => ({ text: "", segments: [] }),
}));

const schema = await import("../drizzle/schema");
const { MENSAGEM_ERRO_DE_CONSULTA } = await import("./banco-indisponivel");

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const tabelas = new Map<unknown, Record<string, unknown>[]>();

/**
 * O WHERE de cada operação, renderizado pelo dialeto do MySQL (sem banco). O
 * fake não executa o predicado, então o escopo por dona só se prova olhando
 * para o SQL E os parâmetros — uma lista de colunas deixava passar `and`→`or`
 * (cita as mesmas colunas e apaga os derivados de todas as reuniões da dona).
 */
type Predicado = { sql: string; params: unknown[] };
const dialeto = new MySqlDialect();
const renderizar = (condicao?: SQL): Predicado => {
  const { sql, params } = condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] };
  return { sql, params };
};
const REUNIAO_DA_DONA = { sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ?)", params: ["reuniao-1", "dona-1"] };
const derivadaDaReuniaoDaDona = (tabela: string) => ({ sql: `(\`${tabela}\`.\`meeting_id\` = ? and \`${tabela}\`.\`owner_id\` = ?)`, params: ["reuniao-1", "dona-1"] });

type Operacao = { tabela: unknown } & Predicado;
const delecoes: Operacao[] = [];
const tabelasApagadas = () => delecoes.map(operacao => operacao.tabela);
const leituras: Operacao[] = [];
const ordenacoes: unknown[] = [];
const atualizacoes: Array<Operacao & { valores: Record<string, unknown> }> = [];
const predicadoDe = ({ sql, params }: Operacao) => ({ sql, params });
// A ordem de TODAS as escritas: o "deleted" precisa vir antes do primeiro
// delete, e só a sequência prova isso.
const sequencia: string[] = [];

/** where() do drizzle é "thenable": dá para aguardar direto ou encadear. */
const consulta = (linhas: Record<string, unknown>[]) => ({
  limit: async () => linhas,
  // síncrono de propósito: o drizzle encadeia .orderBy(...).limit(...)
  orderBy: (ordem: unknown) => { ordenacoes.push(ordem); return consulta(linhas); },
  then: (resolver: (valor: Record<string, unknown>[]) => unknown) => resolver(linhas),
});

/**
 * select(projeção) devolve só as colunas pedidas, com o nome dado na projeção,
 * como o banco faria; select() devolve a linha inteira. Assim o que a lista e o
 * detalhe escolhem se prova pelo que chega à tela, e não pela forma da chamada.
 */
const projetar = (tabela: unknown, projecao: Record<string, unknown> | undefined, linhas: Record<string, unknown>[]) => {
  if (!projecao) return linhas;
  const chavePorColuna = new Map<unknown, string>(
    Object.entries(getTableColumns(tabela as typeof schema.meetings)).map(([chave, coluna]) => [coluna, chave]),
  );
  return linhas.map(linha => Object.fromEntries(
    Object.entries(projecao).map(([nome, coluna]) => [nome, linha[chavePorColuna.get(coluna) ?? ""]]),
  ));
};

const fakeDb = {
  select: (projecao?: Record<string, unknown>) => ({
    from: (tabela: unknown) => ({
      where: (condicao?: SQL) => {
        leituras.push({ tabela, ...renderizar(condicao) });
        return consulta(projetar(tabela, projecao, tabelas.get(tabela) ?? []));
      },
    }),
  }),
  delete: (tabela: unknown) => ({
    where: async (condicao?: SQL) => { delecoes.push({ tabela, ...renderizar(condicao) }); sequencia.push("delete"); },
  }),
  // O mysql2 devolve [ResultSetHeader, campos]; aqui a linha "existe" se a
  // tabela simulada tem alguma — é como o fake responde "não é dela".
  update: (tabela: unknown) => ({
    set: (valores: Record<string, unknown>) => ({
      where: async (condicao?: SQL) => {
        atualizacoes.push({ tabela, valores, ...renderizar(condicao) });
        sequencia.push("update");
        return [{ affectedRows: (tabelas.get(tabela) ?? []).length }];
      },
    }),
  }),
  insert: () => ({ values: async () => {} }),
};
vi.mock("./db", () => ({ exigirDb: async () => fakeDb as never, getDb: async () => fakeDb as never }));

const servico = await import("./meeting-service");

// Depois do import do serviço, e não antes: importar meeting-service (com o SDK
// do bucket) passa de 1 s com a máquina ocupada, e a gravação "dentro do prazo"
// (AGORA + 1000) chegava vencida ao teste.
const AGORA = Date.now();

const REUNIAO = { id: "reuniao-1", ownerId: "dona-1", title: "Reunião", status: "ready", consentGranted: true, createdAt: AGORA - 1000 };
const gravacaoCom = (expiresAt: number) => ({
  id: "grav-1", meetingId: "reuniao-1", ownerId: "dona-1",
  storageKey: "meetings/dona-1/reuniao-1/recording_abc.webm",
  storageUrl: "/manus-storage/meetings/dona-1/reuniao-1/recording_abc.webm",
  mimeType: "audio/webm", sizeBytes: 12345, durationSeconds: 92,
  expiresAt, createdAt: AGORA,
});

beforeEach(() => {
  tabelas.clear();
  delecoes.length = 0;
  leituras.length = 0;
  ordenacoes.length = 0;
  atualizacoes.length = 0;
  sequencia.length = 0;
  // mockReset (não mockClear): um mockRejectedValueOnce não consumido por um
  // teste vazaria para o próximo e o faria falhar por motivo errado.
  storageDelete.mockReset();
  storageDelete.mockImplementation(async () => {});
  tabelas.set(schema.meetings, [REUNIAO]);
  tabelas.set(schema.meetingTranscripts, []);
  tabelas.set(schema.meetingEntities, []);
  tabelas.set(schema.meetingContactSuggestions, []);
  tabelas.set(schema.meetingRecordings, []);
});

describe("Playback — a API entrega a gravação para a tela poder tocar", () => {
  it("gravação dentro do prazo volta com endereço, duração e validade", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 10 * 24 * 60 * 60 * 1000)]);
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recording?.url).toBe("/manus-storage/meetings/dona-1/reuniao-1/recording_abc.webm");
    expect(dados?.recording?.durationSeconds).toBe(92);
    expect(dados?.recording?.mimeType).toBe("audio/webm");
    expect(dados?.recordingExpired).toBe(false);
  });

  it("o endereço é o do proxy autenticado, nunca o do bucket", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recording?.url.startsWith("/manus-storage/")).toBe(true);
  });

  it("a chave do bucket NÃO vai para a tela", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recording).not.toHaveProperty("storageKey");
  });

  it("reunião sem áudio devolve nada, sem alarde", async () => {
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recording).toBeNull();
    expect(dados?.recordingExpired).toBe(false);
    expect(storageDelete).not.toHaveBeenCalled();
  });

  it("a gravação lida é a da reunião DA dona (meeting_id E owner_id) — como a reunião, a transcrição, as entidades e as sugestões", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);
    await servico.getPrivateMeeting("dona-1", "reuniao-1");
    const porTabela = (tabela: unknown) => leituras.filter(operacao => operacao.tabela === tabela).map(predicadoDe);
    expect(porTabela(schema.meetings)).toEqual([REUNIAO_DA_DONA]);
    expect(porTabela(schema.meetingTranscripts)).toEqual([derivadaDaReuniaoDaDona("meeting_transcripts")]);
    expect(porTabela(schema.meetingEntities)).toEqual([derivadaDaReuniaoDaDona("meeting_entities")]);
    expect(porTabela(schema.meetingContactSuggestions)).toEqual([derivadaDaReuniaoDaDona("meeting_contact_suggestions")]);
    expect(porTabela(schema.meetingRecordings)).toEqual([derivadaDaReuniaoDaDona("meeting_recordings")]);
  });

  it("a transcrição e as sugestões continuam vindo como antes", async () => {
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados).toHaveProperty("transcript");
    expect(dados).toHaveProperty("entities");
    expect(dados).toHaveProperty("suggestions");
  });
});

describe("Leitura — processing_error legado com o SQL do driver não chega à tela", () => {
  // Antes de mensagemDaFalha, a mensagem do DrizzleQueryError ia inteira para
  // a coluna: há linhas assim em produção, com o INSERT e os parâmetros
  // (nome, telefone, e-mail das pessoas da reunião). Limpar a coluna depende
  // do Roberto; até lá, quem LÊ mascara — nos dois caminhos que chegam à tela.
  const legado = "Failed query: insert into `meeting_contact_suggestions` (`full_name`, `email`) values (?, ?)\nparams: Ana Souza,ana@vinhosdosul.com";

  it("getPrivateMeeting devolve a frase neutra no lugar do SQL", async () => {
    tabelas.set(schema.meetings, [{ ...REUNIAO, status: "failed", processingError: legado }]);
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.meeting.processingError).toBe(MENSAGEM_ERRO_DE_CONSULTA);
    expect(JSON.stringify(dados)).not.toContain("ana@vinhosdosul.com");
    expect(JSON.stringify(dados)).not.toContain("Failed query");
  });

  it("listPrivateMeetings também: a lista vai inteira para o navegador", async () => {
    tabelas.set(schema.meetings, [{ ...REUNIAO, status: "failed", processingError: legado }, { ...REUNIAO, id: "reuniao-2" }]);
    const lista = await servico.listPrivateMeetings("dona-1");
    expect(lista.map(reuniao => reuniao.processingError)).toEqual([MENSAGEM_ERRO_DE_CONSULTA, undefined]);
    expect(JSON.stringify(lista)).not.toContain("Failed query");
  });

  it("frase para a dona, o código ERRO_INTERROMPIDO e null passam inteiros", () => {
    expect(servico.processingErrorSeguro("Arquivo de áudio inválido.")).toBe("Arquivo de áudio inválido.");
    expect(servico.processingErrorSeguro(servico.CODIGO_ERRO_INTERROMPIDO)).toBe("ERRO_INTERROMPIDO");
    expect(servico.processingErrorSeguro(null)).toBeNull();
  });
});

describe("Lista e detalhe — escolhem as colunas, e o controle da fila não vai ao navegador", () => {
  // A migração 0014 pôs em `meetings` a reserva da fila de transcrição
  // (attempts, locked_until, lock_token). Com select() da linha inteira, ela ia
  // para o navegador em meetings.list e meetings.get. A linha simulada tem TODAS
  // as colunas do schema (inclusive as que vierem depois), para a projeção ser
  // provada pelo que chega à tela.
  const CONTROLE_DA_FILA = ["attempts", "lockedUntil", "lockToken"];
  const NA_TELA = [
    "id", "ownerId", "title", "contactId", "contextId", "status", "consentGranted",
    "consentAt", "language", "processingError", "createdAt", "updatedAt",
  ];
  const linhaCompleta = () => ({
    ...Object.fromEntries(Object.keys(getTableColumns(schema.meetings)).map(chave => [chave, `valor-de-${chave}`])),
    ...REUNIAO,
    processingError: null,
    attempts: 2,
    lockedUntil: AGORA + 60_000,
    lockToken: "ficha-da-fila-0123",
  });

  it("a linha simulada tem mesmo as colunas de controle", () => {
    for (const coluna of CONTROLE_DA_FILA) expect(linhaCompleta()).toHaveProperty(coluna);
  });

  it("a lista manda só as colunas escolhidas, sem a reserva da fila", async () => {
    tabelas.set(schema.meetings, [linhaCompleta()]);
    const lista = await servico.listPrivateMeetings("dona-1");
    expect(lista).toHaveLength(1);
    for (const coluna of CONTROLE_DA_FILA) expect(lista[0]).not.toHaveProperty(coluna);
    expect(JSON.stringify(lista)).not.toContain("ficha-da-fila-0123");
    expect(Object.keys(lista[0]).sort()).toEqual([...NA_TELA].sort());
    expect(lista[0]).toMatchObject({ id: "reuniao-1", title: "Reunião", status: "ready", createdAt: AGORA - 1000 });
  });

  it("o detalhe também", async () => {
    tabelas.set(schema.meetings, [linhaCompleta()]);
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    for (const coluna of CONTROLE_DA_FILA) expect(dados?.meeting).not.toHaveProperty(coluna);
    expect(JSON.stringify(dados)).not.toContain("ficha-da-fila-0123");
    expect(Object.keys(dados!.meeting).sort()).toEqual([...NA_TELA].sort());
    expect(dados?.meeting).toMatchObject({ id: "reuniao-1", title: "Reunião", status: "ready" });
  });
});

describe("Retenção — os 30 dias deixam de ser promessa e viram ação", () => {
  it("gravação vencida não é servida, e o arquivo é apagado do bucket", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA - 1)]);
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recording).toBeNull();
    expect(dados?.recordingExpired).toBe(true);
    expect(storageDelete).toHaveBeenCalledWith("meetings/dona-1/reuniao-1/recording_abc.webm");
    expect(tabelasApagadas()).toContain(schema.meetingRecordings);
  });

  it("o storage fora do ar não derruba a leitura da reunião", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA - 1)]);
    storageDelete.mockRejectedValueOnce(new Error("bucket fora do ar"));
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recordingExpired).toBe(true);
    expect(dados?.meeting).toBeTruthy();
  });

  it("bucket falhou: a LINHA fica, senão o áudio some do banco e vive no bucket para sempre", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA - 1)]);
    storageDelete.mockRejectedValueOnce(new Error("bucket fora do ar"));
    await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(tabelasApagadas()).not.toContain(schema.meetingRecordings);
  });

  it("depois de descartada, a tela continua sabendo que EXPIROU — não vira 'nunca houve áudio'", async () => {
    // sem linha, mas a reunião é mais velha que o prazo
    tabelas.set(schema.meetings, [{ ...REUNIAO, createdAt: AGORA - TTL_MS - 1 }]);
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recording).toBeNull();
    expect(dados?.recordingExpired).toBe(true);
  });

  it("reunião recente sem áudio não é confundida com expirada", async () => {
    const dados = await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(dados?.recordingExpired).toBe(false);
  });

  it("a leitura da gravação é ordenada: sem unique por reunião, a escolha não pode ficar ao acaso", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);
    await servico.getPrivateMeeting("dona-1", "reuniao-1");
    expect(ordenacoes.length).toBeGreaterThan(0);
  });
});

describe("Retenção — a varredura faz os 30 dias valerem sem depender de alguém abrir a tela", () => {
  it("apaga arquivo e linha das gravações vencidas", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA - 1)]);
    const resultado = await servico.limparGravacoesVencidas();
    expect(resultado).toEqual({ encontradas: 1, apagadas: 1 });
    expect(storageDelete).toHaveBeenCalledWith("meetings/dona-1/reuniao-1/recording_abc.webm");
    expect(tabelasApagadas()).toContain(schema.meetingRecordings);
  });

  it("bucket falhou: conta como não apagada e a linha permanece para a próxima rodada", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA - 1)]);
    storageDelete.mockRejectedValueOnce(new Error("bucket fora do ar"));
    const resultado = await servico.limparGravacoesVencidas();
    expect(resultado).toEqual({ encontradas: 1, apagadas: 0 });
    expect(tabelasApagadas()).not.toContain(schema.meetingRecordings);
  });

  it("a varredura filtra por expiresAt <= agora — não sai apagando a base inteira, nem o que ainda vale", async () => {
    tabelas.set(schema.meetingRecordings, []);
    const antes = Date.now();
    await servico.limparGravacoesVencidas();
    const depois = Date.now();
    const leitura = leituras.find(operacao => operacao.tabela === schema.meetingRecordings);
    expect(leitura?.sql).toBe("`meeting_recordings`.`expires_at` <= ?");
    expect(leitura?.params).toHaveLength(1);
    expect(Number(leitura?.params[0])).toBeGreaterThanOrEqual(antes);
    expect(Number(leitura?.params[0])).toBeLessThanOrEqual(depois);
  });
});

describe("Exclusão — apagar a reunião apaga a VOZ, não só a linha", () => {
  it("o arquivo de áudio sai do bucket", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);
    await servico.deletePrivateMeeting("dona-1", "reuniao-1");
    expect(storageDelete).toHaveBeenCalledWith("meetings/dona-1/reuniao-1/recording_abc.webm");
  });

  it("as TRADUÇÕES da transcrição também saem — senão o conteúdo sobrevive em nove idiomas", async () => {
    await servico.deletePrivateMeeting("dona-1", "reuniao-1");
    expect(tabelasApagadas()).toContain(schema.meetingTranscriptTranslations);
  });

  it("todo delete da exclusão — e a leitura das gravações — é da reunião DA dona: meeting_id E owner_id, em AND", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);
    await servico.deletePrivateMeeting("dona-1", "reuniao-1");

    // A leitura que diz onde o arquivo está: sem o owner_id, o áudio de uma
    // reunião com o mesmo id de outra dona sairia do bucket.
    expect(leituras.filter(operacao => operacao.tabela === schema.meetingRecordings).map(predicadoDe))
      .toEqual([derivadaDaReuniaoDaDona("meeting_recordings")]);

    const esperado = new Map<unknown, Predicado>([
      [schema.meetingContactSuggestions, derivadaDaReuniaoDaDona("meeting_contact_suggestions")],
      // Meu Network Inteligente: as pendências tiradas da reunião carregam trechos da transcrição.
      [schema.networkSugestoes, derivadaDaReuniaoDaDona("network_sugestoes")],
      [schema.meetingEntities, derivadaDaReuniaoDaDona("meeting_entities")],
      [schema.meetingTranscripts, derivadaDaReuniaoDaDona("meeting_transcripts")],
      [schema.meetingTranscriptTranslations, derivadaDaReuniaoDaDona("meeting_transcript_translations")],
      [schema.meetingRecordings, derivadaDaReuniaoDaDona("meeting_recordings")],
      [schema.meetings, REUNIAO_DA_DONA],
    ]);
    expect(delecoes).toHaveLength(esperado.size);
    for (const operacao of delecoes) {
      // `or` citaria as mesmas colunas e apagaria os derivados de TODAS as
      // reuniões da dona (ou a reunião de mesmo id de outra dona).
      expect(predicadoDe(operacao)).toEqual(esperado.get(operacao.tabela));
    }
  });

  it("o áudio sai ANTES da linha: é ela que diz onde o arquivo está", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const fonte = readFileSync(join(__dirname, "meeting-service.ts"), "utf8");
    // A lista do que sai mora em apagarDerivadosDaReuniao, compartilhada com a
    // compensação de processMeetingRecording.
    const corpo = fonte.slice(fonte.indexOf("async function apagarDerivadosDaReuniao"));
    const posicaoArquivo = corpo.indexOf("apagarArquivoDaGravacao");
    const posicaoLinha = corpo.indexOf("delete(meetingRecordings)");
    expect(posicaoArquivo).toBeGreaterThan(-1);
    expect(posicaoArquivo).toBeLessThan(posicaoLinha);
  });

  it("a reunião é marcada 'deleted' ANTES do primeiro delete: é o sinal que um processamento em curso lê", async () => {
    // Sem a marca, processMeetingRecording (1–2 min de Gemini e LLM) gravava
    // transcrição e sugestões DEPOIS da exclusão, órfãs e indexáveis pela
    // Memória. O UPDATE também substitui o SELECT de existência: zero linhas
    // é "não é dela".
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);

    await servico.deletePrivateMeeting("dona-1", "reuniao-1");

    expect(sequencia[0]).toBe("update");
    expect(atualizacoes[0].tabela).toBe(schema.meetings);
    expect(atualizacoes[0].valores).toMatchObject({ status: "deleted" });
    expect(typeof atualizacoes[0].valores.updatedAt).toBe("number");
    // id E owner_id, em AND: `or` marcaria 'deleted' toda reunião da dona
    expect(predicadoDe(atualizacoes[0])).toEqual(REUNIAO_DA_DONA);
    // e a linha da reunião só sai por último, depois dos derivados
    expect(sequencia.filter(operacao => operacao === "delete").length).toBe(7);
    expect(tabelasApagadas().at(-1)).toBe(schema.meetings);
  });

  it("falha no bucket não impede a reunião de ser excluída", async () => {
    tabelas.set(schema.meetingRecordings, [gravacaoCom(AGORA + 1000)]);
    storageDelete.mockRejectedValueOnce(new Error("bucket fora do ar"));
    await expect(servico.deletePrivateMeeting("dona-1", "reuniao-1")).resolves.toBe(true);
    expect(tabelasApagadas()).toContain(schema.meetings);
  });

  it("reunião de outra dona não apaga nada", async () => {
    tabelas.set(schema.meetings, []);
    expect(await servico.deletePrivateMeeting("dona-2", "reuniao-1")).toBe(false);
    expect(storageDelete).not.toHaveBeenCalled();
    expect(tabelasApagadas()).toHaveLength(0);
  });
});
