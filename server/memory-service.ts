import crypto from "crypto";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  contactAssets,
  contactContexts,
  contactNeeds,
  contextParticipants,
  contexts,
  meetings,
  meetingTranscripts,
  memoryDocuments,
  privateContacts,
} from "../drizzle/schema";
import { sql } from "drizzle-orm";
import { rotaDaReuniao } from "@shared/rotas";
import { exigirDb } from "./db";
import { embedManyWithGemini, embedWithGemini } from "./gemini";
import { invokeLLM } from "./_core/llm";

const MAX_DOCUMENTS_PER_OWNER = 800;
const MAX_QUERY_LENGTH = 1000;

// Ritmo da indexação: o limite do Gemini conta requisições por minuto, então os
// embeddings saem em lotes (1 requisição por lote) com uma pausa curta entre
// eles, e cada rodada tem um orçamento de tempo — a busca roda atrás do proxy
// do Render, que corta requisições longas. O que não couber fica pendente e sai
// na próxima busca ou reindexação, porque a indexação é incremental.
const EMBED_BATCH_SIZE = 16;
const EMBED_BATCH_PAUSE_MS = 300;
const INDEX_BUDGET_MS = 30_000;
const espera = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type MemorySourceType = "contact" | "context" | "meeting";
export type SearchHit = {
  id: string;
  sourceType: MemorySourceType;
  sourceId: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
};

type MemorySource = Omit<SearchHit, "id" | "score">;

function now() {
  return Date.now();
}

