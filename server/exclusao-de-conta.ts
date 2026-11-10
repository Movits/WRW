// Exclusão da conta pela própria dona (cartão "Não existe caminho para excluir
// os dados de uma usuária").
//
// O plano é DECLARATIVO e escrito com as tabelas e colunas do Drizzle, não com
// nomes em texto: `scripts/exame/limpeza.mjs` faz o mesmo trabalho com strings
// porque é um .mjs sem tipos, e paga o preço de precisar de um teste que confira
// cada nome contra o schema — lá, "Unknown column" e "zero linhas apagadas em
// silêncio" são o mesmo erro. Aqui um nome errado não compila.
//
// Regras que valem para cada passo:
//
// 1. NÃO HÁ FOREIGN KEY em nenhuma das 51 tabelas: nada cascateia e o que não
//    estiver listado aqui vira órfão para sempre. Por isso o plano inclui as
//    tabelas FILHAS que só conhecem o id do pai (sivc_checks pela verificação,
//    as mensagens da sala pelo id da sala, opportunity_matches pela
//    oportunidade): apagar só pela coluna de usuária deixaria o dado pessoal
//    — resultado de conferência de documento, conversa da negociação — vivo no
//    banco, sem ninguém para reclamar dele.
// 2. `users` SAI POR ÚLTIMO, e exigindo id E openId da mesma conta. Enquanto a
//    linha existe a dona consegue entrar e tentar de novo; se ela saísse
//    primeiro e a conexão caísse no meio, sobraria dado pessoal no banco sem
//    nenhuma conta capaz de pedir a exclusão outra vez. É a mesma razão pela
//    qual `deletePrivateContact` apaga o rastro antes do contato.
// 3. Coluna em que a conta aparece como ATOR SECUNDÁRIO em registro alheio
//    (quem moderou a oportunidade de outra, quem concedeu o Ouro a outra, quem
//    resolveu o evento de segurança de outra) NÃO é apagada nem anulada: a
//    linha é de outra pessoa e o registro é de um ato institucional. O que fica
//    é um inteiro apontando para conta inexistente — sem nome, sem e-mail, sem
//    nada que identifique alguém. Cada uma dessas colunas está listada em
//    ATORES_SECUNDARIOS_PRESERVADOS com a justificativa, e o teste exige que a
//    lista cubra todas as colunas de usuária do schema que o plano não apaga.
// 4. `audit_logs` perde o ruído e guarda as ações da decisão do Roberto em
//    02/09/2026 (leitura do acervo Ouro e tentativa com sessão revogada): elas
//    respondem "quem viu meus contatos" mesmo para conta encerrada. Nunca
//    UPDATE nessa tabela: ela é imutável por desenho.
// 5. Arquivo no bucket só é apagado quando a CHAVE prova a posse (o servidor a
//    montou a partir do openId ou do id da dona). Chave que veio do client
//    (`opportunity_documents.fileKey`, `user_profiles.avatarUrl`) não prova
//    nada: apagar por ela transformaria a exclusão da própria conta numa
//    exclusão de arquivo alheio. Essas linhas saem do banco e o objeto fica.
// 6. A linha de uma PARTE do áudio de reunião (meeting_audio_slices) só sai
//    quando o objeto dela saiu do bucket. Se o bucket recusou, a linha é o único
//    ponteiro para a voz de quem participou: ela fica, sem a transcrição, com o
//    prazo vencido e fora da fila (ver `fatiasComAudioNoBucket`). As gravações
//    inteiras (meeting_recordings) ainda saem do banco mesmo com o objeto no
//    bucket; a #134 aplica a elas a mesma regra.

