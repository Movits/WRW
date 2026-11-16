import { DrizzleQueryError, mapUpdateSet, type SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Assistente de Reuniões (etapa 3) — contratos da auditoria de 04/09 e da
 * reverificação do mesmo dia:
 *
 * 1. O cabeçalho do FileReader usa o tipo que o NAVEGADOR dá ao arquivo:
 *    um .mp4 chega como "data:video/mp4;base64,..." mesmo com a tela mandando
 *    mimeType audio/mp4, e um arquivo sem tipo vem como
 *    application/octet-stream. Só aceitar "data:audio/" recusava os dois
 *    como "áudio inválido" — arquivos que a tela aceita por extensão.
 * 2. Áudio recusado marca a reunião como FALHA (com o motivo): antes, a
 *    decodificação ficava fora do try e a reunião recém-criada ficava em
 *    "Gravação pendente" para sempre, sem erro e sem como tentar de novo.
 * 3. `processing_error` nunca guarda a mensagem do driver: ela é o INSERT
 *    inteiro com nome, telefone e e-mail das pessoas da reunião, e a tela a
 *    renderizava numa caixa vermelha.
 * 4. O que a IA devolve é cortado no tamanho das colunas antes do insert; em
 *    modo estrito, um telefone de 74 caracteres derrubava a reunião inteira
 *    depois de transcrição e extração já pagas.
 * 5. Excluída no meio do processamento, a reunião não ganha transcrição nem
 *    sugestões órfãs: o status é relido antes das escritas, e o UPDATE final
 *    para 'ready' só vale se a linha ainda estiver viva — senão o que foi
 *    gravado sai (compensação).
 * 6. A execução tem FICHA (reprocessamento de reunião com falha, 13/09): só
 *    toma a reunião que espera áudio ('recording'), e releitura, 'ready' e
 *    'failed' exigem 'processing' com o updated_at que ela gravou. Quem tomou
 *    a reunião depois (reprocessamento novo, varredura de interrompidas) vence,
 *    e a execução velha sai sem escrever nada.
 */

const atualizacoes: Array<Record<string, unknown>> = [];
// O WHERE de cada SELECT, UPDATE e DELETE, renderizado pelo dialeto do MySQL
// (sem banco): o fake não executa o predicado, então o escopo por dona e o
// `status <> 'deleted'` só se provam olhando para o SQL E os parâmetros. Uma
// lista de colunas não bastava — `and`→`or` e `<>`→`=` citam as mesmas
// colunas (padrão de memoria-orfaos-e-resiliencia).
type Predicado = { sql: string; params: unknown[] };
const dialeto = new MySqlDialect();
const renderizar = (condicao?: SQL): Predicado => {
  const { sql, params } = condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] };
  return { sql, params };
};
const escopos: Predicado[] = [];
const leituras: Array<{ tabela: unknown } & Predicado> = [];
// `noDuplicado`: o set do onDuplicateKeyUpdate, como o Drizzle o monta para o
// banco; ausente no insert que não o usa.
const insercoes: Array<{ tabela: unknown; valores: Record<string, unknown>[]; noDuplicado?: Predicado }> = [];
const delecoes: Array<{ tabela: unknown } & Predicado> = [];
const REUNIAO_DA_DONA = { sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ?)", params: ["reuniao-1", "dona-1"] };
// A falha da decodificação e a tomada só valem para a reunião que ainda espera áudio.
const REUNIAO_DA_DONA_ESPERANDO_AUDIO = { sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ? and `meetings`.`status` = ?)", params: ["reuniao-1", "dona-1", "recording"] };
// 'ready' e 'failed' só valem para a reunião ainda DESTA execução: 'processing' + a ficha.
const REUNIAO_DA_DONA_COM_FICHA = (ficha: unknown) => ({
  sql: "(`meetings`.`id` = ? and `meetings`.`owner_id` = ? and `meetings`.`status` = ? and `meetings`.`updated_at` = ?)",
  params: ["reuniao-1", "dona-1", "processing", ficha],
});
const derivadaDaReuniaoDaDona = (tabela: string) => ({ sql: `(\`${tabela}\`.\`meeting_id\` = ? and \`${tabela}\`.\`owner_id\` = ?)`, params: ["reuniao-1", "dona-1"] });
const reuniao = { id: "reuniao-1", ownerId: "dona-1", consentGranted: true, status: "recording", updatedAt: 1_000 };
// A linha viva da reunião: todo UPDATE aceito em `meetings` é aplicado nela, e
// a releitura devolve o status e o updated_at que a execução gravou.
let reuniaoNoBanco: Record<string, unknown> = { ...reuniao };
// O que cada SELECT em `meetings` devolve, em ordem (1ª: entrada; 2ª: releitura
// antes das escritas; 3ª: releitura depois de um 'ready' com 0 linhas). `null`
// ou fila vazia: a linha viva acima.
const reunioesPorLeitura: Array<Record<string, unknown>[] | null> = [];
// Linhas afetadas que o fake responde a cada UPDATE, em ordem (o mysql2 devolve
// [ResultSetHeader, campos]). Fila vazia: 1.
const linhasAfetadasPorUpdate: number[] = [];
// Tabela cujo INSERT o banco recusa, e com qual erro.
let recusarInsert: ((tabela: unknown) => Error | null) | null = null;
let respostaDaIA: { entities: unknown[]; contacts: unknown[] } = { entities: [], contacts: [] };
let falhaDaIA: Error | null = null;

const schema = await import("../drizzle/schema");

vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => ({
    select: () => ({ from: (tabela: unknown) => ({ where: (condicao?: SQL) => {
      leituras.push({ tabela, ...renderizar(condicao) });
      // A gravação que a execução inseriu é a que a compensação lê para tirar
      // o arquivo do bucket (as outras tabelas voltam vazias).
      const linhas = tabela === schema.meetings
        ? (reunioesPorLeitura.shift() ?? [{ ...reuniaoNoBanco }])
        : tabela === schema.meetingRecordings
          ? insercoes.filter(operacao => operacao.tabela === schema.meetingRecordings).flatMap(operacao => operacao.valores)
          : [];
      return { limit: async () => linhas, then: (resolver: (valor: unknown) => unknown) => resolver(linhas) };
    } }) }),
    update: (tabela: unknown) => ({ set: (valores: Record<string, unknown>) => ({ where: async (condicao?: SQL) => {
      atualizacoes.push(valores); escopos.push(renderizar(condicao));
      const afetadas = linhasAfetadasPorUpdate.shift() ?? 1;
      if (afetadas && tabela === schema.meetings) Object.assign(reuniaoNoBanco, valores);
      return [{ affectedRows: afetadas }];
    } }) }),
    // Preguiçoso como o builder do Drizzle: grava ao ser aguardado, ou pelo
    // onDuplicateKeyUpdate do contador de minutos (registrarConsumoDeMinutos) e
    // do pedido do resumo guardado. O set do conflito fica registrado, para o
    // teste ver o que ele faria com a linha que já existe.
    insert: (tabela: unknown) => ({ values: (valores: Record<string, unknown> | Record<string, unknown>[]) => {
      const insercao: (typeof insercoes)[number] = { tabela, valores: Array.isArray(valores) ? valores : [valores] };
      const gravar = async () => {
        const erro = recusarInsert?.(tabela);
        if (erro) throw erro;
        insercoes.push(insercao);
      };
      return {
        then: (ok: (valor: unknown) => unknown, falha: (erro: unknown) => unknown) => gravar().then(ok, falha),
        onDuplicateKeyUpdate: ({ set }: { set: Record<string, unknown> }) => {
          insercao.noDuplicado = renderizar(dialeto.buildUpdateSet(tabela as MySqlTable, mapUpdateSet(tabela as MySqlTable, set)));
          return gravar();
        },
      };
    } }),
    delete: (tabela: unknown) => ({ where: async (condicao?: SQL) => { delecoes.push({ tabela, ...renderizar(condicao) }); } }),
  }),
}));
const storagePut = vi.fn(async () => ({ key: "k", url: "/manus-storage/k" }));
const storageDelete = vi.fn(async () => {});
// O áudio de reunião sai do bucket com todas as versões (storageApagarTodasAsVersoes).
const apagarAudio = vi.fn(async (_chave: string) => {});
vi.mock("./storage", async importOriginal => ({
  ...await importOriginal<typeof import("./storage")>(),
  storagePut: (...args: unknown[]) => storagePut(...(args as [])),
  storageDelete: (...args: unknown[]) => storageDelete(...(args as [])),
  storageApagarTodasAsVersoes: (...args: unknown[]) => apagarAudio(...(args as [string])),
  storageGetBytes: async () => { throw new Error("o envio original nunca lê o áudio de volta do bucket"); },
  storageGetSignedUrl: async () => "https://assinada",
}));
let falhaDoGemini: Error | null = null;
// O que o Gemini "ouviu". Telefone e e-mail da sugestão só passam se a
// transcrição os sustenta (spec da Glenda de 14/09, item 6: QUEM SOU não se
// inventa) — por isso os testes de fronteira põem os valores na fala.
let textoDaTranscricao = "transcrição";
// As CLASSES de erro vêm do módulo real: meeting-service faz `instanceof
// GeminiIndisponivelError` para decidir o que passa inteiro para a tela, e um
// dublê com classes próprias provaria o instanceof contra a classe errada.
vi.mock("./gemini", async importOriginal => ({
  ...await importOriginal<typeof import("./gemini")>(),
  transcribeWithGemini: async () => {
    if (falhaDoGemini) throw falhaDoGemini;
    return { text: textoDaTranscricao, segments: [], language: "pt" };
  },
  embedWithGemini: async () => [], embedManyWithGemini: async () => [],
}));
vi.mock("./_core/llm", () => ({
  invokeLLM: async () => {
    if (falhaDaIA) throw falhaDaIA;
    return { choices: [{ message: { content: JSON.stringify(respostaDaIA) } }] };
  },
}));
// Os bytes daqui são texto, não áudio: a medição (provada em
// duracao-do-audio.test.ts com contêineres de verdade) é dublada.
let duracaoMedida: number | null = 30;
vi.mock("./duracao-do-audio", () => ({ medirDuracaoDoAudio: () => duracaoMedida }));

const { decodeMeetingAudio, processMeetingRecording, LIMITE_SUGESTAO, LIMITE_VALOR_NORMALIZADO, ReuniaoForaDoEstado, ReuniaoTomadaPorOutraExecucao, MENSAGEM_DURACAO_ILEGIVEL, MENSAGEM_REUNIAO_LONGA_DEMAIS } = await import("./meeting-service");
const { MENSAGEM_ERRO_DE_CONSULTA } = await import("./banco-indisponivel");
const { GeminiCotaEsgotadaError, GeminiRecusouChamadaError } = await import("./gemini");

const base64 = (texto: string) => Buffer.from(texto).toString("base64");
const entradaValida = {
  meetingId: "reuniao-1", ownerId: "dona-1", mimeType: "audio/mp4",
  audioBase64: `data:video/mp4;base64,${base64("reuniao em mp4")}`, durationSeconds: 30, language: "pt",
} as const;
const ana = { fullName: "Ana Souza", jobTitle: "Diretora", company: "Vinhos do Sul", phone: "+55 11 99999-9999", email: "ana@vinhosdosul.com", confidence: 0.9 };
const tabelasInseridas = () => insercoes.map(operacao => operacao.tabela);
const tabelasApagadas = () => delecoes.map(operacao => operacao.tabela);
const leiturasDe = (tabela: unknown) => leituras.filter(operacao => operacao.tabela === tabela).map(({ sql, params }) => ({ sql, params }));
// A ficha que a execução gravou ao tomar a reunião.
const fichaGravada = () => atualizacoes.find(a => a.status === "processing")?.updatedAt;

