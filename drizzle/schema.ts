import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  boolean,
  json,
  bigint,
  index,
  uniqueIndex,
  float,
  tinyint,
  mediumtext,
} from "drizzle-orm/mysql-core";
import { decimal } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/mysql-core";

/**
 * Coluna JSON que funciona em MySQL e MariaDB.
 *
 * O MariaDB não tem tipo JSON nativo: `json` é apelido de `longtext` com uma
 * checagem, então o driver entrega texto. O MySQL 8 tem o tipo de verdade e
 * entrega objeto. Sem isto, o mesmo código devolve tipos diferentes conforme o
 * motor, e qualquer `.map()` na leitura quebra só num deles.
 */
const jsonCompat = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "json",
  toDriver: valor => JSON.stringify(valor),
  fromDriver: valor => (typeof valor === "string" ? JSON.parse(valor) : valor),
});


// ============================================================
// TABELA PRINCIPAL DE USUÁRIOS
// role: bronze = Nível Bronze (recém-chegada) | silver = Nível Prata | gold = Nível Ouro | admin = moderador | president = presidente Frauen
// ============================================================
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }).unique(),
  passwordHash: text("passwordHash"),
  emailVerified: boolean("emailVerified").default(false).notNull(),
  loginMethod: varchar("loginMethod", { length: 64 }).default("email"),
  role: mysqlEnum("role", ["bronze", "silver", "gold", "admin", "president"]).default("bronze").notNull(),
  country: varchar("country", { length: 2 }),
  company: varchar("company", { length: 200 }),
  position: varchar("position", { length: 200 }),
  isActive: boolean("isActive").default(true).notNull(),
  isVerified: boolean("isVerified").default(false).notNull(),
  onboardingCompleted: boolean("onboardingCompleted").default(false).notNull(),
  // Poder de distribuição do Smart Match: a pessoa real que confere cada pedido de
  // interesse antes de encaminhá-lo. É um PODER, não um nível: acumula com qualquer
  // `role` e não é tocado por grantGoldAccess/revokeGoldAccess. Concedido e revogado
  // pelo Painel Ouro (router `distribuicao`); exigido por `distribuidorProcedure`.
  isDistributor: boolean("isDistributor").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

// ============================================================
// PERFIL PROFISSIONAL DO USUÁRIO
// ============================================================
export const userProfiles = mysqlTable("user_profiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  displayName: varchar("displayName", { length: 100 }),
  bio: text("bio"),
  gender: mysqlEnum("gender", ["male", "female", "prefer_not_to_say"]),
  avatarUrl: text("avatarUrl"),
  city: varchar("city", { length: 100 }),
  country: varchar("country", { length: 2 }),
  sectors: jsonCompat("sectors"),        // string[] — setores de atuação
  languages: jsonCompat("languages"),    // string[] — idiomas
  linkedinUrl: text("linkedinUrl"),
  websiteUrl: text("websiteUrl"),
  profileCompleteness: int("profileCompleteness").default(0),

  // --- Novos campos de perfil profissional (regras de negócio v2) ---
  company: varchar("company", { length: 200 }),           // Empresa
  personType: mysqlEnum("personType", ["individual", "legal_entity", "mei", "nonprofit"]),
  companySize: mysqlEnum("companySize", ["mei", "micro", "small", "medium", "large"]),
  companyCnpj: varchar("companyCnpj", { length: 255 }),
  jobTitle: varchar("jobTitle", { length: 200 }),          // Cargo
  activityArea: varchar("activityArea", { length: 200 }),  // Área de Atuação
  interestSectors: jsonCompat("interestSectors"),                // string[] — Setores de Interesse
  institutionalNetwork: varchar("institutionalNetwork", { length: 300 }), // Rede Institucional
  currentResources: text("currentResources"),              // Texto livre: o que a usuária tem hoje
  whatIHave: jsonCompat("whatIHave"),    // string[] — ativos/recursos disponíveis
  whatINeed: jsonCompat("whatINeed"),    // string[] — demandas/necessidades
  // DemandaDetalhada[] (shared/o-que-preciso.ts): a segunda camada de "O que
  // preciso" (Rosber, 14/09). Cada demanda separada, com categoria, dados
  // estruturados e a descrição — a necessidade DECLARADA que chega aos motores.
  whatINeedDetails: jsonCompat("whatINeedDetails"),

  // --- Campos do sistema de matching (MMM original) ---
  primarySpecialty: varchar("primarySpecialty", { length: 100 }),
  secondarySpecialties: jsonCompat("secondarySpecialties"),
  // LEGADO: duplicam jobTitle/company. Ninguém mais grava aqui; a leitura só as
  // usa quando jobTitle/company estão vazios (server/perfil-consolidado.ts).
  // Saem na etapa 2 da consolidação, depois de copiadas.
  currentRole: varchar("currentRole", { length: 200 }),
  currentCompany: varchar("currentCompany", { length: 200 }),
  sector: varchar("sector", { length: 100 }),
  seekingTypes: jsonCompat("seekingTypes"),
  // Texto obrigatório de "Outra necessidade" em "O que você busca?"
  // (shared/o-que-busca.ts): necessidade DECLARADA pela própria pessoa.
  seekingOtherNeed: text("seekingOtherNeed"),
  shortTermGoal: text("shortTermGoal"),   // Objetivo de curto prazo (próximos 12 meses)
  longTermGoal: text("longTermGoal"),     // Objetivo de longo prazo (3–5 anos)
  businessInterests: jsonCompat("businessInterests"),
  preferredCompanySize: varchar("preferredCompanySize", { length: 50 }),
  openToRemote: boolean("openToRemote").default(false),
  availableForTravel: boolean("availableForTravel").default(false),
  workStyle: varchar("workStyle", { length: 50 }),
  values: jsonCompat("values"),
  incomeRange: varchar("incomeRange", { length: 50 }),
  investmentCapacity: varchar("investmentCapacity", { length: 50 }),
  lookingForInvestment: boolean("lookingForInvestment").default(false),
  investmentAmountSeeking: varchar("investmentAmountSeeking", { length: 50 }),
  experienceYears: int("experienceYears"),
  educationLevel: varchar("educationLevel", { length: 50 }),
  age: int("age"),
  encryptedSensitiveData: text("encryptedSensitiveData"),
  lastAiAnalysisAt: timestamp("lastAiAnalysisAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  userIdIdx: index("profile_userId_idx").on(table.userId),
  countryIdx: index("profile_country_idx").on(table.country),
}));

// ============================================================
// OPORTUNIDADES — CORE DA PLATAFORMA FRAUEN
// type: offer=oferta | demand=demanda | investment=investimento | partnership=parceria | other
// complianceLevel: green/yellow/orange/red (calculado pela IA)
// isConfidential: true = visível apenas para usuários Ouro
// ============================================================
export const opportunities = mysqlTable("opportunities", {
  id: int("id").autoincrement().primaryKey(),
  publishedBy: int("publishedBy").notNull(),   // userId

  title: varchar("title", { length: 300 }).notNull(),
  description: text("description").notNull(),
  type: mysqlEnum("type", [
    "offer",          // oferta de produto/serviço/commodity
    "demand",         // demanda de compra/importação
    "investment",     // projeto de investimento
    "partnership",    // parceria comercial
    "distribution",   // busca de distribuidores/representantes
    "other"
  ]).notNull(),
  sector: varchar("sector", { length: 100 }),
  country: varchar("country", { length: 2 }),
  region: varchar("region", { length: 100 }),  // continente ou região
  tags: jsonCompat("tags"),                           // string[] — palavras-chave

  // Compliance e confiabilidade
  frauenTrustScore: float("frauenTrustScore").default(0),   // 0-100
  complianceLevel: mysqlEnum("complianceLevel", [
    "green", "yellow", "orange", "red", "pending"
  ]).default("pending").notNull(),
  complianceExplanation: text("complianceExplanation"),     // texto da IA explicando a classificação
  suggestedDocuments: jsonCompat("suggestedDocuments"),           // string[] — documentos sugeridos pela IA
  lastComplianceAt: timestamp("lastComplianceAt"),

  // Visibilidade
  isConfidential: boolean("isConfidential").default(false).notNull(),  // true = apenas Ouro
  status: mysqlEnum("status", [
    "draft",     // rascunho
    "pending",   // aguardando moderação
    "active",    // publicada
    "rejected",  // rejeitada pelo admin
    "closed",    // encerrada
    "removed"    // retirada por uma membra Ouro
  ]).default("pending").notNull(),
  moderatedBy: int("moderatedBy"),
  moderationNote: text("moderationNote"),
  moderatedAt: timestamp("moderatedAt"),

  viewCount: int("viewCount").default(0),
  interestCount: int("interestCount").default(0),
  expiresAt: timestamp("expiresAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  publishedByIdx: index("opp_publishedBy_idx").on(table.publishedBy),
  typeIdx: index("opp_type_idx").on(table.type),
  statusIdx: index("opp_status_idx").on(table.status),
  sectorIdx: index("opp_sector_idx").on(table.sector),
  countryIdx: index("opp_country_idx").on(table.country),
  complianceIdx: index("opp_compliance_idx").on(table.complianceLevel),
  ftsIdx: index("opp_fts_idx").on(table.frauenTrustScore),
}));

