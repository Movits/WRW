import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { apagarPelaChave } from "./test/apagar-pela-chave";
import type { Segmento } from "./transcricao-de-fatia";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

// Só a IA é dublada: o texto (invokeLLM) e o embedding da pergunta (a ordem da Memória).
const duble = vi.hoisted(() => ({ invokeLLM: vi.fn(), embed: vi.fn() }));
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => duble.invokeLLM(...args) }));
vi.mock("./gemini", async importOriginal => ({ ...(await importOriginal<typeof import("./gemini")>()), embedWithGemini: (...args: unknown[]) => duble.embed(...args) }));

const { getDb } = await import("./db");
const { meetings, meetingTranscripts, memoryDocuments, perguntasEntreReunioes, users } = await import("../drizzle/schema");
const { appRouter } = await import("./routers");
const { tetoDaIADaReuniao, PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA } = await import("./routers/meetings");
const { dataNoFuso } = await import("./perguntar-a-varias-reunioes");
const { LIMITE_DA_LEITURA_DA_IA, PERGUNTAS_ENTRE_REUNIOES_EM_24H, RECUSAS_ENTRE_REUNIOES, JANELA_DAS_PERGUNTAS_ENTRE_REUNIOES_MS } = await import("@shared/perguntar-a-varias-reunioes");
type TrpcContext = import("./_core/context").TrpcContext;

/**
 * O Pergunte a várias reuniões (H6c) de ponta a ponta contra um banco real DE
 * TESTE (sem DATABASE_URL_TESTES, se pula): o router, a escolha (uma a uma e
 * pela etiqueta), a dona nas consultas, o que cabe no teto e a ordem da
 * Memória, a conferência da resposta, a linha sem conteúdo, o teto de 24 h, as
 * vagas do teto de pedidos à IA e a avaliação. Só a IA é dublada.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-varias-${crypto.randomUUID()}`;
const OUTRA = `teste-varias-outra-${crypto.randomUUID()}`;
const AGORA = Date.now();
const DIA = 24 * 60 * 60_000;
let idDaDona = 0;

function contexto(openId: string, id: number): TrpcContext {
  return {
    user: { id, openId, role: "silver", name: "Dona Teste", onboardingCompleted: true },
    req: { headers: {}, ip: "203.0.113.30", socket: { remoteAddress: "203.0.113.30" } },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}
const daDona = () => appRouter.createCaller(contexto(DONA, idDaDona)).perguntasEntreReunioes;
const daOutra = () => appRouter.createCaller(contexto(OUTRA, idDaDona + 1)).perguntasEntreReunioes;
async function db() { return (await getDb())!; }

type OpcoesDaReuniao = {
  titulo?: string; falas?: Segmento[]; texto?: string; status?: "ready" | "processing" | "deleted"; etiquetas?: string[] | null;
  criadaEm?: number; nomes?: Record<string, string> | null; semTranscricao?: boolean;
  /** Na lixeira (H7d): a hora em que foi para lá. */
  naLixeira?: boolean;
};

async function reuniao(ownerId: string, opcoes: OpcoesDaReuniao = {}) {
  const banco = await db();
  const id = crypto.randomUUID();
  const criadaEm = opcoes.criadaEm ?? AGORA;
  await banco.insert(meetings).values({
    id, ownerId, title: opcoes.titulo ?? "Reunião", status: opcoes.status ?? "ready", consentGranted: true, language: "pt-BR",
    origem: "gravacao", etiquetas: opcoes.etiquetas ?? null, speakerNames: opcoes.nomes ?? null, createdAt: criadaEm, updatedAt: criadaEm,
    trashedAt: opcoes.naLixeira ? AGORA : null,
  });
  if (!opcoes.semTranscricao) {
    const falas = opcoes.falas ?? [];
    const texto = opcoes.texto ?? falas.map(fala => fala.texto).join("\n");
    await banco.insert(meetingTranscripts).values({
      id: crypto.randomUUID(), meetingId: id, ownerId, transcript: texto, segments: falas.length ? falas : null, language: "pt-BR", createdAt: criadaEm, updatedAt: criadaEm,
    });
  }
  return id;
}

