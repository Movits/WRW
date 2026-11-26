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
  date,
} from "drizzle-orm/mysql-core";
import { decimal, primaryKey } from "drizzle-orm/mysql-core";
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
  // O envio automático do resumo por e-mail (H22): ligado, a WRW manda à
  // própria dona o link de cada reunião cujo primeiro resumo ficar pronto.
  // Desligado por padrão; só ela liga, no painel do resumo por e-mail.
  resumoPorEmailAutomatico: boolean("resumoPorEmailAutomatico").default(false).notNull(),
  // A conta de uma ENTIDADE (federação, associação, sindicato: a base das
  // associações, N1). É um PODER, como o distribuidor: marca a conta que tem uma
  // linha em `entidades` e abre o painel da entidade. Gravado junto com a linha,
  // na mesma transação, pela equipe (`entidades.admin.criar`).
  isEntidade: boolean("isEntidade").default(false).notNull(),
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
    "compliance_update", "system",
    // Os avisos do gravador (H15 do plano do gravador), no FIM da lista de
    // propósito: acrescentar valor no fim de um enum é alteração instantânea
    // no MySQL 8. 'lembrete' é o da próxima ação e o da reunião da agenda;
    // 'reuniao_pronta', o de quando a transcrição e o resumo terminam.
    "lembrete", "reuniao_pronta",
  ]).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body"),
  actionUrl: varchar("actionUrl", { length: 500 }),
  // Nos dois tipos do gravador, a tela escreve o aviso pelo tipo, no idioma de
  // quem lê, com o que fica aqui (o texto da ação, o título e a hora da
  // reunião; shared/lembretes.ts). title guarda só o título da origem, para a
  // tela antiga. Nos outros tipos é nulo, e o texto pronto fica em title e body.
  parametros: jsonCompat("parametros").$type<Record<string, unknown>>(),
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
// CHAVES DE ACESSO (passkeys, WebAuthn) — A6 do desenho do gravador
// Entrar com Face ID, digital ou o bloqueio de tela do aparelho
// (server/chaves-de-acesso.ts). O aparelho confere a pessoa e manda só uma
// assinatura: a WRW guarda a chave PÚBLICA e dados técnicos da chave, nunca
// biometria. Varchar com o enum só no TypeScript, como em network_sugestoes.
// ============================================================
export const chavesDeAcesso = mysqlTable("chaves_de_acesso", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: int("userId").notNull(),
  // O id da credencial, em base64url, como o aparelho o manda na entrada.
  credencialId: varchar("credencial_id", { length: 512 }).notNull(),
  // A chave pública no formato COSE, em base64url.
  chavePublica: text("chave_publica").notNull(),
  // O contador de usos que o aparelho assina; o que volta é recusado.
  contador: bigint("contador", { mode: "number" }).default(0).notNull(),
  // As formas de conexão da chave (internal, hybrid, usb...), para a entrada.
  transportes: jsonCompat("transportes").$type<string[]>(),
  // singleDevice: presa a um aparelho; multiDevice: pode ser sincronizada.
  tipoDoAparelho: varchar("tipo_do_aparelho", { length: 16, enum: ["singleDevice", "multiDevice"] }).notNull(),
  // A chave está numa cópia sincronizada (iCloud, Google, gerenciador de senhas).
  sincronizada: boolean("sincronizada").default(false).notNull(),
  // O identificador da conta que o aparelho guarda com a chave (user handle):
  // aleatório, o mesmo em todas as chaves da conta, nunca o id nem o e-mail.
  identificadorDaUsuaria: varchar("identificador_da_usuaria", { length: 64 }).notNull(),
  // O modelo do autenticador (AAGUID); zeros quando o aparelho não diz.
  aaguid: varchar("aaguid", { length: 36 }),
  apelido: varchar("apelido", { length: 60 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  ultimoUsoEm: bigint("ultimo_uso_em", { mode: "number" }),
}, (table) => ({
  credencialUnique: uniqueIndex("chaves_de_acesso_credencial_unique").on(table.credencialId),
  userIdx: index("chaves_de_acesso_user_idx").on(table.userId),
}));

// O desafio de uso único de cada cadastro ou entrada com chave de acesso.
// Fica fora do audit_logs de propósito: o insert de lá engole o erro, e um
// desafio que falhasse em ser gasto continuaria valendo. É gasto por UPDATE
// condicional (consumido_em ainda nulo e prazo vivo) e vence em 5 minutos.
// `userId` é nulo na entrada, que começa sem saber quem é a pessoa.
export const desafiosDeChaveDeAcesso = mysqlTable("desafios_de_chave_de_acesso", {
  id: varchar("id", { length: 36 }).primaryKey(),
  desafio: varchar("desafio", { length: 128 }).notNull(),
  finalidade: varchar("finalidade", { length: 12, enum: ["cadastro", "entrada"] }).notNull(),
  userId: int("userId"),
  // No cadastro, o identificador que foi para o aparelho e que a chave vai guardar.
  identificadorDaUsuaria: varchar("identificador_da_usuaria", { length: 64 }),
  expiraEm: bigint("expira_em", { mode: "number" }).notNull(),
  consumidoEm: bigint("consumido_em", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => ({
  desafioUnique: uniqueIndex("desafios_de_chave_de_acesso_desafio_unique").on(table.desafio),
  expiraIdx: index("desafios_de_chave_de_acesso_expira_idx").on(table.expiraEm),
  userIdx: index("desafios_de_chave_de_acesso_user_idx").on(table.userId),
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
  // Como o áudio chegou: 'single' é o envio único em base64 (o meetings.submitRecording,
  // que saiu na G14, parte 2, em 25/11/2026: só as reuniões antigas o têm);
  // 'slices' é a gravação enviada em partes, uma linha de meeting_audio_slices
  // por parte. As partes são internas: para quem grava, a gravação é contínua e
  // não tem teto de tempo.
  audioPipeline: mysqlEnum("audio_pipeline", ["single", "slices"]).default("single").notNull(),
  // De onde a reunião veio. Varchar com o enum só no TypeScript: valor novo não
  // pede migração. Nula no envio único, que recebe tanto a gravação do
  // microfone quanto um arquivo escolhido sem dizer qual dos dois: a coluna é
  // preenchida por quem cria a reunião sabendo de onde ela vem. 'pdf' e 'foto'
  // (H12 e H12b) são as reuniões que nasceram de um documento, e não de áudio:
  // o arquivo fica em meeting_documents, e o texto lido vira a transcrição.
  origem: varchar("origem", { length: 16, enum: ["gravacao", "arquivo", "aba", "pdf", "youtube", "foto"] }),
  // De onde veio a reunião que não é gravação: na origem 'youtube' (H13), a URL
  // canônica do vídeo (https://www.youtube.com/watch?v=ID, montada pelo id em
  // shared/youtube.ts, sem os parâmetros do link colado). O servidor nunca a
  // busca: ela vai ao Gemini, que lê o vídeo. Nula nas outras origens (o PDF e
  // as fotos da H12 e da H12b guardam o arquivo em meeting_documents).
  sourceUrl: varchar("source_url", { length: 512 }),
  // A versão do aviso de gravação que a dona aceitou (o nome vem da spec da
  // etapa 5). Nula nas reuniões anteriores ao aviso versionado.
  consentNoticeVersion: varchar("consent_notice_version", { length: 32 }),
  // Os nomes que a dona deu às vozes da transcrição por falante (H3 do desenho
  // do gravador): { "F1": "Ana", "F2": "Bia" }. Nulo: nenhuma voz nomeada, e a
  // tela mostra "Falante n". A dona vê, e o link aberto também, quando foi
  // ligado com a confirmação que fala dos nomes (H3b, decisão de 16/11/2026).
  speakerNames: jsonCompat("speaker_names").$type<Record<string, string>>(),
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
  // O link aberto da reunião (pedido do Roberto em 12/11/2026, "por enquanto"):
  // quem tem o endereço /r/{shareToken} ouve a gravação, lê a transcrição e
  // pergunta à IA sobre a reunião, sem conta na WRW. Nulo: a reunião não está
  // compartilhada. Desligar o link volta a nulo, e um link novo tem outro valor.
  // Fica em texto, não em hash, porque a dona copia o link de novo depois; quem
  // lê esta tabela já lê a transcrição (server/link-aberto-da-reuniao.ts).
  shareToken: varchar("share_token", { length: 64 }),
  // Os detalhes da reunião (H7c do plano do gravador): as etiquetas que a dona
  // dá à reunião (["Clientes", "Mentoria"]; o vocabulário da tela é
  // "etiqueta") e "Onde foi" (o lugar ou o canal, em texto livre). Nulos: sem
  // etiqueta e sem lugar. Só a dona os lê (a lista e o detalhe escolhem as
  // colunas, em server/meeting-service.ts); o link aberto não os leva. A
  // normalização (tamanho, quantidade, repetidas) mora em
  // shared/detalhes-da-reuniao.ts.
  etiquetas: jsonCompat("etiquetas").$type<string[]>(),
  ondeFoi: varchar("onde_foi", { length: 120 }),
  // A senha de 6 dígitos do link aberto (H23), que a dona liga, troca e tira.
  // Só o hash (scrypt com sal, server/senha-do-link-aberto.ts): a senha em
  // texto sai uma vez, para a dona, na hora de criar ou trocar. Nulo: o link
  // abre sem senha, como todos os ligados antes da H23. As colunas abaixo não
  // vão à tela como estão: o detalhe da dona recebe só se o link pede senha e
  // se leva o áudio (getPrivateMeeting, em server/meeting-service.ts).
  sharePasswordHash: varchar("share_password_hash", { length: 128 }),
  // O freio da força bruta por link (server/entrada-no-link-aberto.ts): as
  // tentativas erradas seguidas, a hora da última e até quando o link recusa
  // senha. Ficam no banco, e não em memória, para o deploy não zerá-las.
  sharePasswordFailures: int("share_password_failures").default(0).notNull(),
  sharePasswordFailedAt: bigint("share_password_failed_at", { mode: "number" }),
  sharePasswordLockedUntil: bigint("share_password_locked_until", { mode: "number" }),
  // Se o link serve o áudio e o player (H23). Desligado, o servidor não manda
  // a gravação nem assina o áudio pelo link. O padrão é o de antes da H23: o
  // link ligado antes dela segue com o áudio.
  shareAudio: boolean("share_audio").default(true).notNull(),
  // A pasta da reunião (H7d do plano do gravador): no máximo uma, da própria
  // dona (meeting_folders). Nula: sem pasta. Apagar a pasta solta as reuniões
  // dela (a coluna volta a nula) na mesma transação; nada da reunião sai com a
  // pasta. Só a dona lê; o link aberto não leva a pasta.
  folderId: varchar("folder_id", { length: 36 }),
  // A lixeira (H7d): a hora em que a dona mandou a reunião para a lixeira.
  // Nula: fora da lixeira. É exclusão ADIADA: preenchida, a reunião sai de toda
  // consulta (a lista, a busca, a Memória, o link aberto, as filas, os motores
  // e cada procedimento pelo id), salvo a lixeira da própria dona e o
  // restaurar (server/lixeira-de-reunioes.ts). Passados os 30 dias, a
  // varredura a exclui de vez pelo caminho de sempre (deletePrivateMeeting).
  // Ir e voltar da lixeira não mexe no updated_at, que é a ficha de quem
  // processa a reunião.
  trashedAt: bigint("trashed_at", { mode: "number" }),
  // O pedido do resumo feito antes de gravar (H4e): o modelo (pronto, da dona
  // ou "a IA escolhe"), o estilo e as instruções da dona para esta reunião.
  // Nulo: o resumo nasce com as preferências dela (preferencias_do_resumo).
  // Conferido de novo na hora de usar (server/modelos-proprios.ts): o modelo
  // da dona apagado depois do pedido volta ao padrão dela.
  summaryRequest: jsonCompat("summary_request"),
  // As vozes ligadas às contas (H3c do desenho de 16/11): { "F1": "owner",
  // "F2": "<id de meeting_participants>" }. O valor é "owner" (a própria dona)
  // ou o id da PARTICIPAÇÃO, nunca o users.id: a participação que sai, ou a
  // conta excluída, deixa uma referência que a leitura ignora, sem dado
  // pessoal. O nome da conta é resolvido na hora de ler
  // (server/vozes-da-reuniao.ts). Nula: nenhuma voz ligada a conta.
  speakerAccounts: jsonCompat("speaker_accounts").$type<Record<string, string>>(),
  // As vozes juntadas (H3c, "F3 é a mesma pessoa que F1"): { "F3": "F1" }, a
  // voz juntada apontando para a principal, sem cadeia. O nome e a conta da
  // voz juntada ficam guardados, sem uso, e "Separar" os devolve. Reprocessar
  // zera esta coluna, a de cima e speaker_names: a transcrição nova renumera
  // as vozes.
  speakerMerges: jsonCompat("speaker_merges").$type<Record<string, string>>(),
}, (table) => ({
  ownerCreatedIdx: index("meetings_owner_created_idx").on(table.ownerId, table.createdAt),
  ownerStatusIdx: index("meetings_owner_status_idx").on(table.ownerId, table.status),
  // A fila acha as reuniões em partes pelo estado, sem varrer as do envio único.
  pipelineStatusIdx: index("meetings_pipeline_status_idx").on(table.audioPipeline, table.status),
  // O link aberto acha a reunião pelo token; o MySQL aceita vários nulos.
  shareTokenUnique: uniqueIndex("meetings_share_token_unique").on(table.shareToken),
  // Excluir um contexto anula o ponteiro das reuniões da dona que estavam nele
  // (deleteContext, em server/db.ts), e o filtro por contexto acha as reuniões
  // dele, sem varrer as reuniões da dona.
  ownerContextIdx: index("meetings_owner_context_idx").on(table.ownerId, table.contextId),
  // As reuniões de uma pasta (a contagem e o filtro da lista) e o soltar da
  // pasta apagada, sem varrer as reuniões da dona.
  ownerFolderIdx: index("meetings_owner_folder_idx").on(table.ownerId, table.folderId),
  // A varredura acha a lixeira vencida sem varrer as reuniões.
  trashedIdx: index("meetings_trashed_idx").on(table.trashedAt),
}));

// As pastas das reuniões (H7d do plano do gravador; HN-67 no app de referência
// da cliente): cada dona organiza as reuniões dela em pastas com nome, ícone e
// cor. Uma reunião fica em no máximo uma pasta (meetings.folder_id). O ícone e
// a cor são chaves de listas fechadas (shared/pastas-de-reunioes.ts),
// conferidas no servidor: ícone ou cor nova não pede migração. Só a dona lê; o
// link aberto não leva a pasta. Excluir a conta apaga as pastas
// (server/exclusao-de-conta.ts). Nomes em inglês, como as irmãs meeting_*.
export const meetingFolders = mysqlTable("meeting_folders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  name: varchar("name", { length: 60 }).notNull(),
  icon: varchar("icon", { length: 24 }).notNull(),
  color: varchar("color", { length: 16 }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // As pastas da dona, na ordem em que nasceram.
  ownerCreatedIdx: index("meeting_folders_owner_created_idx").on(table.ownerId, table.createdAt),
}));

// As participantes da reunião (R1b do desenho de 16/11; decisão do Roberto de
// 22/11): a dona convida por um link de uso único (source link) ou uma das
// conexões aceitas dela (source connection), e a convidada que aceita passa a
// ler a reunião na conta dela: resumo, transcrição, gravação e o Pergunte, sem
// mudar nada. Uma linha por convite; a do link nasce sem userId, só com o hash
// do token (sha256, o token nunca é guardado), e o aceite preenche o userId,
// apaga o hash e a ativa. O convite pendente vence em expires_at (7 dias) e sai
// quando a dona abre o painel ou cria outro (limpeza preguiçosa). Sair, ser
// removida, a reunião excluída e a conta excluída (das duas pontas) apagam a
// linha. Nomes em inglês, como as irmãs meeting_*; a coluna da conta chama
// "userId", como as outras que apontam para users.id.
export const meetingParticipants = mysqlTable("meeting_participants", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  userId: int("userId"),
  status: mysqlEnum("status", ["invited", "active"]).notNull(),
  source: mysqlEnum("source", ["link", "connection"]).notNull(),
  inviteTokenHash: varchar("invite_token_hash", { length: 64 }),
  invitedAt: bigint("invited_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }),
  acceptedAt: bigint("accepted_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // Uma participação por conta em cada reunião (o MySQL aceita vários nulos:
  // os convites por link ainda não usados).
  meetingUserUnique: uniqueIndex("meeting_participants_meeting_user_unique").on(table.meetingId, table.userId),
  // O convite por link é achado pelo hash do token.
  tokenUnique: uniqueIndex("meeting_participants_token_unique").on(table.inviteTokenHash),
  // As reuniões compartilhadas com a conta e os convites dela.
  userStatusIdx: index("meeting_participants_user_status_idx").on(table.userId, table.status),
  // O painel da dona e a exclusão da reunião.
  ownerMeetingIdx: index("meeting_participants_owner_meeting_idx").on(table.ownerId, table.meetingId),
}));

// Os espaços de equipe (R2 do plano do gravador; HN-62 no app de referência
// da cliente): a pasta da dona (meeting_folders) vira o espaço de uma equipe
// quando ela convida alguém, por um link de uso único (source link) ou uma das
// conexões aceitas dela (source connection), como as participantes da reunião
// (R1b). Cada linha diz o papel: "member" lê as reuniões da pasta e escreve as
// tarefas da equipe; "reader" só lê. A dona da pasta é a dona da equipe e não
// tem linha aqui. A do link nasce sem userId, só com o hash do token (sha256),
// e o aceite preenche o userId, apaga o hash e a ativa. O convite pendente
// vence em expires_at (7 dias) e sai quando a dona abre a equipe ou cria outro
// (limpeza preguiçosa). Sair, ser removida, a pasta apagada e a conta excluída
// (das duas pontas) apagam a linha.
export const meetingFolderMembers = mysqlTable("meeting_folder_members", {
  id: varchar("id", { length: 36 }).primaryKey(),
  folderId: varchar("folder_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  userId: int("userId"),
  role: mysqlEnum("role", ["member", "reader"]).notNull(),
  status: mysqlEnum("status", ["invited", "active"]).notNull(),
  source: mysqlEnum("source", ["link", "connection"]).notNull(),
  inviteTokenHash: varchar("invite_token_hash", { length: 64 }),
  invitedAt: bigint("invited_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }),
  acceptedAt: bigint("accepted_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // Uma linha por conta em cada equipe (o MySQL aceita vários nulos: os
  // convites por link ainda não usados).
  folderUserUnique: uniqueIndex("meeting_folder_members_folder_user_unique").on(table.folderId, table.userId),
  // O convite por link é achado pelo hash do token.
  tokenUnique: uniqueIndex("meeting_folder_members_token_unique").on(table.inviteTokenHash),
  // As equipes da conta e os convites dela.
  userStatusIdx: index("meeting_folder_members_user_status_idx").on(table.userId, table.status),
  // A tela da equipe para a dona, a pasta apagada e a exclusão da conta.
  ownerFolderIdx: index("meeting_folder_members_owner_folder_idx").on(table.ownerId, table.folderId),
}));

// As tarefas da equipe (R2): o que a equipe tem a fazer, com o texto, quem
// ficou responsável (como foi escrito), o prazo e se já foi feita. A dona e as
// membras de papel "member" escrevem; as de papel "reader" só leem. São da
// pasta, não das próximas ações da dona (proximas_acoes): não vão à Google
// Agenda de ninguém nem se ligam a contato da rede particular. owner_id é a
// dona da pasta, quem quer que tenha escrito (a auditoria guarda quem foi):
// saem com a conta dela e com a pasta apagada.
export const meetingFolderTasks = mysqlTable("meeting_folder_tasks", {
  id: varchar("id", { length: 36 }).primaryKey(),
  folderId: varchar("folder_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  texto: varchar("texto", { length: 500 }).notNull(),
  responsavel: varchar("responsavel", { length: 120 }),
  prazo: date("prazo", { mode: "string" }),
  feita: boolean("feita").default(false).notNull(),
  feitaEm: bigint("feita_em", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // A lista da equipe: as abertas primeiro, por prazo.
  ownerFolderIdx: index("meeting_folder_tasks_owner_folder_idx").on(table.ownerId, table.folderId, table.feita, table.prazo),
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

// O arquivo da reunião que nasceu de um documento (H12 e H12b do desenho do
// gravador, origem 'pdf' ou 'foto'): sempre um PDF, porque as fotos de um texto
// viram um PDF no aparelho, uma página por foto. Uma linha por reunião. O texto
// que a IA lê dele vira a transcrição (meeting_transcripts), e o arquivo segue
// a regra do áudio: 30 dias contados do envio (MEETING_AUDIO_TTL_MS), a
// varredura e a leitura vencida o tiram do bucket com todas as versões, e a
// exclusão da reunião e a da conta também. A linha é o ponteiro para o objeto:
// só sai depois dele, e fica (vencida) quando o bucket recusa. Nomes em inglês,
// como as irmãs meeting_*.
export const meetingDocuments = mysqlTable("meeting_documents", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  // A chave é montada pelo servidor (meetings/<openId>/<reunião>/...), e é ela
  // que prova a posse na exclusão da conta. A url é o caminho do proxy
  // autenticado (/manus-storage/...), nunca o endereço do bucket.
  storageKey: varchar("storage_key", { length: 512 }).notNull(),
  storageUrl: varchar("storage_url", { length: 512 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  // Do conteúdo recebido: o reenvio do mesmo arquivo é reconhecido.
  sha256: varchar("sha256", { length: 64 }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => ({
  // Um documento por reunião: o segundo envio ao mesmo tempo não duplica.
  meetingUnique: uniqueIndex("meeting_documents_meeting_unique").on(table.meetingId),
  // A exclusão da conta acha os documentos pela dona; a varredura, pelo prazo.
  ownerExpiresIdx: index("meeting_documents_owner_expires_idx").on(table.ownerId, table.expiresAt),
}));

// As fotos e os desenhos à mão que a dona anexa ao resumo da reunião (H4g e
// H4h do plano do gravador; HN-32 e HN-33 no app de referência da cliente).
// A imagem chega já reduzida no aparelho (client/src/lib/reduzir-imagem.ts, a
// régua da #149) e segue a regra dos arquivos da reunião: 30 dias contados do
// envio (MEETING_AUDIO_TTL_MS), a varredura tira a vencida do bucket com todas
// as versões, e a exclusão da reunião e a da conta também. A linha é o
// ponteiro para o objeto: só sai depois dele, e fica (vencida) quando o bucket
// recusa. O link aberto mostra a imagem só pela rota dele, que confere a senha
// (H23). Nomes em inglês, como as irmãs meeting_*.
export const meetingAttachments = mysqlTable("meeting_attachments", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  // 'photo' (H4g): a foto escolhida ou tirada; 'drawing' (H4h): o desenho ou a
  // escrita à mão da tela de desenho.
  kind: mysqlEnum("kind", ["photo", "drawing"]).notNull(),
  // A chave é montada pelo servidor (meetings/<openId>/<reunião>/anexo-...), e é
  // ela que prova a posse na exclusão da conta. A url é o caminho do proxy
  // autenticado (/manus-storage/...), nunca o endereço do bucket.
  storageKey: varchar("storage_key", { length: 512 }).notNull(),
  storageUrl: varchar("storage_url", { length: 512 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => ({
  // A tela e o link leem os anexos da reunião, na ordem em que entraram.
  meetingIdx: index("meeting_attachments_meeting_idx").on(table.meetingId, table.createdAt),
  // A exclusão da conta acha os anexos pela dona; a varredura, pelo prazo.
  ownerExpiresIdx: index("meeting_attachments_owner_expires_idx").on(table.ownerId, table.expiresAt),
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
  // A edição da transcrição pela dona (H18 da auditoria de 16/11; HN-23 e
  // HN-27 do app de referência da cliente): `transcript` e `segments` acima
  // guardam a versão que a dona vê, editada ou não, e todo leitor (o resumo
  // refeito, o Pergunte, a busca, a Memória, a exportação, o link aberto) lê
  // essa versão. O texto e as falas como a IA os escreveu ficam aqui, copiados
  // na primeira edição: a conferência do que a IA tirou da transcrição
  // original (as pendências da extração, server/network-extracao.ts) e o
  // "Voltar ao original" leem daqui. Nulos: a transcrição está como a IA a
  // escreveu (nunca editada, ou toda devolvida ao original). Só a dona os lê,
  // e o link aberto nunca os seleciona (server/editar-transcricao.ts).
  originalTranscript: mediumtext("original_transcript"),
  originalSegments: jsonCompat("original_segments"),
  // Quando a dona mudou a transcrição por último (editar, trocar a voz,
  // substituir ou voltar ao original). O resumo e o mapa mental gravados antes
  // disso são de outra versão: a tela oferece "Refazer o resumo". Nulo: nunca
  // mudou.
  editedAt: bigint("edited_at", { mode: "number" }),
  // Sobe a cada mudança da dona. A tela manda a revisão que viu (a edição de
  // outra aba é recusada, em vez de desfeita em silêncio), e a fila do resumo
  // e a tradução descartam o que a IA escreveu sobre uma revisão anterior.
  revision: int("revision").default(0).notNull(),
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
  // Participou da reunião ('present') ou a reunião disse que ela não estava
  // ('mentioned'), como a extração disse (achado 7 da bancada de 16/11): a tela
  // separa as citadas das participantes. Nula nas sugestões anteriores e na
  // dúvida (a extração diz 'unknown'), que a tela mostra com as participantes.
  // Varchar com o enum só no TypeScript, como em network_sugestoes.
  presence: varchar("presence", { length: 12, enum: ["present", "mentioned"] }),
  sourceEntityIds: jsonCompat("source_entity_ids"),
  confidence: decimal("confidence", { precision: 4, scale: 3 }).default("0.000").notNull(),
  // 'self' (N5): a dona disse "Sou eu". Nenhum contato nasce; o que a pessoa
  // tem e precisa espera a confirmação dela com destino no PERFIL dela
  // (network_sugestoes.alvo = 'perfil'). No fim da lista: o valor novo não
  // reordena os que já estão gravados.
  status: mysqlEnum("status", ["pending", "created", "linked", "ignored", "self"]).default("pending").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerMeetingIdx: index("meeting_contact_suggestions_owner_meeting_idx").on(table.ownerId, table.meetingId),
  statusIdx: index("meeting_contact_suggestions_status_idx").on(table.ownerId, table.status),
}));

// O resumo GUARDADO da reunião (H4 do desenho do gravador,
// docs/arquitetura/gravador-de-reunioes.md), no formato que a cliente pediu:
// ações com caixa de marcar, foco, tarefas por assunto, decisões, bloqueios e
// questões pendentes. Uma linha por reunião, gerada em segundo plano pela fila
// do resumo; os itens ficam em meeting_summary_items. Varchar com o enum só no
// TypeScript, como em network_sugestoes: valor novo não pede migração.
export const meetingSummaries = mysqlTable("meeting_summaries", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  // A transcrição de que o resumo saiu: o reprocessamento troca a transcrição,
  // e o resumo da anterior não é gravado.
  transcriptId: varchar("transcript_id", { length: 36 }),
  status: varchar("status", { length: 12, enum: ["pending", "ready", "failed"] }).default("pending").notNull(),
  // O modelo de resumo (H4d): o que a dona escolheu ao pedir o resumo ou no
  // "Refazer como…". A lista da tela mora em shared/modelos-de-resumo.ts, e
  // server/modelos-de-resumo.ts confere que é a mesma deste enum.
  template: varchar("template", { length: 16, enum: ["general", "networking", "mentoring", "sales", "one_on_one"] }).default("general").notNull(),
  // O idioma em que o resumo foi escrito: o da reunião.
  language: varchar("language", { length: 12 }),
  // O emoji do título, como no app de referência da cliente. Nulo: sem emoji.
  emoji: varchar("emoji", { length: 16 }),
  // O título sugerido pela IA, escrito com o resumo, como no app de referência
  // da cliente ("📱 Preparação e validação do aplicativo": o emoji acima e a
  // data da reunião ficam fora do texto). É só sugestão: o título da reunião
  // muda quando a dona toca em "Usar este título", e nunca sozinho. Nulo: a IA
  // não sugeriu (ou o resumo é de antes da sugestão).
  suggestedTitle: varchar("suggested_title", { length: 200 }),
  // pending: a dona ainda não decidiu; confirmed: usou; ignored: manteve o
  // dela. Enum só no TypeScript, como o status do resumo.
  suggestedTitleStatus: varchar("suggested_title_status", { length: 12, enum: ["pending", "confirmed", "ignored"] }),
  // O id do modelo de IA que escreveu o resumo.
  model: varchar("model", { length: 80 }),
  // Sobe a cada resumo que a fila grava, e só aí: editar ou acrescentar um item
  // (H4f) não a muda. A tradução do resumo (H11) guarda de qual versão saiu e é
  // refeita inteira quando ela muda; o item editado (a impressão digital do
  // texto não bate) e o acrescentado (o id não tem tradução) são traduzidos
  // sozinhos.
  version: int("version").default(0).notNull(),
  generatedAt: bigint("generated_at", { mode: "number" }),
  // A transcrição que a versão de agora leu estava editada pela dona (H18)? A
  // fila grava junto com o generated_at. A dona que volta tudo ao original (ou
  // o único trecho que mudou) devolve a transcrição que um resumo escrito sobre
  // a versão da IA leu: ele não é de outra versão, e a tela não oferece
  // "Refazer o resumo" (server/resumo-guardado.ts). Nulo: o resumo é de antes
  // da edição existir, quando só havia a versão da IA.
  transcriptEdited: boolean("transcript_edited"),
  // Controle da fila do resumo; fica no servidor.
  attempts: int("attempts").default(0).notNull(),
  lockedUntil: bigint("locked_until", { mode: "number" }),
  lockToken: varchar("lock_token", { length: 36 }),
  // Código nosso, nunca o texto da IA ou do driver.
  lastError: varchar("last_error", { length: 40 }),
  // O mapa mental (H10): o mesmo trabalho da fila, numa chamada à IA depois
  // do resumo, com as mesmas colunas de reserva. O mapa que falha não derruba
  // o resumo pronto. A árvore guardada já passou pela conferência de
  // shared/mapa-mental.ts (de 2 a 12 ramos, até 8 folhas por ramo, até 4
  // filhos por folha, até 150 nós, rótulos de até 60 caracteres e nenhum
  // rótulo de voz); a raiz é o título da reunião e não fica guardada.
  mindMap: jsonCompat("mind_map"),
  // Nulo: o resumo é de antes do mapa, e a dona o pede na aba do mapa.
  mindMapStatus: varchar("mind_map_status", { length: 12, enum: ["pending", "ready", "failed"] }),
  // Quando o mapa foi gravado: a tradução do resumo (H11) refaz a do mapa
  // quando ela muda (a `version` sobe só com o resumo).
  mindMapGeneratedAt: bigint("mind_map_generated_at", { mode: "number" }),
  // Código nosso, como o last_error.
  mindMapError: varchar("mind_map_error", { length: 40 }),
  // O modelo da própria dona (H4e), quando o resumo saiu de um: o template
  // fica 'general' (as seções e as quantidades do Geral) e a instrução dela
  // entra no lugar da frase de contexto. Nulo: um modelo pronto. O modelo
  // apagado solta os resumos que o usavam (server/modelos-proprios.ts).
  customTemplateId: varchar("custom_template_id", { length: 36 }),
  // "A IA escolhe o modelo" (H4e): 'pending' até a fila pedir a escolha ao
  // modelo Lite, 'chosen' depois de gravar o resumo no modelo que ela
  // escolheu. Nulo: quem escolheu foi a dona.
  aiTemplate: varchar("ai_template", { length: 8, enum: ["pending", "chosen"] }),
  // O estilo (H4e): conciso, equilibrado (o resumo de antes) ou detalhado.
  style: varchar("style", { length: 10, enum: ["concise", "balanced", "detailed"] }).default("balanced").notNull(),
  // As instruções da dona para este resumo (H4e: o pedido antes de gravar, o
  // pedido e o "Refazer o resumo"), até 500 caracteres. Só da dona: o link
  // aberto nunca as recebe.
  instructions: varchar("instructions", { length: 500 }),
  // "O resumo teve o tamanho certo?" (H4e): a resposta da dona a esta versão.
  // Muda o ajuste dela (preferencias_do_resumo.length_adjust), que vale para
  // os próximos resumos. O refazer a zera: a versão nova é outra.
  lengthFeedback: varchar("length_feedback", { length: 8, enum: ["short", "right", "long"] }),
  // O mapa que a dona editou (H10b; HN-40 do app de referência da cliente):
  // ramos renomeados, arrastados, acrescentados ou apagados. A versão da IA
  // continua em `mind_map`, como a transcrição da IA fica em
  // `original_transcript` na H18; a tela e o link mostram esta quando existe.
  // Passa pela mesma conferência (shared/mapa-mental-edicao.ts). Nulo: o mapa
  // está como a IA o escreveu.
  mindMapEdited: jsonCompat("mind_map_edited"),
  mindMapEditedAt: bigint("mind_map_edited_at", { mode: "number" }),
  // Sobe a cada mudança no mapa (editar, voltar ao da IA, refazer, o mapa novo
  // que a fila grava): a tela manda a revisão que viu, e a mudança de outra
  // aba é recusada em vez de desfeita em silêncio.
  mindMapRevision: int("mind_map_revision").default(0).notNull(),
  // O estilo do mapa (H10b): o que a dona pediu no "Refazer em outro estilo",
  // que a IA segue e a tela desenha. Nulo: a visão geral da H10.
  mindMapStyle: varchar("mind_map_style", { length: 16, enum: ["overview", "hierarchical", "timeline", "concept"] }),
  // O estilo do mapa que segue à vista enquanto o "Refazer em outro estilo"
  // está na fila ou depois que ele falhou: mindMapStyle já é o pedido, e o
  // mapa guardado ainda é o de antes. A fila o limpa ao gravar o mapa novo.
  mindMapPreviousStyle: varchar("mind_map_previous_style", { length: 16, enum: ["overview", "hierarchical", "timeline", "concept"] }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  meetingUnique: uniqueIndex("meeting_summaries_meeting_unique").on(table.meetingId),
  ownerMeetingIdx: index("meeting_summaries_owner_meeting_idx").on(table.ownerId, table.meetingId),
  // A fila reserva pelo estado e pela reserva vencida.
  statusLockedIdx: index("meeting_summaries_status_locked_idx").on(table.status, table.lockedUntil),
  // E o mapa pendente (H10) pelo estado dele, sem varrer os resumos prontos.
  mindMapStatusLockedIdx: index("meeting_summaries_mind_map_status_locked_idx").on(table.mindMapStatus, table.lockedUntil),
}));

// Os modelos de resumo da própria dona (H4e do plano do gravador, HN-35 do
// HiNoter): o nome, o ícone (de uma lista fechada, shared/modelos-de-resumo.ts)
// e as instruções que dizem à IA que tipo de reunião é e o que destacar. Só da
// dona: toda consulta leva o owner_id, e o link aberto não recebe nada disto.
// Até 20 por dona (MODELOS_PROPRIOS_MAX).
export const modelosDeResumoProprios = mysqlTable("modelos_de_resumo_proprios", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  nome: varchar("nome", { length: 60 }).notNull(),
  icone: varchar("icone", { length: 16 }).notNull(),
  instrucoes: varchar("instrucoes", { length: 1500 }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerIdx: index("modelos_de_resumo_proprios_owner_idx").on(table.ownerId, table.createdAt),
}));

// As preferências do resumo da dona (H4e): o modelo padrão (um pronto, 'ia'
// para "a IA escolhe" ou 'proprio' com o id), o estilo padrão e o ajuste do
// tamanho que as respostas a "O resumo teve o tamanho certo?" acumulam (de -2
// a +2). Sem linha: o Geral, equilibrado, sem ajuste.
export const preferenciasDoResumo = mysqlTable("preferencias_do_resumo", {
  ownerId: varchar("owner_id", { length: 128 }).primaryKey(),
  modeloPadrao: varchar("modelo_padrao", { length: 16 }).default("general").notNull(),
  modeloProprioPadraoId: varchar("modelo_proprio_padrao_id", { length: 36 }),
  estiloPadrao: varchar("estilo_padrao", { length: 10, enum: ["concise", "balanced", "detailed"] }).default("balanced").notNull(),
  ajusteDoTamanho: int("ajuste_do_tamanho").default(0).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// O teto de custo do "Refazer o resumo" (H4e): uma linha por refazer aceito,
// SEM a reunião nem o conteúdo, só a dona e a hora. Conta as últimas 24 h
// (REFAZERES_POR_DIA), no banco e não em memória, para o deploy não o zerar,
// como o Pergunte a várias reuniões (perguntas_entre_reunioes).
export const resumosRefeitos = mysqlTable("resumos_refeitos", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerCreatedIdx: index("resumos_refeitos_owner_created_idx").on(table.ownerId, table.createdAt),
}));

// Cada item do resumo guardado. Nada extraído por IA entra sozinho
// (CLAUDE.md): o item nasce 'pending', com a confiança e o TRECHO literal da
// transcrição que o sustenta, e só vale como dado da dona quando ela confirma.
// Quem falou aparece como o rótulo da voz ({F2}), que a tela troca pelo nome
// que a dona deu (meetings.speaker_names); o servidor nunca escreve o nome.
// A dona também edita o item e acrescenta item à mão (H4f): o que ela escreve
// vale como confirmado, e a origem diz quem escreveu o item.
export const meetingSummaryItems = mysqlTable("meeting_summary_items", {
  id: varchar("id", { length: 36 }).primaryKey(),
  summaryId: varchar("summary_id", { length: 36 }).notNull(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  section: varchar("section", { length: 12, enum: ["action", "focus", "task", "decision", "blocker", "question"] }).notNull(),
  position: int("position").notNull(),
  // O assunto das tarefas ("Publicação nas lojas"); nulo nas outras seções.
  subject: varchar("subject", { length: 120 }),
  text: text("text").notNull(),
  // Quem ficou responsável: o rótulo da voz ("{F2}") ou o nome como foi dito, um
  // ou mais ("{F2}, {F3}"). Nulo quando a transcrição não sustenta todos.
  assignee: varchar("assignee", { length: 120 }),
  // O prazo como foi dito ("até sexta-feira"). Nulo quando não foi dito.
  due: varchar("due", { length: 120 }),
  // Vazio no item que a dona acrescentou: ele não sai de um trecho.
  excerpt: text("excerpt").notNull(),
  // O segundo da reunião em que o trecho começa; nulo sem tempo (envio único).
  startSeconds: int("start_seconds"),
  confidence: decimal("confidence", { precision: 4, scale: 3 }).default("0.000").notNull(),
  status: varchar("status", { length: 12, enum: ["pending", "confirmed", "ignored"] }).default("pending").notNull(),
  // A caixa de marcar das ações.
  done: boolean("done").default(false).notNull(),
  decidedAt: bigint("decided_at", { mode: "number" }),
  doneAt: bigint("done_at", { mode: "number" }),
  // Quem escreveu o item (H4f): a IA, a partir da transcrição, ou a dona, à
  // mão. O item da dona nasce confirmado, sem trecho, sem tempo e sem
  // confiança. Não muda quando a dona edita: o item da IA editado continua
  // vindo da reunião, com o trecho e o tempo, e o edited_at marca a edição.
  // Varchar com o enum só no TypeScript: a origem que vier depois (a busca na
  // web da H4i) não pede migração.
  origin: varchar("origin", { length: 12, enum: ["ai", "owner"] }).default("ai").notNull(),
  // Quando a dona mudou por último o texto, o assunto, o responsável ou o
  // prazo do item. Nulo: o item está como foi escrito. O item escrito pela
  // dona (acrescentado ou editado) não volta a "para conferir".
  editedAt: bigint("edited_at", { mode: "number" }),
  // O estado de antes do Ignorar (H4f), para o Desfazer voltar a ele: o
  // status (pending ou confirmed) e a hora em que a ação foi marcada feita
  // (nula: não estava feita). Gravado ao ignorar e só lido enquanto o item
  // está ignorado. Nulo no item ignorado antes destas colunas, quando só o
  // item pendente tinha Ignorar: o Desfazer o devolve pendente. Exceção: o
  // item pendente com pending aqui é o que a dona ignorou e a IA repetiu no
  // "Refazer como…" (server/fila-do-resumo.ts, defeito do T29): a tela avisa
  // que ele voltou. A marca só vale no item pendente: decidir o item a apaga
  // ou a regrava, e o confirmado não a mostra.
  statusBeforeIgnore: varchar("status_before_ignore", { length: 12, enum: ["pending", "confirmed"] }),
  doneAtBeforeIgnore: bigint("done_at_before_ignore", { mode: "number" }),
  // O complemento pela busca na web (H4i, server/complemento-pela-busca.ts): a
  // dona pede, num item, que a IA complete uma referência dita pela metade (o
  // número de uma lei, o nome de uma norma ou de uma empresa). O complemento
  // vem de FORA da reunião: nasce pending, com a fonte (o endereço que a
  // busca da Google devolveu), e só entra no resumo (o link, a Memória, o
  // áudio) quando a dona o confirma; ignorar apaga as colunas. Um por item.
  complementText: text("complement_text"),
  complementSourceUrl: varchar("complement_source_url", { length: 2048 }),
  complementSourceTitle: varchar("complement_source_title", { length: 300 }),
  // As consultas que a busca fez (até 5, de até 200 caracteres): a tela as
  // mostra, como pedem os termos da busca da Google no Gemini.
  complementQueries: jsonCompat("complement_queries"),
  complementStatus: varchar("complement_status", { length: 12, enum: ["pending", "confirmed"] }),
  complementAt: bigint("complement_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  summaryPositionIdx: index("meeting_summary_items_summary_position_idx").on(table.summaryId, table.position),
  ownerMeetingIdx: index("meeting_summary_items_owner_meeting_idx").on(table.ownerId, table.meetingId),
  // As próximas ações (H5) leem os itens confirmados de todas as reuniões da dona.
  ownerSectionStatusIdx: index("meeting_summary_items_owner_section_status_idx").on(table.ownerId, table.section, table.status),
}));

// As próximas ações da dona (H5a do desenho do gravador,
// docs/arquitetura/gravador-de-reunioes.md): o que ela confirmou como ação ou
// tarefa no resumo guardado de uma reunião (origem 'reuniao') e o que anotou à
// mão (origem 'manual'). A da reunião nasce na mesma transação em que a dona
// confirma o item (server/proximas-acoes.ts) e copia dele o texto, o
// responsável, o prazo como foi dito e o trecho. Os rótulos de voz ({F2}) ficam
// como no item, e a tela os troca pelos nomes enquanto a ação está presa a ele.
// A reunião excluída ou reprocessada solta a ação: os nomes das vozes viram
// texto e item_id fica nulo; na exclusão, meeting_id e o trecho também. Excluir
// o contato anula contact_id. Varchar com o enum só no TypeScript, como em
// network_sugestoes.
export const proximasAcoes = mysqlTable("proximas_acoes", {
  id:          varchar("id", { length: 36 }).primaryKey(),
  ownerId:     varchar("owner_id", { length: 128 }).notNull(),
  texto:       text("texto").notNull(),
  detalhe:     text("detalhe"),
  // Quem ficou responsável: o rótulo da voz ou o nome como foi dito (vem do
  // item), ou o que a dona escreveu.
  responsavel: varchar("responsavel", { length: 120 }),
  // O prazo em data, que a dona escolhe. O que foi dito na reunião ("até
  // sexta-feira") fica em prazo_dito, como no item.
  prazo:       date("prazo", { mode: "string" }),
  prazoDito:   varchar("prazo_dito", { length: 120 }),
  contactId:   bigint("contact_id", { mode: "number" }),
  meetingId:   varchar("meeting_id", { length: 36 }),
  itemId:      varchar("item_id", { length: 36 }),
  trecho:      text("trecho"),
  origem:      varchar("origem", { length: 8, enum: ["reuniao", "manual"] }).notNull(),
  feita:       boolean("feita").default(false).notNull(),
  feitaEm:     bigint("feita_em", { mode: "number" }),
  // A ação na Google Agenda conectada da dona (H5c do plano do gravador), com
  // os estados de agenda_reunioes.google. Nulo enquanto ela não está lá: sem
  // prazo, feita, sem a Google Agenda conectada, com o dia do prazo encerrado
  // antes de ir, ou depois que a conta Google sai ou muda (server/google-agenda.ts).
  // "pendente" do momento em que o banco gravou até a Google responder; "ok"
  // quando a Google tem a versão daqui; "falhou" quando não tem, e a tela
  // mostra "Tentar de novo". O id do evento lá é "acao" mais o id daqui sem os
  // hífens (server/acoes-na-google.ts): não há coluna para ele. Enum só no
  // TypeScript, como em agenda_reunioes.google.
  google:      varchar("google", { length: 16, enum: ["pendente", "ok", "falhou"] }),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:   bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // Uma ação por item: confirmar de novo, ou duas abas ao mesmo tempo, não
  // duplica. A manual e a solta têm item_id nulo, e nulos não colidem.
  ownerItemUnique: uniqueIndex("proximas_acoes_owner_item_unique").on(table.ownerId, table.itemId),
  // A página e o cartão do Dashboard: as abertas da dona, por prazo.
  ownerFeitaPrazoIdx: index("proximas_acoes_owner_feita_prazo_idx").on(table.ownerId, table.feita, table.prazo),
  // Soltar as ações da reunião excluída e anular o contato excluído.
  ownerMeetingIdx: index("proximas_acoes_owner_meeting_idx").on(table.ownerId, table.meetingId),
  ownerContactIdx: index("proximas_acoes_owner_contact_idx").on(table.ownerId, table.contactId),
}));

// A agenda de reuniões da dona (H16a do plano do gravador): a reunião marcada
// para depois, com o convite por WhatsApp e por e-mail aberto no app da própria
// dona e o .ics feito no navegador. Só a dona lê e escreve: owner_id no WHERE de
// tudo (server/agenda-de-reunioes.ts). A gravação só nasce quando ela toca em
// "Gravar agora"; aqui fica só o ponteiro (meeting_id), que a exclusão da
// reunião volta a nulo.
export const agendaReunioes = mysqlTable("agenda_reunioes", {
  id:              varchar("id", { length: 36 }).primaryKey(),
  ownerId:         varchar("owner_id", { length: 128 }).notNull(),
  titulo:          varchar("titulo", { length: 200 }).notNull(),
  // O início em UTC (ms) e a duração em minutos. O fuso (IANA, como
  // "America/Sao_Paulo") é o do aparelho de quem marcou: o convite diz a hora
  // como ela marcou, com o nome do fuso.
  inicioEm:        bigint("inicio_em", { mode: "number" }).notNull(),
  duracaoMinutos:  int("duracao_minutos").notNull(),
  fuso:            varchar("fuso", { length: 64 }).notNull(),
  // O endereço ou o link da chamada (Meet, Zoom, Teams), como a dona escreveu.
  local:           varchar("local", { length: 500 }),
  // Quem vai: o nome e o e-mail, cada um opcional, nunca os dois vazios. É dado
  // de terceiros na base particular da dona, como os contatos: sai com a conta
  // dela (server/exclusao-de-conta.ts).
  participantes:   jsonCompat("participantes").$type<Array<{ nome: string | null; email: string | null }>>().notNull(),
  // Minutos antes do início; nulo é sem lembrete. Vai no .ics (VALARM).
  lembreteMinutos: int("lembrete_minutos"),
  // A gravação feita pelo "Gravar agora". Nulo enquanto ninguém gravou; a
  // exclusão da reunião volta a nulo (deletePrivateMeeting).
  meetingId:       varchar("meeting_id", { length: 36 }),
  // A reunião na Google Agenda conectada da dona (H16c do plano do gravador).
  // Nulo enquanto ela nunca foi mandada para lá (a dona não tinha a Google
  // Agenda conectada), e de novo quando a conta Google sai ou muda: o estado é
  // da conta conectada (server/google-agenda.ts). A reunião que já acabou não é
  // criada lá e fica nula. "pendente" do momento em que o banco gravou até a Google
  // responder; "ok" quando a Google tem a versão que está aqui; "falhou" quando
  // não tem, e a tela mostra "Tentar de novo". O id do evento lá é o id daqui
  // sem os hífens (server/google-agenda-eventos.ts): não há coluna para ele.
  // Enum só no TypeScript, como em google_agenda_conexoes.falha.
  google:          varchar("google", { length: 16, enum: ["pendente", "ok", "falhou"] }),
  // "A Google manda o convite pela sua conta": só com ela marcada os
  // participantes com e-mail entram no evento como convidados, e a Google manda
  // o convite (e os avisos de mudança e de cancelamento) pela conta da dona.
  // Falso por padrão: o evento fica só na agenda dela, sem convidados, e a WRW
  // não faz a Google mostrar nem mandar nada a terceiros sem ela marcar.
  googleConvites:  boolean("google_convites").default(false).notNull(),
  // A agenda da equipe (R2): a reunião marcada que a dona pôs numa pasta dela
  // com equipe. As membras veem o título, a hora, a duração, o fuso e o local,
  // nunca os participantes (nome e e-mail de terceiros). Apagar a pasta volta a
  // nulo, na mesma transação.
  folderId:        varchar("folder_id", { length: 36 }),
  createdAt:       bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:       bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // A tela lê a agenda da dona pela data.
  ownerInicioIdx: index("agenda_reunioes_owner_inicio_idx").on(table.ownerId, table.inicioEm),
  // Uma gravação liga a uma reunião da agenda só; o MySQL aceita vários nulos.
  meetingUnique:  uniqueIndex("agenda_reunioes_meeting_unique").on(table.meetingId),
  // A agenda da equipe, pela pasta.
  ownerFolderIdx: index("agenda_reunioes_owner_folder_idx").on(table.ownerId, table.folderId),
}));

// A conta Google que a dona conectou para a Google Agenda (H16b do plano do
// gravador), por OAuth com PKCE e sem biblioteca (server/google-oauth.ts). Só o
// refresh token fica no banco, cifrado com a VAULT_ENCRYPTION_KEY (encryptData,
// server/security.ts); o token de acesso vive só na memória do processo, menos
// de 1 hora. Uma conexão por conta: reconectar troca a linha. A Google revoga
// por conta Google e projeto, não por token, então o token anterior só é
// revogado quando a conta Google mudou e nenhuma outra conexão usa a anterior.
// Desconectar e excluir a conta revogam o token (menos quando outra conta da
// WRW usa a mesma conta Google) e apagam a linha (server/google-agenda.ts e
// server/exclusao-de-conta.ts).
export const googleAgendaConexoes = mysqlTable("google_agenda_conexoes", {
  id:                  varchar("id", { length: 36 }).primaryKey(),
  userId:              int("userId").notNull(),
  // O `sub` do id_token: o id da conta Google, que nunca muda nem é reusado (o
  // e-mail pode mudar). Duas linhas com o mesmo sub dividem a mesma
  // autorização na Google: revogar o token de uma derruba a outra. É por ele
  // que a WRW decide se pode revogar.
  googleSub:           varchar("google_sub", { length: 255 }).notNull(),
  // O e-mail da conta Google, tirado do id_token, só para a dona saber qual
  // conta está ligada. Nulo quando a Google não o manda.
  emailGoogle:         varchar("email_google", { length: 320 }),
  // "iv:authTag:dados", o formato de encryptData. Nunca vai à tela nem ao log.
  refreshTokenCifrado: text("refresh_token_cifrado").notNull(),
  // Os escopos que a Google devolveu na troca do código, separados por espaço.
  escopos:             varchar("escopos", { length: 1000 }).notNull(),
  // Nulo enquanto a conexão vale. "revogada" quando ela parou de funcionar: a
  // Google recusou o refresh token (invalid_grant) ou ele não se decifra mais.
  // A tela pede "Reconectar". Enum só no TypeScript, como em chaves_de_acesso.
  falha:               varchar("falha", { length: 32, enum: ["revogada"] }),
  createdAt:           bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:           bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // Uma conexão por conta: o reconectar é INSERT ... ON DUPLICATE KEY UPDATE.
  userUnique: uniqueIndex("google_agenda_conexoes_user_unique").on(table.userId),
  // Antes de revogar, a WRW procura outra conexão com a mesma conta Google.
  // Não é único: duas contas da WRW podem ligar a mesma conta Google.
  subIdx: index("google_agenda_conexoes_sub_idx").on(table.googleSub),
}));

// Entrar com a conta Google (A8; server/entrar-com-google.ts). A linha liga UMA
// conta Google a UMA conta da WRW, pelo `sub` do id_token (o id da conta
// Google, que nunca muda nem é reusado). Nenhum token da Google fica guardado:
// a entrada só precisa saber quem é a pessoa, e o token de acesso da troca é
// descartado na hora (sem revogar: a Google revoga por conta Google e projeto,
// e revogar derrubaria a conexão da Google Agenda da mesma conta). Sai com a
// exclusão da conta, com "Desligar" no Perfil e com a redefinição de senha
// (como as chaves de acesso).
export const contasGoogle = mysqlTable("contas_google", {
  id:          varchar("id", { length: 36 }).primaryKey(),
  userId:      int("userId").notNull(),
  // O `sub` do id_token. Único: uma conta Google entra numa conta da WRW só.
  googleSub:   varchar("google_sub", { length: 255 }).notNull(),
  // O e-mail verificado da conta Google na hora de ligar, só para a dona saber
  // qual conta está ligada. Nada decide por ele depois de ligada.
  emailGoogle: varchar("email_google", { length: 320 }),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
  ultimoUsoEm: bigint("ultimo_uso_em", { mode: "number" }),
}, (table) => ({
  // Uma conta Google por conta da WRW: ligar outra pede desligar a de antes.
  userUnique: uniqueIndex("contas_google_user_unique").on(table.userId),
  subUnique: uniqueIndex("contas_google_sub_unique").on(table.googleSub),
}));

// Os lembretes no sino (H15 do plano do gravador): o da próxima ação com prazo
// (H5a) e o da reunião da agenda com lembrete (H16a). Uma linha por origem,
// escrita junto com ela (server/lembretes.ts): marcar o prazo ou a hora agenda,
// mudar reagenda, apagar a origem apaga o lembrete. O laço do servidor reserva
// os que venceram por token, a cada 60 s, e grava o aviso no sino e a marca de
// disparado na mesma transação. O texto não fica aqui: no disparo, o laço lê a
// origem (e troca os rótulos de voz pelos nomes). Varchar com o enum só no
// TypeScript, como em network_sugestoes.
export const lembretes = mysqlTable("lembretes", {
  id:          varchar("id", { length: 36 }).primaryKey(),
  ownerId:     varchar("owner_id", { length: 128 }).notNull(),
  // De onde vem: a próxima ação ('acao', proximas_acoes.id) ou a reunião da
  // agenda ('agenda', agenda_reunioes.id).
  origem:      varchar("origem", { length: 8, enum: ["acao", "agenda"] }).notNull(),
  origemId:    varchar("origem_id", { length: 36 }).notNull(),
  // Quando avisar e até quando o aviso ainda serve (o dia do prazo passou, a
  // reunião acabou): vencido, sai sem aviso. Em ms UTC.
  dispararEm:  bigint("disparar_em", { mode: "number" }).notNull(),
  expiraEm:    bigint("expira_em", { mode: "number" }).notNull(),
  // A marca: o aviso desta hora já saiu (ou venceu sem sair). Reagendar para
  // outra hora a zera; a mesma hora, não, para o aviso não sair duas vezes.
  disparadoEm: bigint("disparado_em", { mode: "number" }),
  lockToken:   varchar("lock_token", { length: 36 }),
  lockedUntil: bigint("locked_until", { mode: "number" }),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:   bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // Um lembrete por origem: agendar de novo, ou duas abas ao mesmo tempo, não duplica.
  ownerOrigemUnique: uniqueIndex("lembretes_owner_origem_unique").on(table.ownerId, table.origem, table.origemId),
  // O laço: os que ainda não saíram, pela hora; e os que ele reservou, pelo token.
  disparoIdx: index("lembretes_disparo_idx").on(table.disparadoEm, table.dispararEm),
  lockIdx: index("lembretes_lock_idx").on(table.lockToken),
}));

// A tradução do resumo guardado (H11) para o idioma de quem lê: o resumo é
// escrito no idioma da reunião, e a IA o traduz em segundo plano quando alguém
// o lê em outro idioma. Uma linha por dona, reunião e idioma. O conteúdo vai
// por id de item, com a impressão digital do texto de que saiu, mais os
// rótulos do mapa mental (H10): item novo ou editado não acha a tradução e é
// traduzido de novo, e a tradução de outra versão do resumo não vale. O trecho
// nunca é traduzido (é a prova, no idioma original), e os rótulos de voz
// ({F2}) vão como estão: a tela é que os troca pelo nome.
export const meetingSummaryTranslations = mysqlTable("meeting_summary_translations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  // O resumo de que a tradução saiu: reprocessar a reunião cria outro.
  summaryId: varchar("summary_id", { length: 36 }).notNull(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  language: varchar("language", { length: 12 }).notNull(),
  // A versão do resumo (meeting_summaries.version) de que a tradução saiu.
  sourceVersion: int("source_version").notNull(),
  // { itens: { [id do item]: { h, subject, text, due } }, mapa: { [rótulo]: tradução } }
  content: jsonCompat("content").notNull(),
  // O id do modelo de IA que traduziu.
  model: varchar("model", { length: 80 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerMeetingLanguageIdx: uniqueIndex("meeting_summary_translations_owner_meeting_language_idx").on(table.ownerId, table.meetingId, table.language),
}));

// O resumo por e-mail (H22 do plano do gravador; HN-54 do HiNoter): uma linha
// por e-mail que a WRW manda com o link de uma reunião, a pedido da dona (um
// toque no detalhe) ou pelo envio automático dela (users.resumoPorEmailAutomatico).
// A linha nasce 'pendente' ANTES da Resend, na transação do pedido: a Resend
// fora do ar deixa 'falhou', e a dona manda de novo sem escolher outra vez. As
// linhas das últimas 24 h são os tetos por reunião e por dona
// (server/resumo-por-email.ts). O destinatário é dado de terceiros na base da
// dona: excluir a reunião o apaga (a linha fica, sem ele, para o teto da dona)
// e excluir a conta apaga as linhas (server/exclusao-de-conta.ts). Enums só no
// TypeScript, como em agenda_reunioes.google.
export const resumoPorEmail = mysqlTable("resumo_por_email", {
  id: varchar("id", { length: 36 }).primaryKey(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  // O pedido de que a linha saiu: um toque manda a várias pessoas.
  loteId: varchar("lote_id", { length: 36 }).notNull(),
  // Nulo depois que a reunião é excluída.
  destinatario: varchar("destinatario", { length: 320 }),
  origem: varchar("origem", { length: 16, enum: ["dona", "participante", "digitado"] }).notNull(),
  // O idioma do texto do e-mail: o da reunião, um dos 10 da tela.
  idioma: varchar("idioma", { length: 12 }).notNull(),
  status: varchar("status", { length: 12, enum: ["pendente", "enviado", "falhou"] }).default("pendente").notNull(),
  // O envio automático do fim da reunião, que vai só para a dona.
  automatico: boolean("automatico").default(false).notNull(),
  tentativas: int("tentativas").default(0).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  enviadoEm: bigint("enviado_em", { mode: "number" }),
}, (table) => ({
  // Os tetos contam as linhas das últimas 24 h, por dona e por reunião.
  ownerCreatedIdx: index("resumo_por_email_owner_created_idx").on(table.ownerId, table.createdAt),
  meetingCreatedIdx: index("resumo_por_email_meeting_created_idx").on(table.meetingId, table.createdAt),
}));

// O Pergunte a várias reuniões (H6c do plano do gravador,
// server/perguntar-a-varias-reunioes.ts): uma linha por pergunta que foi à IA,
// SEM o conteúdo. Nem a pergunta, nem a resposta, nem as citações, nem quais
// reuniões: só quantas, o tamanho do que a IA leu, como terminou, o modelo e a
// avaliação da dona. Serve ao teto de 24 h (contado aqui, e não em memória, para
// o deploy não zerá-lo) e à avaliação da resposta. Guardar o texto pede o aviso
// novo da Cris (o histórico do Pergunte, a H6b inteira, está fora).
export const perguntasEntreReunioes = mysqlTable("perguntas_entre_reunioes", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  // 'pendente' enquanto a IA responde; a falha da IA fica 'falhou' (e conta no teto).
  situacao: varchar("situacao", { length: 16, enum: ["pendente", "respondida", "nao_respondida", "falhou"] }).default("pendente").notNull(),
  reunioesEscolhidas: int("reunioes_escolhidas").notNull(),
  reunioesLidas: int("reunioes_lidas").notNull(),
  // As reuniões diferentes nas citações conferidas: o "número de fontes" da tela.
  fontesCitadas: int("fontes_citadas").default(0).notNull(),
  // O tamanho da entrada da IA, o que custa a pergunta.
  caracteres: int("caracteres").notNull(),
  // A tabela ou o gráfico que foi à tela (H6d); nulo sem visual.
  visual: varchar("visual", { length: 12, enum: ["tabela", "barras", "linhas"] }),
  modelo: varchar("modelo", { length: 80 }),
  // "Ajudou" (boa) ou "Não ajudou" (ruim); nula enquanto a dona não avalia.
  avaliacao: varchar("avaliacao", { length: 8, enum: ["boa", "ruim"] }),
  avaliadaEm: bigint("avaliada_em", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  // O teto conta as linhas das últimas 24 h da dona.
  ownerCreatedIdx: index("perguntas_entre_reunioes_owner_created_idx").on(table.ownerId, table.createdAt),
}));

// O áudio do resumo com a voz do Gemini (H19b, server/resumo-em-audio.ts): a
// dona pede "Baixar o áudio do resumo", e o servidor gera o MP3 uma vez por
// texto do resumo (o hash do que a voz lê) e idioma, guarda no bucket sob
// meetings/<openId>/ e serve de novo. Uma linha por geração, mesmo a que
// falhou: o teto de 24 h conta aqui (e não em memória, para o deploy não
// zerá-lo). Quando o texto muda, o objeto antigo sai e a linha fica sem a chave
// (só para o teto); a exclusão da reunião tira os objetos; a da conta, as
// linhas. Sem texto do resumo: só o hash dele.
export const resumoEmAudio = mysqlTable("resumo_em_audio", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  meetingId: varchar("meeting_id", { length: 36 }).notNull(),
  language: varchar("language", { length: 12 }).notNull(),
  textHash: varchar("text_hash", { length: 64 }).notNull(),
  situacao: varchar("situacao", { length: 12, enum: ["pendente", "pronto", "falhou"] }).default("pendente").notNull(),
  // Nula enquanto gera, na falha e depois que o objeto saiu.
  storageKey: varchar("storage_key", { length: 512 }),
  bytes: int("bytes"),
  durationMs: int("duration_ms"),
  modelo: varchar("modelo", { length: 80 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerCreatedIdx: index("resumo_em_audio_owner_created_idx").on(table.ownerId, table.createdAt),
  meetingIdx: index("resumo_em_audio_meeting_idx").on(table.ownerId, table.meetingId),
}));

// As buscas na web do complemento (H4i, server/complemento-pela-busca.ts): uma
// linha por busca que foi à IA, sem o conteúdo (nem o item, nem a resposta,
// nem as consultas), para o teto de 24 h por dona, contado aqui para o deploy
// não zerá-lo. O complemento mesmo mora no item (meeting_summary_items).
export const buscasDoComplemento = mysqlTable("buscas_do_complemento", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  situacao: varchar("situacao", { length: 12, enum: ["pendente", "achou", "nao_achou", "falhou"] }).default("pendente").notNull(),
  modelo: varchar("modelo", { length: 80 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerCreatedIdx: index("buscas_do_complemento_owner_created_idx").on(table.ownerId, table.createdAt),
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
  // De onde o item veio, quando não foi a dona que escreveu: "entidade" (a planilha da
  // entidade, N1) ou "cnae" (a atividade da empresa pela tabela do IBGE, N4). Nulo = a dona.
  // A CNAE só preenche este lado ("o que tem"); contact_needs não tem a coluna de propósito.
  origem: varchar("origem", { length: 20 }),
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
  // cargo e empresa: o apoio da pessoa da reunião, que criar ou vincular não grava sozinho (achado 6 da bancada de 16/11).
  campo:               varchar("campo", { length: 12, enum: ["nome", "telefone", "email", "tipo_pessoa", "tenho", "preciso", "cargo", "empresa"] }).notNull(),
  valor:               varchar("valor", { length: 320 }).notNull(),
  categoria:           varchar("categoria", { length: 120 }),
  trecho:              text("trecho"),
  confianca:           decimal("confianca", { precision: 4, scale: 3 }).default("0.000").notNull(),
  status:              varchar("status", { length: 12, enum: ["pendente", "confirmada", "ignorada"] }).default("pendente").notNull(),
  // Para onde o item vai quando a dona confirma (N5): o CONTATO (contact_id,
  // como sempre) ou o PERFIL da própria dona, quando ela disse "Sou eu" na
  // reunião (só "tenho" e "preciso"; contact_id fica nulo). A linha
  // confirmada guarda a origem do item (reunião, trecho e valor): os itens
  // não ganham coluna. Varchar com o enum só no TypeScript, como em origem.
  alvo:                varchar("alvo", { length: 8, enum: ["contato", "perfil"] }).default("contato").notNull(),
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

// ============================================================
// A BASE DAS ASSOCIAÇÕES (N1, docs/arquitetura/entidades.md)
// A entidade é uma conta; cada associado é um contato da rede dela
// (private_contacts + contact_assets/contact_needs), com o ID anônimo do Meu
// Network Inteligente, e uma linha em entidade_membros com o que só a entidade
// vê: o documento (HMAC para achar repetidos, cifrado para mostrar), os
// contatos cifrados e as CNAEs. Nada daqui é lido pelo cruzamento global.
// ============================================================
export const entidades = mysqlTable("entidades", {
  id:                 int("id").autoincrement().primaryKey(),
  // A conta da entidade (openId). Uma conta por entidade (decisão de 22/11).
  ownerId:            varchar("owner_id", { length: 128 }).notNull(),
  nome:               varchar("nome", { length: 200 }).notNull(),
  tipo:               varchar("tipo", { length: 20, enum: ["federacao", "associacao", "confederacao", "sindicato", "outra"] }).notNull(),
  // ISO 3166-1 alfa-2: decide o documento dos associados (BR: CNPJ; MZ: NUIT).
  pais:               varchar("pais", { length: 2 }).notNull(),
  convenioEstado:     varchar("convenio_estado", { length: 20, enum: ["em_negociacao", "ativo", "encerrado"] }).default("em_negociacao").notNull(),
  convenioInicio:     bigint("convenio_inicio", { mode: "number" }),
  convenioFim:        bigint("convenio_fim", { mode: "number" }),
  convenioReferencia: varchar("convenio_referencia", { length: 120 }),
  // "Membro da Associação X" no match (N2): só com autorização no convênio.
  mostrarNomeNoMatch: boolean("mostrar_nome_no_match").default(false).notNull(),
  // Os associados entram disponíveis para a rede (decisão de 22/11).
  disponivelPorPadrao: boolean("disponivel_por_padrao").default(true).notNull(),
  // O link de convite ao app: o hash acha o convite; o cifrado o mostra de novo à entidade.
  conviteHash:        varchar("convite_hash", { length: 64 }),
  conviteCifrado:     text("convite_cifrado"),
  conviteGeradoEm:    bigint("convite_gerado_em", { mode: "number" }),
  createdAt:          bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:          bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerUnique:  uniqueIndex("entidades_owner_unique").on(table.ownerId),
  conviteUnique: uniqueIndex("entidades_convite_unique").on(table.conviteHash),
}));

export const entidadeMembros = mysqlTable("entidade_membros", {
  id:                  bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  ownerId:             varchar("owner_id", { length: 128 }).notNull(),
  entidadeId:          int("entidade_id").notNull(),
  // O contato da rede da entidade. Nulo só no removido (fica a lista de bloqueio pelo HMAC).
  contactId:           bigint("contact_id", { mode: "number" }),
  paisDocumento:       varchar("pais_documento", { length: 2 }).notNull(),
  tipoDocumento:       varchar("tipo_documento", { length: 10 }).notNull(),
  // HMAC-SHA256 com ENTIDADES_HMAC_KEY: acha o repetido sem guardar o número em claro.
  documentoHmac:       varchar("documento_hmac", { length: 64 }).notNull(),
  documentoCifrado:    text("documento_cifrado"),
  // Telefone e e-mail da empresa, cifrados juntos (JSON); só a entidade decifra, com auditoria.
  contatoCifrado:      text("contato_cifrado"),
  cnaePrincipal:       varchar("cnae_principal", { length: 7 }),
  cnaesSecundarios:    jsonCompat("cnaes_secundarios").$type<string[]>(),
  referenciaDaEntidade: varchar("referencia_da_entidade", { length: 100 }),
  // A necessidade foi declarada à entidade (origem) nesta data; nunca inferida da CNAE.
  precisoOrigem:       varchar("preciso_origem", { length: 20 }),
  precisoDeclaradoEm:  bigint("preciso_declarado_em", { mode: "number" }),
  loteId:              int("lote_id"),
  estado:              varchar("estado", { length: 12, enum: ["importado", "ativado", "removido"] }).default("importado").notNull(),
  // A ativação do cadastro importado (N3): o link de uso único que a entidade
  // distribui. Só o hash do token fica aqui (o token sai uma vez, na hora de
  // gerar); gerar de novo troca o hash, e o link anterior deixa de abrir.
  // Ativado, o hash some e fica a conta que nasceu dele (nula se ela for excluída).
  ativacaoHash:        varchar("ativacao_hash", { length: 64 }),
  ativacaoExpiraEm:    bigint("ativacao_expira_em", { mode: "number" }),
  ativadoUserId:       int("ativado_user_id"),
  ativadoEm:           bigint("ativado_em", { mode: "number" }),
  createdAt:           bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:           bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ativacaoUnique:  uniqueIndex("em_ativacao_unique").on(table.ativacaoHash),
  ativadoIdx:      index("em_ativado_user_idx").on(table.ativadoUserId),
  contatoUnique:   uniqueIndex("em_contact_unique").on(table.contactId),
  documentoUnique: uniqueIndex("em_entidade_documento_unique").on(table.entidadeId, table.documentoHmac),
  documentoIdx:    index("em_documento_idx").on(table.documentoHmac),
  estadoIdx:       index("em_entidade_estado_idx").on(table.entidadeId, table.estado),
  ownerIdx:        index("em_owner_idx").on(table.ownerId),
}));

export const importacoesDeEntidade = mysqlTable("importacoes_de_entidade", {
  id:                 int("id").autoincrement().primaryKey(),
  ownerId:            varchar("owner_id", { length: 128 }).notNull(),
  entidadeId:         int("entidade_id").notNull(),
  // SHA-256 do arquivo (calculado na tela): o arquivo em si nunca chega ao servidor.
  arquivoSha256:      varchar("arquivo_sha256", { length: 64 }).notNull(),
  modo:               varchar("modo", { length: 10, enum: ["ensaio", "aplicar"] }).notNull(),
  estado:             varchar("estado", { length: 15, enum: ["em_andamento", "concluida"] }).default("em_andamento").notNull(),
  totalLinhas:        int("total_linhas").notNull(),
  linhasProcessadas:  int("linhas_processadas").default(0).notNull(),
  criados:            int("criados").default(0).notNull(),
  atualizados:        int("atualizados").default(0).notNull(),
  recusados:          int("recusados").default(0).notNull(),
  comAviso:           int("com_aviso").default(0).notNull(),
  // Quantas linhas por código de recusa ou aviso; os números das linhas ficam na tela.
  porCodigo:          jsonCompat("por_codigo").$type<Record<string, number>>(),
  iniciadaEm:         bigint("iniciada_em", { mode: "number" }).notNull(),
  concluidaEm:        bigint("concluida_em", { mode: "number" }),
}, (table) => ({
  entidadeIdx: index("ie_entidade_idx").on(table.entidadeId, table.iniciadaEm),
}));

// Os documentos já vistos numa importação, para recusar a segunda linha com o
// mesmo documento mesmo em blocos diferentes (e no ensaio, que não grava
// membros). Só o HMAC; apagados ao concluir.
export const importacaoDocumentosVistos = mysqlTable("importacao_documentos_vistos", {
  importacaoId:  int("importacao_id").notNull(),
  ownerId:       varchar("owner_id", { length: 128 }).notNull(),
  documentoHmac: varchar("documento_hmac", { length: 64 }).notNull(),
  linha:         int("linha").notNull(),
}, (table) => ({
  // Chave primária composta, não só índice único: o MySQL do Aiven roda com
  // sql_require_primary_key e recusa tabela sem chave primária (a 0030 caiu no
  // deploy de 25/11 por isso). O par continua único, como antes.
  pk: primaryKey({ name: "idv_pk", columns: [table.importacaoId, table.documentoHmac] }),
  ownerIdx:    index("idv_owner_idx").on(table.ownerId),
}));

export type Entidade = typeof entidades.$inferSelect;
export type EntidadeMembro = typeof entidadeMembros.$inferSelect;

// O pedido de contato pela entidade (N2, docs/arquitetura/entidades.md, seção 11).
// Quem está do outro lado de uma conexão com um associado pede o contato; a
// entidade recebe, fala com a empresa fora do app e registra o que houve. O nome
// e o canal da empresa só saem no "aceito" (shared/pedidos-pela-entidade.ts).
export const pedidosPelaEntidade = mysqlTable("pedidos_pela_entidade", {
  id:            varchar("id", { length: 36 }).primaryKey(),
  // A conta da entidade (openId) que recebe o pedido.
  ownerId:       varchar("owner_id", { length: 128 }).notNull(),
  entidadeId:    int("entidade_id").notNull(),
  // O associado (entidade_membros.id) e a conexão registrada em que ele apareceu.
  membroId:      bigint("membro_id", { mode: "number" }).notNull(),
  conexaoId:     varchar("conexao_id", { length: 36 }).notNull(),
  // Quem pede (users.id): a membra, a dona do contato do outro lado, ou outra entidade.
  userId:        int("userId").notNull(),
  // A mensagem opcional de quem pede, com telefone e e-mail escondidos.
  mensagem:      varchar("mensagem", { length: 500 }),
  estado:        varchar("estado", { length: 16, enum: ["na_entidade", "encaminhado", "aceito", "recusado", "nao_encaminhado", "expirado"] }).default("na_entidade").notNull(),
  // O canal que a empresa escolheu (só no aceito), entre os que a entidade tem dela.
  canal:         varchar("canal", { length: 10, enum: ["telefone", "email", "ambos"] }),
  expiraEm:      bigint("expira_em", { mode: "number" }).notNull(),
  encaminhadoEm: bigint("encaminhado_em", { mode: "number" }),
  decididoEm:    bigint("decidido_em", { mode: "number" }),
  createdAt:     bigint("created_at", { mode: "number" }).notNull(),
  updatedAt:     bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  pedidoUnique:      uniqueIndex("pe_conexao_solicitante_unique").on(table.conexaoId, table.userId, table.membroId),
  entidadeEstadoIdx: index("pe_entidade_estado_idx").on(table.entidadeId, table.estado),
  solicitanteIdx:    index("pe_solicitante_idx").on(table.userId, table.createdAt),
  ownerIdx:          index("pe_owner_idx").on(table.ownerId),
}));

export type PedidoPelaEntidade = typeof pedidosPelaEntidade.$inferSelect;

// O índice invertido do cruzamento (N4b, docs/arquitetura/entidades.md, seção 8).
// Uma linha por chave de cada item de contact_assets ("tem") e contact_needs
// ("precisa"), calculada por shared/chaves-de-cruzamento.ts. A chave só acha
// candidatos: quem decide o match continua sendo scoreMatch. Guarda o hash da
// chave (16 hex do SHA-256), nunca o texto do item; colisão só traz candidato a
// mais. Os itens só recebem INSERT e DELETE, então as chaves de um item nunca
// mudam: o índice se mantém pela varredura dos itens sem chave e das chaves sem
// item (server/indice-de-cruzamento.ts), além da indexação na hora da carga.
export const chavesDeCruzamento = mysqlTable("chaves_de_cruzamento", {
  id:        bigint("id", { mode: "number" }).primaryKey().autoincrement(),
  lado:      varchar("lado", { length: 8, enum: ["tem", "precisa"] }).notNull(),
  itemId:    bigint("item_id", { mode: "number" }).notNull(),
  contactId: bigint("contact_id", { mode: "number" }).notNull(),
  ownerId:   varchar("owner_id", { length: 128 }).notNull(),
  chave:     varchar("chave", { length: 16 }).notNull(),
}, (table) => ({
  itemChaveUnique: uniqueIndex("cdc_lado_item_chave_unique").on(table.lado, table.itemId, table.chave),
  chaveIdx:        index("cdc_lado_chave_contato_idx").on(table.lado, table.chave, table.contactId),
  contatoIdx:      index("cdc_contato_idx").on(table.contactId),
  ownerIdx:        index("cdc_owner_idx").on(table.ownerId),
}));

// A fila do cruzamento grande (N4b): a busca na rede global de uma dona com
// muitos contatos disponíveis (a entidade) e o motor privado de uma conta com
// muitos contatos rodam no servidor, em lotes, fora do pedido HTTP
// (server/fila-de-cruzamento.ts). Um trabalho vivo por dona e tipo; o pedido que
// chega com ele rodando marca `de_novo`, e o trabalho recomeça ao terminar.
export const filaDeCruzamento = mysqlTable("fila_de_cruzamento", {
  id:           int("id").primaryKey().autoincrement(),
  ownerId:      varchar("owner_id", { length: 128 }).notNull(),
  userId:       int("user_id").notNull(),
  tipo:         varchar("tipo", { length: 10, enum: ["global", "privado"] }).notNull(),
  estado:       varchar("estado", { length: 12, enum: ["pendente", "concluida", "falhou"] }).default("pendente").notNull(),
  // O último contato já cruzado (a busca global anda por id, em lotes).
  cursor:       bigint("cursor", { mode: "number" }).default(0).notNull(),
  deNovo:       boolean("de_novo").default(false).notNull(),
  processados:  int("processados").default(0).notNull(),
  conexoes:     int("conexoes").default(0).notNull(),
  tentativas:   int("tentativas").default(0).notNull(),
  erro:         varchar("erro", { length: 300 }),
  lockToken:    varchar("lock_token", { length: 36 }),
  lockedUntil:  bigint("locked_until", { mode: "number" }),
  criadaEm:     bigint("criada_em", { mode: "number" }).notNull(),
  atualizadaEm: bigint("atualizada_em", { mode: "number" }).notNull(),
}, (table) => ({
  estadoIdx: index("fdc_estado_idx").on(table.estado, table.criadaEm),
  donaIdx:   index("fdc_dona_idx").on(table.ownerId, table.tipo, table.estado),
}));

// O perfil de voz da dona (H3d do desenho de 16/11; HN-24 da auditoria,
// aprovado pelo Roberto em 24/11/2026; server/perfil-de-voz.ts): um trecho
// curto da voz dela (cerca de 30 s, lendo um texto na tela), guardado no bucket
// sob perfis-de-voz/<openId>/, que vai junto no pedido de transcrição de cada
// parte das reuniões dela, para a IA rotular a fala dela com a conta dela.
// É dado biométrico (LGPD art. 11): só existe com o consentimento próprio
// (voice_profile_consents), separado do aceite dos Termos. Uma linha por dona.
// Desligar o perfil e excluir a conta apagam o objeto (com todas as versões) e
// a linha, de vez: não há "desativado". O áudio nunca sai pelo proxy
// /manus-storage, pelo link aberto, para as participantes nem para a consulta
// da administração (R1a): só a dona o ouve, pelo procedimento perfilDeVoz.ouvir.
export const voiceProfiles = mysqlTable("voice_profiles", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  storageKey: varchar("storage_key", { length: 512 }).notNull(),
  mimeType: varchar("mime_type", { length: 32 }).notNull(),
  bytes: int("bytes").notNull(),
  durationMs: int("duration_ms").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerUnique: uniqueIndex("voice_profiles_owner_unique").on(table.ownerId),
}));

// O registro de cada consentimento ao perfil de voz e de cada revogação
// (pontos técnicos da Cris para o H3d): data e hora, a versão do texto, o
// idioma e o texto que a dona viu, com o hash. Sem a voz. Sobrevive à exclusão
// do perfil e à da conta (a prova de que houve consentimento e de quando ele
// acabou; ver server/exclusao-de-conta.ts). "origem" diz quem revogou: a dona
// (desligar) ou a exclusão da conta. Nunca UPDATE: uma linha por evento.
export const voiceProfileConsents = mysqlTable("voice_profile_consents", {
  id: varchar("id", { length: 36 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 128 }).notNull(),
  evento: varchar("evento", { length: 12, enum: ["consentiu", "revogou"] }).notNull(),
  origem: varchar("origem", { length: 20, enum: ["dona", "exclusao_da_conta"] }).notNull(),
  versaoDoTexto: varchar("versao_do_texto", { length: 40 }).notNull(),
  idioma: varchar("idioma", { length: 12 }),
  textoExibido: text("texto_exibido"),
  textoHash: varchar("texto_hash", { length: 64 }),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => ({
  ownerCreatedIdx: index("voice_profile_consents_owner_created_idx").on(table.ownerId, table.createdAt),
}));