// ============================================================
// DOCUMENTOS ANEXADOS ÀS OPORTUNIDADES
// ============================================================
export const opportunityDocuments = mysqlTable("opportunity_documents", {
  id: int("id").autoincrement().primaryKey(),
  opportunityId: int("opportunityId").notNull(),
  uploadedBy: int("uploadedBy").notNull(),
  name: varchar("name", { length: 300 }).notNull(),
  url: text("url").notNull(),
  fileKey: varchar("fileKey", { length: 500 }).notNull(),
  mimeType: varchar("mimeType", { length: 100 }),
  sizeBytes: bigint("sizeBytes", { mode: "number" }),
  isConfidential: boolean("isConfidential").default(false).notNull(),  // true = apenas Ouro
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  opportunityIdx: index("doc_opportunity_idx").on(table.opportunityId),
}));

// ============================================================
// INTERESSES EM OPORTUNIDADES
// Prata pode demonstrar interesse; Ouro vê quem demonstrou
// ============================================================
export const opportunityInterests = mysqlTable("opportunity_interests", {
  id: int("id").autoincrement().primaryKey(),
  opportunityId: int("opportunityId").notNull(),
  userId: int("userId").notNull(),
  message: text("message"),
  status: mysqlEnum("status", ["pending", "viewed", "contacted", "declined"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  opportunityIdx: index("interest_opp_idx").on(table.opportunityId),
  userIdx: index("interest_user_idx").on(table.userId),
}));

// ============================================================
// OPORTUNIDADES SALVAS (BOOKMARKS)
// ============================================================
export const savedOpportunities = mysqlTable("saved_opportunities", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  opportunityId: int("opportunityId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("saved_user_idx").on(table.userId),
  oppIdx: index("saved_opp_idx").on(table.opportunityId),
}));

// ============================================================
// MATCHES ENTRE OPORTUNIDADES (IA conecta oportunidades complementares)
// ============================================================
export const opportunityMatches = mysqlTable("opportunity_matches", {
  id: int("id").autoincrement().primaryKey(),
  opportunityAId: int("opportunityAId").notNull(),
  opportunityBId: int("opportunityBId").notNull(),
  score: float("score").notNull(),                // 0-100
  aiExplanation: text("aiExplanation"),           // por que são complementares
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  oppAIdx: index("omatch_oppA_idx").on(table.opportunityAId),
  oppBIdx: index("omatch_oppB_idx").on(table.opportunityBId),
  scoreIdx: index("omatch_score_idx").on(table.score),
}));

// ============================================================
// GRUPOS ESTRATÉGICOS (apenas Ouro)
// ============================================================
export const strategicGroups = mysqlTable("strategic_groups", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  createdBy: int("createdBy").notNull(),
  memberIds: jsonCompat("memberIds"),    // number[] — userIds dos membros
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  createdByIdx: index("group_createdBy_idx").on(table.createdBy),
}));

// ============================================================
// MENSAGENS DIRETAS ENTRE USUÁRIOS OURO
// ============================================================
export const directMessages = mysqlTable("direct_messages", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  senderId: int("senderId").notNull(),
  recipientId: int("recipientId"),   // null = mensagem de grupo
  groupId: int("groupId"),
  encryptedContent: text("encryptedContent").notNull(),
  isRead: boolean("isRead").default(false),
  readAt: timestamp("readAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  senderIdx: index("dm_sender_idx").on(table.senderId),
  recipientIdx: index("dm_recipient_idx").on(table.recipientId),
  groupIdx: index("dm_group_idx").on(table.groupId),
}));

// ============================================================
// CONCESSÃO DE ACESSO OURO (gerenciado pelos Presidentes)
// ============================================================
export const goldAccessGrants = mysqlTable("gold_access_grants", {
  id: int("id").autoincrement().primaryKey(),
  grantedTo: int("grantedTo").notNull(),    // userId que recebeu acesso Ouro
  grantedBy: int("grantedBy").notNull(),    // userId do presidente que concedeu
  reason: text("reason"),
  revokedAt: timestamp("revokedAt"),
  revokedBy: int("revokedBy"),
  revokeReason: text("revokeReason"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  grantedToIdx: index("gold_grantedTo_idx").on(table.grantedTo),
  grantedByIdx: index("gold_grantedBy_idx").on(table.grantedBy),
}));

// ============================================================
// NOTIFICAÇÕES DA PLATAFORMA
// ============================================================
export const platformNotifications = mysqlTable("platform_notifications", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", [
    "new_match", "interest_received", "gold_granted", "gold_revoked",
    "opportunity_approved", "opportunity_rejected", "new_message",
    "compliance_update", "system"
  ]).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body"),
  actionUrl: varchar("actionUrl", { length: 500 }),
  isRead: boolean("isRead").default(false),
  readAt: timestamp("readAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("pnotif_userId_idx").on(table.userId),
  typeIdx: index("pnotif_type_idx").on(table.type),
}));

// ============================================================
// TABELAS DE SEGURANÇA (MANTIDAS)
// ============================================================
export const sessions = mysqlTable("sessions", {
  id: int("id").autoincrement().primaryKey(),
  sessionToken: varchar("sessionToken", { length: 128 }).notNull().unique(),
  userId: int("userId").notNull(),
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: text("userAgent"),
  deviceFingerprint: varchar("deviceFingerprint", { length: 64 }),
  isTrustedDevice: boolean("isTrustedDevice").default(false),
  isActive: boolean("isActive").default(true).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  lastActivityAt: timestamp("lastActivityAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("session_userId_idx").on(table.userId),
  tokenIdx: index("session_token_idx").on(table.sessionToken),
}));

export const auditLogs = mysqlTable("audit_logs", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  userId: int("userId"),
  action: varchar("action", { length: 100 }).notNull(),
  resource: varchar("resource", { length: 100 }),
  resourceId: varchar("resourceId", { length: 64 }),
  details: jsonCompat("details"),
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: text("userAgent"),
  status: mysqlEnum("status", ["success", "failure", "blocked"]).default("success").notNull(),
  riskLevel: mysqlEnum("riskLevel", ["low", "medium", "high", "critical"]).default("low").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("audit_userId_idx").on(table.userId),
  actionIdx: index("audit_action_idx").on(table.action),
  createdAtIdx: index("audit_createdAt_idx").on(table.createdAt),
}));

export const loginAttempts = mysqlTable("login_attempts", {
  id: int("id").autoincrement().primaryKey(),
  identifier: varchar("identifier", { length: 320 }).notNull(),
  ipAddress: varchar("ipAddress", { length: 45 }).notNull(),
  success: boolean("success").default(false).notNull(),
  blockedUntil: timestamp("blockedUntil"),
  attemptCount: int("attemptCount").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  identifierIdx: index("attempts_identifier_idx").on(table.identifier),
  ipIdx: index("attempts_ip_idx").on(table.ipAddress),
}));

export const securityEvents = mysqlTable("security_events", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId"),
  eventType: mysqlEnum("eventType", [
    "failed_login", "suspicious_ip", "multiple_sessions",
    "brute_force_attempt", "unusual_location", "account_locked",
    "password_reset", "mfa_failed", "data_export", "admin_access",
  ]).notNull(),
  severity: mysqlEnum("severity", ["info", "warning", "critical"]).default("info").notNull(),
  ipAddress: varchar("ipAddress", { length: 45 }),
  details: jsonCompat("details"),
  resolved: boolean("resolved").default(false).notNull(),
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: int("resolvedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("security_userId_idx").on(table.userId),
  eventTypeIdx: index("security_eventType_idx").on(table.eventType),
}));

export const trustedDevices = mysqlTable("trusted_devices", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  deviceName: varchar("deviceName", { length: 100 }),
  deviceFingerprint: varchar("deviceFingerprint", { length: 64 }).notNull(),
  userAgent: text("userAgent"),
  ipAddress: varchar("ipAddress", { length: 45 }),
  isActive: boolean("isActive").default(true).notNull(),
  lastUsedAt: timestamp("lastUsedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("device_userId_idx").on(table.userId),
}));

// ============================================================
// MATCHES ENTRE PERFIS DE USUÁRIOS (sistema original MMM)
// ============================================================
export const matches = mysqlTable("matches", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  matchedUserId: int("matchedUserId"),
  overallScore: int("overallScore").default(0).notNull(),
  specialtyScore: int("specialtyScore").default(0),
  objectivesScore: int("objectivesScore").default(0),
  incomeScore: int("incomeScore").default(0),
  locationScore: int("locationScore").default(0),
  valuesScore: int("valuesScore").default(0),
  aiInsight: text("aiInsight"),
  aiGeneratedAt: timestamp("aiGeneratedAt"),
  userSeen: boolean("userSeen").default(false).notNull(),
  userDismissed: boolean("userDismissed").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("match_userId_idx").on(table.userId),
  matchedUserIdIdx: index("match_matchedUserId_idx").on(table.matchedUserId),
  scoreIdx: index("match_score_idx").on(table.overallScore),
  // Um match entre duas usuárias é único. Sem isto, cada "Reanalisar matches"
  // reinseria o conjunto inteiro (o insert não tinha upsert e nada no banco
  // segurava a duplicata), e quem tinha sido dispensado voltava como linha nova.
  // A regeneração agora faz upsert contra esta chave.
  matchPairUnq: uniqueIndex("match_user_matched_unq").on(table.userId, table.matchedUserId),
}));

