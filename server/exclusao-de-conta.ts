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
// 6. A linha do ÁUDIO de reunião, a parte (meeting_audio_slices) e a gravação
//    inteira (meeting_recordings), só sai quando o objeto dela saiu do bucket,
//    com todas as versões (`storageApagarTodasAsVersoes`: no B2, que guarda
//    versões, o DELETE simples só esconderia a voz). Se o bucket recusou, a
//    linha é o único ponteiro para a voz de quem participou: ela fica, com o
//    prazo vencido e, na parte, sem a transcrição e fora da fila (ver
//    `audiosQueFicaramNoBucket`). Sem a reunião, a varredura das gravações
//    (`limparGravacoesVencidas`) a acha e tenta o bucket de novo. O PDF da
//    reunião de documento (meeting_documents, H12) segue a mesma regra, e as
//    fotos e os desenhos do resumo (meeting_attachments, H4g e H4h) também.
// 7. O perfil de voz (H3d, server/perfil-de-voz.ts) é dado biométrico: a
//    amostra sai do bucket com TODAS as versões, como o áudio de reunião, e a
//    linha sai no plano. Antes, a exclusão registra a revogação do
//    consentimento (origem "exclusao_da_conta") em voice_profile_consents, que
//    FICA: é a prova de que houve consentimento e de quando ele acabou, sem a
//    voz. Se o bucket recusar, a chave vai para `arquivosComFalha` (log e
//    auditoria, como os outros arquivos) e a linha FICA, como a do áudio na
//    regra 6: é o único ponteiro para a voz. A linha só sai no plano quando a
//    chave dela foi lida com as outras e saiu do bucket (`perfisQueSaem`); o
//    perfil gravado ou regravado depois da leitura também fica. Sem a conta, a
//    varredura das gravações (`limparGravacoesVencidas`, ramo "perfisDeVoz")
//    o acha, tenta o bucket de novo e só então tira a linha.