import { and, eq, inArray, notInArray, or, sql, getTableName } from "drizzle-orm";
import type { MySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import type { exigirDb } from "./db";
import { chaveDoStorageDaDona } from "./storage";
import {
  aiMatchSuggestions, auditLogs, connections, consents, contactAssets, contactContexts,
  contactNeeds, contextMedia, contextParticipants, contexts, dealRoomDocuments,
  dealRoomMessages, dealRooms, directMessages, enrichmentMessages, enrichmentSessions,
  enrichmentSuggestions, goldAccessGrants, loginAttempts, matches, meetingAudioSlices, meetingContactSuggestions,
  meetingEntities, meetingRecordings, meetingTranscriptTranslations, meetingTranscripts,
  meetings, memoryDocuments, nationalLeaders, ndaAcceptances, opportunities,
  opportunityDocuments, opportunityInterests, opportunityMatches, passwordResetTokens,
  platformNotifications, presidentValidations, privateContacts, savedOpportunities,
  securityEvents, sessions, sivcChecks, sivcConsents, sivcDocuments, sivcVerifications,
  strategicGroups, trustedDevices, userProfiles, users,
  networkSugestoes, conexoesParticipantes, consumoDeMinutos, assinaturasDeMinutos,
} from "../drizzle/schema";

/**
 * O `db` entra por parâmetro em toda função daqui para o teste executar a
 * lógica de verdade, sem banco — o mesmo desenho de `apagarRastroDoContato`.
 */
export type Db = Awaited<ReturnType<typeof exigirDb>>;

/** As ações de auditoria que sobrevivem à exclusão (decisão do Roberto, 02/09/2026). */
export const ACOES_DE_AUDITORIA_PRESERVADAS = ["GOLD_ACERVO_READ", "REVOKED_SESSION_ACCESS_ATTEMPT"] as const;

/**
 * Chaves da conta, e os ids que só existem depois de olhar o banco:
 * - `id` (int) é o módulo institucional; `openId` (varchar) é a rede particular;
 *   `email` é como `login_attempts` guarda quem tentou entrar.
 * - `oportunidades`, `salas` e `verificacoes` são os pais cujos filhos precisam
 *   sair junto.
 */
export type ChavesDaConta = {
  id: number;
  openId: string;
  email: string | null;
  oportunidades: number[];
  salas: number[];
  verificacoes: number[];
};

type Origem = "id" | "openId" | "email" | "oportunidades" | "salas" | "verificacoes";

/**
 * O que só se sabe depois de passar pelo bucket: as partes do áudio de reunião
 * (ids de meeting_audio_slices) cujo objeto NÃO saiu. Essas linhas ficam.
 */
export type ContextoDaExclusao = {
  fatiasQueFicam: string[];
};

export type PassoDeExclusao = {
  tabela: MySqlTable;
  coluna: MySqlColumn;
  origem: Origem;
  /**
   * Segunda condição, quando a coluna sozinha não delimita a linha. O
   * `contexto` só existe depois do bucket; o passo das partes do áudio
   * (meeting_audio_slices) não filtra nada sem ele.
   */
  filtro?: (chaves: ChavesDaConta, contexto?: ContextoDaExclusao) => ReturnType<typeof sql> | undefined;
  /** Por que este passo existe, quando não é óbvio pelo nome da coluna. */
  motivo?: string;
};

/**
 * Ordem de execução: filhas antes das mães, `users` fora daqui (é o último
 * passo de `excluirConta`, com regra própria).
 */
export const PLANO_DE_EXCLUSAO: PassoDeExclusao[] = [
  // ── filhas que só conhecem o id do pai ────────────────────────────────────
  {
    tabela: sivcChecks, coluna: sivcChecks.verificationId, origem: "verificacoes",
    motivo: "campo por campo do documento de identidade conferido; só conhece a verificação",
  },
  {
    tabela: opportunityMatches, coluna: opportunityMatches.opportunityAId, origem: "oportunidades",
    motivo: "cruzamento entre oportunidades; sem a dela, o par aponta para nada",
  },
  { tabela: opportunityMatches, coluna: opportunityMatches.opportunityBId, origem: "oportunidades" },
  { tabela: presidentValidations, coluna: presidentValidations.opportunityId, origem: "oportunidades" },
  { tabela: opportunityDocuments, coluna: opportunityDocuments.opportunityId, origem: "oportunidades" },
  {
    tabela: opportunityInterests, coluna: opportunityInterests.opportunityId, origem: "oportunidades",
    motivo: "interesse de TERCEIRA na oportunidade dela: a oportunidade sai, o ponteiro não pode ficar",
  },
  { tabela: savedOpportunities, coluna: savedOpportunities.opportunityId, origem: "oportunidades" },
  {
    tabela: ndaAcceptances, coluna: ndaAcceptances.dealRoomId, origem: "salas",
    motivo: "aceite do NDA das duas pontas: a sala inteira sai, e o aceite sem sala não prova nada",
  },
  { tabela: dealRoomMessages, coluna: dealRoomMessages.dealRoomId, origem: "salas" },
  { tabela: dealRoomDocuments, coluna: dealRoomDocuments.dealRoomId, origem: "salas" },
  {
    tabela: dealRooms, coluna: dealRooms.id, origem: "salas",
    motivo: "a negociação tem duas pontas e não continua sem uma delas",
  },

  // ── rede particular: chave openId ─────────────────────────────────────────
  { tabela: aiMatchSuggestions, coluna: aiMatchSuggestions.ownerId, origem: "openId" },
  { tabela: contactAssets, coluna: contactAssets.ownerId, origem: "openId" },
  { tabela: contactNeeds, coluna: contactNeeds.ownerId, origem: "openId" },
  { tabela: memoryDocuments, coluna: memoryDocuments.ownerId, origem: "openId" },
  { tabela: meetingContactSuggestions, coluna: meetingContactSuggestions.ownerId, origem: "openId" },
  { tabela: meetingEntities, coluna: meetingEntities.ownerId, origem: "openId" },
  { tabela: meetingTranscriptTranslations, coluna: meetingTranscriptTranslations.ownerId, origem: "openId" },
  { tabela: meetingTranscripts, coluna: meetingTranscripts.ownerId, origem: "openId" },
  {
    tabela: meetingAudioSlices, coluna: meetingAudioSlices.ownerId, origem: "openId",
    filtro: (_chaves, contexto) => (contexto?.fatiasQueFicam.length
      ? notInArray(meetingAudioSlices.id, contexto.fatiasQueFicam)
      : undefined),
    motivo: "a parte cujo áudio não saiu do bucket fica, sem a transcrição, como o único ponteiro para o objeto",
  },
  { tabela: meetingRecordings, coluna: meetingRecordings.ownerId, origem: "openId" },
  { tabela: meetings, coluna: meetings.ownerId, origem: "openId" },
  { tabela: enrichmentSuggestions, coluna: enrichmentSuggestions.ownerId, origem: "openId" },
  { tabela: enrichmentMessages, coluna: enrichmentMessages.ownerId, origem: "openId" },
  { tabela: enrichmentSessions, coluna: enrichmentSessions.ownerId, origem: "openId" },
  { tabela: contextMedia, coluna: contextMedia.ownerId, origem: "openId" },
  { tabela: contextMedia, coluna: contextMedia.uploadedBy, origem: "openId" },
  { tabela: contextParticipants, coluna: contextParticipants.ownerId, origem: "openId" },
  { tabela: contactContexts, coluna: contactContexts.ownerId, origem: "openId" },
  { tabela: contexts, coluna: contexts.ownerId, origem: "openId" },
  // Meu Network Inteligente: pendências da IA (com trechos das reuniões), o
  // lado da conta nas conexões registradas e o contador de minutos. O
  // cabeçalho da conexão (conexoes_registradas) não tem coluna de usuária:
  // fica só com IDs anônimos e rótulos, sem ninguém a quem apontar.
  { tabela: networkSugestoes, coluna: networkSugestoes.ownerId, origem: "openId" },
  { tabela: conexoesParticipantes, coluna: conexoesParticipantes.ownerId, origem: "openId" },
  { tabela: consumoDeMinutos, coluna: consumoDeMinutos.ownerId, origem: "openId" },
  { tabela: privateContacts, coluna: privateContacts.ownerId, origem: "openId" },

  // ── módulo institucional: chave id ────────────────────────────────────────
  { tabela: consents, coluna: consents.userId, origem: "id" },
  { tabela: conexoesParticipantes, coluna: conexoesParticipantes.userId, origem: "id" },
  { tabela: assinaturasDeMinutos, coluna: assinaturasDeMinutos.userId, origem: "id" },
  { tabela: sivcDocuments, coluna: sivcDocuments.userId, origem: "id" },
  { tabela: sivcConsents, coluna: sivcConsents.userId, origem: "id" },
  { tabela: sivcVerifications, coluna: sivcVerifications.userId, origem: "id" },
  { tabela: nationalLeaders, coluna: nationalLeaders.userId, origem: "id" },
  { tabela: dealRoomDocuments, coluna: dealRoomDocuments.uploadedBy, origem: "id" },
  { tabela: dealRoomMessages, coluna: dealRoomMessages.senderId, origem: "id" },
  { tabela: ndaAcceptances, coluna: ndaAcceptances.userId, origem: "id" },
  { tabela: connections, coluna: connections.requesterId, origem: "id" },
  { tabela: connections, coluna: connections.recipientId, origem: "id" },
  { tabela: matches, coluna: matches.userId, origem: "id" },
  { tabela: matches, coluna: matches.matchedUserId, origem: "id" },
  { tabela: passwordResetTokens, coluna: passwordResetTokens.userId, origem: "id" },
  { tabela: trustedDevices, coluna: trustedDevices.userId, origem: "id" },
  { tabela: securityEvents, coluna: securityEvents.userId, origem: "id" },
  { tabela: sessions, coluna: sessions.userId, origem: "id" },
  { tabela: platformNotifications, coluna: platformNotifications.userId, origem: "id" },
  { tabela: directMessages, coluna: directMessages.senderId, origem: "id" },
  { tabela: directMessages, coluna: directMessages.recipientId, origem: "id" },
  { tabela: savedOpportunities, coluna: savedOpportunities.userId, origem: "id" },
  { tabela: opportunityInterests, coluna: opportunityInterests.userId, origem: "id" },
  { tabela: opportunityDocuments, coluna: opportunityDocuments.uploadedBy, origem: "id" },
  { tabela: opportunities, coluna: opportunities.publishedBy, origem: "id" },
  { tabela: strategicGroups, coluna: strategicGroups.createdBy, origem: "id" },
  { tabela: goldAccessGrants, coluna: goldAccessGrants.grantedTo, origem: "id" },
  { tabela: userProfiles, coluna: userProfiles.userId, origem: "id" },
  {
    tabela: auditLogs, coluna: auditLogs.userId, origem: "id",
    filtro: () => sql`${auditLogs.action} NOT IN (${sql.join(
      ACOES_DE_AUDITORIA_PRESERVADAS.map(acao => sql`${acao}`), sql`, `,
    )})`,
    motivo: "sai o ruído; ficam as duas ações que respondem 'quem viu meus contatos'",
  },

  // ── login_attempts guarda o e-mail em minúsculas, não o id ────────────────
  { tabela: loginAttempts, coluna: loginAttempts.identifier, origem: "email" },
];

/**
 * Colunas de usuária cuja LINHA sai por outro passo, pelo id do pai. Existem
 * para o teste não exigir um passo por coluna quando a linha já está coberta:
 * apagar a sala pelas duas pontas, por exemplo, deixaria de fora a sala que uma
 * TERCEIRA abriu numa oportunidade dela.
 */
export const COBERTAS_PELO_PAI = [
  { tabela: "deal_rooms", coluna: "ownerId", passo: "deal_rooms.id (origem salas)" },
  { tabela: "deal_rooms", coluna: "interestedId", passo: "deal_rooms.id (origem salas)" },
] as const;

/**
 * Colunas de usuária do schema que o plano NÃO apaga, com a justificativa (ver
 * regra 3 no topo). O teste exige que plano ∪ esta lista cubra o schema inteiro:
 * coluna nova de usuária quebra o teste até alguém decidir o que fazer com ela.
 */
export const ATORES_SECUNDARIOS_PRESERVADOS = [
  { tabela: "opportunities", coluna: "moderatedBy", motivo: "quem moderou a oportunidade de OUTRA; registro do ato institucional" },
  { tabela: "connections", coluna: "moderatedBy", motivo: "quem distribuiu o pedido de interesse de OUTRAS duas; registro do ato institucional (os pedidos da própria conta saem por requesterId/recipientId)" },
  { tabela: "gold_access_grants", coluna: "grantedBy", motivo: "quem concedeu o Ouro a OUTRA; a concessão é da outra" },
  { tabela: "gold_access_grants", coluna: "revokedBy", motivo: "quem revogou o Ouro de OUTRA" },
  { tabela: "national_leaders", coluna: "nominatedBy", motivo: "quem indicou OUTRA líder nacional" },
  { tabela: "national_leaders", coluna: "revokedBy", motivo: "quem revogou OUTRA líder nacional" },
  { tabela: "president_validations", coluna: "validatedBy", motivo: "quem validou a oportunidade de OUTRA (as da própria conta saem pelo passo da oportunidade)" },
  { tabela: "security_events", coluna: "resolvedBy", motivo: "quem tratou o evento de segurança de OUTRA" },
  { tabela: "enrichment_suggestions", coluna: "actionedBy", motivo: "sempre a própria dona; a linha sai pelo owner_id" },
  { tabela: "strategic_groups", coluna: "memberIds", motivo: "array JSON: a conta sai da lista com UPDATE (tirarDosGruposAlheios), não com DELETE" },
] as const;

/** Nome legível do passo, para o relatório e para o teste. */
export function nomeDoPasso(passo: PassoDeExclusao): string {
  return `${getTableName(passo.tabela)}.${passo.coluna.name}`;
}

export type RelatorioDeExclusao = {
  passos: { nome: string; linhas: number }[];
  arquivosApagados: number;
  arquivosComFalha: string[];
  linhasApagadas: number;
};

/** Descobre os ids que o plano precisa antes de apagar qualquer coisa. */
export async function lerChavesDaConta(
  db: Db,
  conta: { id: number; openId: string; email: string | null },
): Promise<ChavesDaConta> {
  const oportunidades = await db.select({ id: opportunities.id })
    .from(opportunities).where(eq(opportunities.publishedBy, conta.id));
  const idsDeOportunidade = oportunidades.map(o => o.id);
  // A sala nasce com ownerId = publishedBy da oportunidade (routers/dealRoom.ts),
  // então a sala que uma TERCEIRA abre numa oportunidade dela já entra pelas duas
  // primeiras condições; a terceira é cinto de segurança contra sala órfã.
  const condicoesDeSala = [eq(dealRooms.ownerId, conta.id), eq(dealRooms.interestedId, conta.id)];
  if (idsDeOportunidade.length) condicoesDeSala.push(inArray(dealRooms.opportunityId, idsDeOportunidade));
  const salas = await db.select({ id: dealRooms.id }).from(dealRooms).where(or(...condicoesDeSala));
  const verificacoes = await db.select({ id: sivcVerifications.id })
    .from(sivcVerifications).where(eq(sivcVerifications.userId, conta.id));

  return {
    id: conta.id,
    openId: conta.openId,
    email: conta.email ? conta.email.trim().toLowerCase() : null,
    oportunidades: idsDeOportunidade,
    salas: salas.map(s => s.id),
    verificacoes: verificacoes.map(v => v.id),
  };
}

/**
 * As chaves de storage que a conta PROVA ter (ver regra 5 no topo). Roda antes
 * dos DELETEs, porque depois dos DELETEs não há mais linha que diga onde o
 * arquivo está.
 */
export async function chavesDeArquivosDaConta(
  db: Db,
  chaves: ChavesDaConta,
): Promise<string[]> {
  const encontradas: string[] = [];
  const guardar = (chave: string | null) => { if (chave) encontradas.push(chave); };

  const contatos = await db.select({ foto: privateContacts.photoUrl, cartao: privateContacts.cardImageUrl })
    .from(privateContacts).where(eq(privateContacts.ownerId, chaves.openId));
  for (const contato of contatos) {
    if (contato.foto) guardar(chaveDoStorageDaDona("contacts", chaves.openId, contato.foto));
    if (contato.cartao) guardar(chaveDoStorageDaDona("contacts", chaves.openId, contato.cartao));
  }

  const midias = await db.select({ caminho: contextMedia.storagePath, miniatura: contextMedia.thumbnailPath })
    .from(contextMedia).where(eq(contextMedia.ownerId, chaves.openId));
  for (const midia of midias) {
    guardar(chaveDoStorageDaDona("contexts", chaves.openId, midia.caminho));
    if (midia.miniatura) guardar(chaveDoStorageDaDona("contexts", chaves.openId, midia.miniatura));
  }

  const gravacoes = await db.select({ chave: meetingRecordings.storageKey })
    .from(meetingRecordings).where(eq(meetingRecordings.ownerId, chaves.openId));
  for (const gravacao of gravacoes) guardar(chaveDoStorageDaDona("meetings", chaves.openId, gravacao.chave));

  // As partes do áudio da reunião gravada em partes: a chave também é montada
  // pelo servidor sob meetings/<openId>/, então prova a posse do mesmo jeito.
  const partes = await db.select({ chave: meetingAudioSlices.storageKey })
    .from(meetingAudioSlices).where(eq(meetingAudioSlices.ownerId, chaves.openId));
  for (const parte of partes) guardar(chaveDoStorageDaDona("meetings", chaves.openId, parte.chave));

  // SIVC e Deal Room indexam pelo id (int), não pelo openId: o prefixo é outro,
  // mas a prova de posse é a mesma — foi o servidor que montou a chave.
  const documentosSivc = await db.select({ chave: sivcDocuments.fileKey })
    .from(sivcDocuments).where(eq(sivcDocuments.userId, chaves.id));
  for (const doc of documentosSivc) {
    if (doc.chave.startsWith(`sivc/${chaves.id}/`)) guardar(doc.chave);
  }

  if (chaves.salas.length) {
    const documentosDaSala = await db.select({ chave: dealRoomDocuments.fileKey, sala: dealRoomDocuments.dealRoomId })
      .from(dealRoomDocuments).where(inArray(dealRoomDocuments.dealRoomId, chaves.salas));
    for (const doc of documentosDaSala) {
      if (doc.chave.startsWith(`deal-rooms/${doc.sala}/`)) guardar(doc.chave);
    }
  }

  return Array.from(new Set(encontradas));
}

function valoresDaOrigem(chaves: ChavesDaConta, origem: Origem): (string | number)[] {
  switch (origem) {
    case "id": return [chaves.id];
    case "openId": return [chaves.openId];
    case "email": return chaves.email ? [chaves.email] : [];
    case "oportunidades": return chaves.oportunidades;
    case "salas": return chaves.salas;
    case "verificacoes": return chaves.verificacoes;
  }
}

/**
 * Tira a conta da lista de membros dos grupos estratégicos de OUTRAS pessoas.
 * `memberIds` é um array JSON, então não há DELETE por coluna: é ler, filtrar e
 * gravar. O grupo continua sendo da criadora; só a participação sai.
 */
export async function tirarDosGruposAlheios(
  db: Db,
  id: number,
): Promise<number> {
  const grupos = await db.select({ id: strategicGroups.id, membros: strategicGroups.memberIds })
    .from(strategicGroups);
  let alterados = 0;
  for (const grupo of grupos) {
    if (!Array.isArray(grupo.membros)) continue;
    const restantes = (grupo.membros as unknown[]).filter(membro => Number(membro) !== id);
    if (restantes.length === grupo.membros.length) continue;
    await db.update(strategicGroups).set({ memberIds: restantes }).where(eq(strategicGroups.id, grupo.id));
    alterados++;
  }
  return alterados;
}

/** O que fica escrito na parte de áudio que sobra como ponteiro (frase nossa, sem dado de ninguém). */
export const MOTIVO_DA_PARTE_QUE_FICOU = "conta excluída; o áudio desta parte não saiu do bucket";

/**
 * As partes do áudio de reunião cujo objeto NÃO saiu do bucket (ids de
 * meeting_audio_slices). Casa pelo ID da linha, não pela chave: a chave de
 * `arquivosComFalha` passou por chaveDoStorageDaDona (sem "/manus-storage/",
 * sem barra no começo), e uma linha com a chave escrita de outro jeito não
 * bateria num filtro pela coluna. Só lê o banco quando algum áudio falhou.
 */
async function fatiasComAudioNoBucket(
  db: Db,
  chaves: ChavesDaConta,
  arquivosComFalha: string[],
): Promise<string[]> {
  const audiosComFalha = new Set(arquivosComFalha.filter(chave => chave.startsWith("meetings/")));
  if (!audiosComFalha.size) return [];
  const partes = await db.select({ id: meetingAudioSlices.id, chave: meetingAudioSlices.storageKey })
    .from(meetingAudioSlices).where(eq(meetingAudioSlices.ownerId, chaves.openId));
  return partes
    .filter(parte => audiosComFalha.has(chaveDoStorageDaDona("meetings", chaves.openId, parte.chave) ?? ""))
    .map(parte => parte.id);
}

/**
 * A parte que fica guarda só o ponteiro para o objeto. Perde a transcrição
 * (`result`, fala de quem participou). Sai da fila: 'failed' e sem reserva, e
 * como a fila grava o resultado com a reserva (lock_token) no WHERE, uma
 * transcrição em curso não o regrava. E vence na hora, para quem varre as
 * partes vencidas tentar o objeto de novo e só então apagar a linha.
 */
async function deixarSoOPonteiro(db: Db, chaves: ChavesDaConta, fatiasQueFicam: string[]): Promise<number> {
  const agora = Date.now();
  const [resultado] = await db.update(meetingAudioSlices).set({
    status: "failed",
    lastError: MOTIVO_DA_PARTE_QUE_FICOU,
    result: null,
    lockedUntil: null,
    lockToken: null,
    expiresAt: agora,
    updatedAt: agora,
  }).where(and(eq(meetingAudioSlices.ownerId, chaves.openId), inArray(meetingAudioSlices.id, fatiasQueFicam)));
  return Number((resultado as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/**
 * Apaga a conta e tudo que é dela. Recebe o `db` por parâmetro para o teste
 * executar a lógica de verdade, sem banco, como `apagarRastroDoContato`.
 *
 * `apagarArquivo` é injetável pelo mesmo motivo, e também porque em
 * desenvolvimento não há `STORAGE_*`: sem bucket configurado, a exclusão do
 * banco não pode parar. Falha de arquivo nunca aborta o resto — ela volta no
 * relatório, em `arquivosComFalha`, e o chamador é obrigado a contá-la para a
 * dona (ver o bloco sobre o bucket, dentro da função). Se o arquivo é parte do
 * áudio de uma reunião, a linha dela fica como ponteiro (regra 6 no topo).
 */
export async function excluirConta(
  db: Db,
  conta: { id: number; openId: string; email: string | null },
  opcoes: { apagarArquivo?: (chave: string) => Promise<void> } = {},
): Promise<RelatorioDeExclusao> {
  // Import tardio do bucket: sem ele, importar este módulo puxaria o SDK da AWS
  // para dentro do teste, que injeta o próprio apagador e nunca fala com o B2.
  const apagarArquivo = opcoes.apagarArquivo
    ?? (async (chave: string) => (await import("./storage")).storageDelete(chave));
  const chaves = await lerChavesDaConta(db, conta);
  const arquivos = await chavesDeArquivosDaConta(db, chaves);

  // Os objetos saem ANTES das linhas, porque é aqui que a linha ainda diz onde o
  // arquivo está: apagada a linha, não há mais ponteiro para o objeto.
  //
  // E O QUE ACONTECE QUANDO O BUCKET RECUSA (achado do Nicolas, 14/09): a
  // exclusão CONTINUA. O comentário antigo prometia que a falha "deixa a conta
  // de pé e a dona tenta outra vez", e o código nunca fez isso — nem deve: a
  // dona PEDIU a exclusão, e parar no meio deixaria perfil, contatos, reuniões e
  // mensagens no banco por causa de um objeto que o B2 não apagou. O que muda é
  // que a falha não some: cada chave que ficou vai para `arquivosComFalha`, sai
  // no log (aqui) e na auditoria (server/routers/conta.ts, que grava o
  // procedimento com status "failure"), e a tela mostra aviso em vez de
  // "excluídos" (client/src/components/ExcluirMinhaConta.tsx).
  const arquivosComFalha: string[] = [];
  let arquivosApagados = 0;
  for (const chave of arquivos) {
    try {
      await apagarArquivo(chave);
      arquivosApagados++;
    } catch (erro) {
      arquivosComFalha.push(chave);
      console.error(`[ExclusãoDeConta] o bucket recusou apagar um objeto (userId ${conta.id}):`, erro instanceof Error ? erro.message : erro);
    }
  }
  if (arquivosComFalha.length) {
    // Uma linha com a LISTA das chaves, e não só a contagem: daqui a pouco as
    // linhas que citavam esses objetos não existem mais (fora a das partes de
    // áudio, regra 6), e este log é o único lugar em que ainda está escrito o
    // que precisa de remoção manual no bucket.
    console.error(
      `[ExclusãoDeConta] ${arquivosComFalha.length} objeto(s) ficaram no bucket e a conta foi apagada assim mesmo (userId ${conta.id}). ` +
      `Precisam de remoção manual: ${arquivosComFalha.join(", ")}`,
    );
  }

  const passos: { nome: string; linhas: number }[] = [];
  let linhasApagadas = 0;

  // A parte do áudio cujo objeto ficou no bucket não sai (regra 6 no topo):
  // fica só como ponteiro, e o passo dela no plano deixa essas linhas de fora.
  const fatiasQueFicam = await fatiasComAudioNoBucket(db, chaves, arquivosComFalha);
  const contexto: ContextoDaExclusao = { fatiasQueFicam };
  if (fatiasQueFicam.length) {
    const linhas = await deixarSoOPonteiro(db, chaves, fatiasQueFicam);
    if (linhas > 0) passos.push({ nome: "meeting_audio_slices (ponteiro, UPDATE)", linhas });
  }

  for (const passo of PLANO_DE_EXCLUSAO) {
    const valores = valoresDaOrigem(chaves, passo.origem);
    if (!valores.length) continue;
    const condicoes = [
      valores.length === 1 ? eq(passo.coluna, valores[0]) : inArray(passo.coluna, valores),
    ];
    const extra = passo.filtro?.(chaves, contexto);
    if (extra) condicoes.push(extra);
    const [resultado] = await db.delete(passo.tabela).where(and(...condicoes));
    const linhas = Number((resultado as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
    if (linhas > 0) passos.push({ nome: nomeDoPasso(passo), linhas });
    linhasApagadas += linhas;
  }

  const gruposAlterados = await tirarDosGruposAlheios(db, conta.id);
  if (gruposAlterados > 0) passos.push({ nome: "strategic_groups.memberIds (UPDATE)", linhas: gruposAlterados });

  // Notificação que a oportunidade dela gerou em conta de TERCEIRA (alerta de
  // compatibilidade, aprovação): a chave é a URL, não a usuária. Sem isso, a
  // outra membra fica com um aviso que leva a uma página que não existe mais.
  //
  // O mesmo vale para a SALA, e aqui é pior que link morto: a notificação de
  // mensagem nova guarda os 100 primeiros caracteres do que foi escrito na sala
  // (routers/dealRoom.ts), então o texto dela continuaria legível para a
  // contraparte depois da conta apagada — exatamente o que esta rota existe
  // para impedir.
  const urlsMortas = [
    ...chaves.oportunidades.map(id => `/opportunities/${id}`),
    ...chaves.salas.map(id => `/deal-room/${id}`),
  ];
  if (urlsMortas.length) {
    const [resultado] = await db.delete(platformNotifications)
      .where(inArray(platformNotifications.actionUrl, urlsMortas));
    const linhas = Number((resultado as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
    if (linhas > 0) passos.push({ nome: "platform_notifications.actionUrl", linhas });
    linhasApagadas += linhas;
  }

  // A conta, por último, exigindo as DUAS chaves da mesma linha: um id errado
  // (ou um openId de outra conta) não apaga gente.
  const [resultadoDaConta] = await db.delete(users)
    .where(and(eq(users.id, conta.id), eq(users.openId, conta.openId)));
  const linhasDaConta = Number((resultadoDaConta as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
  passos.push({ nome: "users.id + users.openId", linhas: linhasDaConta });
  linhasApagadas += linhasDaConta;

  return { passos, arquivosApagados, arquivosComFalha, linhasApagadas };
}