// ============================================================
// CONEXÕES ENTRE USUÁRIOS (pedidos de contato)
// ============================================================
// Pedido de interesse do Smart Match. Máquina de estados (docs/arquitetura/fluxos.md):
//   in_review     → nasceu; espera o DISTRIBUIDOR conferir (a destinatária não vê)
//   pending       → encaminhado; espera a destinatária aceitar ou recusar
//   accepted      → interesse mútuo: os nomes aparecem para as duas partes
//   declined      → a destinatária recusou
//   not_forwarded → o distribuidor não encaminhou (a destinatária nunca soube)
//   blocked       → histórico
// `reciprocatedAt` marca que a destinatária TAMBÉM clicou enquanto o pedido estava
// em análise: uma linha só por par, e a aprovação já revela os dois nomes.
export const connections = mysqlTable("connections", {
  id: int("id").autoincrement().primaryKey(),
  requesterId: int("requesterId").notNull(),
  recipientId: int("recipientId").notNull(),
  status: mysqlEnum("status", ["pending", "accepted", "declined", "blocked", "in_review", "not_forwarded"]).default("pending").notNull(),
  message: text("message"),
  // Trilha do distribuidor, com os mesmos nomes de `opportunities`.
  moderatedBy: int("moderatedBy"),
  moderationNote: text("moderationNote"),
  moderatedAt: timestamp("moderatedAt"),
  reciprocatedAt: timestamp("reciprocatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  requesterIdx: index("conn_requester_idx").on(table.requesterId),
  recipientIdx: index("conn_recipient_idx").on(table.recipientId),
  // A fila do distribuidor é `WHERE status = 'in_review'`.
  statusIdx: index("conn_status_idx").on(table.status),
}));

// ============================================================
// RECUPERAÇÃO DE SENHA
// ============================================================
export const passwordResetTokens = mysqlTable("password_reset_tokens", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  token: varchar("token", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index("prt_token_idx").on(table.token),
  userIdIdx: index("prt_userId_idx").on(table.userId),
}));

/** Registro mínimo para limitar pedidos de recuperação por endereço IP. */
export const passwordResetRequests = mysqlTable("password_reset_requests", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ipAddress: varchar("ip_address", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  ipCreatedIdx: index("prr_ip_created_idx").on(table.ipAddress, table.createdAt),
}));

// ============================================================
// CAMPOS EXTRAS DO PERFIL (sistema original MMM)
// Adicionados ao userProfiles via colunas extras para compatibilidade
// ============================================================

// ============================================================
// DEAL ROOM — SALA DE NEGOCIAÇÃO PRIVADA
// Criada quando uma membra demonstra interesse em uma oportunidade
// ============================================================
export const dealRooms = mysqlTable("deal_rooms", {
  id: int("id").autoincrement().primaryKey(),
  opportunityId: int("opportunityId").notNull(),
  ownerId: int("ownerId").notNull(),          // dona da oportunidade
  interestedId: int("interestedId").notNull(), // quem demonstrou interesse
  status: mysqlEnum("status", [
    "awaiting_nda",   // aguardando aceite do NDA por ambas as partes
    "active",         // NDA aceito por ambas — sala ativa
    "closed",         // encerrada
  ]).default("awaiting_nda").notNull(),
  // NDA — aceite digital
  ndaAcceptedByOwner: boolean("ndaAcceptedByOwner").default(false).notNull(),
  ndaAcceptedByOwnerAt: timestamp("ndaAcceptedByOwnerAt"),
  ndaAcceptedByInterested: boolean("ndaAcceptedByInterested").default(false).notNull(),
  ndaAcceptedByInterestedAt: timestamp("ndaAcceptedByInterestedAt"),
  // Metadados
  interestMessage: text("interestMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  opportunityIdx: index("dr_opportunity_idx").on(table.opportunityId),
  ownerIdx: index("dr_owner_idx").on(table.ownerId),
  interestedIdx: index("dr_interested_idx").on(table.interestedId),
}));

// Trilha de auditoria do aceite do NDA (etapa 13). Os booleanos em deal_rooms
// continuam mandando no fluxo; esta tabela é prova, não estado: quem aceitou,
// de onde, e o texto que estava na tela. O texto do NDA vem do i18n do cliente
// e varia por idioma — por isso a linha guarda idioma e texto exibidos, com o
// hash SHA-256 calculado no servidor. Aceites antigos não têm linha aqui.
export const ndaAcceptances = mysqlTable("nda_acceptances", {
  id: int("id").autoincrement().primaryKey(),
  dealRoomId: int("dealRoomId").notNull(),
  userId: int("userId").notNull(),
  papel: mysqlEnum("papel", ["owner", "interested"]).notNull(),
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: text("userAgent"),
  locale: varchar("locale", { length: 10 }),
  textoExibido: text("textoExibido"),
  textoHash: varchar("textoHash", { length: 64 }),
  acceptedAt: timestamp("acceptedAt").defaultNow().notNull(),
}, (table) => ({
  roomIdx: index("nda_acc_room_idx").on(table.dealRoomId),
  userIdx: index("nda_acc_user_idx").on(table.userId),
}));

// Mensagens do chat privado dentro do Deal Room
export const dealRoomMessages = mysqlTable("deal_room_messages", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  dealRoomId: int("dealRoomId").notNull(),
  senderId: int("senderId").notNull(),
  content: text("content").notNull(),
  isRead: boolean("isRead").default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  roomIdx: index("drm_room_idx").on(table.dealRoomId),
  senderIdx: index("drm_sender_idx").on(table.senderId),
}));

// Documentos confidenciais compartilhados dentro do Deal Room
export const dealRoomDocuments = mysqlTable("deal_room_documents", {
  id: int("id").autoincrement().primaryKey(),
  dealRoomId: int("dealRoomId").notNull(),
  uploadedBy: int("uploadedBy").notNull(),
  name: varchar("name", { length: 300 }).notNull(),
  fileKey: varchar("fileKey", { length: 500 }).notNull(),
  url: text("url").notNull(),
  mimeType: varchar("mimeType", { length: 100 }),
  sizeBytes: bigint("sizeBytes", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  roomIdx: index("drd_room_idx").on(table.dealRoomId),
}));

// ============================================================
// BASE PARTICULAR DE CONTATOS (Minha Rede de Relacionamentos)
// Isolamento total por ownerId — RLS obrigatório em todas as queries
// ============================================================
export const privateContacts = mysqlTable("private_contacts", {
  id:           bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  ownerId:      varchar("ownerId", { length: 128 }).notNull(),

  fullName:     varchar("fullName",  { length: 200 }).notNull(),
  photoUrl:     varchar("photoUrl",  { length: 512 }),
  jobTitle:     varchar("jobTitle",  { length: 200 }),
  company:      varchar("company",   { length: 200 }),

  country:      varchar("country",   { length: 100 }),
  state:        varchar("state",     { length: 100 }),
  city:         varchar("city",      { length: 100 }),

  phone:        varchar("phone",     { length: 50 }),
  whatsapp:     varchar("whatsapp",  { length: 50 }),
  email:        varchar("email",     { length: 254 }),

  linkedinUrl:  varchar("linkedinUrl",  { length: 512 }),
  instagram:    varchar("instagram",    { length: 100 }),

  profileTags:  jsonCompat("profileTags").$type<string[]>(),

  // Etapas 8/10 — o nível de visibilidade escolhido pela DONA (privacidade.md):
  // 'privado' (só a dona — o padrão, nada vira público por omissão), 'publico'
  // (o contato entra na vitrine do ecossistema SÓ como oportunidade: país,
  // cidade e o que possui/procura — nenhuma coluna pessoal é sequer lida) e
  // 'ouro' (etapa 10: entra no acervo Ouro, lido apenas por membras com Status
  // Ouro — listAcervoOuro em server/db.ts. Os níveis NÃO são cumulativos:
  // 'publico' expõe só a oportunidade a todas, 'ouro' expõe os campos
  // estratégicos do cartão só a Ouro — pendência nº 2 de decisoes-em-aberto.md).
  // O índice existe porque a vitrine consulta por nível SEM ownerId — é a
  // única leitura legítima que atravessa donas, e sem índice ela viraria um
  // full-scan da tabela inteira do ecossistema a cada visita à tela.
  nivelVisibilidade: varchar("nivel_visibilidade", { length: 10, enum: ["privado", "ouro", "publico"] }).default("privado").notNull(),

  cardImageUrl: varchar("cardImageUrl", { length: 512 }),
  cardOcrText:  text("cardOcrText"),

  notes:        text("notes"),
  // Selo "IA em andamento" na lista da Rede. A coluna sempre existiu no banco
  // (era do Manus) mas não estava declarada aqui — o drizzle descartava a chave
  // nos updates (sobrava UPDATE sem SET, erro de SQL ao iniciar o chat de
  // enriquecimento) e nos selects (o selo nunca aparecia). O `as any` nos
  // chamadores escondia tudo.
  enrichmentStatus: varchar("enrichment_status", { length: 20 }),

  // Meu Network Inteligente (spec da Glenda de 14/09, itens 6, 13 e 14).
  // ID ANÔNIMO do contato no formato do pedido (NW-7F29A4): aleatório,
  // guardado e estável — nunca derivado do id sequencial nem do segredo do
  // servidor, que ao girar trocaria todos os IDs já registrados em conexões.
  // Nulo nos contatos antigos até a primeira leitura do painel preencher
  // (server/network-codigo-anonimo.ts). NULLs não colidem no índice único.
  codigoAnonimo: varchar("codigo_anonimo", { length: 16 }),
  // "Disponibilizar este contato para oportunidades da rede": SIM/NÃO, padrão
  // NÃO. Com SIM, o cruzamento com a rede global lê SÓ o ID anônimo e o que o
  // contato tem e precisa (server/network-rede-global.ts).
  disponivelRedeGlobal: boolean("disponivel_rede_global").default(false).notNull(),
  disponibilidadeAlteradaEm: bigint("disponibilidade_alterada_em", { mode: "number" }),
  // QUEM SOU pode distinguir pessoa física de jurídica (item 6); nulo = não informado.
  tipoPessoa: varchar("tipo_pessoa", { length: 10, enum: ["fisica", "juridica"] }),

  createdAt:    bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:    bigint("updatedAt", { mode: "number" }).notNull(),
}, (table) => ({
  codigoAnonimoUnique: uniqueIndex("pc_codigo_anonimo_unique").on(table.codigoAnonimo),
  // A leitura da rede global atravessa donas por esta coluna, como a vitrine
  // pelo nível: sem índice, cada cruzamento varreria a tabela inteira.
  disponivelIdx:   index("pc_disponivel_rede_global_idx").on(table.disponivelRedeGlobal),
  ownerIdx:        index("pc_owner_idx").on(table.ownerId),
  ownerNameIdx:    index("pc_owner_name_idx").on(table.ownerId, table.fullName),
  ownerCompanyIdx: index("pc_owner_company_idx").on(table.ownerId, table.company),
  ownerCountryIdx: index("pc_owner_country_idx").on(table.ownerId, table.country),
  ownerUpdatedIdx: index("pc_owner_updated_idx").on(table.ownerId, table.updatedAt),
  nivelIdx:        index("pc_nivel_idx").on(table.nivelVisibilidade),
}));