import { and, eq, inArray, notInArray, or, sql, getTableName } from "drizzle-orm";
import type { MySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import type { exigirDb } from "./db";
import { ehErroDeBancoIndisponivel } from "./banco-indisponivel";
// Só o tipo: o módulo da Google Agenda continua com import tardio (excluirConta).
import type { RevogacaoNaExclusao } from "./google-agenda";
import { chaveDoStorageDaDona, CONCORRENCIA_DO_EXPURGO_DO_AUDIO } from "./storage";
import { PREFIXO_DO_PERFIL_DE_VOZ } from "@shared/perfil-de-voz";
import { comConcorrenciaLimitada } from "./concorrencia-limitada";
import {
  agendaReunioes, aiMatchSuggestions, entidadeMembros, pedidosPelaEntidade, entidades, importacaoDocumentosVistos, importacoesDeEntidade, auditLogs, chavesDeAcesso, contasGoogle, connections, consents, contactAssets, contactContexts,
  desafiosDeChaveDeAcesso, dispositivosDePush,
  contactNeeds, contextMedia, contextParticipants, contexts, dealRoomDocuments,
  dealRoomMessages, dealRooms, directMessages, enrichmentMessages, enrichmentSessions,
  enrichmentSuggestions, goldAccessGrants, loginAttempts, matches, meetingAttachments, meetingAudioSlices, meetingContactSuggestions, meetingDocuments,
  meetingEntities, meetingRecordings, meetingSummaries, meetingSummaryItems, meetingSummaryTranslations, meetingTranscriptTranslations, meetingTranscripts,
  lembretes, meetingFolders, meetings, memoryDocuments, nationalLeaders, ndaAcceptances, opportunities,
  opportunityDocuments, opportunityInterests, opportunityMatches, passwordResetTokens,
  platformNotifications, presidentValidations, privateContacts, savedOpportunities,
  securityEvents, sessions, sivcChecks, sivcConsents, sivcDocuments, sivcVerifications,
  strategicGroups, trustedDevices, userProfiles, users,
  networkSugestoes, conexoesParticipantes, consumoDeMinutos, assinaturasDeMinutos,
  proximasAcoes,
  googleAgendaConexoes,
  resumoPorEmail,
  perguntasEntreReunioes,
  modelosDeResumoProprios, preferenciasDoResumo, resumosRefeitos,
  resumoEmAudio, buscasDoComplemento,
  meetingParticipants, meetingFolderMembers, meetingFolderTasks,
  voiceProfiles,
} from "../drizzle/schema";

/**
 * O `db` entra por parâmetro em toda função daqui para o teste executar a
 * lógica de verdade, sem banco — o mesmo desenho de `apagarRastroDoContato`.
 */
export type Db = Awaited<ReturnType<typeof exigirDb>>;

/**
 * As ações de auditoria que sobrevivem à exclusão (decisão do Roberto,
 * 02/09/2026). Desde a R1a, também a lista e a consulta das reuniões pela
 * administração (MEETINGS_ADMIN_LIST e MEETING_ADMIN_READ): "quem viu as
 * minhas reuniões?" segue com resposta depois que a conta de quem consultou
 * sai. A cópia em scripts/exame/limpeza.mjs anda junto.
 */
export const ACOES_DE_AUDITORIA_PRESERVADAS = ["GOLD_ACERVO_READ", "REVOKED_SESSION_ACCESS_ATTEMPT", "MEETINGS_ADMIN_LIST", "MEETING_ADMIN_READ"] as const;

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
 * O que só se sabe depois de passar pelo bucket: o áudio de reunião cujo objeto
 * NÃO saiu, as partes (ids de meeting_audio_slices) e as gravações inteiras
 * (ids de meeting_recordings). Essas linhas ficam.
 */
export type ContextoDaExclusao = {
  fatiasQueFicam: string[];
  gravacoesQueFicam?: string[];
  /** Os PDFs das reuniões de documento (ids de meeting_documents) cujo objeto não saiu. */
  documentosQueFicam?: string[];
  /** As fotos e os desenhos do resumo (ids de meeting_attachments, H4g e H4h) cujo objeto não saiu. */
  anexosQueFicam?: string[];
  /**
   * Os perfis de voz (ids de voice_profiles, H3d) cuja amostra foi lida com as
   * outras chaves e saiu do bucket: só essas linhas saem no plano (regra 7).
   */
  perfisQueSaem?: string[];
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
  // As próximas ações (H5a): o que a dona confirmou nos resumos (com o trecho) e o que anotou.
  { tabela: proximasAcoes, coluna: proximasAcoes.ownerId, origem: "openId" },
  // Os lembretes no sino (H15): a hora de cada aviso da próxima ação e da agenda.
  // Os avisos que já saíram estão em platform_notifications, que sai pelo id.
  { tabela: lembretes, coluna: lembretes.ownerId, origem: "openId" },
  // O resumo guardado da reunião (H4), as traduções dele (H11) e os itens, que carregam trechos da transcrição.
  { tabela: meetingSummaryTranslations, coluna: meetingSummaryTranslations.ownerId, origem: "openId" },
  // O resumo por e-mail (H22): a quem a dona mandou o link (o e-mail de terceiros) e quando.
  { tabela: resumoPorEmail, coluna: resumoPorEmail.ownerId, origem: "openId" },
  // O Pergunte a várias reuniões (H6c): uma linha por pergunta, sem o conteúdo (quantas
  // reuniões, o tamanho, como terminou e a avaliação da dona), para o teto de 24 h.
  { tabela: perguntasEntreReunioes, coluna: perguntasEntreReunioes.ownerId, origem: "openId" },
  // Os modelos de resumo da dona (H4e: nome, ícone e instruções), as preferências do
  // resumo (o padrão, o estilo e o ajuste do tamanho) e o teto do refazer (só a hora).
  { tabela: modelosDeResumoProprios, coluna: modelosDeResumoProprios.ownerId, origem: "openId" },
  { tabela: preferenciasDoResumo, coluna: preferenciasDoResumo.ownerId, origem: "openId" },
  { tabela: resumosRefeitos, coluna: resumosRefeitos.ownerId, origem: "openId" },
  // O áudio do resumo com a voz do Gemini (H19b): a linha (o objeto sai antes, em
  // chavesDeArquivosDaConta) e as buscas do complemento (H4i), só para o teto de 24 h.
  { tabela: resumoEmAudio, coluna: resumoEmAudio.ownerId, origem: "openId" },
  {
    tabela: voiceProfiles, coluna: voiceProfiles.ownerId, origem: "openId",
    // Só a linha cuja amostra saiu do bucket (regra 7): sem o contexto, nada
    // a filtrar; com ele, a lista vazia não apaga nenhuma (inArray vazio é falso).
    filtro: (_chaves, contexto) => (contexto?.perfisQueSaem ? inArray(voiceProfiles.id, contexto.perfisQueSaem) : undefined),
    motivo: "o perfil de voz (H3d), dado biométrico: sai só a linha cuja amostra saiu do bucket com todas as versões; a que ficou é o único ponteiro para a voz, e a varredura a retenta",
  },
  { tabela: buscasDoComplemento, coluna: buscasDoComplemento.ownerId, origem: "openId" },
  { tabela: meetingSummaryItems, coluna: meetingSummaryItems.ownerId, origem: "openId" },
  { tabela: meetingSummaries, coluna: meetingSummaries.ownerId, origem: "openId" },
  {
    tabela: meetingAudioSlices, coluna: meetingAudioSlices.ownerId, origem: "openId",
    filtro: (_chaves, contexto) => (contexto?.fatiasQueFicam.length
      ? notInArray(meetingAudioSlices.id, contexto.fatiasQueFicam)
      : undefined),
    motivo: "a parte cujo áudio não saiu do bucket fica, sem a transcrição, como o único ponteiro para o objeto",
  },
  {
    tabela: meetingRecordings, coluna: meetingRecordings.ownerId, origem: "openId",
    filtro: (_chaves, contexto) => (contexto?.gravacoesQueFicam?.length
      ? notInArray(meetingRecordings.id, contexto.gravacoesQueFicam)
      : undefined),
    motivo: "a gravação cujo áudio não saiu do bucket fica como o único ponteiro para o objeto",
  },
  {
    tabela: meetingDocuments, coluna: meetingDocuments.ownerId, origem: "openId",
    filtro: (_chaves, contexto) => (contexto?.documentosQueFicam?.length
      ? notInArray(meetingDocuments.id, contexto.documentosQueFicam)
      : undefined),
    motivo: "o PDF da reunião de documento (H12) que não saiu do bucket fica como o único ponteiro para o objeto",
  },
  {
    tabela: meetingAttachments, coluna: meetingAttachments.ownerId, origem: "openId",
    filtro: (_chaves, contexto) => (contexto?.anexosQueFicam?.length
      ? notInArray(meetingAttachments.id, contexto.anexosQueFicam)
      : undefined),
    motivo: "a foto ou o desenho do resumo (H4g e H4h) que não saiu do bucket fica como o único ponteiro para o objeto",
  },
  // As participantes das reuniões da dona (R1b): as participações e os convites
  // pendentes (só o hash do token). Antes das reuniões, que elas apontam.
  { tabela: meetingParticipants, coluna: meetingParticipants.ownerId, origem: "openId" },
  // A agenda de reuniões (H16a): o título, a hora, o local e os participantes
  // (nome e e-mail de terceiros) que a dona marcou.
  { tabela: agendaReunioes, coluna: agendaReunioes.ownerId, origem: "openId" },
  { tabela: meetings, coluna: meetings.ownerId, origem: "openId" },
  // As pastas das reuniões (H7d): o nome, o ícone e a cor que a dona escolheu.
  // Depois das reuniões, que apontam para elas (as da lixeira saem junto, com
  // o resto das reuniões da conta).
  // Os espaços de equipe das pastas da dona (R2): as membras, os convites
  // pendentes (só o hash do token) e as tarefas da equipe. Antes das pastas.
  { tabela: meetingFolderMembers, coluna: meetingFolderMembers.ownerId, origem: "openId" },
  { tabela: meetingFolderTasks, coluna: meetingFolderTasks.ownerId, origem: "openId" },
  { tabela: meetingFolders, coluna: meetingFolders.ownerId, origem: "openId" },
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
  // A base das associações (N1): a conta de entidade leva os associados, as
  // importações e os HMACs vistos; a linha da entidade sai depois dos contatos.
  // N2: os pedidos de contato que chegaram à conta da entidade.
  { tabela: pedidosPelaEntidade, coluna: pedidosPelaEntidade.ownerId, origem: "openId" },
  { tabela: importacaoDocumentosVistos, coluna: importacaoDocumentosVistos.ownerId, origem: "openId" },
  { tabela: importacoesDeEntidade, coluna: importacoesDeEntidade.ownerId, origem: "openId" },
  {
    tabela: entidadeMembros, coluna: entidadeMembros.ownerId, origem: "openId",
    motivo: "documento e contatos cifrados dos associados; a lista de bloqueio do removido sai junto (pendência e do Dr. Ronei)",
  },
  { tabela: privateContacts, coluna: privateContacts.ownerId, origem: "openId" },
  { tabela: entidades, coluna: entidades.ownerId, origem: "openId" },

  // ── módulo institucional: chave id ────────────────────────────────────────
  { tabela: consents, coluna: consents.userId, origem: "id" },
  {
    tabela: googleAgendaConexoes, coluna: googleAgendaConexoes.userId, origem: "id",
    motivo: "a conexão com a Google Agenda (H16b): a revogação na Google vem antes do laço (revogarGoogle), e a linha sai aqui mesmo sem a confirmação dela",
  },
  { tabela: conexoesParticipantes, coluna: conexoesParticipantes.userId, origem: "id" },
  // N2: os pedidos de contato que esta conta fez a uma entidade (levam o nome dela).
  { tabela: pedidosPelaEntidade, coluna: pedidosPelaEntidade.userId, origem: "id" },
  // A conta como participante das reuniões de outras donas (R1b): ela sai de
  // todas, e a voz que a dona tinha ligado a ela volta ao nome livre ou a
  // "Falante n" (a leitura ignora a participação que não existe mais).
  { tabela: meetingParticipants, coluna: meetingParticipants.userId, origem: "id" },
  // A conta como membra das equipes de outras donas (R2): ela sai de todas.
  { tabela: meetingFolderMembers, coluna: meetingFolderMembers.userId, origem: "id" },
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
  // As chaves de acesso (A6) e os desafios de cadastro delas: a chave pública e
  // o identificador da conta que o aparelho guarda. O desafio de ENTRADA nasce
  // sem conta e vence em 5 minutos; sai pelo prazo.
  { tabela: chavesDeAcesso, coluna: chavesDeAcesso.userId, origem: "id" },
  { tabela: desafiosDeChaveDeAcesso, coluna: desafiosDeChaveDeAcesso.userId, origem: "id" },
  // Os aparelhos do push no celular: o token do Expo e o idioma da tela.
  { tabela: dispositivosDePush, coluna: dispositivosDePush.userId, origem: "id" },
  // A conta Google ligada para entrar (A8): o sub e o e-mail dela. Nenhum token
  // fica guardado, então não há o que revogar na Google.
  { tabela: contasGoogle, coluna: contasGoogle.userId, origem: "id" },
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
    motivo: "sai o ruído; ficam as ações que respondem 'quem viu meus contatos' e 'quem viu as minhas reuniões'",
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
  { tabela: "voice_profile_consents", coluna: "owner_id", motivo: "o registro dos consentimentos e das revogações do perfil de voz (H3d, pontos técnicos da Cris): sem a voz, fica como prova; a exclusão grava antes a revogação dela" },
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
  /**
   * A conexão com a Google Agenda (H16b): o token revogado na Google, nenhuma
   * conexão, a autorização mantida porque outra conta da WRW usa a mesma conta
   * Google, ou a revogação falhou (a linha sai do banco assim mesmo, e a falha
   * vai ao log, à auditoria da exclusão e ao aviso da tela).
   */
  googleAgenda: RevogacaoNaExclusao | "falhou";
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

  // O PDF da reunião de documento (H12): a chave também é montada pelo servidor
  // sob meetings/<openId>/.
  const documentos = await db.select({ chave: meetingDocuments.storageKey })
    .from(meetingDocuments).where(eq(meetingDocuments.ownerId, chaves.openId));
  for (const documento of documentos) guardar(chaveDoStorageDaDona("meetings", chaves.openId, documento.chave));

  // As fotos e os desenhos do resumo (H4g e H4h): a chave também é montada pelo
  // servidor sob meetings/<openId>/.
  const anexos = await db.select({ chave: meetingAttachments.storageKey })
    .from(meetingAttachments).where(eq(meetingAttachments.ownerId, chaves.openId));
  for (const anexo of anexos) guardar(chaveDoStorageDaDona("meetings", chaves.openId, anexo.chave));
  // O áudio do resumo (H19b): voz sintética, montada pelo servidor sob meetings/<openId>/.
  const audiosDoResumo = await db.select({ chave: resumoEmAudio.storageKey })
    .from(resumoEmAudio).where(eq(resumoEmAudio.ownerId, chaves.openId));
  for (const audio of audiosDoResumo) if (audio.chave) guardar(chaveDoStorageDaDona("meetings", chaves.openId, audio.chave));
  // A amostra do perfil de voz (H3d): montada pelo servidor sob perfis-de-voz/<openId>/.
  const perfisDeVoz = await db.select({ chave: voiceProfiles.storageKey })
    .from(voiceProfiles).where(eq(voiceProfiles.ownerId, chaves.openId));
  for (const perfil of perfisDeVoz) guardar(chaveDoStorageDaDona(PREFIXO_DO_PERFIL_DE_VOZ, chaves.openId, perfil.chave));

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
 * Os perfis de voz (H3d) que saem no plano: a chave da amostra estava entre as
 * lidas antes do bucket (`arquivos`) e não falhou. O perfil cuja amostra o
 * bucket recusou fica, e também o gravado (ou regravado) depois da leitura das
 * chaves: a amostra dele não foi tentada, e a linha é o único ponteiro para ela.
 * Sem a conta, a varredura das gravações tenta o bucket de novo (regra 7).
 */
async function perfisDeVozQueSaem(db: Db, chaves: ChavesDaConta, arquivos: string[], arquivosComFalha: string[]): Promise<string[]> {
  const perfis = await db.select({ id: voiceProfiles.id, chave: voiceProfiles.storageKey })
    .from(voiceProfiles).where(eq(voiceProfiles.ownerId, chaves.openId));
  if (!perfis.length) return [];
  const tentadas = new Set(arquivos);
  const falharam = new Set(arquivosComFalha);
  return perfis.filter(perfil => {
    const chave = chaveDoStorageDaDona(PREFIXO_DO_PERFIL_DE_VOZ, chaves.openId, perfil.chave) ?? "";
    return !!chave && tentadas.has(chave) && !falharam.has(chave);
  }).map(perfil => perfil.id);
}

/**
 * O áudio de reunião cujo objeto NÃO saiu do bucket: os ids das partes
 * (meeting_audio_slices) e das gravações inteiras (meeting_recordings). Casa
 * pelo ID da linha, não pela chave: a chave de `arquivosComFalha` passou por
 * chaveDoStorageDaDona (sem "/manus-storage/", sem barra no começo), e uma
 * linha com a chave escrita de outro jeito não bateria num filtro pela coluna.
 * Só lê o banco quando algum áudio falhou.
 */
async function audiosQueFicaramNoBucket(
  db: Db,
  chaves: ChavesDaConta,
  arquivosComFalha: string[],
): Promise<{ fatias: string[]; gravacoes: string[]; documentos: string[]; anexos: string[] }> {
  const audiosComFalha = new Set(arquivosComFalha.filter(chave => chave.startsWith("meetings/")));
  if (!audiosComFalha.size) return { fatias: [], gravacoes: [], documentos: [], anexos: [] };
  const ficou = (chave: string) => audiosComFalha.has(chaveDoStorageDaDona("meetings", chaves.openId, chave) ?? "");
  const partes = await db.select({ id: meetingAudioSlices.id, chave: meetingAudioSlices.storageKey })
    .from(meetingAudioSlices).where(eq(meetingAudioSlices.ownerId, chaves.openId));
  const gravacoes = await db.select({ id: meetingRecordings.id, chave: meetingRecordings.storageKey })
    .from(meetingRecordings).where(eq(meetingRecordings.ownerId, chaves.openId));
  const documentos = await db.select({ id: meetingDocuments.id, chave: meetingDocuments.storageKey })
    .from(meetingDocuments).where(eq(meetingDocuments.ownerId, chaves.openId));
  const anexos = await db.select({ id: meetingAttachments.id, chave: meetingAttachments.storageKey })
    .from(meetingAttachments).where(eq(meetingAttachments.ownerId, chaves.openId));
  return {
    fatias: partes.filter(parte => ficou(parte.chave)).map(parte => parte.id),
    gravacoes: gravacoes.filter(gravacao => ficou(gravacao.chave)).map(gravacao => gravacao.id),
    documentos: documentos.filter(documento => ficou(documento.chave)).map(documento => documento.id),
    anexos: anexos.filter(anexo => ficou(anexo.chave)).map(anexo => anexo.id),
  };
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
 * A gravação inteira que fica guarda só o ponteiro (a linha não tem fala de
 * ninguém: chave, tipo, tamanho e duração) e vence na hora, para a varredura
 * tentar o objeto de novo e só então apagar a linha.
 */
async function deixarSoOPonteiroDasGravacoes(db: Db, chaves: ChavesDaConta, gravacoesQueFicam: string[]): Promise<number> {
  const [resultado] = await db.update(meetingRecordings).set({ expiresAt: Date.now() })
    .where(and(eq(meetingRecordings.ownerId, chaves.openId), inArray(meetingRecordings.id, gravacoesQueFicam)));
  return Number((resultado as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/**
 * O PDF da reunião de documento (H12) que fica guarda só o ponteiro (chave,
 * tipo e tamanho, sem texto de ninguém) e vence na hora, como a gravação inteira.
 */
async function deixarSoOPonteiroDosDocumentos(db: Db, chaves: ChavesDaConta, documentosQueFicam: string[]): Promise<number> {
  const [resultado] = await db.update(meetingDocuments).set({ expiresAt: Date.now() })
    .where(and(eq(meetingDocuments.ownerId, chaves.openId), inArray(meetingDocuments.id, documentosQueFicam)));
  return Number((resultado as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

/** A foto ou o desenho do resumo (H4g e H4h) que fica guarda só o ponteiro e vence na hora, como o PDF. */
async function deixarSoOPonteiroDosAnexos(db: Db, chaves: ChavesDaConta, anexosQueFicam: string[]): Promise<number> {
  const [resultado] = await db.update(meetingAttachments).set({ expiresAt: Date.now() })
    .where(and(eq(meetingAttachments.ownerId, chaves.openId), inArray(meetingAttachments.id, anexosQueFicam)));
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
 * dona (ver o bloco sobre o bucket, dentro da função). Se o arquivo é áudio de
 * reunião (parte ou gravação inteira), a linha dele fica como ponteiro, e a
 * varredura das gravações tenta de novo (regra 6 no topo).
 *
 * `revogarGoogle` é injetável pelo mesmo motivo: revoga na Google o token da
 * Google Agenda da conta (H16b) antes de a linha dele sair no plano. Falha da
 * Google também não aborta: vai ao log e ao relatório (`googleAgenda`). Banco
 * fora do ar aborta, antes de apagar qualquer linha.
 */
export async function excluirConta(
  db: Db,
  conta: { id: number; openId: string; email: string | null },
  opcoes: {
    apagarArquivo?: (chave: string) => Promise<void>;
    revogarGoogle?: (userId: number) => Promise<RevogacaoNaExclusao>;
    registrarRevogacaoDaVoz?: (ownerId: string) => Promise<boolean>;
  } = {},
): Promise<RelatorioDeExclusao> {
  // O apagador do bucket só é montado quando o teste não injeta o próprio, e
  // UMA vez, antes do laço que roda vários arquivos ao mesmo tempo (imports
  // dinâmicos simultâneos de um módulo dublado chegavam a devolver o módulo
  // real no Vitest). O áudio de reunião (chaves meetings/) sai com todas as
  // versões; os outros arquivos (fotos, contextos, Sala, SIVC) seguem com o
  // DELETE simples.
  const apagarArquivo = opcoes.apagarArquivo ?? await (async () => {
    const bucket = await import("./storage");
    // O áudio de reunião e a amostra do perfil de voz (H3d) saem com todas as versões.
    const comVersoes = (chave: string) => chave.startsWith("meetings/") || chave.startsWith(`${PREFIXO_DO_PERFIL_DE_VOZ}/`);
    return (chave: string) => (comVersoes(chave) ? bucket.storageApagarTodasAsVersoes(chave) : bucket.storageDelete(chave));
  })();
  // Import tardio, como o do bucket: o módulo do perfil de voz traz o banco.
  const registrarRevogacaoDaVoz = opcoes.registrarRevogacaoDaVoz
    ?? (async (ownerId: string) => (await import("./perfil-de-voz")).registrarRevogacaoNaExclusao(db, ownerId));
  // Import tardio, como o do bucket: o módulo da Google Agenda só entra quando
  // a exclusão roda de verdade, e o teste injeta o próprio revogador.
  const revogarGoogle = opcoes.revogarGoogle
    ?? (async (userId: number) => (await import("./google-agenda")).revogarGoogleDaConta(db, userId));
  const chaves = await lerChavesDaConta(db, conta);

  // As reuniões da conta viram 'deleted' ANTES de ler as chaves, como na
  // exclusão de uma reunião (deletePrivateMeeting): é o sinal que uma parte
  // ainda subindo de outro aparelho lê depois do upload (receberParte), para
  // tirar o próprio objeto em vez de virar 'received' e perder a linha no plano
  // abaixo, com a voz no bucket; nenhuma parte nova entra numa reunião
  // 'deleted', e o processamento em curso também para.
  await db.update(meetings).set({ status: "deleted", updatedAt: Date.now() })
    .where(eq(meetings.ownerId, chaves.openId));
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
  //
  // Até CONCORRENCIA_DO_EXPURGO_DO_AUDIO arquivos por vez: a dona espera a
  // resposta, e cada áudio de reunião custa 4 a 5 chamadas ao bucket (uma conta
  // com reuniões longas tem centenas de partes). Todos são tentados, e o
  // relatório segue a ordem de `arquivos`.
  const tentativas = await comConcorrenciaLimitada(arquivos, CONCORRENCIA_DO_EXPURGO_DO_AUDIO, async chave => {
    try {
      await apagarArquivo(chave);
      return true;
    } catch (erro) {
      console.error(`[ExclusãoDeConta] o bucket recusou apagar um objeto (userId ${conta.id}):`, erro instanceof Error ? erro.message : erro);
      return false;
    }
  });
  const arquivosComFalha = arquivos.filter((_chave, posicao) => !tentativas[posicao]?.valor);
  const arquivosApagados = arquivos.length - arquivosComFalha.length;
  if (arquivosComFalha.length) {
    // Uma linha com a LISTA das chaves, e não só a contagem: daqui a pouco as
    // linhas que citavam esses objetos não existem mais (fora as do áudio de
    // reunião, regra 6, que a varredura retenta), e este log é o único lugar em
    // que ainda está escrito o que precisa de remoção manual no bucket.
    console.error(
      `[ExclusãoDeConta] ${arquivosComFalha.length} objeto(s) ficaram no bucket e a conta foi apagada assim mesmo (userId ${conta.id}). ` +
      `Precisam de remoção manual: ${arquivosComFalha.join(", ")}`,
    );
  }

  const passos: { nome: string; linhas: number }[] = [];
  let linhasApagadas = 0;

  // O áudio cujo objeto ficou no bucket não sai (regra 6 no topo): a parte e a
  // gravação inteira ficam só como ponteiro, e os passos delas no plano deixam
  // essas linhas de fora.
  const ficaram = await audiosQueFicaramNoBucket(db, chaves, arquivosComFalha);
  const perfisQueSaem = await perfisDeVozQueSaem(db, chaves, arquivos, arquivosComFalha);
  const contexto: ContextoDaExclusao = {
    fatiasQueFicam: ficaram.fatias, gravacoesQueFicam: ficaram.gravacoes, documentosQueFicam: ficaram.documentos, anexosQueFicam: ficaram.anexos,
    perfisQueSaem,
  };
  if (ficaram.fatias.length) {
    const linhas = await deixarSoOPonteiro(db, chaves, ficaram.fatias);
    if (linhas > 0) passos.push({ nome: "meeting_audio_slices (ponteiro, UPDATE)", linhas });
  }
  if (ficaram.gravacoes.length) {
    const linhas = await deixarSoOPonteiroDasGravacoes(db, chaves, ficaram.gravacoes);
    if (linhas > 0) passos.push({ nome: "meeting_recordings (ponteiro, UPDATE)", linhas });
  }
  if (ficaram.documentos.length) {
    const linhas = await deixarSoOPonteiroDosDocumentos(db, chaves, ficaram.documentos);
    if (linhas > 0) passos.push({ nome: "meeting_documents (ponteiro, UPDATE)", linhas });
  }
  if (ficaram.anexos.length) {
    const linhas = await deixarSoOPonteiroDosAnexos(db, chaves, ficaram.anexos);
    if (linhas > 0) passos.push({ nome: "meeting_attachments (ponteiro, UPDATE)", linhas });
  }

  // A Google Agenda (H16b) antes do laço, enquanto a linha ainda guarda o
  // token: depois do passo dela, não há mais o que revogar. Se a Google não
  // confirmar, a exclusão segue (como no bucket), e a linha sai assim mesmo:
  // a WRW esquece o token, e a dona ainda pode tirar o acesso pela conta Google.
  let googleAgenda: RelatorioDeExclusao["googleAgenda"];
  try {
    googleAgenda = await revogarGoogle(conta.id);
  } catch (erro) {
    // Banco fora do ar não é "a Google não confirmou": a leitura da conexão
    // falhou antes de falar com a Google, e seguir apagaria a única cópia de um
    // token que continua valendo lá. A exclusão para aqui, antes de apagar
    // qualquer linha, como pararia no primeiro DELETE com o banco fora.
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    googleAgenda = "falhou";
    console.error(
      `[ExclusãoDeConta] o token da Google Agenda não foi revogado na Google (userId ${conta.id}); a conexão sai do banco assim mesmo:`,
      erro instanceof Error ? erro.message : erro,
    );
  }

  // A revogação do consentimento ao perfil de voz (H3d), antes de a linha do
  // perfil sair no plano: o registro fica (regra 7 no topo).
  if (await registrarRevogacaoDaVoz(chaves.openId)) passos.push({ nome: "voice_profile_consents (revogação, INSERT)", linhas: 1 });

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

  // A conta que nasceu da ativação de um cadastro importado (N3): o associado é
  // da ENTIDADE e fica com ela, como `ativado` (a reimportação não o recria),
  // mas sem apontar para a conta que deixou de existir.
  const [desligados] = await db.update(entidadeMembros).set({ ativadoUserId: null })
    .where(eq(entidadeMembros.ativadoUserId, conta.id));
  const linhasDesligadas = Number((desligados as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
  if (linhasDesligadas > 0) passos.push({ nome: "entidade_membros.ativado_user_id (UPDATE)", linhas: linhasDesligadas });

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

  return { passos, arquivosApagados, arquivosComFalha, linhasApagadas, googleAgenda };
}
