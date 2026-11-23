import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Editar a transcrição (H18) contra um banco real DE TESTE (sem
 * DATABASE_URL_TESTES, se pula). A IA é dublê (o resumo e o mapa mental da
 * fila), e o que se prova é o banco:
 *
 * - a versão editada vale para todo leitor, a da IA fica guardada e volta;
 * - a revisão que a tela viu, a dona no WHERE, a reunião pronta, o documento;
 * - a auditoria na mesma transação, sem a fala; as traduções da versão
 *   anterior saem; o pedido que não muda nada não grava;
 * - o link aberto mostra a versão editada e nunca a da IA, nem pelo trecho de
 *   um item do resumo, nem na tradução do resumo;
 * - o resumo gravado antes da edição é de outra versão; "Refazer o resumo"
 *   refaz também o mapa; a edição no meio da geração devolve o resumo à fila;
 * - a busca entre reuniões, a lista, a exportação e a conferência das
 *   pendências da extração (com a versão da IA);
 * - a lixeira (H7d): a reunião que está lá não se edita (a guarda e a leitura
 *   travada do serviço), e a transcrição editada some com ela, volta com ela e
 *   sai de vez com ela, a versão da IA junto.
 */
const gerarResumoDaReuniao = vi.hoisted(() => vi.fn());
vi.mock("./resumo-da-reuniao", async original => ({ ...(await original<typeof import("./resumo-da-reuniao")>()), gerarResumoDaReuniao: (...a: unknown[]) => gerarResumoDaReuniao(...a) }));
const gerarMapaMental = vi.hoisted(() => vi.fn());
vi.mock("./mapa-mental", async original => ({ ...(await original<typeof import("./mapa-mental")>()), gerarMapaMental: (...a: unknown[]) => gerarMapaMental(...a) }));
// O e-mail automático do resumo (H22) nunca sai daqui.
vi.mock("./resumo-por-email", async original => ({ ...(await original<typeof import("./resumo-por-email")>()), envioAutomaticoDoResumo: async () => undefined }));
// A tradução do resumo (H11) é dublê: põe "EN " na frente de cada texto, mantendo as chaves.
const pedirJsonAIA = vi.hoisted(() => vi.fn());
vi.mock("./ia-em-json", async original => ({ ...(await original<typeof import("./ia-em-json")>()), pedirJsonAIA: (...a: unknown[]) => pedirJsonAIA(...a) }));
type PedidoDeTraducao = { usuario: string };
type EnviadoParaTraduzir = { itens: Array<{ chave: string; assunto: string | null; texto: string; prazo: string | null }>; rotulos: Array<{ chave: string; rotulo: string }> };
const paraIngles = async (pedido: PedidoDeTraducao) => {
  const { itens, rotulos } = JSON.parse(pedido.usuario.slice(pedido.usuario.indexOf("{"))) as EnviadoParaTraduzir;
  return {
    dados: {
      itens: itens.map(i => ({ chave: i.chave, assunto: i.assunto && `EN ${i.assunto}`, texto: `EN ${i.texto}`, prazo: i.prazo && `EN ${i.prazo}` })),
      rotulos: rotulos.map(r => ({ chave: r.chave, rotulo: `EN ${r.rotulo}` })),
    },
    modelo: "gemini-teste-1",
  };
};

const { createPrivateContact, getDb } = await import("./db");
const {
  auditLogs, meetings, meetingSummaries, meetingSummaryItems, meetingSummaryTranslations, meetingTranscriptTranslations, meetingTranscripts,
  networkSugestoes, platformNotifications, privateContacts, users,
} = await import("../drizzle/schema");
const { traduzirResumoPeloLink } = await import("./traducao-do-resumo");
const { appRouter } = await import("./routers");
const { editarTranscricao, RecusaDaEdicao } = await import("./editar-transcricao");
const { ligarLinkAberto, verReuniaoPeloLink } = await import("./link-aberto-da-reuniao");
const { resumoGuardadoPeloLink } = await import("./resumo-guardado");
const { decidirPendenciasDaPessoaSugerida } = await import("./network-extracao");
const fila = await import("./fila-do-resumo");
const { ACAO_TRANSCRICAO_EDITADA, EDICOES_POR_JANELA, RECUSAS_DA_EDICAO } = await import("@shared/editar-transcricao");
const { tetoDaEdicao } = await import("./routers/meetings");
type TrpcContext = import("./_core/context").TrpcContext;