// ============================================================
// TIPOS EXPORTADOS
// ============================================================
// ============================================================
// SIVC — Sistema de Verificação de Identidade e Credenciais
//
// Estas tabelas existiam apenas em SQL escrito à mão dentro de
// server/routers/sivc.ts. Sem definição aqui, a migração gerada não as cria e
// um banco novo sobe com o módulo inteiro quebrado — foi o que apareceu ao
// preparar o deploy. As colunas foram reconstruídas a partir das queries.
//
// Os campos de status usam varchar em vez de mysqlEnum de propósito: os
// valores gravados vêm do OCR e de constantes do router, e um enum
// incompleto rejeitaria a escrita em produção.
// ============================================================

export const sivcVerifications = mysqlTable("sivc_verifications", {
  id:               int("id").autoincrement().primaryKey(),
  userId:           int("userId").notNull(),
  status:           varchar("status", { length: 32 }).default("in_progress").notNull(),
  level:            varchar("level", { length: 32 }),
  overallScore:     int("overallScore").default(0),
  mandatoryPassed:  boolean("mandatoryPassed").default(false),
  consentGrantedAt: timestamp("consentGrantedAt"),
  createdAt:        timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("sivc_ver_user_idx").on(table.userId),
}));

export const sivcConsents = mysqlTable("sivc_consents", {
  id:          int("id").autoincrement().primaryKey(),
  userId:      int("userId").notNull(),
  consentType: varchar("consentType", { length: 64 }).notNull(),
  ipAddress:   varchar("ipAddress", { length: 45 }),
  payloadJson: jsonCompat("payloadJson"),
  createdAt:   timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("sivc_con_user_idx").on(table.userId),
}));

// O índice único é obrigatório, não decorativo: o router faz
// INSERT ... ON DUPLICATE KEY UPDATE nesta tripla. Sem ele, cada
// atualização de um campo criaria uma linha nova em vez de sobrescrever.
export const sivcChecks = mysqlTable("sivc_checks", {
  id:              int("id").autoincrement().primaryKey(),
  verificationId:  int("verificationId").notNull(),
  module:          varchar("module", { length: 64 }).notNull(),
  field:           varchar("field", { length: 64 }).notNull(),
  declaredValue:   text("declaredValue"),
  verifiedValue:   text("verifiedValue"),
  status:          varchar("status", { length: 32 }).default("unverified").notNull(),
  confidenceScore: int("confidenceScore").default(0),
  weight:          int("weight").default(1),
  isMandatory:     boolean("isMandatory").default(false),
  source:          varchar("source", { length: 64 }),
  auditLog:        jsonCompat("auditLog"),
  createdAt:       timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  checkUnq: uniqueIndex("sivc_chk_unq").on(table.verificationId, table.module, table.field),
}));

export const sivcDocuments = mysqlTable("sivc_documents", {
  id:              int("id").autoincrement().primaryKey(),
  verificationId:  int("verificationId").notNull(),
  userId:          int("userId").notNull(),
  module:          varchar("module", { length: 64 }).notNull(),
  docType:         varchar("docType", { length: 64 }).notNull(),
  fileKey:         varchar("fileKey", { length: 500 }).notNull(),
  url:             text("url"),
  mimeType:        varchar("mimeType", { length: 100 }),
  sizeBytes:       bigint("sizeBytes", { mode: "number" }),
  ocrStatus:       varchar("ocrStatus", { length: 32 }).default("processing").notNull(),
  ocrText:         text("ocrText"),
  extractedData:   jsonCompat("extractedData"),
  confidenceScore: int("confidenceScore").default(0),
  createdAt:       timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  verIdx: index("sivc_doc_ver_idx").on(table.verificationId),
  // Nenhuma TELA filtra por usuária (o painel entra por verificationId, que já
  // tem o índice acima). Quem lê este HOJE é `scripts/exame/limpeza.mjs`, que
  // apaga sivc_documents por userId ao limpar as contas do exame de produção —
  // e amanhã a exclusão de conta, que faz o mesmo. Sem ele, apagar uma conta
  // varre a tabela de documentos de identidade inteira. É índice de escrita
  // rara e exclusão confiável, não de consulta: não tire achando que é morto.
  userIdx: index("sivc_doc_user_idx").on(table.userId),
}));

// ============================================================
// GOVERNANÇA — validação da presidência e líderes regionais
// Mesma situação das tabelas do SIVC: só existiam em SQL cru, em
// server/routers/president.ts.
// ============================================================

// Uma validação por oportunidade: o router faz upsert por opportunityId.
export const presidentValidations = mysqlTable("president_validations", {
  id:            int("id").autoincrement().primaryKey(),
  opportunityId: int("opportunityId").notNull(),
  validatedBy:   int("validatedBy").notNull(),
  status:        varchar("status", { length: 32 }).notNull(),
  note:          text("note"),
  createdAt:     timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  oppUnq: uniqueIndex("pres_val_opp_unq").on(table.opportunityId),
}));