export function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (!magnitude) return vector;
  return vector.map(value => value / magnitude);
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function buildMemoryHash(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function embed(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY") {
  return normalizeVector(await embedWithGemini(text, taskType));
}

async function collectOwnerSources(ownerId: string): Promise<MemorySource[]> {
  const db = await exigirDb();
  const [contacts, privateContexts, transcripts, assets, needs, participantes, reunioes, vinculos] = await Promise.all([
    db.select().from(privateContacts).where(eq(privateContacts.ownerId, ownerId)),
    db.select().from(contexts).where(and(eq(contexts.ownerId, ownerId), eq(contexts.visibility, "private"))),
    // Projeção explícita: `segments` (o JSON palavra-a-palavra) nunca entra no
    // documento e é a coluna mais pesada da tabela — não viaja à toa.
    db.select({ meetingId: meetingTranscripts.meetingId, transcript: meetingTranscripts.transcript, language: meetingTranscripts.language })
      .from(meetingTranscripts).where(eq(meetingTranscripts.ownerId, ownerId)),
    db.select().from(contactAssets).where(eq(contactAssets.ownerId, ownerId)),
    db.select().from(contactNeeds).where(eq(contactNeeds.ownerId, ownerId)),
    db.select({ contextId: contextParticipants.contextId, name: contextParticipants.name, company: contextParticipants.company, role: contextParticipants.role, notes: contextParticipants.notes })
      .from(contextParticipants).where(eq(contextParticipants.ownerId, ownerId)),
    db.select({ id: meetings.id, title: meetings.title, status: meetings.status }).from(meetings).where(eq(meetings.ownerId, ownerId)),
    // O vínculo contato↔contexto (onde e como a pessoa foi conhecida, com
    // cidade/país/notas do encontro) ficava fora dos documentos: "Quem conheço
    // na Nigéria?" não achava a Ana vinculada à "Missão Comercial Lagos"
    // (auditoria de 04/09, etapa 9).
    db.select({
      contactId: contactContexts.contactId, contextId: contactContexts.contextId,
      city: contactContexts.city, country: contactContexts.country,
      eventDate: contactContexts.eventDate, notes: contactContexts.notes,
      relationshipType: contactContexts.relationshipType,
    }).from(contactContexts).where(eq(contactContexts.ownerId, ownerId)),
  ]);

  // O que o contato possui/procura é O dado de negócio da base — "Quem exporta
  // medicamentos?" mora aqui, não no cargo. Ficava fora do documento e a
  // pesquisa da etapa 9 não tinha como responder o exemplo do requisito.
  const porContato = (itens: Array<{ contactId: number; tagLabel: string }>) => {
    const mapa = new Map<number, string[]>();
    for (const item of itens) {
      const lista = mapa.get(item.contactId) ?? [];
      lista.push(item.tagLabel);
      mapa.set(item.contactId, lista);
    }
    return mapa;
  };
  const possuiPorContato = porContato(assets);
  const procuraPorContato = porContato(needs);

  // Vínculos nos dois sentidos: o documento do contato diz ONDE ele foi
  // conhecido (com cidade/país/notas do encontro), e o do contexto diz QUEM
  // foi vinculado a ele — hoje só nomeava os participantes avulsos.
  // Os contextos referenciados por vínculos OU por participantes avulsos vêm
  // de uma consulta pelos ids que a dona pode ver — dela OU do catálogo
  // (ownerId NULL): "Web Summit Lisboa" é catálogo, não está em
  // privateContexts, e sem isto o documento do contato dizia "Onde conheci:
  // (Lisboa · Portugal)" sem o nome. Os participantes entram na mesma lista
  // porque a tela (e o router, via contextIsVisible) aceita participante
  // avulso em contexto do catálogo, e esse participante — dado da própria
  // dona — não caía em documento nenhum (reverificação de 04/09, etapa 9).
  // Contexto privado de OUTRA dona (vínculo legado) fica de fora, de propósito.
  const idsDeContextoReferenciado = Array.from(new Set([
    ...vinculos.map(vinculo => vinculo.contextId),
    ...participantes.map(participante => participante.contextId),
  ]));
  const contextosVisiveis = idsDeContextoReferenciado.length
    ? await db.select({
        id: contexts.id, ownerId: contexts.ownerId, name: contexts.name,
        eventDate: contexts.eventDate, city: contexts.city, country: contexts.country,
      }).from(contexts)
        .where(and(inArray(contexts.id, idsDeContextoReferenciado), or(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId))))
    : [];
  const nomeDoContexto = new Map(contextosVisiveis.map(context => [context.id, context.name]));
  const nomeDoContato = new Map(contacts.map(contact => [contact.id, contact.fullName]));
  const contextosPorContato = new Map<number, string[]>();
  const contatosPorContexto = new Map<string, string[]>();
  for (const vinculo of vinculos) {
    const lugar = [vinculo.city, vinculo.country].filter(Boolean).join(" · ");
    const descricao = [
      nomeDoContexto.get(vinculo.contextId),
      lugar && `(${lugar})`,
      vinculo.eventDate,
      vinculo.notes,
    ].filter(Boolean).join(" ");
    if (descricao) {
      const lista = contextosPorContato.get(vinculo.contactId) ?? [];
      lista.push(descricao);
      contextosPorContato.set(vinculo.contactId, lista);
    }
    const nome = nomeDoContato.get(vinculo.contactId);
    if (nome) {
      const lista = contatosPorContexto.get(vinculo.contextId) ?? [];
      lista.push([nome, vinculo.notes].filter(Boolean).join(", "));
      contatosPorContexto.set(vinculo.contextId, lista);
    }
  }

  const contactSources: MemorySource[] = contacts.map(contact => ({
    sourceType: "contact",
    sourceId: String(contact.id),
    title: contact.fullName,
    content: [
      `Contato: ${contact.fullName}`,
      contact.jobTitle && `Cargo: ${contact.jobTitle}`,
      contact.company && `Empresa: ${contact.company}`,
      [contact.city, contact.state, contact.country].filter(Boolean).join(" · "),
      Array.isArray(contact.profileTags) && contact.profileTags.length ? `Tags: ${contact.profileTags.join(", ")}` : "",
      possuiPorContato.has(contact.id) ? `Possui / oferece: ${possuiPorContato.get(contact.id)!.join(", ")}` : "",
      procuraPorContato.has(contact.id) ? `Procura: ${procuraPorContato.get(contact.id)!.join(", ")}` : "",
      contextosPorContato.has(contact.id) ? `Onde conheci: ${contextosPorContato.get(contact.id)!.join("; ")}` : "",
      contact.notes && `Notas: ${contact.notes}`,
    ].filter(Boolean).join("\n"),
    metadata: { href: "/network", contactId: contact.id, kind: "Contato" },
  }));

  // Quem foi encontrado num contexto e ainda não virou contato só existe em
  // context_participants — "Quem conhece ministros?" mora no role/notes dessas
  // pessoas, e o documento do contexto não as nomeava.
  const participantesPorContexto = new Map<string, string[]>();
  for (const participante of participantes) {
    const lista = participantesPorContexto.get(participante.contextId) ?? [];
    lista.push([participante.name, participante.role, participante.company, participante.notes].filter(Boolean).join(", "));
    participantesPorContexto.set(participante.contextId, lista);
  }

  const contextSources: MemorySource[] = privateContexts.map(context => ({
    sourceType: "context",
    sourceId: context.id,
    title: context.name,
    content: [
      `Contexto: ${context.name}`,
      context.description && `Descrição: ${context.description}`,
      context.eventDate && `Data: ${context.eventDate}`,
      [context.city, context.country].filter(Boolean).join(" · "),
      participantesPorContexto.has(context.id) ? `Participantes: ${participantesPorContexto.get(context.id)!.join("; ")}` : "",
      contatosPorContexto.has(context.id) ? `Contatos vinculados: ${contatosPorContexto.get(context.id)!.join("; ")}` : "",
      context.notes && `Notas: ${context.notes}`,
    ].filter(Boolean).join("\n"),
    metadata: { href: "/contexts", contextId: context.id, kind: "Contexto" },
  }));

  // Contexto do CATÁLOGO em que a dona registrou participantes ou vínculos
  // também vira documento — por dona, com sourceId = id do contexto (a chave
  // do índice inclui owner_id, então donas diferentes não colidem). Só o que
  // é dela entra além de nome/data/lugar: description e notes do catálogo são
  // texto global que não responde nada sobre a rede dela e inflaria o índice
  // de todas as donas com o mesmo conteúdo. Catálogo sem nada dela não gera
  // documento.
  const catalogSources: MemorySource[] = contextosVisiveis
    .filter(context => context.ownerId == null
      && (participantesPorContexto.has(context.id) || contatosPorContexto.has(context.id)))
    .map(context => ({
      sourceType: "context",
      sourceId: context.id,
      title: context.name,
      content: [
        `Contexto: ${context.name}`,
        context.eventDate && `Data: ${context.eventDate}`,
        [context.city, context.country].filter(Boolean).join(" · "),
        participantesPorContexto.has(context.id) ? `Participantes: ${participantesPorContexto.get(context.id)!.join("; ")}` : "",
        contatosPorContexto.has(context.id) ? `Contatos vinculados: ${contatosPorContexto.get(context.id)!.join("; ")}` : "",
      ].filter(Boolean).join("\n"),
      metadata: { href: "/contexts", contextId: context.id, kind: "Contexto" },
    }));

  // O título da reunião mora na tabela meetings; sem ele o documento era um
  // texto anônimo ("Transcrição de reunião") difícil de casar com a pergunta.
  // Só reuniões VIVAS: uma transcrição cuja reunião sumiu (ou está 'deleted',
  // a janela em que a exclusão ainda apaga o resto) é órfã de um
  // processamento que terminou depois do Excluir — e virava documento da
  // memória, respondendo a buscas pela fala de uma reunião que a dona mandou
  // apagar. O filtro é em memória, de propósito: a lista de reuniões da dona
  // já está carregada (para os títulos), então não custa nada — e um JOIN na
  // consulta das transcrições exigiria dos testes da memória um fake de banco
  // que hoje simula só SELECT simples por tabela.
  const reunioesVivas = reunioes.filter(reuniao => reuniao.status !== "deleted");
  const tituloDaReuniao = new Map(reunioesVivas.map(reuniao => [reuniao.id, reuniao.title]));

  const transcriptSources: MemorySource[] = transcripts
    .filter(transcript => tituloDaReuniao.has(transcript.meetingId))
    .map(transcript => ({
      sourceType: "meeting",
      sourceId: transcript.meetingId,
      title: tituloDaReuniao.get(transcript.meetingId) ?? "Transcrição de reunião",
      content: [
        `Reunião: ${tituloDaReuniao.get(transcript.meetingId)}`,
        transcript.transcript,
      ].filter(Boolean).join("\n"),
      // O "Abrir fonte" leva ao detalhe da reunião. Documento já indexado guarda
      // "/meetings" até a reunião mudar; a tela abre pelo meetingId mesmo assim.
      metadata: { href: rotaDaReuniao(transcript.meetingId), meetingId: transcript.meetingId, kind: "Reunião", language: transcript.language },
    }));

  return [...contactSources, ...contextSources, ...catalogSources, ...transcriptSources].filter(source => source.content.trim().length > 2);
}

