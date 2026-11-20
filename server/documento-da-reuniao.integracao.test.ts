import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * A reunião que nasce de um documento (H12 e H12b) contra um banco real DE
 * TESTE: sem DATABASE_URL_TESTES se pula (server/test/setup-banco.ts). O bucket
 * e a IA são dublês; o que se prova é o caminho no banco:
 *
 * - o PDF (e as fotos, que chegam juntas num PDF) vira a transcrição, com as
 *   páginas, e a reunião segue o caminho de sempre até o resumo guardado;
 * - o arquivo fica 30 dias, como o áudio, e sai pela varredura, pela leitura
 *   vencida, pela exclusão da reunião e, quando o bucket recusa, fica como
 *   ponteiro vencido;
 * - a falha grava o código, e o reprocesso relê o PDF guardado;
 * - o link aberto mostra o texto, nunca o arquivo.
 */
const storagePut = vi.hoisted(() => vi.fn());
const storageApagarTodasAsVersoes = vi.hoisted(() => vi.fn());
const storageGetBytes = vi.hoisted(() => vi.fn());
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storagePut: (...a: unknown[]) => storagePut(...a),
  storageApagarTodasAsVersoes: (...a: unknown[]) => storageApagarTodasAsVersoes(...a),
  storageGetBytes: (...a: unknown[]) => storageGetBytes(...a),
  storageDelete: async () => { throw new Error("o arquivo da reunião não sai por storageDelete"); },
}));
// A leitura do PDF pela IA: dublada, com as classes de erro reais.
const gerarComArquivoNoGemini = vi.hoisted(() => vi.fn());
vi.mock("./gemini", async original => ({
  ...(await original<typeof import("./gemini")>()),
  gerarComArquivoNoGemini: (...a: unknown[]) => gerarComArquivoNoGemini(...a),
}));
// A extração (contatos e entidades) da transcrição: dublada no módulo da reunião.
const extrairDadosDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./meeting-service", async original => ({
  ...(await original<typeof import("./meeting-service")>()),
  extrairDadosDaReuniao: (...a: unknown[]) => extrairDadosDaReuniao(...a),
}));
// O resumo guardado e o mapa mental, que a fila do resumo gera depois.
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));
const gerarMapaMental = vi.hoisted(() => vi.fn());
vi.mock("./mapa-mental", async original => ({ ...(await original<typeof import("./mapa-mental")>()), gerarMapaMental: (...a: unknown[]) => gerarMapaMental(...a) }));