export const nationalLeaders = mysqlTable("national_leaders", {
  id:           int("id").autoincrement().primaryKey(),
  userId:       int("userId").notNull(),
  nominatedBy:  int("nominatedBy").notNull(),
  region:       varchar("region", { length: 120 }).notNull(),
  specialty:    varchar("specialty", { length: 200 }),
  isActive:     boolean("isActive").default(true).notNull(),
  revokedAt:    timestamp("revokedAt"),
  revokedBy:    int("revokedBy"),
  revokeReason: text("revokeReason"),
  createdAt:    timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  activeIdx: index("nat_lead_active_idx").on(table.isActive),
  userIdx:   index("nat_lead_user_idx").on(table.userId),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type Match = typeof matches.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;
export type Opportunity = typeof opportunities.$inferSelect;
export type InsertOpportunity = typeof opportunities.$inferInsert;
export type OpportunityDocument = typeof opportunityDocuments.$inferSelect;
export type OpportunityInterest = typeof opportunityInterests.$inferSelect;
export type SavedOpportunity = typeof savedOpportunities.$inferSelect;
export type OpportunityMatch = typeof opportunityMatches.$inferSelect;
export type StrategicGroup = typeof strategicGroups.$inferSelect;
export type DirectMessage = typeof directMessages.$inferSelect;
export type GoldAccessGrant = typeof goldAccessGrants.$inferSelect;
export type PlatformNotification = typeof platformNotifications.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type DealRoom = typeof dealRooms.$inferSelect;
export type DealRoomMessage = typeof dealRoomMessages.$inferSelect;
export type DealRoomDocument = typeof dealRoomDocuments.$inferSelect;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type SecurityEvent = typeof securityEvents.$inferSelect;
export type TrustedDevice = typeof trustedDevices.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type PrivateContact = typeof privateContacts.$inferSelect;
export type InsertPrivateContact = typeof privateContacts.$inferInsert;

// ============================================================
// MÓDULO DE CONTEXTOS (Onde e Como Conheceu) — Etapa 3
// ============================================================
export const contextTypes = mysqlTable("context_types", {
  id:         varchar("id", { length: 36 }).primaryKey(),
  name:       varchar("name", { length: 80 }).notNull(),
  slug:       varchar("slug", { length: 80 }).notNull(),
  iconName:   varchar("icon_name", { length: 50 }),
  colorToken: varchar("color_token", { length: 30 }),
  sortOrder:  int("sort_order").default(0).notNull(),
  isActive:   boolean("is_active").default(true).notNull(),
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:  bigint("updated_at", { mode: "number" }).notNull(),
});

export const contexts = mysqlTable("contexts", {
  id:            varchar("id", { length: 36 }).primaryKey(),
  ownerId:       varchar("owner_id", { length: 128 }),  // NULL = global
  contextTypeId: varchar("context_type_id", { length: 36 }),
  name:          varchar("name", { length: 100 }).notNull(),
  description:   text("description"),
  eventDate:     varchar("event_date", { length: 20 }),  // DATE stored as string
  city:          varchar("city", { length: 100 }),
  country:       varchar("country", { length: 100 }),
  notes:         text("notes"),
  isCustom:      boolean("is_custom").default(false).notNull(),
  visibility:    varchar("visibility", { length: 10 }).default("private").notNull(),
  createdAt:     bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:     bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // A rede particular é sempre lida por dona. Sem índice, listar contextos varre
  // a tabela inteira: invisível com 3 linhas, caro com a base de participantes
  // carregada no primeiro dia.
  ownerIdx: index("ctx_owner_idx").on(table.ownerId),
}));

export const contactContexts = mysqlTable("contact_contexts", {
  id:               varchar("id", { length: 36 }).primaryKey(),
  ownerId:          varchar("owner_id", { length: 128 }).notNull(),
  contactId:        bigint("contact_id", { mode: "number" }).notNull(),
  contextId:        varchar("context_id", { length: 36 }).notNull(),
  eventDate:        varchar("event_date", { length: 20 }),
  city:             varchar("city", { length: 100 }),
  country:          varchar("country", { length: 100 }),
  notes:            varchar("notes", { length: 1000 }),
  relationshipType: varchar("relationship_type", { length: 20 }).default("profissional").notNull(),
  visibility:       varchar("visibility", { length: 10 }).default("private").notNull(),
  createdAt:        bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:        bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerContextIdx: index("cc_owner_context_idx").on(table.ownerId, table.contextId),
  ownerContactIdx: index("cc_owner_contact_idx").on(table.ownerId, table.contactId),
}));

export const contextParticipants = mysqlTable("context_participants", {
  id:                 varchar("id", { length: 36 }).primaryKey(),
  ownerId:            varchar("owner_id", { length: 128 }).notNull(),
  contextId:          varchar("context_id", { length: 36 }).notNull(),
  name:               varchar("name", { length: 200 }).notNull(),
  company:            varchar("company", { length: 200 }),
  role:               varchar("role", { length: 200 }),
  notes:              varchar("notes", { length: 500 }),
  convertedContactId: bigint("converted_contact_id", { mode: "number" }),
  createdAt:          bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:          bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerContextIdx: index("cpart_owner_context_idx").on(table.ownerId, table.contextId),
}));

export const contextMedia = mysqlTable("context_media", {
  id:            varchar("id", { length: 36 }).primaryKey(),
  ownerId:       varchar("owner_id", { length: 128 }).notNull(),
  contextId:     varchar("context_id", { length: 36 }).notNull(),
  storagePath:   varchar("storage_path", { length: 512 }).notNull(),
  fileType:      varchar("file_type", { length: 50 }).notNull(),
  fileSize:      bigint("file_size", { mode: "number" }).notNull(),
  originalName:  varchar("original_name", { length: 255 }).notNull(),
  caption:       varchar("caption", { length: 255 }),
  thumbnailPath: varchar("thumbnail_path", { length: 512 }),
  sortOrder:     int("sort_order").default(0).notNull(),
  uploadedBy:    varchar("uploaded_by", { length: 128 }).notNull(),
  createdAt:     bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:     bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerContextIdx: index("cmedia_owner_context_idx").on(table.ownerId, table.contextId),
}));

// Tipos exportados — Contextos
export type ContextType = typeof contextTypes.$inferSelect;
export type Context = typeof contexts.$inferSelect;
export type ContactContext = typeof contactContexts.$inferSelect;
export type ContextParticipant = typeof contextParticipants.$inferSelect;
export type ContextMedia = typeof contextMedia.$inferSelect;

// ============================================================
// MÓDULO DE ENRIQUECIMENTO COM IA — Etapa 4
// ============================================================
export const enrichmentSessions = mysqlTable("enrichment_sessions", {
  id:                varchar("id", { length: 36 }).primaryKey(),
  ownerId:           varchar("owner_id", { length: 128 }).notNull(),
  contactId:         bigint("contact_id", { mode: "number" }).notNull(),
  status:            varchar("status", { length: 20 }).default("active").notNull(),
  questionsAnswered: int("questions_answered").default(0).notNull(),
  questionsSkipped:  int("questions_skipped").default(0).notNull(),
  summary:           text("summary"),
  lastActivityAt:    bigint("last_activity_at", { mode: "number" }).notNull(),
  completedAt:       bigint("completed_at", { mode: "number" }),
  createdAt:         bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:         bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerContactIdx: index("enr_sess_owner_contact_idx").on(table.ownerId, table.contactId),
}));

export const enrichmentMessages = mysqlTable("enrichment_messages", {
  id:         varchar("id", { length: 36 }).primaryKey(),
  sessionId:  varchar("session_id", { length: 36 }).notNull(),
  ownerId:    varchar("owner_id", { length: 128 }).notNull(),
  role:       varchar("role", { length: 10 }).notNull(),
  content:    text("content").notNull(),
  metadata:   jsonCompat("metadata"),
  tokenCount: int("token_count"),
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:  bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerSessionIdx: index("enr_msg_owner_session_idx").on(table.ownerId, table.sessionId),
}));

export const enrichmentSuggestions = mysqlTable("enrichment_suggestions", {
  id:             varchar("id", { length: 36 }).primaryKey(),
  sessionId:      varchar("session_id", { length: 36 }).notNull(),
  messageId:      varchar("message_id", { length: 36 }).notNull(),
  ownerId:        varchar("owner_id", { length: 128 }).notNull(),
  contactId:      bigint("contact_id", { mode: "number" }).notNull(),
  fieldType:      varchar("field_type", { length: 30 }).notNull(),
  suggestedValue: text("suggested_value").notNull(),
  appliedValue:   text("applied_value"),
  tagId:          varchar("tag_id", { length: 36 }),
  tagIsNew:       boolean("tag_is_new").default(false).notNull(),
  confidence:     decimal("confidence", { precision: 4, scale: 3 }).default("0.000").notNull(),
  status:         varchar("status", { length: 20 }).default("pending").notNull(),
  actionedAt:     bigint("actioned_at", { mode: "number" }),
  actionedBy:     varchar("actioned_by", { length: 20 }),
  // O que "Desfazer" precisa para reverter o que a confirmação gravou: o valor
  // anterior do campo, o id da tag inserida, a linha de nota acrescentada...
  // Gravado no mesmo UPDATE que marca `applied`; nulo nas sugestões aplicadas
  // antes do recurso existir (essas não têm como ser revertidas).
  undoSnapshot:   jsonCompat("undo_snapshot"),
  createdAt:      bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:      bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // getEnrichmentHistory filtra (dona, contato) e ordena por data.
  ownerContactIdx: index("enr_sug_owner_contact_idx").on(table.ownerId, table.contactId),
  // getPendingEnrichmentSuggestions (server/db.ts) filtra sessão + dona + status,
  // e é o que roda a cada abertura do chat de enriquecimento. Só o prefixo
  // `owner_id` do índice acima não basta: ele tiraria a varredura global, mas
  // ainda leria TODAS as sugestões daquela dona para achar as pendentes de uma
  // sessão.
  ownerSessionStatusIdx: index("enr_sug_owner_session_status_idx").on(table.ownerId, table.sessionId, table.status),
}));