export type ResultadoDaIndexacao = {
  indexed: number; skipped: number; removed: number;
  pending: number; truncated: number; total: number;
};

/**
 * Assinatura barata da base: contagem e o updatedAt mais novo de cada tabela-
 * fonte (coberto por índice em owner_id nas tabelas grandes — contatos,
 * reuniões, transcrições, possui/procura; contextos, participantes e vínculos
 * não têm esse índice, mas são tabelas pequenas). Se nada mudou desde a
 * última rodada completa, a busca nem carrega as fontes — antes, TODA
 * pergunta arrastava as 5 tabelas inteiras (transcrições completas incluídas)
 * e fazia sha256 do corpus todo só para descobrir que não havia nada a fazer.
 * Guardada em memória: um restart apenas custa uma rodada completa a mais.
 */
const assinaturaIndexada = new Map<string, { assinatura: string; truncated: number }>();

async function assinaturaDaBase(db: Awaited<ReturnType<typeof exigirDb>>, ownerId: string) {
  type TabelaFonte = typeof privateContacts | typeof contexts | typeof meetingTranscripts
    | typeof contactAssets | typeof contactNeeds | typeof contextParticipants | typeof meetings
    | typeof contactContexts;
  const resumo = (tabela: TabelaFonte, escopo: SQL) =>
    db.select({ n: sql<number>`count(*)`, m: sql<number>`coalesce(max(${tabela.updatedAt}), 0)` })
      .from(tabela).where(escopo);
  const daDona = (tabela: TabelaFonte) => resumo(tabela, eq(tabela.ownerId, ownerId));
  // As OITO tabelas que alimentam os documentos, não só as cinco principais:
  // participante novo, reunião renomeada e vínculo contato↔contexto editado
  // mudam o conteúdo e precisam mudar a assinatura, senão o índice congela
  // até outra coisa qualquer ser editada.
  // E o CATÁLOGO de contextos (owner_id NULL), que nenhum filtro pela dona
  // alcança: o documento da dona sobre um contexto do catálogo (participantes
  // ou vínculos dela nele) carrega nome/data/cidade/país do catálogo, então
  // renomear ou editar o catálogo muda o conteúdo — e sem este agregado a
  // assinatura não via a mudança e o nome velho ficava no índice até a dona
  // editar outra coisa (revisão da PR-D). Um count/max sobre as linhas sem
  // dona é barato: a tabela é pequena (catálogo + contextos privados) e a
  // varredura é a mesma que o agregado da dona já faz nela.
  const linhas = await Promise.all([
    daDona(privateContacts), daDona(contexts), daDona(meetingTranscripts),
    daDona(contactAssets), daDona(contactNeeds),
    daDona(contextParticipants), daDona(meetings), daDona(contactContexts),
    resumo(contexts, isNull(contexts.ownerId)),
  ]);
  return linhas.map(([linha]) => (linha ? `${linha.n}:${linha.m}` : "0:0")).join("|");
}