const { getDb } = await import("./db");
const { consumoDeMinutos, meetingDocuments, meetings, meetingSummaries, meetingSummaryItems, meetingTranscripts, users } = await import("../drizzle/schema");
const { iniciarDocumento, lerDocumentoGuardado, receberDocumento, RecusaDoDocumento } = await import("./documento-da-reuniao");
const { deletePrivateMeeting, getPrivateMeeting, iniciarReprocessamento, limparGravacoesVencidas, MEETING_AUDIO_TTL_MS } = await import("./meeting-service");
const { GeminiRespostaCortadaError } = await import("./gemini");
const { ObjetoAusenteNoStorageError } = await import("./storage");
const fila = await import("./fila-do-resumo");
const { resumoGuardadoDaDona } = await import("./resumo-guardado");
const { chaveDoAudioDoLink, verReuniaoPeloLink } = await import("./link-aberto-da-reuniao");
const { VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO } = await import("@shared/aviso-do-documento");

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-documento-${crypto.randomUUID()}`;
const DIA = 24 * 60 * 60_000;
async function db() { return (await getDb())!; }

/** Um PDF mínimo: o que importa ao servidor é o "%PDF-" do começo. */
const pdf = (conteudo = "documento de teste") => Buffer.from(`%PDF-1.4\n% ${conteudo}\n%%EOF\n`);
const PAGINAS = [
  { pagina: 1, texto: "Proposta de exportação de café para Lisboa." },
  { pagina: 2, texto: "" },
  { pagina: 3, texto: "Contato: Ana Souza, ana@exemplo.com." },
];
const leituraDa = (paginas: unknown) => ({ texto: JSON.stringify({ paginas }), modelo: "gemini-teste-1" });
const SEM_EXTRACAO = { entities: [], contacts: [] };
const ITENS = [
  { section: "decision", subject: null, text: "Mandar a proposta a Lisboa", assignee: null, due: null, excerpt: "Proposta de exportação de café para Lisboa", startSeconds: null, confidence: 0.9 },
] as const;
const RESUMO = { emoji: "📄", modelo: "gemini-teste-1", itens: ITENS, recebidos: 1 };

async function documentoDe(meetingId: string) {
  return (await (await db()).select().from(meetingDocuments).where(eq(meetingDocuments.meetingId, meetingId)))[0];
}
async function reuniaoDe(meetingId: string) {
  return (await (await db()).select().from(meetings).where(eq(meetings.id, meetingId)))[0];
}
const chavesExpurgadas = () => storageApagarTodasAsVersoes.mock.calls.map(chamada => chamada[0] as string);

/** Um documento recebido e lido até o fim. */
async function documentoPronto(origem: "pdf" | "foto" = "pdf", conteudo?: string) {
  const { id } = await iniciarDocumento(DONA, { title: "Documento", language: "pt-BR", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem });
  const recebido = await receberDocumento({ ownerId: DONA, meetingId: id, bytes: pdf(conteudo ?? id) });
  await recebido.trabalho;
  return id;
}

async function limparDaDona() {
  const banco = await db();
  for (const tabela of [meetingDocuments, meetingTranscripts, meetingSummaryItems, meetingSummaries, consumoDeMinutos, meetings] as const) {
    await banco.delete(tabela).where(eq(tabela.ownerId, DONA));
  }
}

describe.skipIf(!temBanco)("Reunião de documento no banco (integração)", () => {
  beforeAll(async () => {
    await (await db()).insert(users).values({ openId: DONA, name: "Dona do documento", email: `${DONA}@exemplo.com` });
  });
  afterAll(async () => {
    if (!(await getDb())) return;
    await limparDaDona();
    await (await db()).delete(users).where(eq(users.openId, DONA));
  });
  beforeEach(async () => {
    await limparDaDona();
    storagePut.mockReset();
    storagePut.mockImplementation(async (chave: string) => ({ key: chave, url: `/manus-storage/${chave}` }));
    storageApagarTodasAsVersoes.mockReset();
    storageApagarTodasAsVersoes.mockResolvedValue(undefined);
    storageGetBytes.mockReset();
    gerarComArquivoNoGemini.mockReset();
    gerarComArquivoNoGemini.mockResolvedValue(leituraDa(PAGINAS));
    extrairDadosDaReuniao.mockReset();
    extrairDadosDaReuniao.mockResolvedValue(SEM_EXTRACAO);
    gerarResumoDaReuniao.mockReset();
    gerarResumoDaReuniao.mockResolvedValue(RESUMO);
    gerarMapaMental.mockReset();
    gerarMapaMental.mockResolvedValue({ ramos: [{ rotulo: "Exportação", folhas: [] }] });
    fila.religarParaTestes();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a reunião nasce recebendo o documento, com o consentimento, a versão do aviso e a origem", async () => {
    const { id } = await iniciarDocumento(DONA, { title: "Contrato", language: "pt-BR", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem: "pdf" });
    const reuniao = await reuniaoDe(id);
    expect(reuniao).toMatchObject({
      status: "uploading", consentGranted: true, consentNoticeVersion: "documento-2026-11-19", origem: "pdf", audioPipeline: "single", language: "pt-BR",
    });
    expect(reuniao.consentAt).toBeGreaterThan(0);
  });

  it("o texto do PDF vira a transcrição, com as páginas, e a reunião segue até o resumo guardado", async () => {
    const id = await documentoPronto();
    // A leitura foi pedida com o PDF inteiro, como PDF, e com o teto do documento.
    const [pedido] = gerarComArquivoNoGemini.mock.calls[0];
    expect(pedido).toMatchObject({ mimeType: "application/pdf", tetoInlineBytes: 15_000_000, saidaMaxima: 65_536 });
    expect(Buffer.isBuffer(pedido.bytes) && pedido.bytes.subarray(0, 5).toString()).toBe("%PDF-");

    expect((await reuniaoDe(id)).status).toBe("ready");
    const [transcricao] = await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, id));
    expect(transcricao.transcript).toBe("Proposta de exportação de café para Lisboa.\n\nContato: Ana Souza, ana@exemplo.com.");
    // A página sem texto fica, vazia, para a numeração bater com a do PDF.
    expect(transcricao.segments).toEqual(PAGINAS);
    expect(transcricao.durationSeconds).toBe(0);
    expect(extrairDadosDaReuniao).toHaveBeenCalledWith(transcricao.transcript);
    // Documento não conta minutos de reunião.
    expect(await (await db()).select().from(consumoDeMinutos).where(eq(consumoDeMinutos.referencia, id))).toEqual([]);

    // O resumo guardado: o pedido nasce com a reunião pronta, e a fila o gera do texto do documento.
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(gerarResumoDaReuniao.mock.calls[0][0]).toMatchObject({ transcricao: transcricao.transcript, segmentos: [] });
    const resumo = await resumoGuardadoDaDona(DONA, id);
    expect(resumo.estado).toBe("pronto");
    expect(resumo.itens.map(item => item.text)).toEqual(["Mandar a proposta a Lisboa"]);
  });

  it("o arquivo fica guardado como o áudio: chave exata da dona, 30 dias, e a tela da dona recebe só a url do proxy", async () => {
    const antes = Date.now();
    const id = await documentoPronto();
    const documento = await documentoDe(id);
    expect(documento.storageKey).toMatch(new RegExp(`^meetings/${DONA}/${id}/documento-[0-9a-f]{8}\\.pdf$`));
    expect(documento.storageUrl).toBe(`/manus-storage/${documento.storageKey}`);
    expect(documento.mimeType).toBe("application/pdf");
    expect(documento.expiresAt).toBeGreaterThanOrEqual(antes + MEETING_AUDIO_TTL_MS);
    expect(documento.expiresAt).toBeLessThanOrEqual(Date.now() + MEETING_AUDIO_TTL_MS);
    expect(storagePut).toHaveBeenCalledWith(documento.storageKey, expect.any(Buffer), "application/pdf", { chaveExata: true });

    const tela = await getPrivateMeeting(DONA, id);
    expect(tela?.documento).toEqual({ url: documento.storageUrl, mimeType: "application/pdf", sizeBytes: documento.sizeBytes, expiresAt: documento.expiresAt });
    expect(tela?.recording).toBeNull();
    expect(tela?.meeting.origem).toBe("pdf");
    expect(JSON.stringify(tela)).not.toContain(`"storageKey"`);
  });

  it("as fotos de um texto chegam juntas num PDF e seguem o mesmo caminho, com a origem 'foto'", async () => {
    const id = await documentoPronto("foto");
    expect((await reuniaoDe(id)).origem).toBe("foto");
    expect((await reuniaoDe(id)).status).toBe("ready");
    expect(await documentoDe(id)).toBeTruthy();
  });

  it("o mesmo arquivo de novo não duplica; outro arquivo na mesma reunião é recusado", async () => {
    const { id } = await iniciarDocumento(DONA, { title: "D", language: "pt-BR", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem: "pdf" });
    const primeiro = await receberDocumento({ ownerId: DONA, meetingId: id, bytes: pdf("um") });
    await primeiro.trabalho;
    expect(await receberDocumento({ ownerId: DONA, meetingId: id, bytes: pdf("um") })).toEqual({ repetido: true, trabalho: null });
    const outro = await receberDocumento({ ownerId: DONA, meetingId: id, bytes: pdf("dois") }).catch(erro => erro);
    expect(outro).toBeInstanceOf(RecusaDoDocumento);
    expect(outro.codigo).toBe("CONTEUDO_DIFERENTE");
    expect(storagePut).toHaveBeenCalledTimes(1);
  });

  it("reunião de áudio, de outra dona ou já excluída não recebe documento; e o objeto que subiu sem linha sai do bucket", async () => {
    const audio = crypto.randomUUID();
    await (await db()).insert(meetings).values({ id: audio, ownerId: DONA, title: "Áudio", status: "recording", consentGranted: true, language: "pt-BR", createdAt: Date.now(), updatedAt: Date.now() });
    const recusa = await receberDocumento({ ownerId: DONA, meetingId: audio, bytes: pdf() }).catch(erro => erro);
    expect(recusa.codigo).toBe("FORA_DO_ESTADO");

    const { id } = await iniciarDocumento(DONA, { title: "D", language: "pt-BR", consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem: "pdf" });
    expect((await receberDocumento({ ownerId: "outra-dona", meetingId: id, bytes: pdf() }).catch(erro => erro)).codigo).toBe("SEM_REUNIAO");

    // A reunião é excluída enquanto o PDF sobe: a linha não entra, e o objeto sai.
    storagePut.mockImplementationOnce(async (chave: string) => {
      await (await db()).update(meetings).set({ status: "deleted" }).where(eq(meetings.id, id));
      return { key: chave, url: `/manus-storage/${chave}` };
    });
    expect((await receberDocumento({ ownerId: DONA, meetingId: id, bytes: pdf() }).catch(erro => erro)).codigo).toBe("SEM_REUNIAO");
    expect(await documentoDe(id)).toBeUndefined();
    expect(chavesExpurgadas()).toEqual([storagePut.mock.calls.at(-1)![0]]);
  });

  it("a falha grava o código (nunca frase), e o reprocesso relê o PDF guardado", async () => {
    gerarComArquivoNoGemini.mockRejectedValueOnce(new GeminiRespostaCortadaError("MAX_TOKENS"));
    const id = await documentoPronto();
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: "DOCUMENTO_LONGO_DEMAIS" });

    const documento = await documentoDe(id);
    storageGetBytes.mockResolvedValueOnce(pdf("o mesmo"));
    const { trabalho } = await iniciarReprocessamento(DONA, id);
    await trabalho;
    expect(storageGetBytes).toHaveBeenCalledWith(documento.storageKey, 15_000_000);
    expect(await reuniaoDe(id)).toMatchObject({ status: "ready", processingError: null });
    // Reprocessar não grava arquivo novo nem renova os 30 dias.
    expect(storagePut).toHaveBeenCalledTimes(1);
    expect((await documentoDe(id)).expiresAt).toBe(documento.expiresAt);
  });

  it("sem texto em página nenhuma é DOCUMENTO_SEM_TEXTO; o PDF que sumiu do bucket no reprocesso é DOCUMENTO_AUSENTE", async () => {
    gerarComArquivoNoGemini.mockResolvedValueOnce(leituraDa([{ pagina: 1, texto: "  " }]));
    const id = await documentoPronto();
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: "DOCUMENTO_SEM_TEXTO" });
    storageGetBytes.mockRejectedValueOnce(new ObjetoAusenteNoStorageError("sumiu"));
    await (await iniciarReprocessamento(DONA, id)).trabalho;
    expect(await reuniaoDe(id)).toMatchObject({ status: "failed", processingError: "DOCUMENTO_AUSENTE" });
  });

  it("a varredura tira o PDF vencido (com todas as versões, e só então a linha), e deixa o do prazo e o da reunião em leitura", async () => {
    const vencido = await documentoPronto("pdf", "vencido");
    const noPrazo = await documentoPronto("pdf", "no prazo");
    const lendo = await documentoPronto("pdf", "lendo");
    const banco = await db();
    await banco.update(meetingDocuments).set({ expiresAt: Date.now() - 1000 }).where(eq(meetingDocuments.meetingId, vencido));
    await banco.update(meetingDocuments).set({ expiresAt: Date.now() - 1000 }).where(eq(meetingDocuments.meetingId, lendo));
    await banco.update(meetings).set({ status: "processing" }).where(eq(meetings.id, lendo));
    const chaveVencida = (await documentoDe(vencido)).storageKey;

    const resultado = await limparGravacoesVencidas({ ownerId: DONA });
    expect(resultado).toEqual({ encontradas: 1, apagadas: 1 });
    expect(chavesExpurgadas()).toEqual([chaveVencida]);
    expect(await documentoDe(vencido)).toBeUndefined();
    expect(await documentoDe(noPrazo)).toBeTruthy();
    expect(await documentoDe(lendo)).toBeTruthy();
    // A transcrição fica até a dona excluir a reunião.
    expect(await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, vencido))).toHaveLength(1);
  });

  it("o bucket que recusa deixa a linha; a passada seguinte tenta de novo", async () => {
    const id = await documentoPronto();
    await (await db()).update(meetingDocuments).set({ expiresAt: Date.now() - 1000 }).where(eq(meetingDocuments.meetingId, id));
    storageApagarTodasAsVersoes.mockRejectedValueOnce(new Error("bucket fora"));
    expect(await limparGravacoesVencidas({ ownerId: DONA })).toEqual({ encontradas: 1, apagadas: 0 });
    expect(await documentoDe(id)).toBeTruthy();
    expect(await limparGravacoesVencidas({ ownerId: DONA })).toEqual({ encontradas: 1, apagadas: 1 });
    expect(await documentoDe(id)).toBeUndefined();
  });

  it("a leitura do PDF vencido o tira na hora e só então diz que saiu; com o bucket recusando, diz que está saindo", async () => {
    const id = await documentoPronto();
    const banco = await db();
    await banco.update(meetings).set({ createdAt: Date.now() - 40 * DIA }).where(eq(meetings.id, id));
    await banco.update(meetingDocuments).set({ expiresAt: Date.now() - 1000 }).where(eq(meetingDocuments.meetingId, id));
    storageApagarTodasAsVersoes.mockRejectedValueOnce(new Error("bucket fora"));
    expect(await getPrivateMeeting(DONA, id)).toMatchObject({ documento: null, documentoExpirado: false, documentoSaindo: true });
    expect(await documentoDe(id)).toBeTruthy();
    expect(await getPrivateMeeting(DONA, id)).toMatchObject({ documento: null, documentoExpirado: true, documentoSaindo: false });
    expect(await documentoDe(id)).toBeUndefined();
    // E a reunião de documento nunca diz que "a gravação foi apagada".
    expect(await getPrivateMeeting(DONA, id)).toMatchObject({ recording: null, recordingExpired: false, recordingDeletionPending: false, documentoExpirado: true });
  });

  it("excluir a reunião tira o PDF do bucket antes da linha; com o bucket recusando, a linha fica como ponteiro vencido para a varredura", async () => {
    const id = await documentoPronto();
    const chave = (await documentoDe(id)).storageKey;
    expect(await deletePrivateMeeting(DONA, id)).toBe(true);
    expect(chavesExpurgadas()).toEqual([chave]);
    expect(await documentoDe(id)).toBeUndefined();

    const outra = await documentoPronto("pdf", "outra");
    const outraChave = (await documentoDe(outra)).storageKey;
    storageApagarTodasAsVersoes.mockRejectedValueOnce(new Error("bucket fora"));
    expect(await deletePrivateMeeting(DONA, outra)).toBe(true);
    expect(await reuniaoDe(outra)).toBeUndefined();
    const ponteiro = await documentoDe(outra);
    expect(ponteiro.storageKey).toBe(outraChave);
    expect(ponteiro.expiresAt).toBeLessThanOrEqual(Date.now());
    // Sem a reunião, a varredura acha o ponteiro e o tira.
    expect(await limparGravacoesVencidas({ ownerId: DONA })).toEqual({ encontradas: 1, apagadas: 1 });
    expect(await documentoDe(outra)).toBeUndefined();
  });

  it("o link aberto mostra o texto e o resumo, como a transcrição de hoje, e nunca o arquivo", async () => {
    const id = await documentoPronto();
    const token = `t${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 32);
    await (await db()).update(meetings).set({ shareToken: token }).where(eq(meetings.id, id));
    const pagina = await verReuniaoPeloLink(token);
    expect(pagina.documento).toBe(true);
    expect(pagina.transcricao?.texto).toContain("Proposta de exportação de café");
    // As páginas não passam pelo contrato das falas: o link recebe só o texto corrido.
    expect(pagina.transcricao?.segmentos).toEqual([]);
    expect(pagina.gravacao).toBeNull();
    expect(pagina.gravacaoExpirada).toBe(false);
    const chave = (await documentoDe(id)).storageKey;
    expect(JSON.stringify(pagina)).not.toContain(chave);
    expect(JSON.stringify(pagina)).not.toContain("manus-storage");
    // E a rota do áudio do link não serve o PDF.
    expect(await chaveDoAudioDoLink(token)).toBeNull();
  });