// ============================================================
// ASSISTENTE DE REUNIÕES — Etapa 5
// Isolamento obrigatório por ownerId em todas as consultas.
// ============================================================
export const meetings = mysqlTable("meetings", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  contactId: bigint("contact_id", { mode: "number" }),
  contextId: varchar("context_id", { length: 36 }),
  // 'uploading' é o "enviando" da spec da etapa 5: a gravação terminou e as
  // partes do áudio ainda estão chegando. Fica no FIM da lista de propósito:
  // acrescentar valor no fim de um enum é alteração instantânea no MySQL 8,
  // e mudar a ordem reconstruiria a tabela.
  status: mysqlEnum("status", ["draft", "recording", "processing", "ready", "failed", "deleted", "uploading"]).default("draft").notNull(),
  consentGranted: boolean("consent_granted").default(false).notNull(),
  consentAt: bigint("consent_at", { mode: "number" }),
  language: varchar("language", { length: 12 }).default("pt").notNull(),
  processingError: text("processing_error"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  // Como o áudio chegou: 'single' é o envio único em base64 (meetings.submitRecording);
  // 'slices' é a gravação enviada em partes, uma linha de meeting_audio_slices
  // por parte. As partes são internas: para quem grava, a gravação é contínua e
  // não tem teto de tempo.
  audioPipeline: mysqlEnum("audio_pipeline", ["single", "slices"]).default("single").notNull(),
  // De onde a reunião veio. Varchar com o enum só no TypeScript: valor novo não
  // pede migração. Nula no envio único, que recebe tanto a gravação do
  // microfone quanto um arquivo escolhido sem dizer qual dos dois: a coluna é
  // preenchida por quem cria a reunião sabendo de onde ela vem.
  origem: varchar("origem", { length: 16, enum: ["gravacao", "arquivo", "aba", "pdf", "youtube"] }),
  // A versão do aviso de gravação que a dona aceitou (o nome vem da spec da
  // etapa 5). Nula nas reuniões anteriores ao aviso versionado.
  consentNoticeVersion: varchar("consent_notice_version", { length: 32 }),
  // Quantas partes a gravação teve, informado quando ela termina. Nulo
  // enquanto grava e no envio único.
  expectedSlices: int("expected_slices"),
  // Controle da fila de transcrição no passo final da reunião em partes:
  // tentativas, até quando vale a reserva e de quem ela é. Ficam no servidor;
  // a lista e o detalhe escolhem as colunas que vão ao navegador
  // (COLUNAS_DA_REUNIAO_NA_TELA, em server/meeting-service.ts).
  attempts: int("attempts").default(0).notNull(),
  lockedUntil: bigint("locked_until", { mode: "number" }),
  lockToken: varchar("lock_token", { length: 36 }),
}, (table) => ({
  ownerCreatedIdx: index("meetings_owner_created_idx").on(table.ownerId, table.createdAt),
  ownerStatusIdx: index("meetings_owner_status_idx").on(table.ownerId, table.status),
  // A fila acha as reuniões em partes pelo estado, sem varrer as do envio único.
  pipelineStatusIdx: index("meetings_pipeline_status_idx").on(table.audioPipeline, table.status),
}));

export const meetingRecordings = mysqlTable("meeting_recordings", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  storageKey: varchar("storage_key", { length: 512 }).notNull(),
  storageUrl: varchar("storage_url", { length: 512 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  durationSeconds: int("duration_seconds").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => ({
  meetingIdx: index("meeting_recordings_meeting_idx").on(table.meetingId),
  ownerExpiresIdx: index("meeting_recordings_owner_expires_idx").on(table.ownerId, table.expiresAt),
}));

// Partes do áudio de uma reunião gravada em partes (audio_pipeline 'slices').
// São internas: quem grava aperta começar e encerrar, e o app manda o áudio em
// partes por baixo para não perder a gravação se a rede cair; as partes se
// emendam na transcrição. Nenhuma coluna supõe teto de tempo da reunião.
// Estados: 'uploading' (a linha nasce ANTES de o objeto subir ao bucket, porque
// é ela o ponteiro para ele), 'received' (o objeto subiu), 'transcribed' (a IA
// devolveu o resultado) e 'failed'. Nomes em inglês, como as irmãs meeting_*.
export const meetingAudioSlices = mysqlTable("meeting_audio_slices", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  // Posição da parte na gravação, a partir de 0.
  seq: int("seq").notNull(),
  status: mysqlEnum("status", ["uploading", "received", "transcribed", "failed"]).default("uploading").notNull(),
  // A chave é montada pelo servidor (meetings/<openId>/...), e é ela que prova
  // a posse na exclusão da conta. A url é o caminho do proxy autenticado
  // (/manus-storage/...), nunca o endereço do bucket.
  storageKey: varchar("storage_key", { length: 512 }).notNull(),
  storageUrl: varchar("storage_url", { length: 512 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  // Do conteúdo recebido: o reenvio da mesma parte é reconhecido, e um
  // conteúdo diferente na mesma posição, recusado.
  sha256: varchar("sha256", { length: 64 }).notNull(),
  // Duração medida desta parte e o ponto em que ela começa na reunião, em
  // milissegundos. O início é a soma das partes anteriores, gravado quando a
  // parte é transcrita; bigint para nenhuma duração de reunião ter teto.
  durationMs: int("duration_ms").notNull(),
  offsetMs: bigint("offset_ms", { mode: "number" }),
  // Controle da fila de transcrição desta parte; fica no servidor.
  attempts: int("attempts").default(0).notNull(),
  lockedUntil: bigint("locked_until", { mode: "number" }),
  lockToken: varchar("lock_token", { length: 36 }),
  // Código ou frase nossa, nunca o texto do driver ou da IA.
  lastError: varchar("last_error", { length: 500 }),
  // O que a IA devolveu para esta parte (as falas, com falante e tempo), que a
  // montagem da transcrição da reunião lê. É fala de quem participou: na
  // exclusão da conta, a linha que fica como ponteiro para o objeto perde esta
  // coluna (server/exclusao-de-conta.ts).
  result: jsonCompat("result"),
  // O id do modelo de IA que transcreveu a parte.
  model: varchar("model", { length: 80 }),
  // Prazo do áudio desta parte, pela mesma regra do áudio das gravações.
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // Uma linha por posição: a mesma parte enviada duas vezes não duplica.
  meetingSeqUnique: uniqueIndex("meeting_audio_slices_meeting_seq_unique").on(table.meetingId, table.seq),
  // A fila reserva pelo estado e pela reserva vencida.
  statusLockedIdx: index("meeting_audio_slices_status_locked_idx").on(table.status, table.lockedUntil),
  ownerMeetingIdx: index("meeting_audio_slices_owner_meeting_idx").on(table.ownerId, table.meetingId),
  // A faxina acha o áudio vencido.
  expiresIdx: index("meeting_audio_slices_expires_idx").on(table.expiresAt),
}));

export const meetingTranscripts = mysqlTable("meeting_transcripts", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull().unique(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  // MEDIUMTEXT (até 16 MiB): o TEXT para em 64 KiB, menos que a transcrição de
  // uma reunião longa, e no modo estrito o banco recusa o que passa. 16 MiB dão
  // mais de 100 horas de fala, mesmo traduzidas para escrita de 3 bytes por letra.
  transcript: mediumtext("transcript").notNull(),
  segments: jsonCompat("segments"),
  language: varchar("language", { length: 12 }),
  durationSeconds: int("duration_seconds"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerMeetingIdx: index("meeting_transcripts_owner_meeting_idx").on(table.ownerId, table.meetingId),
}));

export const meetingTranscriptTranslations = mysqlTable("meeting_transcript_translations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  language: varchar("language", { length: 12 }).notNull(),
  // MEDIUMTEXT pelo mesmo motivo da transcrição (meeting_transcripts.transcript).
  translatedText: mediumtext("translated_text").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerMeetingLanguageIdx: uniqueIndex("meeting_transcript_translations_owner_meeting_language_idx").on(table.ownerId, table.meetingId, table.language),
}));

export const meetingEntities = mysqlTable("meeting_entities", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  entityType: varchar("entity_type", { length: 40 }).notNull(),
  value: text("value").notNull(),
  normalizedValue: varchar("normalized_value", { length: 500 }),
  confidence: decimal("confidence", { precision: 4, scale: 3 }).default("0.000").notNull(),
  status: mysqlEnum("status", ["pending", "confirmed", "ignored"]).default("pending").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerMeetingIdx: index("meeting_entities_owner_meeting_idx").on(table.ownerId, table.meetingId),
  statusIdx: index("meeting_entities_status_idx").on(table.ownerId, table.status),
}));

export const meetingContactSuggestions = mysqlTable("meeting_contact_suggestions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  existingContactId: bigint("existing_contact_id", { mode: "number" }),
  fullName: varchar("full_name", { length: 200 }).notNull(),
  jobTitle: varchar("job_title", { length: 200 }),
  company: varchar("company", { length: 200 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  sourceEntityIds: jsonCompat("source_entity_ids"),
  confidence: decimal("confidence", { precision: 4, scale: 3 }).default("0.000").notNull(),
  status: mysqlEnum("status", ["pending", "created", "linked", "ignored"]).default("pending").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerMeetingIdx: index("meeting_contact_suggestions_owner_meeting_idx").on(table.ownerId, table.meetingId),
  statusIdx: index("meeting_contact_suggestions_status_idx").on(table.ownerId, table.status),
}));

// ============================================================
// MEMÓRIA INTELIGENTE — Etapa 6
// Vetores ficam em JSON para compatibilidade com MySQL. A similaridade é
// calculada exclusivamente em memória após filtrar por ownerId.
// ============================================================
export const memoryDocuments = mysqlTable("memory_documents", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  sourceType: varchar("source_type", { length: 40 }).notNull(),
  sourceId: varchar("source_id", { length: 128 }).notNull(),
  title: varchar("title", { length: 300 }).notNull(),
  content: text("content").notNull(),
  metadata: jsonCompat("metadata"),
  embedding: jsonCompat("embedding").$type<number[]>(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  indexedAt: bigint("indexed_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerSourceIdx: index("memory_documents_owner_source_idx").on(table.ownerId, table.sourceType, table.sourceId),
  ownerIndexedIdx: index("memory_documents_owner_indexed_idx").on(table.ownerId, table.indexedAt),
}));