/** Só para os testes: o cache de assinatura é estado de módulo. */
export function esquecerAssinaturasDeIndexacao() {
  assinaturaIndexada.clear();
}

// Uma rodada por dona de cada vez: buscas simultâneas compartilham a mesma
// indexação em vez de disparar rodadas concorrentes — que, com a chave
// composta (owner, source) sem índice único no banco, duplicavam documentos.
const indexacoesEmVoo = new Map<string, Promise<ResultadoDaIndexacao>>();

export type OpcoesDeIndexacao = {
  /**
   * Ignora a assinatura lembrada e não se contenta com a rodada em voo. É o
   * botão "Atualizar memória" (memory.reindex): a assinatura só enxerga as
   * tabelas-fonte, então um duplicado nascido em memory_documents DEPOIS dela
   * (rodadas concorrentes de dois processos) não a muda, e o clique devolvia
   * "0 removidos" com o duplicado ainda pesquisável (revisão da PR-D). A busca
   * continua usando o cache: ela roda a cada pergunta e não pode pagar a
   * leitura do corpus inteiro toda vez.
   */
  forcar?: boolean;
};

export async function indexOwnerMemory(ownerId: string, opcoes: OpcoesDeIndexacao = {}): Promise<ResultadoDaIndexacao> {
  const emVoo = indexacoesEmVoo.get(ownerId);
  if (emVoo) {
    if (!opcoes.forcar) return emVoo;
    // A rodada em voo fotografou a base ANTES do clique (e pode ter caído no
    // atalho da assinatura): a reindexação explícita espera ela terminar —
    // duas rodadas simultâneas da mesma dona é justamente o que duplicava
    // documentos — e abre a sua. Ao voltar, o finally já tirou a antiga do
    // mapa, mas uma busca pode ter aberto outra: por isso a checagem repete.
    await emVoo.catch(() => {});
    return indexOwnerMemory(ownerId, opcoes);
  }
  const rodada = executarIndexacao(ownerId, opcoes.forcar === true).finally(() => indexacoesEmVoo.delete(ownerId));
  indexacoesEmVoo.set(ownerId, rodada);
  return rodada;
}