it("o PDF guardado volta à dona para a tela mostrar as páginas; vencido, de outra dona, excluído ou fora do bucket, não", async () => {
    const id = await documentoPronto();
    const chave = (await documentoDe(id)).storageKey;
    storageGetBytes.mockResolvedValueOnce(pdf("guardado"));
    expect((await lerDocumentoGuardado(DONA, id))?.toString()).toBe(pdf("guardado").toString());
    expect(storageGetBytes).toHaveBeenLastCalledWith(chave, 15_000_000);

    storageGetBytes.mockClear();
    expect(await lerDocumentoGuardado("outra-dona", id)).toBeNull();
    expect(storageGetBytes).not.toHaveBeenCalled();

    storageGetBytes.mockRejectedValueOnce(new ObjetoAusenteNoStorageError("sumiu"));
    expect(await lerDocumentoGuardado(DONA, id)).toBeNull();

    storageGetBytes.mockRejectedValueOnce(new Error("bucket fora"));
    await expect(lerDocumentoGuardado(DONA, id)).rejects.toThrow("bucket fora");

    const banco = await db();
    await banco.update(meetingDocuments).set({ expiresAt: Date.now() - 1000 }).where(eq(meetingDocuments.meetingId, id));
    storageGetBytes.mockClear();
    expect(await lerDocumentoGuardado(DONA, id)).toBeNull();
    await banco.update(meetingDocuments).set({ expiresAt: Date.now() + DIA }).where(eq(meetingDocuments.meetingId, id));
    await banco.update(meetings).set({ status: "deleted" }).where(eq(meetings.id, id));
    expect(await lerDocumentoGuardado(DONA, id)).toBeNull();
    expect(storageGetBytes).not.toHaveBeenCalled();
  });
});
