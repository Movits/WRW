import crypto from "crypto";
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import {
  contactAssets,
  contactContexts,
  contactNeeds,
  contextParticipants,
  contexts,
  meetings,
  meetingSummaries,
  meetingSummaryItems,
  meetingTranscripts,
  memoryDocuments,
  privateContacts,
} from "../drizzle/schema";
import { sql } from "drizzle-orm";
import { rotaDaReuniao } from "@shared/rotas";
import { nomesDosFalantes } from "@shared/const";
import { vozesNoTexto } from "@shared/vozes-no-texto";
import { dividirEmJanelas } from "./janelas-de-texto";
import { exigirDb } from "./db";
import { estaNaLixeira } from "./reuniao-visivel";
import { embedManyWithGemini, embedWithGemini } from "./gemini";
import { invokeLLM } from "./_core/llm";

const MAX_DOCUMENTS_PER_OWNER = 800;
// Uma janela por documento da reunião longa. É o que a resposta da IA lê de cada
// fonte de reunião (JANELA_POR_FONTE.meeting, abaixo): uma janela maior entraria
// inteira na busca (o embedding lê até 20 mil) e só pela metade na resposta.
const JANELA_DA_MEMORIA = 12_000;
// Na busca, no máximo duas janelas da mesma reunião: uma reunião longa não pode
// ocupar todos os lugares e empurrar os contatos e as outras reuniões.
const JANELAS_DA_MESMA_REUNIAO_NA_BUSCA = 2;
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