async function executarIndexacao(ownerId: string, forcar: boolean): Promise<ResultadoDaIndexacao> {
  const db = await exigirDb();

  // A assinatura é calculada mesmo na rodada forçada: é ela que fica lembrada
  // no fim, para a busca seguinte cair no atalho.
  const assinatura = await assinaturaDaBase(db, ownerId);
  const lembrada = assinaturaIndexada.get(ownerId);
  if (!forcar && lembrada?.assinatura === assinatura) {
    // O truncamento não deixa de existir porque nada mudou: quem está acima do
    // teto continua acima dele, e a busca precisa continuar contando isso.
    return { indexed: 0, skipped: 0, removed: 0, pending: 0, truncated: lembrada.truncated, total: 0 };
  }

  // O instante do retrato: buscas concorrentes também reindexam, e um documento
  // criado por outra rodada DEPOIS deste retrato não pode ser tratado como
  // órfão — a fonte dele só não aparece aqui porque a lista é mais antiga.
  const snapshotAt = now();
  const allSources = await collectOwnerSources(ownerId);
  // O teto por dona continua, mas deixa de ser silencioso: quem passar dele
  // fica sabendo pelo log e pelo retorno, em vez de descobrir na busca que as
  // reuniões (as últimas da fila) nunca entraram no índice.
  const truncated = Math.max(0, allSources.length - MAX_DOCUMENTS_PER_OWNER);
  if (truncated > 0) {
    console.warn(`[Memória] ${ownerId} tem ${allSources.length} fontes; ${truncated} acima do teto de ${MAX_DOCUMENTS_PER_OWNER} ficaram fora do índice.`);
  }
  const sources = allSources.slice(0, MAX_DOCUMENTS_PER_OWNER);
  // Projeção enxuta: a comparação incremental usa só chave, hash, vetor,
  // createdAt e indexedAt — carregar content/metadata daqui dobrava a leitura
  // do corpus.
  const existing = await db.select({
    id: memoryDocuments.id,
    sourceType: memoryDocuments.sourceType,
    sourceId: memoryDocuments.sourceId,
    contentHash: memoryDocuments.contentHash,
    embedding: memoryDocuments.embedding,
    createdAt: memoryDocuments.createdAt,
    indexedAt: memoryDocuments.indexedAt,
  }).from(memoryDocuments).where(eq(memoryDocuments.ownerId, ownerId));
  // Um documento por chave (owner, sourceType, sourceId): a chave não tem
  // índice único no banco, e rodadas concorrentes (dois processos no deploy,
  // reinício no meio) já duplicaram documentos. O Map ficava com o ÚLTIMO da
  // lista e o outro nunca mais era tocado: a edição do contato atualizava um
  // só, e o duplicado com as notas já apagadas seguia pesquisável e citável.
  // Sobrevive o de indexedAt maior (o mais recente a receber conteúdo); em
  // empate, o de createdAt maior; ainda em empate, o de id maior (comparação
  // de string). O desempate é total porque o id é único: o sobrevivente NÃO
  // depende da ordem em que o SELECT devolveu as linhas — sem ORDER BY o
  // MySQL não a garante, e "em empate, o primeiro lido" deixava duas rodadas
  // escolherem sobreviventes diferentes para a mesma dupla (revisão da PR-D).
  // Os demais viram órfãos abaixo.
  type Documento = typeof existing[number];
  const precedencia = (a: Documento, b: Documento) =>
    (a.indexedAt - b.indexedAt) || (a.createdAt - b.createdAt) || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0);
  const byCompositeKey = new Map<string, Documento>();
  const duplicados: Documento[] = [];
  for (const document of existing) {
    const key = `${document.sourceType}:${document.sourceId}`;
    const atual = byCompositeKey.get(key);
    if (!atual) {
      byCompositeKey.set(key, document);
    } else if (precedencia(document, atual) > 0) {
      duplicados.push(atual);
      byCompositeKey.set(key, document);
    } else {
      duplicados.push(document);
    }
  }

  // Fonte apagada leva o documento junto: sem isto, notas de um contato
  // excluído continuavam pesquisáveis (e citáveis pela resposta) para sempre.
  // A comparação usa a lista COMPLETA de fontes, para que um documento além do
  // teto não seja confundido com órfão. Duplicado da mesma chave sai pelo
  // mesmo DELETE, com a mesma guarda: documento criado por outra rodada
  // DEPOIS do retrato não é apagado por esta.
  const liveKeys = new Set(allSources.map(source => `${source.sourceType}:${source.sourceId}`));
  const semFonteViva = existing.filter(document =>
    !liveKeys.has(`${document.sourceType}:${document.sourceId}`) && document.createdAt < snapshotAt);
  const duplicadosVencidos = duplicados.filter(document => document.createdAt < snapshotAt);
  const orphans = Array.from(new Map([...semFonteViva, ...duplicadosVencidos].map(document => [document.id, document])).values());
  if (orphans.length) {
    await db.delete(memoryDocuments).where(and(
      eq(memoryDocuments.ownerId, ownerId),
      inArray(memoryDocuments.id, orphans.map(orphan => orphan.id)),
    ));
  }

  let skipped = 0;
  const pendingSources: Array<{ source: MemorySource; contentHash: string; previous?: typeof existing[number] }> = [];
  for (const source of sources) {
    const key = `${source.sourceType}:${source.sourceId}`;
    const contentHash = buildMemoryHash(source.content);
    const previous = byCompositeKey.get(key);
    // Vetores anteriores da OpenAI tinham 1536 dimensões. Só reutilizamos vetores
    // já compatíveis com o Gemini (768), preservando os documentos e reindexando
    // os demais de forma incremental e não destrutiva.
    if (previous?.contentHash === contentHash && Array.isArray(previous.embedding) && previous.embedding.length === 768) {
      skipped += 1;
      continue;
    }
    pendingSources.push({ source, contentHash, previous });
  }

  let indexed = 0;
  let pending = 0;
  const startedAt = now();
  for (let offset = 0; offset < pendingSources.length; offset += EMBED_BATCH_SIZE) {
    if (offset > 0) {
      if (now() - startedAt > INDEX_BUDGET_MS) {
        pending = pendingSources.length - offset;
        console.warn(`[Memória] orçamento de tempo da rodada esgotado; ${pending} documento(s) ficam para a próxima.`);
        break;
      }
      await espera(EMBED_BATCH_PAUSE_MS);
    }
    const batch = pendingSources.slice(offset, offset + EMBED_BATCH_SIZE);
    let vectors: number[][];
    try {
      vectors = (await embedManyWithGemini(batch.map(item => item.source.content), "RETRIEVAL_DOCUMENT")).map(normalizeVector);
    } catch (error) {
      // Indexar é melhor-esforço: pico ou cota do serviço de IA não pode
      // derrubar a rodada inteira. O que já foi indexado fica valendo e o
      // restante sai na próxima, quando o serviço respirar.
      pending = pendingSources.length - offset;
      console.warn(`[Memória] embeddings indisponíveis (${error instanceof Error ? error.message : error}); ${pending} documento(s) ficam para a próxima rodada.`);
      break;
    }
    for (let position = 0; position < batch.length; position += 1) {
      const { source, contentHash, previous } = batch[position];
      const embedding = vectors[position];
      const timestamp = now();
      if (previous) {
        await db.update(memoryDocuments).set({
          title: source.title,
          content: source.content,
          metadata: source.metadata,
          embedding,
          contentHash,
          indexedAt: timestamp,
          updatedAt: timestamp,
        }).where(and(eq(memoryDocuments.id, previous.id), eq(memoryDocuments.ownerId, ownerId)));
      } else {
        await db.insert(memoryDocuments).values({
          id: crypto.randomUUID(),
          ownerId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          title: source.title,
          content: source.content,
          metadata: source.metadata,
          embedding,
          contentHash,
          indexedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      indexed += 1;
    }
  }
  const resultado = { indexed, skipped, removed: orphans.length, pending, truncated, total: sources.length };
  // A assinatura só é lembrada quando a rodada terminou INTEIRA: com pendência,
  // a próxima busca precisa voltar aqui para continuar de onde parou.
  if (pending === 0) assinaturaIndexada.set(ownerId, { assinatura, truncated });
  return resultado;
}

export type ResultadoDaBusca = { hits: SearchHit[]; pending: number; truncated: number };

export async function semanticSearch(ownerId: string, query: string, limit = 6): Promise<ResultadoDaBusca> {
  const cleanQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!cleanQuery) return { hits: [], pending: 0, truncated: 0 };
  const db = await exigirDb();
  // O embedding da pergunta vem ANTES da reindexação: se o serviço de
  // embeddings estiver fora, a usuária recebe o erro claro em uma rodada de
  // retentativas — reindexar primeiro somaria as duas esperas e viraria
  // timeout mudo no proxy do Render.
  const queryEmbedding = await embed(cleanQuery, "RETRIEVAL_QUERY");
  // A reindexação é incremental: documentos sem alteração reutilizam o vetor já salvo.
  // Assim, uma busca sempre enxerga contatos, contextos e reuniões adicionados recentemente.
  // E é melhor-esforço: se o índice não puder ser atualizado agora, a busca
  // segue com o que já está indexado em vez de morrer junto. O que ficou por
  // indexar não pode ser segredo: pending/truncated seguem com os resultados,
  // senão a primeira pergunta numa base grande respondia "não encontrei" sobre
  // um índice pela metade, sem nenhuma pista.
  let pending = 0;
  let truncated = 0;
  try {
    const indexacao = await indexOwnerMemory(ownerId);
    pending = indexacao.pending;
    truncated = indexacao.truncated;
  } catch (error) {
    console.warn(`[Memória] reindexação adiada (${error instanceof Error ? error.message : error}); buscando no índice existente.`);
  }
  const documents = await db.select().from(memoryDocuments).where(eq(memoryDocuments.ownerId, ownerId));
  const hits = documents
    .filter(document => Array.isArray(document.embedding) && document.embedding.length === queryEmbedding.length)
    .map(document => ({
      id: document.id,
      sourceType: document.sourceType as MemorySourceType,
      sourceId: document.sourceId,
      title: document.title,
      content: document.content,
      metadata: (document.metadata ?? {}) as Record<string, unknown>,
      score: cosineSimilarity(queryEmbedding, document.embedding as number[]),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(limit, 12)));
  return { hits, pending, truncated };
}

// Sem afirmar a causa: pode ser pico ou cota, mas também configuração — e
// prometer "alta demanda" num erro permanente esconderia o problema real.
export const AI_UNAVAILABLE_ANSWER = "A busca funcionou e as fontes estão listadas abaixo, mas o serviço de IA não conseguiu redigir a resposta agora. Tente perguntar de novo em alguns minutos.";

// Quanto de cada fonte chega ao LLM. O corte único de 2.500 caracteres veio
// do código do Manus sem revisão: cabia para contato e contexto (documentos
// curtos), mas a transcrição de uma reunião de 10 min rende ~9.000 — o
// embedding via o texto todo e a reunião aparecia como fonte, e a resposta
// dizia que a informação não existia porque só os ~3 primeiros minutos
// entravam no prompt. O teto total protege o modelo de 6 hits × 12.000.
export const JANELA_POR_FONTE: Record<MemorySourceType, number> = { meeting: 12_000, contact: 2_500, context: 2_500 };
export const TETO_DO_CONTEXTO = 40_000;

export async function answerFromMemory(query: string, hits: SearchHit[]) {
  if (!hits.length) {
    return "Não encontrei informações privadas suficientes na sua memória para responder a isso.";
  }
  // O teto é descontado na ordem dos hits (os mais relevantes primeiro); o
  // hit que não cabe fica fora, avisado no log, e a numeração [n] continua a
  // da lista de fontes da tela, para as citações não apontarem para a fonte
  // errada.
  const trechos: string[] = [];
  let orcamento = TETO_DO_CONTEXTO;
  hits.forEach((hit, index) => {
    const janela = JANELA_POR_FONTE[hit.sourceType] ?? JANELA_POR_FONTE.contact;
    const trecho = `[${index + 1}] ${hit.title}\n${hit.content.slice(0, janela)}`;
    if (trecho.length > orcamento) {
      console.warn(`[Memória] fonte [${index + 1}] (${hit.sourceType}) ficou fora do prompt: ${trecho.length} caracteres não cabem no teto de ${TETO_DO_CONTEXTO}.`);
      return;
    }
    orcamento -= trecho.length;
    trechos.push(trecho);
  });
  const context = trechos.join("\n\n");
  // invokeLLM usa o mesmo provedor do resto do app (LLM_API_URL/LLM_API_KEY).
  // A versão anterior dependia do SDK da Anthropic com ANTHROPIC_API_KEY, que
  // não existe no ambiente: a resposta falhava mesmo com a busca funcionando.
  let response: Awaited<ReturnType<typeof invokeLLM>>;
  try {
    response = await invokeLLM({
      max_tokens: 700,
      messages: [
        { role: "system", content: "Você é a Memória Inteligente da WRW (Women Rocking the World). Responda em português somente com base no contexto privado fornecido. Nunca invente fatos. Se a evidência não for suficiente, diga isso claramente. Cite as fontes pelo número entre colchetes ao final de cada afirmação relevante." },
        { role: "user", content: `Pergunta: ${query}

Contexto privado:
${context}` },
      ],
    });
  } catch (error) {
    // O LLM fora do ar não anula uma busca que já deu certo: as fontes vão
    // para a tela com um aviso honesto. Estourar aqui derrubava a mutation
    // inteira e cuspia o erro cru do provedor (com o JSON de cota dentro) no
    // toast da usuária.
    console.warn(`[Memória] resposta indisponível: ${error instanceof Error ? error.message : error}`);
    return AI_UNAVAILABLE_ANSWER;
  }
  const text = response.choices?.[0]?.message?.content;
  return (typeof text === "string" ? text : "").trim() || "Não consegui gerar uma resposta agora. Tente novamente em instantes.";
}

export async function searchAndAnswer(ownerId: string, query: string) {
  const { hits, pending, truncated } = await semanticSearch(ownerId, query);
  const answer = await answerFromMemory(query, hits);
  return { answer, hits, pending, truncated };
}