// ============================================================
// MATCH INTELIGENTE — Etapa 7
// Cruzamentos sempre privados entre contatos da mesma ownerId.
// ============================================================
export const contactAssets = mysqlTable("contact_assets", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  contactId: bigint("contact_id", { mode: "number" }).notNull(),
  tagSlug: varchar("tag_slug", { length: 160 }).notNull(),
  tagLabel: varchar("tag_label", { length: 200 }).notNull(),
  category: varchar("category", { length: 120 }),
  description: text("description"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerContactIdx: index("contact_assets_owner_contact_idx").on(table.ownerId, table.contactId),
  ownerSlugIdx: index("contact_assets_owner_slug_idx").on(table.ownerId, table.tagSlug),
  ownerCategoryIdx: index("contact_assets_owner_category_idx").on(table.ownerId, table.category),
}));

export const contactNeeds = mysqlTable("contact_needs", {
  id: bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  contactId: bigint("contact_id", { mode: "number" }).notNull(),
  tagSlug: varchar("tag_slug", { length: 160 }).notNull(),
  tagLabel: varchar("tag_label", { length: 200 }).notNull(),
  category: varchar("category", { length: 120 }),
  description: text("description"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerContactIdx: index("contact_needs_owner_contact_idx").on(table.ownerId, table.contactId),
  ownerSlugIdx: index("contact_needs_owner_slug_idx").on(table.ownerId, table.tagSlug),
  ownerCategoryIdx: index("contact_needs_owner_category_idx").on(table.ownerId, table.category),
}));

export const aiMatchSuggestions = mysqlTable("ai_match_suggestions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  contactAId: bigint("contact_a_id", { mode: "number" }).notNull(),
  contactBId: bigint("contact_b_id", { mode: "number" }).notNull(),
  pairLowContactId: bigint("pair_low_contact_id", { mode: "number" }).notNull(),
  pairHighContactId: bigint("pair_high_contact_id", { mode: "number" }).notNull(),
  matchScore: int("match_score").notNull(),
  // "mutual" é o par que se completa nos dois sentidos: cada contato tem o que o
  // outro procura. É a conexão mais forte que o cruzamento sabe encontrar.
  matchType: mysqlEnum("match_type", ["mutual", "exact", "category", "semantic"]).notNull(),
  matchedAssets: jsonCompat("matched_assets").$type<Array<{ slug: string; label: string }>>().notNull(),
  matchedNeeds: jsonCompat("matched_needs").$type<Array<{ slug: string; label: string }>>().notNull(),
  reasonText: text("reason_text").notNull(),
  status: mysqlEnum("status", ["pending", "viewed", "accepted", "dismissed"]).default("pending").notNull(),
  notifiedAt: bigint("notified_at", { mode: "number" }),
  viewedAt: bigint("viewed_at", { mode: "number" }),
  acceptedAt: bigint("accepted_at", { mode: "number" }),
  dismissedAt: bigint("dismissed_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerStatusScoreIdx: index("ai_match_owner_status_score_idx").on(table.ownerId, table.status, table.matchScore),
  ownerPairIdx: uniqueIndex("ai_match_owner_pair_unique_idx").on(table.ownerId, table.pairLowContactId, table.pairHighContactId),
  contactAIdx: index("ai_match_contact_a_idx").on(table.contactAId),
  contactBIdx: index("ai_match_contact_b_idx").on(table.contactBId),
}));

// ============================================================
// MEU NETWORK INTELIGENTE — spec da Glenda de 14/09 (prompt 7)
// ============================================================

// Pendências da IA sobre um contato: QUEM SOU (nome, telefone, e-mail, pessoa
// física/jurídica), O QUE TENHO e O QUE PRECISO propostos a partir de uma
// reunião, de um áudio curto (voz) ou de um texto livre. Nada entra sozinho
// (CLAUDE.md): cada linha nasce 'pendente', com origem, confiança e o TRECHO
// literal da fonte que a sustenta, e só vira dado quando a dona confirma.
// `contact_id` é nulo enquanto a pessoa ainda é só uma sugestão da reunião
// (`meeting_suggestion_id`); criar ou vincular o contato preenche.
export const networkSugestoes = mysqlTable("network_sugestoes", {
  id:                  varchar("id", { length: 36 }).primaryKey(),
  ownerId:             varchar("owner_id", { length: 128 }).notNull(),
  contactId:           bigint("contact_id", { mode: "number" }),
  meetingId:           varchar("meeting_id", { length: 36 }),
  meetingSuggestionId: varchar("meeting_suggestion_id", { length: 36 }),
  origem:              varchar("origem", { length: 10, enum: ["reuniao", "voz", "texto"] }).notNull(),
  campo:               varchar("campo", { length: 12, enum: ["nome", "telefone", "email", "tipo_pessoa", "tenho", "preciso"] }).notNull(),
  valor:               varchar("valor", { length: 320 }).notNull(),
  categoria:           varchar("categoria", { length: 120 }),
  trecho:              text("trecho"),
  confianca:           decimal("confianca", { precision: 4, scale: 3 }).default("0.000").notNull(),
  status:              varchar("status", { length: 12, enum: ["pendente", "confirmada", "ignorada"] }).default("pendente").notNull(),
  decididaEm:          bigint("decidida_em", { mode: "number" }),
  createdAt:           bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:           bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerContactIdx: index("nw_sug_owner_contact_idx").on(table.ownerId, table.contactId),
  ownerMeetingIdx: index("nw_sug_owner_meeting_idx").on(table.ownerId, table.meetingId),
  ownerSugestaoIdx: index("nw_sug_owner_meeting_suggestion_idx").on(table.ownerId, table.meetingSuggestionId),
}));

// Registro das conexões que podem originar negócio (itens 16 e 17): toda
// conexão identificada pela plataforma ganha uma linha com ORIGEM, e a linha
// sobrevive à sugestão que a originou — é rastreabilidade, não tela.
// Nenhuma coluna pessoal: o motivo fala pelos IDs anônimos e pelos rótulos do
// que cada lado tem e precisa. Quem participa mora em conexoes_participantes.
// Comissão: só o STATUS (itens 17 e 18). Sem percentual, valor ou cobrança —
// isso depende de regra contratual e de integração que não existem.
export const conexoesRegistradas = mysqlTable("conexoes_registradas", {
  id:              varchar("id", { length: 36 }).primaryKey(),
  origem:          varchar("origem", { length: 32, enum: ["PLATFORM_MATCH", "NETWORK_PLATFORM_MATCH", "PRIVATE_NETWORK_MATCH", "NETWORK_NETWORK_MATCH"] }).notNull(),
  // Uma linha por par por origem: recalcular não duplica o registro.
  chaveDoPar:      varchar("chave_do_par", { length: 190 }).notNull(),
  motivo:          text("motivo").notNull(),
  itens:           jsonCompat("itens").$type<Array<{ tem: string; precisa: string; deCodigo: string | null; paraCodigo: string | null }>>().notNull(),
  pontuacao:       int("pontuacao").notNull(),
  status:          varchar("status", { length: 16, enum: ["identificada", "apresentacao", "negociacao", "fechada", "descartada"] }).default("identificada").notNull(),
  apresentacaoEm:  bigint("apresentacao_em", { mode: "number" }),
  negociacaoEm:    bigint("negociacao_em", { mode: "number" }),
  fechamentoEm:    bigint("fechamento_em", { mode: "number" }),
  descartadaEm:    bigint("descartada_em", { mode: "number" }),
  statusComissao:  varchar("status_comissao", { length: 16, enum: ["sem_negocio", "a_apurar", "devida", "nao_devida"] }).default("sem_negocio").notNull(),
  createdAt:       bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:       bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  chaveUnique: uniqueIndex("conexoes_registradas_chave_unique").on(table.chaveDoPar),
  origemIdx:   index("conexoes_registradas_origem_idx").on(table.origem, table.createdAt),
}));

// Os dois lados de cada conexão registrada. Contato: `owner_id` é a dona do
// network (a responsável; nas origens NETWORK_* também a ORIGINADORA do item
// 18) e `codigo_anonimo` é o que aparece para quem não é a dona. Membro:
// `userId`. `contact_id` vira nulo quando o contato é excluído — o ID anônimo
// fica como registro de que a conexão existiu.
export const conexoesParticipantes = mysqlTable("conexoes_participantes", {
  id:                     bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  conexaoId:              varchar("conexao_id", { length: 36 }).notNull(),
  lado:                   varchar("lado", { length: 1, enum: ["a", "b"] }).notNull(),
  tipo:                   varchar("tipo", { length: 12, enum: ["contato", "membro"] }).notNull(),
  ownerId:                varchar("owner_id", { length: 128 }),
  userId:                 int("userId"),
  contactId:              bigint("contact_id", { mode: "number" }),
  codigoAnonimo:          varchar("codigo_anonimo", { length: 16 }),
  originador:             boolean("originador").default(false).notNull(),
  statusComissaoOriginador: varchar("status_comissao_originador", { length: 16, enum: ["sem_negocio", "a_apurar", "devida", "nao_devida"] }),
  createdAt:              bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:              bigint("updated_at", { mode: "number" }).notNull(),
  // O que ESTE lado declarou (network-registro.ts, avancarConexao): descartar
  // vale só para quem descartou, e o fechamento só vira etapa da conexão quando
  // todos os lados confirmam. Nenhum lado encerra sozinho a trilha do outro.
  descartadaEm:           bigint("descartada_em", { mode: "number" }),
  fechamentoConfirmadoEm: bigint("fechamento_confirmado_em", { mode: "number" }),
}, (table) => ({
  conexaoLadoUnique: uniqueIndex("conexoes_participantes_conexao_lado_unique").on(table.conexaoId, table.lado),
  ownerIdx:          index("conexoes_participantes_owner_idx").on(table.ownerId),
  userIdx:           index("conexoes_participantes_user_idx").on(table.userId),
  contatoIdx:        index("conexoes_participantes_contact_idx").on(table.contactId),
}));