// "meeting_summary": o resumo da reunião, só com os itens que a dona confirmou
// (documentosDosResumosConfirmados, abaixo).
export type MemorySourceType = "contact" | "context" | "meeting" | "meeting_summary";
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
  const [contacts, privateContexts, transcripts, assets, needs, participantes, reunioes, vinculos, resumos, itensConfirmados] = await Promise.all([
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
    db.select({ id: meetings.id, title: meetings.title, status: meetings.status, trashedAt: meetings.trashedAt, speakerNames: meetings.speakerNames }).from(meetings).where(eq(meetings.ownerId, ownerId)),
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
    // O resumo guardado (H4) entra na Memória só com o que a dona confirmou:
    // o item "para conferir" e o ignorado ficam de fora (nada extraído por IA
    // entra sozinho). Projeção explícita: o trecho da transcrição já está no
    // documento da transcrição.
    db.select({ id: meetingSummaries.id, meetingId: meetingSummaries.meetingId, status: meetingSummaries.status, version: meetingSummaries.version, language: meetingSummaries.language })
      .from(meetingSummaries).where(eq(meetingSummaries.ownerId, ownerId)),
    db.select({
      summaryId: meetingSummaryItems.summaryId, meetingId: meetingSummaryItems.meetingId, section: meetingSummaryItems.section,
      position: meetingSummaryItems.position, subject: meetingSummaryItems.subject, text: meetingSummaryItems.text,
      assignee: meetingSummaryItems.assignee, due: meetingSummaryItems.due,
      complementText: meetingSummaryItems.complementText, complementSourceUrl: meetingSummaryItems.complementSourceUrl,
      complementStatus: meetingSummaryItems.complementStatus,
    }).from(meetingSummaryItems).where(and(eq(meetingSummaryItems.ownerId, ownerId), eq(meetingSummaryItems.status, "confirmed"))),
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
  // que hoje simula só SELECT simples por tabela. A reunião na lixeira (H7d)
  // também fica fora: o documento dela sai na rodada seguinte, e volta se a
  // dona a restaurar.
  const reunioesVivas = reunioes.filter(reuniao => reuniao.status !== "deleted" && !estaNaLixeira(reuniao.trashedAt));
  const tituloDaReuniao = new Map(reunioesVivas.map(reuniao => [reuniao.id, reuniao.title]));

  // A reunião longa é lida INTEIRA, em janelas (G8): o embedding só lê os
  // primeiros 20 mil caracteres de cada documento, e o resto da reunião ficava
  // fora da busca. A primeira janela mantém a chave de sempre (o meetingId),
  // para a reunião curta não ser reindexada; as seguintes ganham "#2", "#3"...
  // Todas levam o mesmo meetingId no metadata, que é por onde a tela abre a
  // reunião (o sourceId com "#" seria recusado como id de reunião).
  const primeirasJanelas: MemorySource[] = [];
  const janelasExtras: MemorySource[] = [];
  for (const transcript of transcripts) {
    if (!tituloDaReuniao.has(transcript.meetingId)) continue;
    const titulo = tituloDaReuniao.get(transcript.meetingId) ?? "Transcrição de reunião";
    const janelas = dividirEmJanelas(transcript.transcript, JANELA_DA_MEMORIA);
    janelas.forEach((janela, indice) => {
      const fonte: MemorySource = {
        sourceType: "meeting",
        sourceId: indice === 0 ? transcript.meetingId : `${transcript.meetingId}#${indice + 1}`,
        title: titulo,
        content: [`Reunião: ${titulo}`, janela].filter(Boolean).join("\n"),
        // O "Abrir fonte" leva ao detalhe da reunião. Documento já indexado guarda
        // "/meetings" até a reunião mudar; a tela abre pelo meetingId mesmo assim.
        metadata: {
          href: rotaDaReuniao(transcript.meetingId), meetingId: transcript.meetingId, kind: "Reunião", language: transcript.language,
          ...(janelas.length > 1 ? { janela: indice + 1, janelas: janelas.length } : {}),
        },
      };
      (indice === 0 ? primeirasJanelas : janelasExtras).push(fonte);
    });
  }

  const nomesDaReuniao = new Map(reunioesVivas.map(reuniao => [reuniao.id, nomesDosFalantes(reuniao.speakerNames)]));
  const resumosConfirmados = documentosDosResumosConfirmados(resumos, itensConfirmados, tituloDaReuniao, nomesDaReuniao);

  // As janelas extras vão para o FIM: o teto de documentos por dona corta pelo
  // fim da lista, e uma reunião longa não pode empurrar contatos, contextos ou
  // a primeira janela de outras reuniões para fora do índice. O resumo
  // confirmado vem antes delas: é curto e é o que a dona conferiu.
  return [...contactSources, ...contextSources, ...catalogSources, ...primeirasJanelas, ...resumosConfirmados, ...janelasExtras].filter(source => source.content.trim().length > 2);
}

// Os títulos das seções no documento da Memória, em português como o resto
// dos documentos (o prompt da resposta é em português).
const SECAO_NA_MEMORIA: Record<string, string> = {
  action: "Ações", focus: "Foco do trabalho", task: "Tarefas", decision: "Decisões", blocker: "Bloqueios", question: "Questões pendentes",
};
const ORDEM_DAS_SECOES_NA_MEMORIA = ["action", "focus", "task", "decision", "blocker", "question"];

type ResumoNaMemoria = { id: string; meetingId: string; status: string; version: number; language: string | null };
type ItemConfirmadoNaMemoria = {
  summaryId: string; meetingId: string; section: string; position: number; subject: string | null; text: string;
  assignee: string | null; due: string | null; complementText: string | null; complementSourceUrl: string | null; complementStatus: string | null;
};

/**
 * O resumo confirmado de cada reunião viva, um documento por reunião (o
 * sourceId é o id dela, no tipo "meeting_summary"): só os itens que a dona
 * confirmou, do resumo com uma versão que vale na tela (o pronto, ou o que está
 * sendo refeito ou cujo refazer falhou, que segue mostrando a anterior). Sem
 * item confirmado, não há documento, e o que existia sai na rodada (órfão).
 * Quando o resumo muda (a dona confirma, edita, desfaz a confirmação, refaz),
 * o texto muda, e o documento é refeito; a reunião na lixeira ou excluída leva
 * o documento junto, como a transcrição. Os rótulos de voz viram os nomes que a
 * dona deu (a Memória é só dela), ou "Falante n". O complemento pela busca na
 * web (H4i) entra só confirmado, marcado como de fora da reunião e com a fonte.
 */
export function documentosDosResumosConfirmados(
  resumos: ResumoNaMemoria[], itens: ItemConfirmadoNaMemoria[],
  tituloDaReuniao: Map<string, string>, nomesDaReuniao: Map<string, Readonly<Record<string, string>>>,
): MemorySource[] {
  const fontes: MemorySource[] = [];
  for (const resumo of resumos) {
    if (!tituloDaReuniao.has(resumo.meetingId)) continue;
    if (resumo.status !== "ready" && !(Number(resumo.version) > 0)) continue;
    const doResumo = itens.filter(item => item.summaryId === resumo.id && item.meetingId === resumo.meetingId);
    if (!doResumo.length) continue;
    const nomes = nomesDaReuniao.get(resumo.meetingId) ?? {};
    const comVozes = (texto: string) => vozesNoTexto(texto, nomes, numero => `Falante ${numero}`);
    const titulo = tituloDaReuniao.get(resumo.meetingId) ?? "Reunião";
    const linhas = [`Resumo confirmado da reunião: ${titulo}`];
    for (const secao of ORDEM_DAS_SECOES_NA_MEMORIA) {
      const daSecao = doResumo.filter(item => item.section === secao).sort((a, b) => a.position - b.position);
      if (!daSecao.length) continue;
      linhas.push(`${SECAO_NA_MEMORIA[secao]}:`);
      for (const item of daSecao) {
        const extras = [item.assignee && `responsável: ${comVozes(item.assignee)}`, item.due && `prazo: ${item.due}`].filter(Boolean).join("; ");
        linhas.push(`- ${item.subject ? `${comVozes(item.subject)}: ` : ""}${comVozes(item.text)}${extras ? ` (${extras})` : ""}`);
        if (item.complementStatus === "confirmed" && item.complementText) {
          linhas.push(`  Complemento de fora da reunião (busca na web${item.complementSourceUrl ? `, fonte: ${item.complementSourceUrl}` : ""}): ${item.complementText}`);
        }
      }
    }
    fontes.push({
      sourceType: "meeting_summary",
      sourceId: resumo.meetingId,
      title: titulo.slice(0, 300),
      content: linhas.join("\n"),
      metadata: { href: rotaDaReuniao(resumo.meetingId), meetingId: resumo.meetingId, kind: "Resumo da reunião", language: resumo.language },
    });
  }
  return fontes;
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
    | typeof contactContexts | typeof meetingSummaries | typeof meetingSummaryItems;
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
  // As reuniões contam sem as da lixeira (H7d): mandar uma reunião para a
  // lixeira, ou tirá-la de lá, não mexe no updated_at (a ficha de quem a
  // processa), mas muda a contagem, e a assinatura nova faz a rodada tirar (ou
  // devolver) os documentos dela.
  const linhas = await Promise.all([
    daDona(privateContacts), daDona(contexts), daDona(meetingTranscripts),
    daDona(contactAssets), daDona(contactNeeds),
    daDona(contextParticipants), resumo(meetings, and(eq(meetings.ownerId, ownerId), isNull(meetings.trashedAt))!), daDona(contactContexts),
    resumo(contexts, isNull(contexts.ownerId)),
    // O resumo confirmado (H4 na Memória): confirmar, editar, desfazer e
    // refazer mudam o updated_at do item (ou a contagem, quando a fila troca os
    // itens), e a rodada refaz o documento do resumo.
    daDona(meetingSummaries), daDona(meetingSummaryItems),
    // E a própria lixeira: trocar uma reunião por outra entre duas buscas
    // (mandar A para lá e restaurar B) mantém a contagem acima e, sem nenhuma
    // das duas ser a de updated_at maior, o máximo; a rodada não reindexava, e
    // B ficava fora da Memória até outra edição. A hora mais recente de ida
    // para a lixeira muda a cada reunião que vai, e a contagem, a cada uma que volta.
    db.select({ n: sql<number>`count(*)`, m: sql<number>`coalesce(max(${meetings.trashedAt}), 0)` })
      .from(meetings).where(and(eq(meetings.ownerId, ownerId), isNotNull(meetings.trashedAt))!),
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

/** A reunião de um documento da memória: o meetingId do metadata, ou a chave sem a janela ("id#2"). */
function reuniaoDoDocumento(documento: { sourceId: string; metadata: unknown }): string {
  const metadata = documento.metadata as Record<string, unknown> | null;
  return typeof metadata?.meetingId === "string" ? metadata.meetingId : documento.sourceId.split("#")[0];
}

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
  // Só as reuniões que a dona vê (H7d): a reindexação é melhor-esforço, e o
  // índice que ela não conseguiu atualizar ainda tem o documento da reunião
  // que foi para a lixeira (ou que está sendo excluída). Aqui ele sai da busca
  // na hora, sem depender da rodada. Filtro em memória, como o dos títulos.
  const reunioesDaDona = await db.select({ id: meetings.id, status: meetings.status, trashedAt: meetings.trashedAt })
    .from(meetings).where(eq(meetings.ownerId, ownerId));
  const visiveis = new Set(reunioesDaDona
    .filter(reuniao => reuniao.status !== "deleted" && !estaNaLixeira(reuniao.trashedAt))
    .map(reuniao => reuniao.id));
  const hits = documents
    .filter(document => (document.sourceType !== "meeting" && document.sourceType !== "meeting_summary") || visiveis.has(reuniaoDoDocumento(document)))
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
    .sort((left, right) => right.score - left.score);
  const porReuniao = new Map<string, number>();
  const escolhidos = hits.filter(hit => {
    const reuniao = hit.sourceType === "meeting" && typeof hit.metadata.meetingId === "string" ? hit.metadata.meetingId : null;
    if (!reuniao) return true;
    const vistas = porReuniao.get(reuniao) ?? 0;
    porReuniao.set(reuniao, vistas + 1);
    return vistas < JANELAS_DA_MESMA_REUNIAO_NA_BUSCA;
  }).slice(0, Math.max(1, Math.min(limit, 12)));
  return { hits: escolhidos, pending, truncated };
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
export const JANELA_POR_FONTE: Record<MemorySourceType, number> = { meeting: 12_000, meeting_summary: 6_000, contact: 2_500, context: 2_500 };
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
    // O resumo confirmado é citado como resumo, e não como a fala da reunião.
    const titulo = hit.sourceType === "meeting_summary" ? `Resumo confirmado da reunião ${hit.title}` : hit.title;
    const trecho = `[${index + 1}] ${titulo}\n${hit.content.slice(0, janela)}`;
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
        { role: "system", content: "Você é a Memória Inteligente da Marquesa Global Match. Responda em português somente com base no contexto privado fornecido. Nunca invente fatos. Se a evidência não for suficiente, diga isso claramente. Cite as fontes pelo número entre colchetes ao final de cada afirmação relevante. Uma fonte \"Resumo confirmado\" é o resumo da reunião conferido pela dona: cite-a pelo número dela como as outras. O que vier marcado \"de fora da reunião\" veio de uma busca na web, não da reunião: diga isso ao usá-lo." },
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