const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-editar-${crypto.randomUUID()}`;
const OUTRA = `teste-editar-outra-${crypto.randomUUID()}`;
const ID_DA_DONA = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);

function contexto(openId: string, id = ID_DA_DONA): TrpcContext {
  return {
    user: { id, openId, role: "user", name: "Dona Teste", onboardingCompleted: true },
    req: { headers: { "user-agent": "vitest-editar-transcricao" }, ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const daDona = () => appRouter.createCaller(contexto(DONA));
const daOutra = () => appRouter.createCaller(contexto(OUTRA, ID_DA_DONA + 1));
async function db() { return (await getDb())!; }

// A Glenta é a Glenda que a IA ouviu errado; a Akme, a empresa como a IA a ouviu.
const FALAS = [
  { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia, aqui é a Glenta, diretora da Akme.", idioma: "pt-BR" },
  { inicio: 4, fim: 9, falante: "F2", texto: "Bom dia, Glenta. A proposta sai na sexta.", idioma: "pt-BR" },
  { inicio: 9, fim: 15, falante: "F1", texto: "Combinado. O telefone do escritório é 3333-4444.", idioma: "pt-BR" },
];
const TEXTO = FALAS.map(f => f.texto).join("\n");
const AGORA = () => Date.now();

async function reuniaoPronta(opcoes: { dona?: string; status?: "ready" | "processing" | "deleted"; origem?: "gravacao" | "pdf"; falas?: unknown; texto?: string } = {}) {
  const banco = await db();
  const meetingId = crypto.randomUUID();
  const transcricaoId = crypto.randomUUID();
  const dona = opcoes.dona ?? DONA;
  await banco.insert(meetings).values({
    id: meetingId, ownerId: dona, title: "Reunião da edição", status: opcoes.status ?? "ready", consentGranted: true, consentAt: AGORA(),
    language: "pt-BR", origem: opcoes.origem ?? "gravacao", audioPipeline: "slices", createdAt: AGORA(), updatedAt: AGORA(),
  });
  await banco.insert(meetingTranscripts).values({
    id: transcricaoId, meetingId, ownerId: dona, transcript: opcoes.texto ?? TEXTO, segments: opcoes.falas === undefined ? FALAS : opcoes.falas,
    language: "pt-BR", durationSeconds: 15, createdAt: AGORA(), updatedAt: 1000,
  });
  return { meetingId, transcricaoId };
}

/**
 * O resumo pronto, de antes da edição, com dois itens para conferir: o trecho
 * do segundo cita o telefone que a dona vai tirar da fala.
 */
async function resumoDeAntesDaEdicao(alvo: { meetingId: string; transcricaoId: string }) {
  const banco = await db();
  const resumoId = crypto.randomUUID();
  await banco.insert(meetingSummaries).values({
    id: resumoId, meetingId: alvo.meetingId, ownerId: DONA, transcriptId: alvo.transcricaoId, status: "ready", language: "pt-BR", version: 1,
    generatedAt: AGORA() - 60_000, createdAt: AGORA(), updatedAt: AGORA(),
  });
  const item = (posicao: number, texto: string, trecho: string) => ({
    id: crypto.randomUUID(), summaryId: resumoId, meetingId: alvo.meetingId, ownerId: DONA, section: "decision" as const, position: posicao,
    text: texto, excerpt: trecho, startSeconds: 4, confidence: "0.900", status: "pending" as const, createdAt: AGORA(), updatedAt: AGORA(),
  });
  await banco.insert(meetingSummaryItems).values([
    item(0, "A proposta sai na sexta", "A proposta sai na sexta"),
    item(1, "O telefone do escritório foi passado", "O telefone do escritório é 3333-4444"),
  ]);
  return resumoId;
}

const transcricaoDe = async (meetingId: string) => (await (await db()).select().from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, meetingId)))[0];
const auditoriasDe = async (meetingId: string) => (await db()).select().from(auditLogs)
  .where(and(eq(auditLogs.resourceId, meetingId), eq(auditLogs.action, ACAO_TRANSCRICAO_EDITADA)));

async function recusa(promessa: Promise<unknown>) {
  const erro = await promessa.then(() => null, e => e);
  expect(erro).toBeInstanceOf(TRPCError);
  return erro as TRPCError;
}

const editar = (alvo: { meetingId: string; transcricaoId: string }, revisao: number, operacao: Parameters<ReturnType<typeof daDona>["meetings"]["editarTranscricao"]>[0]["operacao"]) =>
  daDona().meetings.editarTranscricao({ ...alvo, revisao, operacao });

describe.skipIf(!temBanco)("Editar a transcrição (integração)", () => {
  beforeAll(async () => {
    await (await db()).insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
  });

  beforeEach(() => {
    gerarResumoDaReuniao.mockReset();
    gerarMapaMental.mockReset();
    fila.religarParaTestes();
  });

  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    const contas = await banco.select({ id: users.id }).from(users).where(inArray(users.openId, [DONA, OUTRA]));
    if (contas.length) await apagarPelaChave(banco, platformNotifications, inArray(platformNotifications.userId, contas.map(conta => conta.id)));
    await apagarPelaChave(banco, auditLogs, inArray(auditLogs.userId, [ID_DA_DONA, ID_DA_DONA + 1]));
    for (const dona of [DONA, OUTRA]) {
      await apagarPelaChave(banco, networkSugestoes, eq(networkSugestoes.ownerId, dona));
      await apagarPelaChave(banco, meetingSummaryTranslations, eq(meetingSummaryTranslations.ownerId, dona));
      await apagarPelaChave(banco, meetingSummaryItems, eq(meetingSummaryItems.ownerId, dona));
      await apagarPelaChave(banco, meetingSummaries, eq(meetingSummaries.ownerId, dona));
      await apagarPelaChave(banco, meetingTranscriptTranslations, eq(meetingTranscriptTranslations.ownerId, dona));
      await apagarPelaChave(banco, meetingTranscripts, eq(meetingTranscripts.ownerId, dona));
      await apagarPelaChave(banco, meetings, eq(meetings.ownerId, dona));
    }
    await banco.delete(privateContacts).where(inArray(privateContacts.ownerId, [DONA, OUTRA]));
    await banco.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });

  it("a dona corrige o texto de um trecho: a versão nova vale, a da IA fica guardada, a revisão sobe e a auditoria entra sem a fala", async () => {
    const alvo = await reuniaoPronta();
    const banco = await db();
    await banco.insert(meetingTranscriptTranslations).values({
      id: crypto.randomUUID(), meetingId: alvo.meetingId, ownerId: DONA, language: "en", translatedText: "Good morning, this is Glenta.", createdAt: AGORA(), updatedAt: AGORA(),
    });
    const antes = AGORA();

    const feita = await editar(alvo, 0, { tipo: "texto", indice: 0, texto: "Bom dia, aqui é a Glenda, diretora da Akme." });

    expect(feita).toEqual({ mudou: true, revisao: 1, editada: true, substituicoes: 0 });
    const linha = await transcricaoDe(alvo.meetingId);
    expect(linha.transcript).toBe(TEXTO.replace("aqui é a Glenta", "aqui é a Glenda"));
    // O resto do segmento (o tempo, a voz, o idioma da fala) fica como estava.
    expect((linha.segments as typeof FALAS)[0]).toEqual({ ...FALAS[0], texto: "Bom dia, aqui é a Glenda, diretora da Akme." });
    expect(linha.originalTranscript).toBe(TEXTO);
    expect(linha.originalSegments).toEqual(FALAS);
    expect(linha.revision).toBe(1);
    expect(Number(linha.editedAt)).toBeGreaterThanOrEqual(antes);
    // O updated_at muda a assinatura da Memória: a versão nova é indexada.
    expect(Number(linha.updatedAt)).toBe(Number(linha.editedAt));
    // A tradução era da versão anterior.
    expect(await banco.select().from(meetingTranscriptTranslations).where(eq(meetingTranscriptTranslations.meetingId, alvo.meetingId))).toEqual([]);

    const [auditoria] = await auditoriasDe(alvo.meetingId);
    expect(auditoria).toMatchObject({ userId: ID_DA_DONA, resource: "meetings", status: "success", riskLevel: "medium", ipAddress: "203.0.113.9", userAgent: "vitest-editar-transcricao" });
    expect(auditoria.details).toEqual({ operacao: "texto", trechos: 1, substituicoes: 0, revisao: 1, voltouAoOriginal: false });
    expect(JSON.stringify(auditoria.details)).not.toMatch(/Glend|Glent|Akme/);
  });

  it("trocar a voz, localizar e substituir, o detalhe da dona e voltar tudo ao original", async () => {
    const alvo = await reuniaoPronta();
    expect(await editar(alvo, 0, { tipo: "voz", indice: 1, falante: "F3" })).toMatchObject({ mudou: true, revisao: 1 });
    expect(await editar(alvo, 1, { tipo: "substituir", localizar: "glenta", substituirPor: "Glenda" })).toEqual({ mudou: true, revisao: 2, editada: true, substituicoes: 2 });

    const linha = await transcricaoDe(alvo.meetingId);
    expect((linha.segments as typeof FALAS).map(f => [f.falante, f.texto])).toEqual([
      ["F1", "Bom dia, aqui é a Glenda, diretora da Akme."], ["F3", "Bom dia, Glenda. A proposta sai na sexta."], ["F1", FALAS[2].texto],
    ]);
    // A versão da IA foi copiada uma vez só, na primeira edição.
    expect(linha.originalSegments).toEqual(FALAS);

    // O detalhe da dona: a versão editada, a revisão e, dos trechos mudados, o
    // que a IA tinha escrito. O texto original inteiro não vem.
    const detalhe = await daDona().meetings.get({ meetingId: alvo.meetingId });
    expect(detalhe.transcript?.transcript).toContain("Glenda");
    expect(detalhe.transcript).not.toHaveProperty("originalTranscript");
    expect(detalhe.transcript).not.toHaveProperty("originalSegments");
    expect(detalhe.transcript?.edicao).toMatchObject({
      revisao: 2, editada: true,
      originais: [{ indice: 0, texto: FALAS[0].texto, falante: "F1" }, { indice: 1, texto: FALAS[1].texto, falante: "F2" }],
    });
    expect((await daDona().meetings.list()).find(r => r.id === alvo.meetingId)?.transcricaoEditada).toBe(true);

    const volta = await editar(alvo, 2, { tipo: "restaurarTudo" });
    expect(volta).toEqual({ mudou: true, revisao: 3, editada: false, substituicoes: 0 });
    const devolvida = await transcricaoDe(alvo.meetingId);
    expect(devolvida).toMatchObject({ transcript: TEXTO, segments: FALAS, originalTranscript: null, originalSegments: null, revision: 3 });
    expect((await daDona().meetings.get({ meetingId: alvo.meetingId })).transcript?.edicao).toMatchObject({ editada: false, originais: [] });
    expect((await daDona().meetings.list()).find(r => r.id === alvo.meetingId)?.transcricaoEditada).toBe(false);
    expect((await auditoriasDe(alvo.meetingId)).map(a => (a.details as { operacao: string }).operacao).sort()).toEqual(["restaurarTudo", "substituir", "voz"]);
  });

  it("voltar um trecho ao original; com o último de volta, a transcrição deixa de estar editada", async () => {
    const alvo = await reuniaoPronta();
    await editar(alvo, 0, { tipo: "texto", indice: 2, texto: "Combinado." });
    expect(await editar(alvo, 1, { tipo: "restaurar", indice: 2 })).toEqual({ mudou: true, revisao: 2, editada: false, substituicoes: 0 });
    expect(await transcricaoDe(alvo.meetingId)).toMatchObject({ transcript: TEXTO, segments: FALAS, originalTranscript: null });
  });

  it("a revisão que a tela viu: a edição de outra aba, ou de outra transcrição, é recusada sem mudar nada", async () => {
    const alvo = await reuniaoPronta();
    await editar(alvo, 0, { tipo: "texto", indice: 0, texto: "Primeira aba." });
    const velha = await recusa(editar(alvo, 0, { tipo: "texto", indice: 1, texto: "Segunda aba." }));
    expect(velha).toMatchObject({ code: "CONFLICT", message: RECUSAS_DA_EDICAO.mudou });
    const outra = await recusa(editar({ meetingId: alvo.meetingId, transcricaoId: crypto.randomUUID() }, 1, { tipo: "texto", indice: 1, texto: "Outra transcrição." }));
    expect(outra).toMatchObject({ code: "CONFLICT", message: RECUSAS_DA_EDICAO.mudou });
    const linha = await transcricaoDe(alvo.meetingId);
    expect(linha.revision).toBe(1);
    expect((linha.segments as typeof FALAS)[1].texto).toBe(FALAS[1].texto);
  });

  it("só a dona, só a reunião pronta e nunca o documento", async () => {
    const alvo = await reuniaoPronta();
    const daOutraConta = await recusa(daOutra().meetings.editarTranscricao({ ...alvo, revisao: 0, operacao: { tipo: "texto", indice: 0, texto: "Invasão." } }));
    expect(daOutraConta.code).toBe("NOT_FOUND");
    const processando = await reuniaoPronta({ status: "processing" });
    expect(await recusa(editar(processando, 0, { tipo: "texto", indice: 0, texto: "x" }))).toMatchObject({ code: "CONFLICT", message: RECUSAS_DA_EDICAO.foraDoEstado });
    const excluida = await reuniaoPronta({ status: "deleted" });
    expect((await recusa(editar(excluida, 0, { tipo: "texto", indice: 0, texto: "x" }))).code).toBe("NOT_FOUND");
    const documento = await reuniaoPronta({ origem: "pdf", falas: [{ pagina: 1, texto: "Página um." }], texto: "Página um." });
    expect(await recusa(editar(documento, 0, { tipo: "textoCorrido", texto: "x" }))).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_EDICAO.documento });
    for (const { meetingId } of [alvo, processando, documento]) expect((await transcricaoDe(meetingId)).revision).toBe(0);
    expect(await auditoriasDe(alvo.meetingId)).toEqual([]);
  });

  it("a reunião na lixeira (H7d) não se edita: a guarda recusa pelo router, e o serviço recusa na leitura travada, sem mudar nada", async () => {
    const alvo = await reuniaoPronta();
    await editar(alvo, 0, { tipo: "texto", indice: 0, texto: "Bom dia, aqui é a Glenda, diretora da Akme." });
    await daDona().meetings.mandarParaALixeira({ meetingIds: [alvo.meetingId] });

    // Pelo router, a guarda da lixeira recusa antes do serviço.
    expect((await recusa(editar(alvo, 1, { tipo: "texto", indice: 1, texto: "Na lixeira." }))).code).toBe("NOT_FOUND");
    // O serviço sozinho: a edição que passou pela guarda e chegou depois do
    // "mandar para a lixeira" esbarra na leitura travada da reunião.
    for (const operacao of [{ tipo: "texto" as const, indice: 1, texto: "Na lixeira." }, { tipo: "restaurarTudo" as const }]) {
      const erro = await editarTranscricao(DONA, alvo.meetingId, { ...alvo, revisao: 1, operacao },
        { userId: ID_DA_DONA, ipAddress: "203.0.113.9", userAgent: null }).then(() => null, e => e);
      expect(erro).toBeInstanceOf(RecusaDaEdicao);
      expect(erro).toMatchObject({ codigoTrpc: "NOT_FOUND", message: "Reunião não encontrada." });
    }
    const linha = await transcricaoDe(alvo.meetingId);
    expect(linha).toMatchObject({ revision: 1, originalTranscript: TEXTO, segments: [{ ...FALAS[0], texto: "Bom dia, aqui é a Glenda, diretora da Akme." }, FALAS[1], FALAS[2]] });
    expect(await auditoriasDe(alvo.meetingId)).toHaveLength(1);
  });

  it("a lixeira (H7d) vale também para a transcrição editada: some do detalhe, da lista, da busca, da exportação e do link; restaurar devolve a edição, e apagar de vez leva a versão da IA junto", async () => {
    const alvo = await reuniaoPronta();
    await editar(alvo, 0, { tipo: "substituir", localizar: "Glenta", substituirPor: "Glendarosa" });
    const token = await ligarLinkAberto(DONA, alvo.meetingId, { userId: ID_DA_DONA, ipAddress: "203.0.113.9", userAgent: "vitest", idioma: "pt-BR", textoExibido: "Confirmo." });
    expect((await verReuniaoPeloLink(token)).transcricao).toMatchObject({ editada: true });
    expect((await daDona().meetings.buscar({ termo: "Glendarosa" })).resultados.some(r => r.meetingId === alvo.meetingId)).toBe(true);

    await daDona().meetings.mandarParaALixeira({ meetingIds: [alvo.meetingId] });
    expect((await recusa(daDona().meetings.get({ meetingId: alvo.meetingId }))).code).toBe("NOT_FOUND");
    expect((await daDona().meetings.list()).some(r => r.id === alvo.meetingId)).toBe(false);
    expect((await daDona().meetings.buscar({ termo: "Glendarosa" })).resultados.some(r => r.meetingId === alvo.meetingId)).toBe(false);
    expect((await recusa(daDona().meetings.exportar({ meetingId: alvo.meetingId, formato: "pdf" }))).code).toBe("NOT_FOUND");
    // Mandar para a lixeira desligou o link: o endereço antigo não abre.
    await expect(verReuniaoPeloLink(token)).rejects.toMatchObject({ codigo: "NOT_FOUND" });

    // Restaurar devolve a reunião com a edição, a revisão e o original da IA.
    await daDona().meetings.restaurarDaLixeira({ meetingIds: [alvo.meetingId] });
    const detalhe = await daDona().meetings.get({ meetingId: alvo.meetingId });
    expect(detalhe.transcript?.transcript).toContain("Glendarosa");
    expect(detalhe.transcript?.edicao).toMatchObject({ revisao: 1, editada: true });
    expect((await daDona().meetings.list()).find(r => r.id === alvo.meetingId)?.transcricaoEditada).toBe(true);

    // Apagar de vez leva a linha da transcrição inteira, com a versão da IA.
    await daDona().meetings.mandarParaALixeira({ meetingIds: [alvo.meetingId] });
    await expect(daDona().meetings.apagarDeVez({ meetingIds: [alvo.meetingId] })).resolves.toEqual({ apagadas: 1 });
    expect(await transcricaoDe(alvo.meetingId)).toBeUndefined();
  });

  it("o pedido que não muda nada não sobe a revisão nem entra na auditoria; o trecho vazio e a troca que esvaziaria um trecho são recusados", async () => {
    const alvo = await reuniaoPronta();
    expect(await editar(alvo, 0, { tipo: "texto", indice: 0, texto: FALAS[0].texto })).toEqual({ mudou: false, revisao: 0, editada: false, substituicoes: 0 });
    expect(await editar(alvo, 0, { tipo: "substituir", localizar: "inexistente", substituirPor: "x" })).toMatchObject({ mudou: false, substituicoes: 0 });
    expect(await recusa(editar(alvo, 0, { tipo: "texto", indice: 0, texto: "   " }))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_EDICAO.vazio });
    expect(await recusa(editar(alvo, 0, { tipo: "substituir", localizar: FALAS[1].texto, substituirPor: "" }))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_EDICAO.vazio });
    expect(await recusa(editar(alvo, 0, { tipo: "texto", indice: 7, texto: "x" }))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_EDICAO.trecho });
    expect(await transcricaoDe(alvo.meetingId)).toMatchObject({ revision: 0, transcript: TEXTO, originalTranscript: null, editedAt: null });
    expect(await auditoriasDe(alvo.meetingId)).toEqual([]);
  });

  it("a transcrição de texto corrido (o envio único) muda como um texto só", async () => {
    const alvo = await reuniaoPronta({ falas: [], texto: "Reunião com a Glenta sobre a feira." });
    expect(await editar(alvo, 0, { tipo: "textoCorrido", texto: "Reunião com a Glenda sobre a feira de Milão." })).toMatchObject({ mudou: true, revisao: 1, editada: true });
    expect(await editar(alvo, 1, { tipo: "substituir", localizar: "Milão", substituirPor: "Paris" })).toMatchObject({ mudou: true, substituicoes: 1 });
    expect(await recusa(editar(alvo, 2, { tipo: "texto", indice: 0, texto: "x" }))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_EDICAO.trecho });
    expect(await transcricaoDe(alvo.meetingId)).toMatchObject({ transcript: "Reunião com a Glenda sobre a feira de Paris.", originalTranscript: "Reunião com a Glenta sobre a feira." });
  });

  it("a auditoria vai na transação: sem a linha dela, a transcrição não muda", async () => {
    const alvo = await reuniaoPronta();
    // userId acima do INT da coluna: a linha da auditoria é recusada pelo banco.
    const erro = await editarTranscricao(DONA, alvo.meetingId, { ...alvo, revisao: 0, operacao: { tipo: "texto", indice: 0, texto: "Sem auditoria." } },
      { userId: 3_000_000_000, ipAddress: "203.0.113.9", userAgent: null }).then(() => null, e => e);
    expect(erro).toBeTruthy();
    expect(await transcricaoDe(alvo.meetingId)).toMatchObject({ transcript: TEXTO, segments: FALAS, originalTranscript: null, revision: 0 });
  });

  it("o link aberto mostra a versão editada e nunca a da IA, nem pelo trecho de um item do resumo", async () => {
    const alvo = await reuniaoPronta();
    await resumoDeAntesDaEdicao(alvo);
    const token = await ligarLinkAberto(DONA, alvo.meetingId, { userId: ID_DA_DONA, ipAddress: "203.0.113.9", userAgent: "vitest", idioma: "pt-BR", textoExibido: "Confirmo." });
    // Antes da edição, os dois trechos saem.
    expect((await resumoGuardadoPeloLink(token)).itens.map(i => i.excerpt)).toEqual(["A proposta sai na sexta", "O telefone do escritório é 3333-4444"]);

    // A dona tira o telefone da fala antes de mandar o link.
    await editar(alvo, 0, { tipo: "texto", indice: 2, texto: "Combinado. O telefone eu mando depois." });

    const vista = await verReuniaoPeloLink(token);
    expect(vista.transcricao?.editada).toBe(true);
    expect(vista.transcricao?.segmentos[2].texto).toBe("Combinado. O telefone eu mando depois.");
    const resumo = await resumoGuardadoPeloLink(token);
    expect(resumo.itens.map(i => [i.excerpt, i.trechoForaDaTranscricao])).toEqual([["A proposta sai na sexta", false], ["", true]]);
    // Nada da versão da IA sai pelo link: nem o texto, nem o trecho do item.
    expect(JSON.stringify(vista)).not.toContain("3333-4444");
    expect(JSON.stringify(resumo)).not.toContain("3333-4444");

    // Para a dona, o resumo é de antes da edição: a tela oferece refazer.
    expect((await daDona().meetings.resumoGuardado({ meetingId: alvo.meetingId })).transcricaoEditadaDepois).toBe(true);
  });

  it("a tradução do resumo pelo link também não leva o trecho que a dona tirou da transcrição", async () => {
    const alvo = await reuniaoPronta();
    await resumoDeAntesDaEdicao(alvo);
    pedirJsonAIA.mockReset().mockImplementation(paraIngles);
    const reuniao = { id: alvo.meetingId, ownerId: DONA };
    const antes = await traduzirResumoPeloLink(reuniao, "en", () => undefined);
    expect(antes.estado === "pronta" && antes.itens.map(i => i.excerpt)).toEqual(["A proposta sai na sexta", "O telefone do escritório é 3333-4444"]);

    await editar(alvo, 0, { tipo: "texto", indice: 2, texto: "Combinado. O telefone eu mando depois." });

    // A tradução guardada continua valendo (o resumo é o mesmo); o trecho é
    // conferido de novo, contra a transcrição de agora, a cada pedido.
    const depois = await traduzirResumoPeloLink(reuniao, "en", () => undefined);
    expect(depois.estado === "pronta" && depois.itens.map(i => [i.text, i.excerpt, i.trechoForaDaTranscricao])).toEqual([
      ["EN A proposta sai na sexta", "A proposta sai na sexta", false], ["EN O telefone do escritório foi passado", "", true],
    ]);
    expect(JSON.stringify(depois)).not.toContain("3333-4444");
    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);
  });

  it("'Refazer o resumo' lê a versão editada e refaz o mapa mental gravado antes da edição", async () => {
    const alvo = await reuniaoPronta();
    const banco = await db();
    const MAPA_VELHO = { ramos: [{ rotulo: "Glenta", folhas: [] }, { rotulo: "Proposta", folhas: [] }] };
    const MAPA_NOVO = { ramos: [{ rotulo: "Glenda", folhas: [] }, { rotulo: "Proposta", folhas: [] }] };
    await banco.insert(meetingSummaries).values({
      id: crypto.randomUUID(), meetingId: alvo.meetingId, ownerId: DONA, transcriptId: alvo.transcricaoId, status: "ready", version: 1,
      generatedAt: AGORA() - 60_000, mindMap: MAPA_VELHO, mindMapStatus: "ready", mindMapGeneratedAt: AGORA() - 60_000, createdAt: AGORA(), updatedAt: AGORA(),
    });
    await editar(alvo, 0, { tipo: "substituir", localizar: "Glenta", substituirPor: "Glenda" });
    gerarResumoDaReuniao.mockResolvedValue({ emoji: null, titulo: null, modelo: "gemini-teste-1", itens: [], recebidos: 0 });
    gerarMapaMental.mockResolvedValue(MAPA_NOVO);

    await daDona().meetings.refazerResumo({ meetingId: alvo.meetingId, modelo: "general" });
    await fila.rodarUmaVez({ ownerId: DONA });

    expect(gerarResumoDaReuniao).toHaveBeenCalledWith(expect.objectContaining({ transcricao: expect.stringContaining("Glenda") }));
    expect(gerarResumoDaReuniao.mock.calls[0][0].transcricao).not.toContain("Glenta");
    expect(gerarMapaMental).toHaveBeenCalledTimes(1);
    const [linha] = await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, alvo.meetingId));
    expect(linha).toMatchObject({ status: "ready", version: 2, mindMapStatus: "ready", mindMap: MAPA_NOVO });
    expect((await daDona().meetings.resumoGuardado({ meetingId: alvo.meetingId })).transcricaoEditadaDepois).toBe(false);
  });

  it("a edição no meio da geração do resumo: o resumo da versão anterior é gravado como de outra versão, e a fila não o refaz sozinha", async () => {
    const alvo = await reuniaoPronta();
    const banco = await db();
    await banco.insert(meetingSummaries).values({ id: crypto.randomUUID(), meetingId: alvo.meetingId, ownerId: DONA, transcriptId: alvo.transcricaoId, status: "pending", createdAt: AGORA(), updatedAt: AGORA() });
    // A dona corrige um nome enquanto o primeiro resumo é escrito (o caso
    // típico da H18), e depois outro, durante a geração do mapa.
    gerarResumoDaReuniao.mockImplementationOnce(async () => {
      await editar(alvo, 0, { tipo: "substituir", localizar: "Glenta", substituirPor: "Glenda" });
      return { emoji: "☕", titulo: null, modelo: "gemini-teste-1", itens: [], recebidos: 0 };
    });
    gerarResumoDaReuniao.mockRejectedValue(new Error("a fila não pode refazer o resumo sozinha"));
    gerarMapaMental.mockImplementationOnce(async () => {
      await editar(alvo, 1, { tipo: "substituir", localizar: "Glenda", substituirPor: "Glenda Maria" });
      return { ramos: [{ rotulo: "Glenda", folhas: [] }, { rotulo: "Proposta", folhas: [] }] };
    });
    gerarMapaMental.mockRejectedValue(new Error("a fila não pode refazer o mapa sozinha"));

    await fila.rodarUmaVez({ ownerId: DONA });
    // O que a IA já escreveu (e custou) fica, com a hora de antes da edição: o
    // resumo e o mapa são de outra versão, e a tela oferece "Refazer o resumo".
    const [gravado] = await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, alvo.meetingId));
    expect(gravado).toMatchObject({ status: "ready", version: 1, emoji: "☕", lockToken: null, lockedUntil: null, mindMapStatus: "ready" });
    const [transcricao] = await banco.select({ editadaEm: meetingTranscripts.editedAt }).from(meetingTranscripts).where(eq(meetingTranscripts.meetingId, alvo.meetingId));
    expect(Number(gravado.generatedAt)).toBeLessThan(Number(transcricao.editadaEm));
    expect(Number(gravado.mindMapGeneratedAt)).toBeLessThan(Number(transcricao.editadaEm));
    expect((await daDona().meetings.resumoGuardado({ meetingId: alvo.meetingId })).transcricaoEditadaDepois).toBe(true);

    // Nada volta à fila sozinho: sem o "Refazer", nenhuma chamada a mais à IA.
    await fila.rodarUmaVez({ ownerId: DONA });
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(gerarResumoDaReuniao).toHaveBeenCalledTimes(1);
    expect(gerarMapaMental).toHaveBeenCalledTimes(1);

    // O "Refazer o resumo" (uma vaga do teto) lê a versão de agora e refaz o mapa também.
    gerarResumoDaReuniao.mockResolvedValue({ emoji: "🍵", titulo: null, modelo: "gemini-teste-1", itens: [], recebidos: 0 });
    gerarMapaMental.mockResolvedValue({ ramos: [{ rotulo: "Glenda Maria", folhas: [] }, { rotulo: "Proposta", folhas: [] }] });
    await daDona().meetings.refazerResumo({ meetingId: alvo.meetingId, modelo: "general" });
    await fila.rodarUmaVez({ ownerId: DONA });
    expect(gerarResumoDaReuniao.mock.calls[1][0].transcricao).toContain("Glenda Maria");
    expect(gerarMapaMental).toHaveBeenCalledTimes(2);
    const [refeito] = await banco.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, alvo.meetingId));
    expect(refeito).toMatchObject({ status: "ready", version: 2, emoji: "🍵", mindMapStatus: "ready" });
    expect((await daDona().meetings.resumoGuardado({ meetingId: alvo.meetingId })).transcricaoEditadaDepois).toBe(false);
  });

  it("a busca entre reuniões e a exportação leem a versão editada; a exportação diz que foi editada", async () => {
    const alvo = await reuniaoPronta();
    await editar(alvo, 0, { tipo: "substituir", localizar: "Glenta", substituirPor: "Glendalina" });
    const achou = await daDona().meetings.buscar({ termo: "Glendalina" });
    expect(achou.resultados.some(r => r.meetingId === alvo.meetingId && r.tipo === "transcricao")).toBe(true);
    const velha = await daDona().meetings.buscar({ termo: "Glenta" });
    expect(velha.resultados.some(r => r.meetingId === alvo.meetingId)).toBe(false);

    const exportada = await daDona().meetings.exportar({ meetingId: alvo.meetingId, formato: "pdf" });
    expect(exportada.transcricao).toMatchObject({ editada: true });
    expect(JSON.stringify(exportada)).not.toContain("Glenta");
    const [auditoria] = await (await db()).select().from(auditLogs).where(and(eq(auditLogs.resourceId, alvo.meetingId), eq(auditLogs.action, "MEETING_EXPORTED")));
    expect(auditoria.details).toMatchObject({ transcricaoEditada: true });
  });

  it("as pendências da extração (cargo e empresa) conferem também na versão da IA, que a extração leu", async () => {
    const alvo = await reuniaoPronta();
    // A dona corrige a empresa que a IA ouviu ("Akme") e tira o cargo da fala.
    await editar(alvo, 0, { tipo: "texto", indice: 0, texto: "Bom dia, aqui é a Glenda, da Acme." });
    const banco = await db();
    const contactId = await createPrivateContact(DONA, { fullName: "Glenda" });
    const meetingSuggestionId = crypto.randomUUID();
    await decidirPendenciasDaPessoaSugerida(banco, {
      ownerId: DONA, meetingSuggestionId, meetingId: alvo.meetingId, acao: "create", contactId,
      quemSouDaSugestao: { fullName: "Glenda", phone: null, email: null, jobTitle: "diretora", company: "Akme", confianca: "0.900" },
    });
    // E o que só a correção dela diz também é dito.
    await decidirPendenciasDaPessoaSugerida(banco, {
      ownerId: DONA, meetingSuggestionId: crypto.randomUUID(), meetingId: alvo.meetingId, acao: "create", contactId,
      quemSouDaSugestao: { fullName: "Glenda", phone: null, email: null, jobTitle: null, company: "Acme", confianca: "0.900" },
    });
    const pendencias = await banco.select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor }).from(networkSugestoes)
      .where(and(eq(networkSugestoes.ownerId, DONA), eq(networkSugestoes.meetingId, alvo.meetingId)));
    expect(pendencias.map(p => `${p.campo}:${p.valor}`).sort()).toEqual(["cargo:diretora", "empresa:Acme", "empresa:Akme"]);
  });

  it("o teto de edições por dona: a 201ª em 10 minutos é recusada com o código", () => {
    const chave = `teto-${crypto.randomUUID()}`;
    for (let i = 0; i < EDICOES_POR_JANELA; i++) tetoDaEdicao.reservar(chave);
    let erro: unknown = null;
    try {
      tetoDaEdicao.reservar(chave);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(TRPCError);
    expect(erro).toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DA_EDICAO.demais });
  });
});