/** Uma reunião rotulada cuja entrada à IA tem cerca de `letras` caracteres (falas de uma voz só, em linhas longas). */
function falasDoTamanho(letras: number, marca: string): Segmento[] {
  const fala = `${marca} ${"palavra ".repeat(120)}`.trim();
  return Array.from({ length: Math.ceil(letras / (fala.length + 6)) }, (_, i) => ({ inicio: i * 10, fim: i * 10 + 9, falante: i % 2 ? "F2" : "F1", texto: fala }));
}

async function documentoDaMemoria(ownerId: string, meetingId: string, vetor: number[]) {
  const banco = await db();
  await banco.insert(memoryDocuments).values({
    id: crypto.randomUUID(), ownerId, sourceType: "meeting", sourceId: meetingId, title: "Reunião", content: "Reunião: janela",
    metadata: { meetingId }, embedding: vetor, contentHash: crypto.randomUUID().replace(/-/g, ""), indexedAt: AGORA, createdAt: AGORA, updatedAt: AGORA,
  });
}

const vetor = (angulo: number) => Array.from({ length: 768 }, (_, i) => (i === 0 ? Math.cos(angulo) : i === 1 ? Math.sin(angulo) : 0));
const respostaDaIA = (dados: unknown) => ({ model: "gemini-3.5-flash", choices: [{ message: { content: JSON.stringify(dados) } }] });
const NAO_RESPONDE = { respondida: false, resposta: "", citacoes: [], visual: { tipo: "nenhum", titulo: "", unidade: "", colunas: [], linhas: [] } };
const mensagemDaIA = (i = 0) => (duble.invokeLLM.mock.calls[i][0] as { messages: Array<{ content: string }> }).messages[1].content;
const linhasDaDona = async () => (await db()).select().from(perguntasEntreReunioes).where(eq(perguntasEntreReunioes.ownerId, DONA));

const CONTRATO: Segmento[] = [
  { inicio: 0, fim: 6, falante: "F1", texto: "Eu fecho o contrato de exportação de café até sexta-feira." },
  { inicio: 6, fim: 12, falante: "F2", texto: "Então eu mando a minuta revisada amanhã cedo." },
];
const FRETE: Segmento[] = [
  { inicio: 40, fim: 50, falante: "F1", texto: "O frete marítimo ficou para a semana que vem, depois do feriado." },
];

async function limpar() {
  const banco = await db();
  await apagarPelaChave(banco, perguntasEntreReunioes, inArray(perguntasEntreReunioes.ownerId, [DONA, OUTRA]));
  await apagarPelaChave(banco, memoryDocuments, inArray(memoryDocuments.ownerId, [DONA, OUTRA]));
  await apagarPelaChave(banco, meetingTranscripts, inArray(meetingTranscripts.ownerId, [DONA, OUTRA]));
  await apagarPelaChave(banco, meetings, inArray(meetings.ownerId, [DONA, OUTRA]));
}