// Minutos de reunião (itens 3, 4 e 25). O gratuito — 10 minutos por reunião —
// é constante do código (MAX_MEETING_DURATION_SECONDS). Plano pago é LINHA
// desta tabela, configurada depois pelo administrador: nenhuma linha nasce com
// o sistema, e nada aqui inventa preço, minutos, nome ou periodicidade.
export const planosDeMinutos = mysqlTable("planos_de_minutos", {
  id:                       varchar("id", { length: 36 }).primaryKey(),
  nome:                     varchar("nome", { length: 80 }),
  limitePorReuniaoSegundos: int("limite_por_reuniao_segundos"),
  limiteMensalSegundos:     int("limite_mensal_segundos"),
  minutosAdicionais:        int("minutos_adicionais"),
  precoCentavos:            int("preco_centavos"),
  moeda:                    varchar("moeda", { length: 3 }),
  periodicidade:            varchar("periodicidade", { length: 20 }),
  ativo:                    boolean("ativo").default(false).notNull(),
  createdAt:                bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:                bigint("updated_at", { mode: "number" }).notNull(),
});

// A assinatura de uma usuária a um plano. Só uma integração de pagamento
// (inexistente hoje) pode criar linha 'ativa': não há procedimento que o faça.
export const assinaturasDeMinutos = mysqlTable("assinaturas_de_minutos", {
  id:                varchar("id", { length: 36 }).primaryKey(),
  userId:            int("userId").notNull(),
  planoId:           varchar("plano_id", { length: 36 }).notNull(),
  status:            varchar("status", { length: 12, enum: ["pendente", "ativa", "cancelada", "expirada"] }).default("pendente").notNull(),
  inicioEm:          bigint("inicio_em", { mode: "number" }),
  fimEm:             bigint("fim_em", { mode: "number" }),
  provedor:          varchar("provedor", { length: 40 }),
  referenciaExterna: varchar("referencia_externa", { length: 128 }),
  createdAt:         bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:         bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  userStatusIdx: index("assinaturas_de_minutos_user_status_idx").on(table.userId, table.status),
}));

// O contador de minutos consumidos: uma linha por reunião transcrita (ou por
// áudio curto de complemento por voz). Mora fora de meeting_transcripts de
// propósito: excluir a reunião não devolve os minutos já usados no mês.
export const consumoDeMinutos = mysqlTable("consumo_de_minutos", {
  id:         varchar("id", { length: 36 }).primaryKey(),
  ownerId:    varchar("owner_id", { length: 128 }).notNull(),
  origem:     varchar("origem", { length: 10, enum: ["reuniao", "voz"] }).notNull(),
  referencia: varchar("referencia", { length: 36 }).notNull(),
  segundos:   int("segundos").notNull(),
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
}, (table) => ({
  referenciaUnique: uniqueIndex("consumo_de_minutos_referencia_unique").on(table.ownerId, table.origem, table.referencia),
  ownerCreatedIdx:  index("consumo_de_minutos_owner_created_idx").on(table.ownerId, table.createdAt),
}));

// Tipos exportados — Enriquecimento
export type EnrichmentSession = typeof enrichmentSessions.$inferSelect;
export type EnrichmentMessage = typeof enrichmentMessages.$inferSelect;
export type EnrichmentSuggestion = typeof enrichmentSuggestions.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type MeetingRecording = typeof meetingRecordings.$inferSelect;
export type MeetingTranscript = typeof meetingTranscripts.$inferSelect;
export type MeetingTranscriptTranslation = typeof meetingTranscriptTranslations.$inferSelect;
export type MeetingEntity = typeof meetingEntities.$inferSelect;
export type MeetingContactSuggestion = typeof meetingContactSuggestions.$inferSelect;
export type MemoryDocument = typeof memoryDocuments.$inferSelect;
export type ContactAsset = typeof contactAssets.$inferSelect;
export type ContactNeed = typeof contactNeeds.$inferSelect;
export type AiMatchSuggestion = typeof aiMatchSuggestions.$inferSelect;
export type SivcVerification = typeof sivcVerifications.$inferSelect;
export type SivcConsent = typeof sivcConsents.$inferSelect;
export type SivcCheck = typeof sivcChecks.$inferSelect;
export type SivcDocument = typeof sivcDocuments.$inferSelect;
export type PresidentValidation = typeof presidentValidations.$inferSelect;
export type NationalLeader = typeof nationalLeaders.$inferSelect;

// ============================================================
// CONSENTIMENTO E DOCUMENTOS — etapa 11, etapa 13 e ajuste A11
// ============================================================
// Versionar o documento é o que transforma consentimento em prova: "fulana
// aceitou" sem versão não diz o que ela aceitou. Por isso o texto vive aqui,
// e não no código — o texto jurídico entra como uma linha nova quando ficar
// pronto, sem exigir deploy.
export const documentVersions = mysqlTable("document_versions", {
  id:          varchar("id", { length: 36 }).primaryKey(),
  type:        mysqlEnum("type", [
                 "termo_smart_match",
                 "acordo_intermediacao",
                 "contrato_comissao",
                 "termo_gravacao",
                 // Etapa 10: o termo pelo qual a DONA autoriza que membras Ouro
                 // vejam os contatos que ela marcar como compartilhados. Sem
                 // versão publicada (o texto jurídico é da Cris), a regra da
                 // etapa 11 vale: não há o que consentir e a leitura libera.
                 "termo_acesso_ouro",
                 // Termo Geral de Uso, Proteção de Dados e Intermediação Digital
                 // (Dr. Ronei, 14/09/2026): a última etapa do cadastro. Sem
                 // versão publicada o cadastro NÃO conclui — ao contrário dos
                 // tipos acima, aqui a ausência de texto barra em vez de liberar
                 // (server/termo-geral-de-uso.ts).
                 "termo_geral_de_uso",
               ]).notNull(),
  version:     int("version").notNull(),
  text:        text("text").notNull(),
  publishedAt: timestamp("publishedAt").defaultNow().notNull(),
  isCurrent:   boolean("isCurrent").default(false).notNull(),
  // No máximo uma versão vigente por tipo. O Postgres faria com índice parcial;
  // no MySQL a coluna gerada resolve: vale o tipo enquanto vigente e NULL depois,
  // e NULLs não colidem em índice único.
  currentType: varchar("currentType", { length: 32 }).generatedAlwaysAs(
                 sql`(CASE WHEN \`isCurrent\` THEN \`type\` ELSE NULL END)`,
                 { mode: "virtual" },
               ),
}, (table) => ({
  typeVersionUnique: uniqueIndex("doc_ver_type_version_unique").on(table.type, table.version),
  currentUnique:     uniqueIndex("doc_ver_current_unique").on(table.currentType),
}));

// Revogar nunca apaga a linha: preenche revokedAt. A consulta do Smart Match
// avalia a condição na hora, então revogar tem efeito imediato, sem rotina de
// limpeza.
export const consents = mysqlTable("consents", {
  id:                int("id").autoincrement().primaryKey(),
  userId:            int("userId").notNull(),
  documentVersionId: varchar("documentVersionId", { length: 36 }).notNull(),
  grantedAt:         timestamp("grantedAt").defaultNow().notNull(),
  revokedAt:         timestamp("revokedAt"),
  ipAddress:         varchar("ipAddress", { length: 45 }),
  userAgent:         text("userAgent"),
  // SHA-256 do texto vigente no instante do aceite. O documentVersionId já
  // aponta o texto, mas o hash prova que o texto da versão não mudou por baixo
  // do aceite — sem depender da imutabilidade de document_versions.
  textHash:          varchar("textHash", { length: 64 }),
  // No máximo UM consentimento ativo por par (usuária, versão). Mesmo truque da
  // coluna gerada usado acima: vale a chave enquanto não revogado e vira NULL
  // depois, e NULLs não colidem em índice único.
  //
  // Um `UNIQUE (userId, documentVersionId)` simples seria errado: proibiria
  // revogar e aceitar de novo, que é um fluxo legítimo e previsto no termo.
  activeKey:         varchar("activeKey", { length: 80 }).generatedAlwaysAs(
                       sql`(CASE WHEN \`revokedAt\` IS NULL THEN CONCAT(\`userId\`, ':', \`documentVersionId\`) ELSE NULL END)`,
                       { mode: "virtual" },
                     ),
}, (table) => ({
  userIdx:     index("consent_user_idx").on(table.userId),
  documentIdx: index("consent_document_idx").on(table.documentVersionId),
  activeUnique: uniqueIndex("consent_active_unique").on(table.activeKey),
}));

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type Consent = typeof consents.$inferSelect;