beforeEach(() => {
  atualizacoes.length = 0; escopos.length = 0; leituras.length = 0; insercoes.length = 0; delecoes.length = 0;
  reunioesPorLeitura.length = 0;
  linhasAfetadasPorUpdate.length = 0;
  reuniaoNoBanco = { ...reuniao };
  recusarInsert = null;
  respostaDaIA = { entities: [], contacts: [] };
  falhaDaIA = null;
  falhaDoGemini = null;
  // O nome da sugestão também precisa estar na fala (nomeSustentadoPelaTranscricao).
  textoDaTranscricao = "transcrição: conversa com a Ana Souza";
  duracaoMedida = 30;
  storagePut.mockReset();
  storagePut.mockImplementation(async () => ({ key: "k", url: "/manus-storage/k" }));
  storageDelete.mockClear();
  apagarAudio.mockReset();
  apagarAudio.mockImplementation(async () => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("decodeMeetingAudio — o cabeçalho vem do navegador, não da tela", () => {
  it("aceita .mp4 que o navegador tipa como video/mp4, com a tela mandando audio/mp4", () => {
    const audio = decodeMeetingAudio(`data:video/mp4;base64,${base64("reuniao em mp4")}`, "audio/mp4");
    expect(audio.toString()).toBe("reuniao em mp4");
  });

  it("aceita .webm tipado como video/webm e arquivo sem tipo (application/octet-stream)", () => {
    expect(decodeMeetingAudio(`data:video/webm;codecs=vp8,opus;base64,${base64("webm")}`, "audio/webm").toString()).toBe("webm");
    expect(decodeMeetingAudio(`data:application/octet-stream;base64,${base64("sem tipo")}`, "audio/webm").toString()).toBe("sem tipo");
  });

  it("continua recusando o que não é base64 e o mimeType fora da lista", () => {
    expect(() => decodeMeetingAudio("data:video/mp4;base64,isto não é base64!", "audio/mp4")).toThrow("Arquivo de áudio inválido.");
    expect(() => decodeMeetingAudio(base64("x"), "video/mp4")).toThrow("Formato de áudio");
  });
});

describe("processMeetingRecording — áudio recusado vira reunião com falha, não pendente para sempre", () => {
  it("marca status=failed com o motivo e não toca o storage", async () => {
    await expect(processMeetingRecording({
      meetingId: "reuniao-1", ownerId: "dona-1", mimeType: "audio/mp4",
      audioBase64: "data:video/mp4;base64,isto não é base64!", durationSeconds: 30, language: "pt",
    })).rejects.toThrow("Arquivo de áudio inválido.");

    expect(storagePut).not.toHaveBeenCalled();
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]).toMatchObject({ status: "failed", processingError: "Arquivo de áudio inválido." });
    // A falha é gravada NA reunião DA dona, e só se ela ainda espera áudio:
    // id + owner_id + status = 'recording', todos em AND. Um reenvio com áudio
    // ruim não rebaixa reunião pronta nem ressuscita excluída. O fake ignora o
    // predicado, então ele é conferido renderizado.
    expect(escopos[0]).toEqual(REUNIAO_DA_DONA_ESPERANDO_AUDIO);
    // e a leitura de entrada já era da reunião DA dona
    expect(leiturasDe(schema.meetings)).toEqual([REUNIAO_DA_DONA]);
  });

  it("formato fora da lista também marca a falha", async () => {
    await expect(processMeetingRecording({
      meetingId: "reuniao-1", ownerId: "dona-1", mimeType: "video/mp4",
      audioBase64: base64("x"), durationSeconds: 30, language: "pt",
    })).rejects.toThrow("Formato de áudio");
    expect(atualizacoes[0]).toMatchObject({ status: "failed" });
    expect(String(atualizacoes[0].processingError)).toContain("Formato de áudio");
  });

  it("áudio válido segue o caminho normal: processing → ready", async () => {
    await expect(processMeetingRecording(entradaValida)).resolves.toMatchObject({ transcript: "transcrição: conversa com a Ana Souza" });
    expect(storagePut).toHaveBeenCalledTimes(1);
    expect(atualizacoes.map(a => a.status)).toEqual(["processing", "ready"]);
    // A tomada só vale para a reunião da dona que espera áudio; o 'ready', só
    // para a que ainda é desta execução: 'processing' + a ficha gravada na tomada.
    const ficha = fichaGravada();
    expect(Number(ficha)).toBeGreaterThan(reuniao.updatedAt);
    expect(escopos).toEqual([REUNIAO_DA_DONA_ESPERANDO_AUDIO, REUNIAO_DA_DONA_COM_FICHA(ficha)]);
    // As duas leituras de meetings (entrada e releitura antes das escritas)
    // são da reunião DA dona.
    expect(leiturasDe(schema.meetings)).toEqual([REUNIAO_DA_DONA, REUNIAO_DA_DONA]);
  });

  it("a duração que vale é a MEDIDA nos bytes: declarada 30 s e medida 25 min recusa, marca a falha e não chega ao bucket nem à IA", async () => {
    duracaoMedida = 25 * 60;
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow(MENSAGEM_REUNIAO_LONGA_DEMAIS);
    expect(storagePut).not.toHaveBeenCalled();
    expect(insercoes).toEqual([]);
    expect(atualizacoes).toEqual([expect.objectContaining({ status: "failed", processingError: MENSAGEM_REUNIAO_LONGA_DEMAIS })]);
    expect(escopos[0]).toEqual(REUNIAO_DA_DONA_ESPERANDO_AUDIO);
  });

  it("sem duração legível nos bytes: recusa com a frase para a dona, em vez de assumir um valor", async () => {
    duracaoMedida = null;
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow(MENSAGEM_DURACAO_ILEGIVEL);
    expect(storagePut).not.toHaveBeenCalled();
    expect(atualizacoes).toEqual([expect.objectContaining({ status: "failed", processingError: MENSAGEM_DURACAO_ILEGIVEL })]);
  });

  it("até 5 s acima dos 10 minutos passa (o gravador fecha o contêiner depois do relógio); gravação, transcrição e contador levam a duração medida", async () => {
    duracaoMedida = 603.4;
    await processMeetingRecording(entradaValida);
    const valoresDe = (tabela: unknown) => insercoes.filter(operacao => operacao.tabela === tabela).flatMap(operacao => operacao.valores);
    expect(valoresDe(schema.meetingRecordings)).toEqual([expect.objectContaining({ durationSeconds: 603 })]);
    expect(valoresDe(schema.meetingTranscripts)).toEqual([expect.objectContaining({ durationSeconds: 603 })]);
    expect(valoresDe(schema.consumoDeMinutos)).toEqual([expect.objectContaining({ origem: "reuniao", referencia: "reuniao-1", segundos: 603 })]);
  });

  it("a reunião que fica pronta ganha o pedido do resumo guardado (H4c): pendente, da dona e da transcrição gravada", async () => {
    await processMeetingRecording(entradaValida);
    const valoresDe = (tabela: unknown) => insercoes.filter(operacao => operacao.tabela === tabela).flatMap(operacao => operacao.valores);
    const [transcricao] = valoresDe(schema.meetingTranscripts);
    expect(valoresDe(schema.meetingSummaries)).toEqual([expect.objectContaining({
      meetingId: "reuniao-1", ownerId: "dona-1", status: "pending", transcriptId: transcricao.id,
    })]);
    expect(String(transcricao.id)).toMatch(/^[0-9a-f-]{36}$/);
    // Idempotente: no conflito com a linha que já existir (índice único da
    // reunião), o banco executa meeting_id = meeting_id, e a linha fica como está.
    const [pedido] = insercoes.filter(operacao => operacao.tabela === schema.meetingSummaries);
    expect(pedido.noDuplicado).toEqual({ sql: "`meeting_id` = `meeting_summaries`.`meeting_id`", params: [] });
  });

  it("o pedido do resumo é escrita da ficha, antes do 'ready': banco fora do ar nele vira falha, e a reunião não fica pronta sem o resumo", async () => {
    recusarInsert = tabela => tabela === schema.meetingSummaries
      ? new DrizzleQueryError("insert into `meeting_summaries` (`id`, `owner_id`) values (?, ?)", ["uuid", "dona-1"],
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" }))
      : null;
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow();
    expect(atualizacoes.map(a => a.status)).toEqual(["processing", "failed"]);
  });

  it("o 'ready' grava processing_error null: reunião pronta nunca carrega motivo de falha", async () => {
    await processMeetingRecording(entradaValida);
    const pronta = atualizacoes.find(a => a.status === "ready")!;
    expect(pronta).toHaveProperty("processingError", null);
  });

  it("reunião que já recebeu áudio (a tomada afeta 0 linhas): ReuniaoForaDoEstado antes do upload e da IA", async () => {
    linhasAfetadasPorUpdate.push(0);
    await expect(processMeetingRecording(entradaValida)).rejects.toBeInstanceOf(ReuniaoForaDoEstado);
    expect(storagePut).not.toHaveBeenCalled();
    expect(insercoes).toEqual([]);
    expect(atualizacoes.map(a => a.status)).toEqual(["processing"]);
    expect(escopos).toEqual([REUNIAO_DA_DONA_ESPERANDO_AUDIO]);
  });

  it("a gravação nasce com o prazo de 30 dias contado da tomada", async () => {
    await processMeetingRecording(entradaValida);
    const [gravacao] = insercoes.find(operacao => operacao.tabela === schema.meetingRecordings)!.valores;
    expect(gravacao.expiresAt).toBe(Number(fichaGravada()) + 30 * 24 * 60 * 60 * 1000);
  });
});

describe("processMeetingRecording — o contador de minutos é gravado antes do 'ready'", () => {
  it("banco fora do ar ao gravar o consumo: a reunião não fica pronta sem a linha do contador — vira falha, e o reprocessamento conta", async () => {
    // Pronta, ela não se reprocessaria, e resumoDeMinutos subcontaria o mês para sempre.
    recusarInsert = tabela => tabela === schema.consumoDeMinutos
      ? new DrizzleQueryError("insert into `consumo_de_minutos` (`id`, `owner_id`) values (?, ?)", ["uuid", "dona-1"],
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3306"), { code: "ECONNREFUSED" }))
      : null;
    await expect(processMeetingRecording(entradaValida)).rejects.toBeInstanceOf(DrizzleQueryError);
    expect(atualizacoes.map(a => a.status)).toEqual(["processing", "failed"]);
    expect(escopos[1]).toEqual(REUNIAO_DA_DONA_COM_FICHA(fichaGravada()));
    expect(tabelasInseridas()).not.toContain(schema.consumoDeMinutos);
  });

  it("erro do contador com o banco de pé (bug nosso, não queda): a reunião pronta não vira erro na tela, e o motivo fica no log", async () => {
    recusarInsert = tabela => tabela === schema.consumoDeMinutos
      ? Object.assign(new Error("Table 'consumo_de_minutos' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 })
      : null;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(processMeetingRecording(entradaValida)).resolves.toBeTruthy();
    expect(atualizacoes.map(a => a.status)).toEqual(["processing", "ready"]);
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining("contador de minutos"), expect.stringContaining("consumo_de_minutos"));
  });
});

describe("processMeetingRecording — processing_error é texto para a dona, nunca o SQL do driver", () => {
  it("erro do driver no insert das sugestões: a tela recebe a frase neutra, sem 'Failed query' nem o e-mail de ninguém", async () => {
    respostaDaIA = { entities: [], contacts: [ana] };
    // O mesmo erro que o drizzle-orm 0.44 embrulha: a mensagem carrega o SQL e
    // os parâmetros — os dados pessoais extraídos da reunião.
    recusarInsert = tabela => tabela === schema.meetingContactSuggestions
      ? new DrizzleQueryError(
          "insert into `meeting_contact_suggestions` (`id`, `full_name`, `phone`, `email`) values (?, ?, ?, ?)",
          ["uuid", ana.fullName, ana.phone, ana.email],
          Object.assign(new Error("Data too long for column 'phone' at row 1"), { code: "ER_DATA_TOO_LONG", errno: 1406 }),
        )
      : null;

    await expect(processMeetingRecording(entradaValida)).rejects.toBeInstanceOf(DrizzleQueryError);

    const falha = atualizacoes.find(a => a.status === "failed");
    expect(falha?.processingError).toBe(MENSAGEM_ERRO_DE_CONSULTA);
    expect(String(falha?.processingError)).not.toContain("Failed query");
    expect(String(falha?.processingError)).not.toContain(ana.email);
    expect(String(falha?.processingError)).not.toContain(ana.phone);
    // O detalhe vai ao log do servidor — com o SQL, sem os parâmetros.
    const registros = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(registros).toContain("Failed query");
    expect(registros).not.toContain(ana.email);
  });

  it("GeminiIndisponivelError (cota esgotada, chamada recusada) continua inteiro: a frase já é para a dona", async () => {
    falhaDoGemini = new GeminiCotaEsgotadaError();
    await expect(processMeetingRecording(entradaValida)).rejects.toBe(falhaDoGemini);
    expect(atualizacoes.find(a => a.status === "failed")?.processingError).toMatch(/^O limite de uso gratuito do serviço de IA foi atingido/);

    atualizacoes.length = 0;
    falhaDoGemini = new GeminiRecusouChamadaError(401);
    await expect(processMeetingRecording(entradaValida)).rejects.toBe(falhaDoGemini);
    expect(atualizacoes.find(a => a.status === "failed")?.processingError).toBe("O serviço de IA recusou a chamada (HTTP 401). Avise o suporte.");
  });

  it("qualquer OUTRO erro da transcrição vira 'Não foi possível transcrever o áudio.': a chave ausente cita LLM_API_KEY, e isso é do log", async () => {
    falhaDoGemini = new Error("Chave do LLM não configurada. Defina LLM_API_KEY (ou GOOGLE_API_KEY) no ambiente.");
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Não foi possível transcrever o áudio.");
    const falha = atualizacoes.find(a => a.status === "failed");
    expect(falha?.processingError).toBe("Não foi possível transcrever o áudio.");
    expect(String(falha?.processingError)).not.toContain("LLM_API_KEY");
    // o original fica no log do servidor
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("LLM_API_KEY");
  });

  it("o bucket recusando o áudio vira 'Não foi possível guardar o áudio.', sem endpoint nem bucket na tela", async () => {
    storagePut.mockRejectedValueOnce(new Error("AccessDenied: bucket mmm-prod em s3.us-west-004.backblazeb2.com"));
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Não foi possível guardar o áudio.");
    const falha = atualizacoes.find(a => a.status === "failed");
    expect(falha?.processingError).toBe("Não foi possível guardar o áudio.");
    expect(String(falha?.processingError)).not.toContain("backblaze");
  });

  it("a IA fora do ar vira 'O serviço de IA não conseguiu extrair os dados da transcrição.', sem o JSON do provedor", async () => {
    falhaDaIA = new Error('LLM invoke failed: 503 {"error":{"message":"The model is overloaded"}}');
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("O serviço de IA não conseguiu extrair os dados da transcrição.");
    const falha = atualizacoes.find(a => a.status === "failed");
    expect(falha?.processingError).toBe("O serviço de IA não conseguiu extrair os dados da transcrição.");
    expect(String(falha?.processingError)).not.toContain("overloaded");
  });

  it("a falha só é gravada na reunião ainda desta execução: id, owner_id, 'processing' e a ficha, tudo em AND (não ressuscita excluída nem sobrescreve quem a tomou depois)", async () => {
    falhaDaIA = new Error("qualquer");
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow();
    const posicaoDaFalha = atualizacoes.findIndex(a => a.status === "failed");
    expect(escopos[posicaoDaFalha]).toEqual(REUNIAO_DA_DONA_COM_FICHA(fichaGravada()));
  });
});

describe("processMeetingRecording — o que a IA devolve cabe nas colunas", () => {
  it("telefone de 74 caracteres vira null, cargo/empresa são cortados em 200 e normalizedValue em 500", async () => {
    respostaDaIA = {
      entities: [{ type: "company", value: "Vinhos do Sul", normalizedValue: "n".repeat(600), confidence: 0.8 }],
      contacts: [{
        ...ana,
        jobTitle: "j".repeat(269),
        company: "c".repeat(250),
        phone: "+55 (11) 99999-9999 (celular) e +55 (11) 3333-3333 (escritório), WhatsApp",
        email: `${"a".repeat(330)}@vinhosdosul.com`,
      }],
    };

    await expect(processMeetingRecording(entradaValida)).resolves.toBeTruthy();

    const [sugestao] = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(sugestao.phone).toBeNull();
    expect(sugestao.email).toBeNull();
    expect(String(sugestao.jobTitle)).toHaveLength(LIMITE_SUGESTAO.jobTitle);
    expect(String(sugestao.company)).toHaveLength(LIMITE_SUGESTAO.company);
    expect(sugestao.fullName).toBe("Ana Souza");
    // dado extraído por IA nasce pendente
    expect(sugestao.status).toBe("pending");
    const [entidade] = insercoes.find(operacao => operacao.tabela === schema.meetingEntities)!.valores;
    expect(String(entidade.normalizedValue)).toHaveLength(LIMITE_VALOR_NORMALIZADO);
    expect(entidade.status).toBe("pending");
  });

  it("nome de 250 caracteres é cortado em 200 (full_name é varchar(200), e em modo estrito estourar é erro)", async () => {
    respostaDaIA = { entities: [], contacts: [{ ...ana, fullName: "A".repeat(250) }] };
    textoDaTranscricao = `Falei com ${"A".repeat(200)}.`;
    await expect(processMeetingRecording(entradaValida)).resolves.toBeTruthy();
    const [sugestao] = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(String(sugestao.fullName)).toHaveLength(LIMITE_SUGESTAO.fullName);
    expect(sugestao.fullName).toBe("A".repeat(200));
  });

  it("telefone e e-mail dentro do teto passam inteiros — o corte não é 'sempre null'", async () => {
    respostaDaIA = { entities: [], contacts: [ana] };
    textoDaTranscricao = `Sou a Ana Souza, meu telefone é ${ana.phone} e o e-mail ${ana.email}.`;
    await processMeetingRecording(entradaValida);
    const [sugestao] = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(sugestao).toMatchObject({ phone: ana.phone, email: ana.email, jobTitle: "Diretora", company: "Vinhos do Sul" });
  });

  it("telefone e e-mail que a transcrição NÃO sustenta ficam vazios: a IA não inventa o Quem Sou", async () => {
    respostaDaIA = { entities: [], contacts: [ana] };
    textoDaTranscricao = "Conversei com a Ana Souza sobre vinhos; ela passa o contato depois.";
    await processMeetingRecording(entradaValida);
    const [sugestao] = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(sugestao).toMatchObject({ fullName: "Ana Souza", phone: null, email: null });
  });

  it("nome também não se inventa: a fala diz só 'Carlos', o modelo devolve 'Carlos Mendes', e a sugestão grava 'Carlos'", async () => {
    respostaDaIA = { entities: [], contacts: [{ ...ana, fullName: "Carlos Mendes" }] };
    textoDaTranscricao = "Falei com o Carlos sobre o galpão.";
    await processMeetingRecording(entradaValida);
    const [sugestao] = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(sugestao.fullName).toBe("Carlos");
  });

  it("nome sem nenhuma palavra na fala: a pessoa não vira sugestão, nem as pendências de Tenho/Preciso dela", async () => {
    respostaDaIA = { entities: [], contacts: [{
      ...ana, fullName: "Carlos Mendes",
      oQueTenho: [{ texto: "Galpão em Curitiba", categoria: null, trecho: "um galpão em Curitiba", confianca: 0.9 }],
    }] };
    textoDaTranscricao = "A diretora tem um galpão em Curitiba.";
    await expect(processMeetingRecording(entradaValida)).resolves.toBeTruthy();
    expect(tabelasInseridas()).not.toContain(schema.meetingContactSuggestions);
    expect(tabelasInseridas()).not.toContain(schema.networkSugestoes);
    expect(atualizacoes.map(a => a.status)).toEqual(["processing", "ready"]);
  });

  it("na fronteira: empresa de exatamente 200 e e-mail de exatamente 320 passam inteiros; 201 e 321 não", async () => {
    const empresaNoTeto = "e".repeat(LIMITE_SUGESTAO.company);
    const emailNoTeto = `${"a".repeat(LIMITE_SUGESTAO.email - "@x.co".length)}@x.co`;
    expect(emailNoTeto).toHaveLength(LIMITE_SUGESTAO.email);
    respostaDaIA = { entities: [], contacts: [
      { ...ana, company: empresaNoTeto, email: emailNoTeto },
      { ...ana, fullName: "Bia", company: `${empresaNoTeto}X`, email: `a${emailNoTeto}` },
    ] };
    textoDaTranscricao = `Contatos da Ana Souza e da Bia: ${emailNoTeto} e a${emailNoTeto}.`;

    await processMeetingRecording(entradaValida);

    const [noTeto, acima] = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(noTeto.company).toBe(empresaNoTeto);
    expect(noTeto.email).toBe(emailNoTeto);
    // empresa é cortada (texto vale pela metade); e-mail acima do teto vira null
    expect(acima.company).toBe(empresaNoTeto);
    expect(acima.email).toBeNull();
  });

  it("sugestão sem nome (vazio ou só espaços) não entra: viraria 'Criar contato' sem ninguém para criar", async () => {
    respostaDaIA = { entities: [], contacts: [{ ...ana, fullName: "   " }, { ...ana, fullName: "" }, ana] };
    await processMeetingRecording(entradaValida);
    const inseridas = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(inseridas.map(sugestao => sugestao.fullName)).toEqual(["Ana Souza"]);
  });

  it("só sugestões sem nome: nenhum INSERT em meeting_contact_suggestions", async () => {
    respostaDaIA = { entities: [], contacts: [{ ...ana, fullName: " " }] };
    await expect(processMeetingRecording(entradaValida)).resolves.toBeTruthy();
    expect(tabelasInseridas()).not.toContain(schema.meetingContactSuggestions);
  });

  it("confidence que não é número ('alta', NaN) vira '0.000': o decimal(4,3) recusaria 'NaN', de novo a cada reprocessamento", async () => {
    respostaDaIA = {
      entities: [{ type: "person", value: "Ana", normalizedValue: null, confidence: "alta" }],
      contacts: [{ ...ana, confidence: Number.NaN }],
    };
    await expect(processMeetingRecording(entradaValida)).resolves.toBeTruthy();
    const [entidade] = insercoes.find(operacao => operacao.tabela === schema.meetingEntities)!.valores;
    const [sugestao] = insercoes.find(operacao => operacao.tabela === schema.meetingContactSuggestions)!.valores;
    expect(entidade.confidence).toBe("0.000");
    expect(sugestao.confidence).toBe("0.000");
  });
});

describe("processMeetingRecording — excluída no meio, a reunião não deixa órfãos", () => {
  it("status 'deleted' na releitura: nenhuma transcrição, entidade ou sugestão é gravada, e a gravação órfã sai", async () => {
    respostaDaIA = { entities: [], contacts: [ana] };
    reunioesPorLeitura.push([reuniao], [{ ...reuniao, status: "deleted" }]);

    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Reunião excluída durante o processamento.");

    // Só a gravação (inserida antes da transcrição) chegou ao banco…
    expect(tabelasInseridas()).toEqual([schema.meetingRecordings]);
    // …e a compensação a leva junto com as outras tabelas derivadas: o arquivo
    // sai do bucket com todas as versões, e só então a linha.
    expect(apagarAudio).toHaveBeenCalledWith("k");
    expect(tabelasApagadas()).toEqual(expect.arrayContaining([schema.meetingRecordings, schema.meetingTranscripts, schema.meetingContactSuggestions]));
    // Sem 'failed' (não há linha viva para marcar) e sem 'ready'.
    expect(atualizacoes.map(a => a.status)).toEqual(["processing"]);
  });

  it("o bucket recusa na compensação: a linha da gravação FICA, vencida, como ponteiro para a varredura", async () => {
    reunioesPorLeitura.push([reuniao], [{ ...reuniao, status: "deleted" }]);
    apagarAudio.mockRejectedValueOnce(new Error("B2 fora do ar"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Reunião excluída durante o processamento.");

    expect(tabelasApagadas()).not.toContain(schema.meetingRecordings);
    expect(atualizacoes.at(-1)).toEqual({ expiresAt: expect.any(Number) });
    const [gravacao] = insercoes.find(operacao => operacao.tabela === schema.meetingRecordings)!.valores;
    expect(escopos.at(-1)).toEqual({ sql: "(`meeting_recordings`.`owner_id` = ? and `meeting_recordings`.`id` in (?))", params: ["dona-1", gravacao.id] });
  });

  it("o banco recusa a linha da gravação depois do upload: o arquivo que subiu sai do bucket, senão ficaria lá sem ponteiro", async () => {
    recusarInsert = tabela => (tabela === schema.meetingRecordings ? new Error("Lock wait timeout exceeded") : null);

    await expect(processMeetingRecording(entradaValida)).rejects.toThrow();

    expect(apagarAudio).toHaveBeenCalledWith("k");
    expect(tabelasInseridas()).toEqual([]);
    // O expurgo deu certo: nenhum pedido de remoção manual.
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("remoção manual");
  });

  it("o banco recusa a linha E o bucket recusa a compensação: o erro do banco sobe, e o log de ERRO diz qual objeto ficou sem ponteiro", async () => {
    // Sem linha nenhuma, nem a varredura nem as exclusões acham o objeto: o log
    // é o único lugar que ainda diz qual chave precisa sair à mão.
    const recusaDoBanco = new Error("Lock wait timeout exceeded");
    recusarInsert = tabela => (tabela === schema.meetingRecordings ? recusaDoBanco : null);
    apagarAudio.mockRejectedValueOnce(new Error("socket hang up"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Lock wait timeout exceeded");

    expect(apagarAudio).toHaveBeenCalledWith("k");
    const pedido = vi.mocked(console.error).mock.calls.map(chamada => chamada.map(String).join(" ")).find(linha => linha.includes("remoção manual"));
    expect(pedido).toBeDefined();
    expect(pedido).toContain("SEM ponteiro");
    expect(pedido).toMatch(/remoção manual: k$/);
    expect(pedido).toContain("reuniao-1");
    expect(tabelasInseridas()).toEqual([]);
  });

  it("toda leitura é da reunião DA dona: a de entrada, a releitura antes das escritas e a das gravações na compensação", async () => {
    reunioesPorLeitura.push([reuniao], [{ ...reuniao, status: "deleted" }]);
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Reunião excluída durante o processamento.");

    expect(leiturasDe(schema.meetings)).toEqual([REUNIAO_DA_DONA, REUNIAO_DA_DONA]);
    // A compensação lê as gravações para achar o arquivo no bucket: sem o
    // owner_id, apagaria (ou listaria) o áudio de uma reunião com o mesmo id
    // de outra dona.
    expect(leiturasDe(schema.meetingRecordings)).toEqual([derivadaDaReuniaoDaDona("meeting_recordings")]);
  });

  it("linha ausente na releitura (exclusão já concluída) aborta do mesmo jeito", async () => {
    respostaDaIA = { entities: [], contacts: [ana] };
    reunioesPorLeitura.push([reuniao], []);
    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Reunião excluída durante o processamento.");
    expect(tabelasInseridas()).not.toContain(schema.meetingTranscripts);
    expect(tabelasInseridas()).not.toContain(schema.meetingContactSuggestions);
  });

  it("'failed' na releitura com outra ficha (a varredura deu a reunião como interrompida): a execução sai sem gravar transcrição, sem 'failed' e sem apagar nada — a reunião segue reprocessável", async () => {
    reunioesPorLeitura.push(null, [{ ...reuniao, status: "failed", processingError: "ERRO_INTERROMPIDO", updatedAt: 9_999_999_999_999 }]);
    await expect(processMeetingRecording(entradaValida)).rejects.toBeInstanceOf(ReuniaoTomadaPorOutraExecucao);
    expect(tabelasInseridas()).toEqual([schema.meetingRecordings]);
    expect(delecoes).toEqual([]);
    expect(atualizacoes.map(a => a.status)).toEqual(["processing"]);
  });

  it("'processing' na releitura com OUTRA ficha (um reprocessamento tomou a reunião): também sai sem escrever", async () => {
    reunioesPorLeitura.push(null, [{ ...reuniao, status: "processing", updatedAt: 9_999_999_999_999 }]);
    await expect(processMeetingRecording(entradaValida)).rejects.toBeInstanceOf(ReuniaoTomadaPorOutraExecucao);
    expect(tabelasInseridas()).toEqual([schema.meetingRecordings]);
    expect(atualizacoes.map(a => a.status)).toEqual(["processing"]);
  });

  it("UPDATE final para 'ready' sem linha afetada: a exclusão venceu entre a releitura e o fim — o que foi gravado sai, com meeting_id + owner_id", async () => {
    respostaDaIA = { entities: [{ type: "person", value: "Ana", normalizedValue: null, confidence: 0.9 }], contacts: [ana] };
    // A tomada passa; o 'ready' não afeta linha; e a releitura depois dele não
    // acha a reunião: a exclusão venceu.
    linhasAfetadasPorUpdate.push(1, 0);
    reunioesPorLeitura.push(null, null, []);

    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Reunião excluída durante o processamento.");

    expect(tabelasInseridas()).toEqual(expect.arrayContaining([schema.meetingTranscripts, schema.meetingEntities, schema.meetingContactSuggestions]));
    const derivadas = {
      meeting_contact_suggestions: schema.meetingContactSuggestions, network_sugestoes: schema.networkSugestoes,
      meeting_entities: schema.meetingEntities, meeting_transcripts: schema.meetingTranscripts, meeting_transcript_translations: schema.meetingTranscriptTranslations,
      meeting_summary_translations: schema.meetingSummaryTranslations, meeting_summary_items: schema.meetingSummaryItems, meeting_summaries: schema.meetingSummaries,
    };
    for (const [nome, tabela] of Object.entries(derivadas)) {
      const delecao = delecoes.find(operacao => operacao.tabela === tabela);
      expect(delecao, `compensação não apagou ${nome}`).toBeDefined();
      // meeting_id E owner_id, em AND — `or` apagaria os derivados de todas as reuniões da dona
      expect({ sql: delecao!.sql, params: delecao!.params }).toEqual(derivadaDaReuniaoDaDona(nome));
    }
    // A linha da gravação sai pelo id (e pela dona), só depois de o arquivo
    // sair do bucket; sem partes nesta reunião, não há DELETE de partes.
    const [gravacao] = insercoes.find(operacao => operacao.tabela === schema.meetingRecordings)!.valores;
    const delecaoDaGravacao = delecoes.find(operacao => operacao.tabela === schema.meetingRecordings);
    expect({ sql: delecaoDaGravacao!.sql, params: delecaoDaGravacao!.params })
      .toEqual({ sql: "(`meeting_recordings`.`owner_id` = ? and `meeting_recordings`.`id` in (?))", params: ["dona-1", gravacao.id] });
    expect(apagarAudio).toHaveBeenCalledWith("k");
    expect(delecoes).toHaveLength(Object.keys(derivadas).length + 1);
    // …e o áudio que a compensação lê para apagar o arquivo é o da dona.
    expect(leiturasDe(schema.meetingRecordings)).toEqual([derivadaDaReuniaoDaDona("meeting_recordings")]);
    expect(leiturasDe(schema.meetingAudioSlices)).toEqual([derivadaDaReuniaoDaDona("meeting_audio_slices")]);
    // O 'ready' só pode valer para a reunião ainda desta execução.
    const posicaoDoReady = atualizacoes.findIndex(a => a.status === "ready");
    expect(escopos[posicaoDoReady]).toEqual(REUNIAO_DA_DONA_COM_FICHA(fichaGravada()));
    expect(atualizacoes.map(a => a.status)).not.toContain("failed");
  });

  it("UPDATE final para 'ready' sem linha afetada e reunião VIVA com outra ficha: nada é apagado, nem o áudio, e não há 'failed' — quem tomou a reunião limpa antes de gravar", async () => {
    respostaDaIA = { entities: [], contacts: [ana] };
    linhasAfetadasPorUpdate.push(1, 0);
    reunioesPorLeitura.push(null, null, [{ ...reuniao, status: "processing", updatedAt: 9_999_999_999_999 }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(processMeetingRecording(entradaValida)).rejects.toBeInstanceOf(ReuniaoTomadaPorOutraExecucao);

    expect(delecoes).toEqual([]);
    expect(apagarAudio).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
    expect(atualizacoes.map(a => a.status)).toEqual(["processing", "ready"]);
  });

  it("UPDATE final para 'ready' sem linha afetada e a releitura acha a reunião ainda 'deleted' (a exclusão não terminou): compensa como exclusão, não como 'outra execução'", async () => {
    respostaDaIA = { entities: [{ type: "person", value: "Ana", normalizedValue: null, confidence: 0.9 }], contacts: [ana] };
    linhasAfetadasPorUpdate.push(1, 0);
    reunioesPorLeitura.push(null, null, [{ ...reuniao, status: "deleted" }]);

    await expect(processMeetingRecording(entradaValida)).rejects.toThrow("Reunião excluída durante o processamento.");

    // A gravação desta execução sai depois do arquivo; sem partes, não há DELETE de partes.
    expect(tabelasApagadas()).toEqual([
      schema.meetingContactSuggestions, schema.networkSugestoes, schema.meetingEntities, schema.meetingTranscripts,
      schema.meetingTranscriptTranslations, schema.meetingSummaryTranslations, schema.meetingSummaryItems, schema.meetingSummaries, schema.meetingRecordings,
    ]);
    expect(apagarAudio).toHaveBeenCalledWith("k");
    expect(atualizacoes.map(a => a.status)).not.toContain("failed");
  });
});