describe.skipIf(!temBanco)("Pergunte a várias reuniões (integração)", () => {
  beforeAll(async () => {
    const banco = await db();
    await banco.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    const [linha] = await banco.select({ id: users.id }).from(users).where(eq(users.openId, DONA));
    idDaDona = linha.id;
  });
  beforeEach(async () => {
    await limpar();
    tetoDaIADaReuniao.esquecer();
    duble.invokeLLM.mockReset();
    duble.embed.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    await limpar();
    await banco.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
  });

  it("a lista: só as reuniões prontas da dona, com transcrição, das mais novas para as mais velhas, com o tamanho", async () => {
    const velha = await reuniao(DONA, { titulo: "Velha", falas: CONTRATO, criadaEm: AGORA - DIA, etiquetas: ["Clientes"] });
    const nova = await reuniao(DONA, { titulo: "Nova", falas: FRETE });
    await reuniao(DONA, { titulo: "Processando", falas: FRETE, status: "processing" });
    await reuniao(DONA, { titulo: "Excluída", falas: FRETE, status: "deleted" });
    await reuniao(DONA, { titulo: "Sem transcrição", semTranscricao: true });
    await reuniao(OUTRA, { titulo: "Da outra", falas: FRETE });
    const lista = await daDona().reunioes();
    expect(lista.map(r => r.id)).toEqual([nova, velha]);
    expect(lista[1]).toMatchObject({ titulo: "Velha", etiquetas: ["Clientes"], origem: "gravacao", caracteres: CONTRATO.map(f => f.texto).join("\n").length });
  });

  it("uma a uma: a IA lê as duas em blocos, na ordem do tempo, sem os nomes das vozes; a resposta conferida volta com as fontes, e a linha guarda só os números", async () => {
    const r1 = await reuniao(DONA, { titulo: "Contrato do café", falas: CONTRATO, criadaEm: AGORA - DIA, nomes: { F1: "Glória Mendes" } });
    const r2 = await reuniao(DONA, { titulo: "Frete", falas: FRETE });
    duble.invokeLLM.mockResolvedValue(respostaDaIA({
      respondida: true, resposta: "{ R1 : F1 } fecha o contrato, e {R2:F1} adiou o frete.",
      citacoes: [{ reuniao: "R1", trecho: "Eu fecho o contrato de exportação de café até sexta-feira" }, { reuniao: "R2", trecho: "O frete marítimo ficou para a semana que vem" }],
      visual: NAO_RESPONDE.visual,
    }));
    const resposta = await daDona().perguntar({ meetingIds: [r2, r1], idioma: "pt-BR", pergunta: "O que ficou combinado?", fuso: "America/Sao_Paulo" });

    expect(resposta).toMatchObject({
      respondida: true, resposta: "{R1:F1} fecha o contrato, e {R2:F1} adiou o frete.", visual: null, escolhidas: 2, alemDoMaximo: 0, ordem: "todas", deFora: [],
      citacoes: [
        { reuniao: 1, meetingId: r1, trecho: "Eu fecho o contrato de exportação de café até sexta-feira", inicioSegundos: 0 },
        { reuniao: 2, meetingId: r2, trecho: "O frete marítimo ficou para a semana que vem", inicioSegundos: 40 },
      ],
      reunioes: [
        { numero: 1, meetingId: r1, titulo: "Contrato do café", nomes: { F1: "Glória Mendes" }, citada: true },
        { numero: 2, meetingId: r2, titulo: "Frete", nomes: {}, citada: true },
      ],
    });
    const mensagem = mensagemDaIA();
    expect(mensagem.indexOf("=== Reunião R1 · Contrato do café")).toBeGreaterThan(-1);
    expect(mensagem.indexOf("=== Reunião R1 · Contrato do café")).toBeLessThan(mensagem.indexOf("=== Reunião R2 · Frete"));
    expect(mensagem).toContain("{F1}: Eu fecho o contrato de exportação de café até sexta-feira.");
    expect(mensagem).not.toContain("Glória");
    // A data no fuso do aparelho de quem pergunta.
    expect(mensagem).toContain(`=== Reunião R1 · Contrato do café · ${dataNoFuso(AGORA - DIA, "America/Sao_Paulo")} ===`);
    expect(mensagem.endsWith("Pergunta: O que ficou combinado?")).toBe(true);

    const [linha] = await linhasDaDona();
    expect(linha).toMatchObject({
      id: resposta.perguntaId, situacao: "respondida", reunioesEscolhidas: 2, reunioesLidas: 2, fontesCitadas: 2,
      caracteres: mensagem.length, visual: null, modelo: "gemini-3.5-flash", avaliacao: null,
    });
    // Nenhuma coluna guarda a pergunta, a resposta ou as reuniões.
    expect(JSON.stringify(linha)).not.toMatch(/combinado|contrato|frete|R1|Glória/i);
  });

  it("um id de outra conta (ou de reunião excluída) recusa a pergunta inteira, sem dizer qual, sem IA e sem linha", async () => {
    const minha = await reuniao(DONA, { falas: CONTRATO });
    const daOutraConta = await reuniao(OUTRA, { falas: FRETE });
    const excluida = await reuniao(DONA, { falas: FRETE, status: "deleted" });
    for (const ids of [[minha, daOutraConta], [minha, excluida]]) {
      await expect(daDona().perguntar({ meetingIds: ids, idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
        .rejects.toMatchObject({ code: "NOT_FOUND", message: RECUSAS_ENTRE_REUNIOES.naoEncontrada });
    }
    expect(duble.invokeLLM).not.toHaveBeenCalled();
    expect(await linhasDaDona()).toEqual([]);
  });

  it("pela etiqueta: as reuniões prontas da dona com a etiqueta, pela chave (sem caixa); nenhuma, recusa com o código", async () => {
    const a = await reuniao(DONA, { titulo: "Cliente A", falas: CONTRATO, etiquetas: ["Clientes"], criadaEm: AGORA - DIA });
    const b = await reuniao(DONA, { titulo: "Cliente B", falas: FRETE, etiquetas: ["clientes", "Mentoria"] });
    await reuniao(DONA, { titulo: "Mentoria", falas: FRETE, etiquetas: ["Mentoria"] });
    await reuniao(DONA, { titulo: "Cliente processando", falas: FRETE, etiquetas: ["Clientes"], status: "processing" });
    await reuniao(OUTRA, { titulo: "Cliente da outra", falas: FRETE, etiquetas: ["Clientes"] });
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    const resposta = await daDona().perguntar({ etiqueta: " CLIENTES ", idioma: "pt-BR", pergunta: "O que os clientes pediram?" });
    expect(resposta).toMatchObject({ respondida: false, escolhidas: 2, reunioes: [{ meetingId: a, numero: 1 }, { meetingId: b, numero: 2 }] });
    expect(mensagemDaIA()).not.toContain("· Mentoria ·");
    expect(mensagemDaIA()).not.toContain("da outra");
    expect(mensagemDaIA()).not.toContain("processando");
    expect((await linhasDaDona())[0]).toMatchObject({ situacao: "nao_respondida", reunioesLidas: 2, fontesCitadas: 0 });

    await expect(daDona().perguntar({ etiqueta: "Inexistente", idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_ENTRE_REUNIOES.semReuniao });
  });

  it("a escolhida que não está pronta fica de fora, com o motivo; nenhuma pronta, recusa antes da IA", async () => {
    const pronta = await reuniao(DONA, { titulo: "Pronta", falas: CONTRATO });
    const processando = await reuniao(DONA, { titulo: "Processando", falas: FRETE, status: "processing" });
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    const resposta = await daDona().perguntar({ meetingIds: [pronta, processando], idioma: "pt-BR", pergunta: "O que ficou combinado?" });
    expect(resposta).toMatchObject({ escolhidas: 2, reunioes: [{ meetingId: pronta }], deFora: [{ meetingId: processando, titulo: "Processando", motivo: "sem_transcricao" }] });

    duble.invokeLLM.mockClear();
    await expect(daDona().perguntar({ meetingIds: [processando], idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_ENTRE_REUNIOES.semTranscricao });
    expect(duble.invokeLLM).not.toHaveBeenCalled();
  });

  it(`acima de ${LIMITE_DA_LEITURA_DA_IA} caracteres, a Memória escolhe as mais ligadas à pergunta; sem o embedding, as mais novas`, async () => {
    const terco = Math.floor(LIMITE_DA_LEITURA_DA_IA * 0.4);
    const ligada = await reuniao(DONA, { titulo: "Ligada", falas: falasDoTamanho(terco, "ligada"), criadaEm: AGORA - 3 * DIA });
    const poucoLigada = await reuniao(DONA, { titulo: "Pouco ligada", falas: falasDoTamanho(terco, "pouco"), criadaEm: AGORA - 2 * DIA });
    const semIndice = await reuniao(DONA, { titulo: "Sem índice", falas: falasDoTamanho(terco, "sem"), criadaEm: AGORA - DIA });
    // A da outra conta, idêntica à pergunta, não conta: a Memória é lida só pela dona.
    await documentoDaMemoria(OUTRA, semIndice, vetor(0));
    await documentoDaMemoria(DONA, ligada, vetor(0.1));
    await documentoDaMemoria(DONA, poucoLigada, vetor(1.4));
    duble.embed.mockResolvedValue(vetor(0));
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));

    const pelaMemoria = await daDona().perguntar({ meetingIds: [semIndice, poucoLigada, ligada], idioma: "pt-BR", pergunta: "O que decidimos?" });
    expect(pelaMemoria).toMatchObject({ ordem: "relevancia", reunioes: [{ meetingId: ligada }, { meetingId: poucoLigada }], deFora: [{ meetingId: semIndice, motivo: "limite" }] });
    expect(duble.embed).toHaveBeenCalledWith("O que decidimos?", "RETRIEVAL_QUERY", { tentativas: 1, timeoutMs: 8_000 });
    expect(mensagemDaIA()).not.toContain("Sem índice");

    duble.embed.mockRejectedValue(new Error("Gemini fora do ar"));
    const pelasNovas = await daDona().perguntar({ meetingIds: [semIndice, poucoLigada, ligada], idioma: "pt-BR", pergunta: "O que decidimos?" });
    expect(pelasNovas).toMatchObject({ ordem: "recentes", reunioes: [{ meetingId: poucoLigada }, { meetingId: semIndice }], deFora: [{ meetingId: ligada, motivo: "limite" }] });
  });

  it("o tamanho medido no banco cabe, mas a entrada com os rótulos passa do teto: a que fica de fora sai pela ordem (as mais novas), e a tela é avisada", async () => {
    // Falas curtas, de vozes alternadas: o "{F1}: " de cada linha soma ~30% à transcrição.
    const curtas = (marca: string): Segmento[] => Array.from({ length: 9_000 }, (_, i) => ({ inicio: i, fim: i + 1, falante: i % 2 ? "F2" : "F1", texto: `${marca} fala ${String(i).padStart(4, "0")}` }));
    const antiga = await reuniao(DONA, { titulo: "Antiga", falas: curtas("antiga"), criadaEm: AGORA - DIA });
    const nova = await reuniao(DONA, { titulo: "Nova", falas: curtas("nova..") });
    const [medidas] = [await daDona().reunioes()];
    const total = medidas.reduce((soma, r) => soma + r.caracteres, 0);
    expect(total).toBeLessThan(LIMITE_DA_LEITURA_DA_IA - 1_000);
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    const resposta = await daDona().perguntar({ meetingIds: [antiga, nova], idioma: "pt-BR", pergunta: "O que houve?" });
    expect(resposta).toMatchObject({ ordem: "recentes", reunioes: [{ meetingId: nova }], deFora: [{ meetingId: antiga, motivo: "limite" }] });
  });

  it("a reunião que não cabe nem sozinha fica de fora; se só há ela, recusa com o código", async () => {
    const longa = await reuniao(DONA, { titulo: "Longa", texto: "x".repeat(LIMITE_DA_LEITURA_DA_IA + 10) });
    const curta = await reuniao(DONA, { titulo: "Curta", falas: CONTRATO });
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await expect(daDona().perguntar({ meetingIds: [longa, curta], idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .resolves.toMatchObject({ reunioes: [{ meetingId: curta }], deFora: [{ meetingId: longa, motivo: "longa_demais" }] });
    await expect(daDona().perguntar({ meetingIds: [longa], idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: RECUSAS_ENTRE_REUNIOES.longasDemais });
  });

  it(`o teto de 24 h: com ${PERGUNTAS_ENTRE_REUNIOES_EM_24H} perguntas no último dia, recusa antes da IA; as de antes de 24 h não contam`, async () => {
    const r1 = await reuniao(DONA, { falas: CONTRATO });
    const r2 = await reuniao(DONA, { falas: FRETE });
    const banco = await db();
    const linha = (criadaEm: number) => ({
      id: crypto.randomUUID(), ownerId: DONA, situacao: "respondida" as const, reunioesEscolhidas: 2, reunioesLidas: 2, caracteres: 100, createdAt: criadaEm, updatedAt: criadaEm,
    });
    await banco.insert(perguntasEntreReunioes).values(Array.from({ length: PERGUNTAS_ENTRE_REUNIOES_EM_24H }, () => linha(AGORA - JANELA_DAS_PERGUNTAS_ENTRE_REUNIOES_MS - 60_000)));
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    await expect(daDona().perguntar({ meetingIds: [r1, r2], idioma: "pt-BR", pergunta: "O que ficou combinado?" })).resolves.toMatchObject({ respondida: false });

    await banco.insert(perguntasEntreReunioes).values(Array.from({ length: PERGUNTAS_ENTRE_REUNIOES_EM_24H - 1 }, () => linha(AGORA - 60 * 60_000)));
    duble.invokeLLM.mockClear();
    await expect(daDona().perguntar({ meetingIds: [r1, r2], idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_ENTRE_REUNIOES.tetoDiario });
    expect(duble.invokeLLM).not.toHaveBeenCalled();
    // A outra conta tem o teto dela.
    const daOutraConta = await reuniao(OUTRA, { falas: FRETE });
    await expect(daOutra().perguntar({ meetingIds: [daOutraConta], idioma: "pt-BR", pergunta: "O que ficou combinado?" })).resolves.toMatchObject({ respondida: false });
  });

  it(`as vagas do teto de pedidos à IA: a pergunta de ~250 mil caracteres gasta 3 das ${PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA}; recusada, devolve as que tomou, sem IA e sem linha`, async () => {
    const grande = await reuniao(DONA, { titulo: "Grande", falas: falasDoTamanho(250_000, "grande") });
    for (let i = 0; i < PEDIDOS_A_IA_DA_REUNIAO_POR_JANELA - 2; i++) tetoDaIADaReuniao.reservar(DONA);
    await expect(daDona().perguntar({ meetingIds: [grande], idioma: "pt-BR", pergunta: "O que ficou combinado?" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(duble.invokeLLM).not.toHaveBeenCalled();
    expect(await linhasDaDona()).toEqual([]);
    // As duas vagas que sobravam voltaram.
    tetoDaIADaReuniao.reservar(DONA);
    tetoDaIADaReuniao.reservar(DONA);
    expect(() => tetoDaIADaReuniao.reservar(DONA)).toThrow();
  });

  it("a IA fora do ar: SERVICE_UNAVAILABLE com a frase da pergunta a uma reunião, e a linha fica como falha (e conta no teto)", async () => {
    const r1 = await reuniao(DONA, { falas: CONTRATO });
    duble.invokeLLM.mockRejectedValue(new Error("LLM sem resposta"));
    await expect(daDona().perguntar({ meetingIds: [r1], idioma: "pt-BR", pergunta: "O que ficou combinado?" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await linhasDaDona()).toMatchObject([{ situacao: "falhou" }]);
  });

  it("a voz sem a reunião, com duas lidas, derruba a resposta; o visual entre reuniões chega com as vozes na forma da tela", async () => {
    const r1 = await reuniao(DONA, { falas: CONTRATO, criadaEm: AGORA - DIA });
    const r2 = await reuniao(DONA, { falas: FRETE });
    const citacao = { reuniao: "R2", trecho: "O frete marítimo ficou para a semana que vem" };
    duble.invokeLLM.mockResolvedValueOnce(respostaDaIA({ respondida: true, resposta: "{F1} adiou o frete.", citacoes: [citacao], visual: NAO_RESPONDE.visual }));
    await expect(daDona().perguntar({ meetingIds: [r1, r2], idioma: "pt-BR", pergunta: "Quem adiou o frete?" })).resolves.toMatchObject({ respondida: false });

    duble.invokeLLM.mockResolvedValueOnce(respostaDaIA({
      respondida: true, resposta: "{R2:F1} adiou o frete.", citacoes: [citacao],
      visual: { tipo: "barras", titulo: "Falas por pessoa", unidade: "", colunas: ["Quem", "Falas"], linhas: [{ celulas: ["{r1:f1}", "1"] }, { celulas: ["{R2:F1}", "1"] }] },
    }));
    const resposta = await daDona().perguntar({ meetingIds: [r1, r2], idioma: "pt-BR", pergunta: "Faça um gráfico das falas" });
    expect(resposta).toMatchObject({ respondida: true, visual: { tipo: "barras", rotulos: ["{R1:F1}", "{R2:F1}"], series: [{ nome: "Falas", valores: [1, 1] }] } });
    expect((await linhasDaDona()).map(linha => linha.situacao).sort()).toEqual(["nao_respondida", "respondida"]);
    expect((await linhasDaDona()).find(linha => linha.situacao === "respondida")).toMatchObject({ visual: "barras", fontesCitadas: 1 });
  });

  it("a avaliação: só a dona, só de pergunta que a IA respondeu; avaliar de novo troca", async () => {
    const r1 = await reuniao(DONA, { falas: CONTRATO });
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    const { perguntaId } = await daDona().perguntar({ meetingIds: [r1], idioma: "pt-BR", pergunta: "O que ficou combinado?" });

    await expect(daDona().avaliar({ perguntaId, nota: "boa" })).resolves.toEqual({ avaliacao: "boa" });
    expect((await linhasDaDona())[0]).toMatchObject({ avaliacao: "boa" });
    expect((await linhasDaDona())[0].avaliadaEm).toBeGreaterThan(0);
    await expect(daDona().avaliar({ perguntaId, nota: "ruim" })).resolves.toEqual({ avaliacao: "ruim" });
    expect((await linhasDaDona())[0]).toMatchObject({ avaliacao: "ruim" });

    await expect(daOutra().avaliar({ perguntaId, nota: "boa" })).rejects.toMatchObject({ code: "NOT_FOUND", message: RECUSAS_ENTRE_REUNIOES.perguntaNaoEncontrada });
    await expect(daDona().avaliar({ perguntaId: crypto.randomUUID(), nota: "boa" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await linhasDaDona())[0]).toMatchObject({ avaliacao: "ruim" });

    duble.invokeLLM.mockRejectedValue(new Error("LLM sem resposta"));
    await expect(daDona().perguntar({ meetingIds: [r1], idioma: "pt-BR", pergunta: "De novo?" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const falha = (await linhasDaDona()).find(linha => linha.situacao === "falhou")!;
    await expect(daDona().avaliar({ perguntaId: falha.id, nota: "boa" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a reunião na lixeira (H7d) fica fora de tudo: da lista, da escolha pela etiqueta e da escolha uma a uma (NOT_FOUND sem dizer qual), sem IA e sem linha", async () => {
    const pronta = await reuniao(DONA, { titulo: "Pronta", falas: CONTRATO, etiquetas: ["Clientes"], criadaEm: AGORA - DIA });
    const naLixeira = await reuniao(DONA, { titulo: "Na lixeira", falas: FRETE, etiquetas: ["Clientes"], naLixeira: true });
    await reuniao(DONA, { titulo: "Só na lixeira", falas: FRETE, etiquetas: ["Arquivo"], naLixeira: true });
    expect((await daDona().reunioes()).map(r => r.id)).toEqual([pronta]);

    await expect(daDona().perguntar({ meetingIds: [pronta, naLixeira], idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: RECUSAS_ENTRE_REUNIOES.naoEncontrada });
    await expect(daDona().perguntar({ etiqueta: "Arquivo", idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_ENTRE_REUNIOES.semReuniao });
    expect(duble.invokeLLM).not.toHaveBeenCalled();
    expect(await linhasDaDona()).toEqual([]);

    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    const resposta = await daDona().perguntar({ etiqueta: "Clientes", idioma: "pt-BR", pergunta: "O que os clientes pediram?" });
    expect(resposta).toMatchObject({ escolhidas: 1, reunioes: [{ meetingId: pronta }], deFora: [] });
    expect(mensagemDaIA()).not.toContain("Na lixeira");
  });

  it("a reunião que vai para a lixeira entre as duas leituras some da resposta: nem é lida nem aparece em 'ficaram de fora'", async () => {
    // Três de 40% do teto: passam do teto juntas (a ordem é decidida), e cabem duas.
    const terco = Math.floor(LIMITE_DA_LEITURA_DA_IA * 0.4);
    const velha = await reuniao(DONA, { titulo: "Velha", falas: falasDoTamanho(terco, "velha"), criadaEm: AGORA - 3 * DIA });
    const meio = await reuniao(DONA, { titulo: "Meio", falas: falasDoTamanho(terco, "meio"), criadaEm: AGORA - 2 * DIA });
    const nova = await reuniao(DONA, { titulo: "Nova para a lixeira", falas: falasDoTamanho(terco, "nova"), criadaEm: AGORA - DIA });
    // No meio da pergunta (entre a escolha e a leitura das transcrições), outro aparelho manda a mais nova à lixeira.
    duble.embed.mockImplementation(async () => {
      await (await db()).update(meetings).set({ trashedAt: Date.now() }).where(eq(meetings.id, nova));
      throw new Error("sem embedding");
    });
    duble.invokeLLM.mockResolvedValue(respostaDaIA(NAO_RESPONDE));
    const resposta = await daDona().perguntar({ meetingIds: [velha, meio, nova], idioma: "pt-BR", pergunta: "O que ficou combinado?" });
    expect(duble.embed).toHaveBeenCalledTimes(1);
    expect(resposta.reunioes.map(r => r.meetingId)).toEqual([meio]);
    expect(resposta.deFora).toEqual([{ meetingId: velha, titulo: "Velha", motivo: "limite" }]);
    expect(JSON.stringify(resposta)).not.toContain("Nova para a lixeira");
    expect(mensagemDaIA()).not.toContain("Nova para a lixeira");
  });

  it("sem nenhuma que caiba sozinha, a ordem da Memória não é pedida: a recusa sai sem chamar o embedding (que fica fora de todo teto)", async () => {
    const grande = LIMITE_DA_LEITURA_DA_IA + 1_000;
    const a = await reuniao(DONA, { titulo: "Grande A", texto: "a".repeat(grande) });
    const b = await reuniao(DONA, { titulo: "Grande B", texto: "b".repeat(grande) });
    duble.embed.mockResolvedValue(vetor(0));
    await expect(daDona().perguntar({ meetingIds: [a, b], idioma: "pt-BR", pergunta: "O que ficou combinado?" }))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: RECUSAS_ENTRE_REUNIOES.longasDemais });
    expect(duble.embed).not.toHaveBeenCalled();
    expect(duble.invokeLLM).not.toHaveBeenCalled();
  });

  it("a escolha é uma das duas: ids e etiqueta juntos, ou nenhum, é BAD_REQUEST sem ler o banco", async () => {
    await expect(daDona().perguntar({ meetingIds: [crypto.randomUUID()], etiqueta: "Clientes", idioma: "pt-BR", pergunta: "O que houve?" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(daDona().perguntar({ idioma: "pt-BR", pergunta: "O que houve?" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(duble.invokeLLM).not.toHaveBeenCalled();
  });
});
