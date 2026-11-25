import { and, eq, desc, asc, like, or, ne, notInArray, inArray, sql, isNull } from "drizzle-orm";
const drizzleOr = or;
import { drizzle } from "drizzle-orm/mysql2";
import { alias } from "drizzle-orm/mysql-core";
import {
  users, userProfiles, opportunities, opportunityDocuments,
  opportunityInterests, savedOpportunities, opportunityMatches,
  goldAccessGrants, platformNotifications, sessions, auditLogs,
  loginAttempts, strategicGroups, directMessages,
  matches, connections,
  type InsertUser,
  privateContacts,
  type PrivateContact,
  type InsertPrivateContact,
  contextTypes, contexts, contactContexts, contextParticipants, contextMedia,
  type Context, type ContextType, type ContactContext, type ContextParticipant, type ContextMedia,
  enrichmentSessions, enrichmentMessages, enrichmentSuggestions,
  type EnrichmentSession, type EnrichmentMessage, type EnrichmentSuggestion,
  contactAssets, contactNeeds, aiMatchSuggestions,
  meetings, meetingContactSuggestions,
  networkSugestoes, conexoesParticipantes,
  proximasAcoes,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import nodeCrypto from "node:crypto";
import { slugifyMatchTag } from "./match-service";
import { normalizar } from "@shared/direcao-do-termo";
import { BancoIndisponivel } from "./banco-indisponivel";
import { condicaoDeStatusNasListas } from "./oportunidade-acesso";
import { consolidarPerfil } from "./perfil-consolidado";
import { CAMPOS_DA_EDICAO_DO_PERFIL, mesclarOQueEntrouDepois, oQueEntrouDepois, PerfilMudouNoMeio, type ListasRecebidas } from "./listas-do-perfil";
import { avaliarQualificacaoDoPerfil } from "@shared/qualificacao-do-perfil";
import { contextoParaOferecer } from "./contexto-oferecido";
import { nomeDoTipoDeContexto } from "./nome-do-tipo-de-contexto";

let _db: ReturnType<typeof drizzle> | null = null;

// Devolve null SÓ quando não há DATABASE_URL. drizzle(url) cria um pool do
// mysql2 sem abrir conexão nenhuma: com a variável definida, isto nunca falha,
// e a queda real do banco aparece na PRIMEIRA QUERY, como erro do driver
// (ECONNREFUSED, ETIMEDOUT, PROTOCOL_CONNECTION_LOST...) dentro de um
// DrizzleQueryError. Quem reconhece esse caso é ehErroDeBancoIndisponivel
// (server/banco-indisponivel.ts), não este null.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to create the pool:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * O banco, ou BancoIndisponivel. É o que todo helper deste arquivo usa: banco
 * fora do ar é ERRO, não "sem dados". Antes cada helper fazia `if (!db) return
 * []` (ou null, ou false), e uma queda do banco aparecia na tela como lista
 * vazia, perfil inexistente, contato apagado.
 *
 * Só cobre a conexão NÃO CONFIGURADA (dev e teste sem DATABASE_URL). Em
 * produção a queda chega como erro do driver na query seguinte, e é o
 * middleware de server/_core/trpc.ts, via ehErroDeBancoIndisponivel, que
 * traduz os dois casos para a usuária com a mesma frase.
 *
 * getDb() continua devolvendo null para quem precisa decidir sozinho o que
 * fazer sem banco. Hoje são só stats.platform, stats.presencaPorPais e
 * system.health, que degradam de propósito para não derrubar a página inicial.
 */
export async function exigirDb() {
  const db = await getDb();
  if (!db) throw new BancoIndisponivel();
  return db;
}

// ─── Users ────────────────────────────────────────────────────
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await exigirDb();
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  textFields.forEach((field) => {
    const value = user[field];
    if (value === undefined) return;
    values[field] = value ?? null;
    updateSet[field] = value ?? null;
  });
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await exigirDb();
  // Não filtrar por isActive aqui: filtrar causava loop de login para contas reativadas.
  // A recusa de conta desativada é feita em sdk.authenticateRequest e em loginUser.
  const result = await db.select().from(users)
    .where(eq(users.openId, openId)).limit(1);
  return result[0] ?? undefined;
}

export async function getUserById(id: number) {
  const db = await exigirDb();
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string) {
  const db = await exigirDb();
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function updateUser(id: number, data: Partial<InsertUser>) {
  const db = await exigirDb();
  await db.update(users).set(data as any).where(eq(users.id, id));
}

// ─── User Profiles ────────────────────────────────────────────
export async function getUserProfile(userId: number) {
  const db = await exigirDb();
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  // Cargo e empresa saem da coluna que fica, com a antiga só tapando buraco
  // (etapa 1 da consolidação das colunas duplicadas).
  return rows[0] ? consolidarPerfil(rows[0]) : null;
}

/**
 * Os campos que contam para o "Perfil completo" do Dashboard.
 *
 * Eram DEZ, copiados da antiga `saveUserProfile` (matching.ts), que ficou órfã
 * quando o onboarding passou a usar este upsert. Dois deles saíram da lista em
 * 15/09: `workStyle` e `values` foram suprimidos do cadastro (Rosber, 14/09
 * 21:08 — ver client/src/pages/Onboarding.tsx) e nunca existiram na tela de
 * Perfil, então nenhuma usuária tinha como preenchê-los: com eles na conta, o
 * teto de todo mundo era 80% e a barra nunca fechava. Campo que a usuária não
 * consegue preencher não entra na conta.
 *
 * Os oito que ficaram são exatamente os que o cadastro envia (`salvarPerfil` em
 * Onboarding.tsx) e o Perfil edita. A lista é exportada para o teste conferir
 * isso contra o schema, porque a leitura abaixo é por nome, sem tipo.
 */
export const CAMPOS_DA_COMPLETUDE_DO_PERFIL = [
  "displayName", "city", "primarySpecialty", "sector",
  "seekingTypes", "incomeRange", "bio", "experienceYears",
] as const;

/**
 * Quanto do perfil está preenchido, de 0 a 100. O número só é EXIBIDO (Dashboard
 * e PresidentPanel): nada no servidor compara com limiar, e quem promove a Prata
 * é a régua de `shared/qualificacao-do-perfil.ts`, que não olha para cá — mudar
 * a lista muda a barra, não muda nível de ninguém.
 */
export function computeProfileCompleteness(profile: Record<string, unknown> | null | undefined) {
  if (!profile) return 0;
  const preenchido = (valor: unknown) =>
    valor !== null && valor !== undefined && valor !== "" && !(Array.isArray(valor) && valor.length === 0);
  const filled = CAMPOS_DA_COMPLETUDE_DO_PERFIL.filter(campo => preenchido(profile[campo])).length;
  return Math.round((filled / CAMPOS_DA_COMPLETUDE_DO_PERFIL.length) * 100);
}

/** As colunas dos outros campos da edição do Perfil (server/listas-do-perfil.ts), para a conferência da versão. */
const COLUNAS_DA_EDICAO_DO_PERFIL = Object.fromEntries(CAMPOS_DA_EDICAO_DO_PERFIL.map(campo => [campo, userProfiles[campo]])) as {
  [Campo in (typeof CAMPOS_DA_EDICAO_DO_PERFIL)[number]]: (typeof userProfiles)[Campo];
};

/**
 * Grava o perfil. Com `versaoDasListas` (o Meu Perfil, que devolve "O que
 * tenho", "O que preciso" e os outros campos dele inteiros), a escrita confere
 * antes, com a linha travada, que as listas e os outros campos gravados são os
 * que a tela carregou, e acrescenta o que entrou depois no fim das listas
 * (server/listas-do-perfil.ts). Lança PerfilMudouNoMeio, sem gravar nada,
 * quando uma lista mudou de outro jeito ou outro campo mudou no banco.
 * Sem a versão (o Perfil antigo em cache, o cadastro), grava como sempre.
 */
export async function upsertUserProfile(userId: number, data: Record<string, unknown>, versaoDasListas?: string) {
  const db = await exigirDb();
  if (versaoDasListas !== undefined) {
    await db.transaction(async tx => {
      // FOR UPDATE, como a confirmação que a reunião leva ao perfil (confirmarItemDaDona):
      // a conferência e a escrita não deixam um item entrar no meio. Os outros campos da
      // edição vêm junto, consolidados como o profile.get os leu (cargo e empresa).
      const [gravadas] = await tx.select({
        whatIHave: userProfiles.whatIHave, whatINeed: userProfiles.whatINeed, whatINeedDetails: userProfiles.whatINeedDetails,
        ...COLUNAS_DA_EDICAO_DO_PERFIL,
      }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1).for("update");
      const entrou = oQueEntrouDepois(versaoDasListas, gravadas && consolidarPerfil(gravadas));
      const listas = entrou && mesclarOQueEntrouDepois(data as ListasRecebidas, entrou);
      if (!listas) throw new PerfilMudouNoMeio();
      if (gravadas) {
        await tx.update(userProfiles).set({ ...data, ...listas, updatedAt: new Date() } as any).where(eq(userProfiles.userId, userId));
      } else {
        await tx.insert(userProfiles).values({ userId, ...data, ...listas } as any);
      }
    });
  } else {
    const existing = await getUserProfile(userId);
    if (existing) {
      await db.update(userProfiles).set({ ...data, updatedAt: new Date() } as any).where(eq(userProfiles.userId, userId));
    } else {
      await db.insert(userProfiles).values({ userId, ...data } as any);
    }
  }
  const atual = await getUserProfile(userId);
  const completeness = computeProfileCompleteness(atual as Record<string, unknown> | null);
  if (atual && (atual as any).profileCompleteness !== completeness) {
    await db.update(userProfiles).set({ profileCompleteness: completeness } as any).where(eq(userProfiles.userId, userId));
  }
}

// ─── Opportunities ────────────────────────────────────────────
export async function getOpportunityById(id: number) {
  const db = await exigirDb();
  const rows = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listOpportunities(filters: {
  type?: string;
  sector?: string;
  country?: string;
  complianceLevel?: string;
  isConfidential?: boolean;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  /** Quem está olhando a lista. Presente, a autora também vê as próprias
   *  oportunidades ainda em análise ("pending") — sem isso, publicar parecia
   *  engolir a oportunidade, porque a lista só mostrava as ativas. */
  viewerUserId?: number;
}) {
  const db = await exigirDb();
  const conditions: any[] = [];
  if (filters.status === undefined && filters.viewerUserId !== undefined) {
    // O mesmo predicado da aba "Salvas" (server/oportunidade-acesso.ts): as
    // duas listas precisam concordar sobre o que uma usuária enxerga.
    conditions.push(condicaoDeStatusNasListas(filters.viewerUserId));
  } else {
    conditions.push(eq(opportunities.status, (filters.status ?? "active") as any));
  }
  if (filters.type) conditions.push(eq(opportunities.type, filters.type as any));
  if (filters.sector) conditions.push(eq(opportunities.sector, filters.sector));
  if (filters.country) conditions.push(eq(opportunities.country, filters.country));
  if (filters.complianceLevel) conditions.push(eq(opportunities.complianceLevel, filters.complianceLevel as any));
  if (filters.isConfidential !== undefined) conditions.push(eq(opportunities.isConfidential, filters.isConfidential));
  if (filters.search) conditions.push(like(opportunities.title, `%${filters.search}%`));
  return db.select().from(opportunities)
    .where(and(...conditions))
    .orderBy(desc(opportunities.frauenTrustScore), desc(opportunities.createdAt))
    .limit(filters.limit ?? 20)
    .offset(filters.offset ?? 0);
}

export async function createOpportunity(data: Omit<typeof opportunities.$inferInsert, "id">) {
  const db = await exigirDb();
  const result = await db.insert(opportunities).values(data as any);
  return (result[0] as any).insertId as number;
}

export async function updateOpportunity(id: number, data: Partial<typeof opportunities.$inferInsert>) {
  const db = await exigirDb();
  await db.update(opportunities).set(data as any).where(eq(opportunities.id, id));
}

// ─── Documents ────────────────────────────────────────────────
export async function getDocumentsByOpportunity(opportunityId: number, includeConfidential = false) {
  const db = await exigirDb();
  const conditions: any[] = [eq(opportunityDocuments.opportunityId, opportunityId)];
  if (!includeConfidential) conditions.push(eq(opportunityDocuments.isConfidential, false));
  return db.select().from(opportunityDocuments).where(and(...conditions));
}

export async function addDocument(data: typeof opportunityDocuments.$inferInsert) {
  const db = await exigirDb();
  const result = await db.insert(opportunityDocuments).values(data);
  return (result[0] as any).insertId as number;
}

// ─── Interests ────────────────────────────────────────────────
export async function expressInterest(opportunityId: number, userId: number, message?: string) {
  const db = await exigirDb();
  const existing = await db.select({ id: opportunityInterests.id })
    .from(opportunityInterests)
    .where(and(eq(opportunityInterests.opportunityId, opportunityId), eq(opportunityInterests.userId, userId)))
    .limit(1);
  if (existing.length > 0) return { alreadyExists: true };
  await db.insert(opportunityInterests).values({ opportunityId, userId, message });
  const opp = await getOpportunityById(opportunityId);
  if (opp) await db.update(opportunities).set({ interestCount: (opp.interestCount ?? 0) + 1 }).where(eq(opportunities.id, opportunityId));
  return { alreadyExists: false };
}

export async function getInterestsByOpportunity(opportunityId: number) {
  const db = await exigirDb();
  return db.select({
    id: opportunityInterests.id,
    userId: opportunityInterests.userId,
    message: opportunityInterests.message,
    status: opportunityInterests.status,
    createdAt: opportunityInterests.createdAt,
    name: users.name,
    company: users.company,
    country: users.country,
  })
    .from(opportunityInterests)
    .innerJoin(users, eq(users.id, opportunityInterests.userId))
    .where(eq(opportunityInterests.opportunityId, opportunityId))
    .orderBy(desc(opportunityInterests.createdAt));
}

// ─── Saved ────────────────────────────────────────────────────
/**
 * Desfaz o favorito, se existir. Sem régua nenhuma, de propósito: a régua
 * (`exigirSalvarOportunidade`) vale para GRAVAR. Uma linha antiga — gravada
 * antes da guarda, ou de uma Ouro rebaixada a Prata — precisa poder sair;
 * antes, o desfazer passava pela régua de leitura, levava FORBIDDEN e a linha
 * ficava órfã. Devolve se havia algo para apagar.
 */
export async function desfazerOportunidadeSalva(userId: number, opportunityId: number) {
  const db = await exigirDb();
  const [resultado] = await db.delete(savedOpportunities)
    .where(and(eq(savedOpportunities.userId, userId), eq(savedOpportunities.opportunityId, opportunityId)));
  return (resultado as { affectedRows?: number }).affectedRows! > 0;
}

/** Grava o favorito. Quem chama já passou a oportunidade pela régua de gravação. */
export async function salvarOportunidade(userId: number, opportunityId: number) {
  const db = await exigirDb();
  await db.insert(savedOpportunities).values({ userId, opportunityId });
}

/**
 * As salvas de uma usuária, já filtradas pela régua de leitura NO BANCO.
 * O mesmo predicado de status da lista geral (ativas, ou pendentes da própria
 * dona); e, para quem não pode ver confidencial, só as públicas ou as que ela
 * mesma publicou. A versão anterior devolvia a linha inteira do JOIN sem olhar
 * status nem isConfidential — o favorito era o terceiro caminho de consulta a
 * ignorar a régua de list/get.
 */
export async function getSavedOpportunities(userId: number, opts: { podeVerConfidencial: boolean }) {
  const db = await exigirDb();
  const condicoes = [
    eq(savedOpportunities.userId, userId),
    condicaoDeStatusNasListas(userId),
  ];
  if (!opts.podeVerConfidencial) {
    condicoes.push(or(eq(opportunities.isConfidential, false), eq(opportunities.publishedBy, userId))!);
  }
  return db.select({ opportunity: opportunities })
    .from(savedOpportunities)
    .innerJoin(opportunities, eq(opportunities.id, savedOpportunities.opportunityId))
    .where(and(...condicoes))
    .orderBy(desc(savedOpportunities.createdAt));
}

// ─── Gold Access ──────────────────────────────────────────────
export async function grantGoldAccess(grantedTo: number, grantedBy: number, reason?: string) {
  const db = await exigirDb();
  // Usar Drizzle ORM diretamente com os campos do schema
  await db.insert(goldAccessGrants).values({
    grantedTo,
    grantedBy,
    reason: reason ?? null,
  });
  await db.update(users).set({ role: "gold" }).where(eq(users.id, grantedTo));
}

/**
 * Revogar o Ouro devolve a pessoa ao nível que o PERFIL sustenta, pela mesma
 * régua da promoção Bronze → Prata (shared/qualificacao-do-perfil.ts): Prata
 * se qualificado, Bronze se não. Antes gravava 'silver' sempre, e um cadastro
 * Bronze que recebeu Ouro (a Gestão Ouro lista Bronze e Prata) virava Prata
 * sem ter o perfil que a Prata exige. Devolve o nível gravado.
 */
export async function revokeGoldAccess(grantedTo: number, revokedBy: number, reason?: string): Promise<"silver" | "bronze"> {
  const db = await exigirDb();
  await db.update(goldAccessGrants)
    .set({ revokedAt: new Date(), revokedBy, revokeReason: reason })
    .where(and(eq(goldAccessGrants.grantedTo, grantedTo)));
  const { qualificado } = avaliarQualificacaoDoPerfil(await getUserProfile(grantedTo));
  const nivel = qualificado ? "silver" : "bronze";
  await db.update(users).set({ role: nivel }).where(eq(users.id, grantedTo));
  return nivel;
}

/**
 * Bronze → Prata pela qualidade do perfil (server/nivel-do-perfil.ts). O UPDATE
 * leva `role = 'bronze'` no WHERE: se no meio do caminho alguém concedeu Ouro
 * ou um admin mudou o nível à mão, nada casa e nada muda. Devolve se promoveu.
 */
export async function promoverBronzeAPrata(userId: number): Promise<boolean> {
  const db = await exigirDb();
  const resultado = await db.update(users).set({ role: "silver" })
    .where(and(eq(users.id, userId), eq(users.role, "bronze")));
  return linhasAfetadas(resultado) > 0;
}

/**
 * As contas Prata de hoje, para a reavaliação única da Prata automática
 * (server/nivel-do-perfil.ts, reavaliarPrataAutomaticaAntiga). Para cada uma,
 * diz se o nível tem ORIGEM REGISTRADA: alguma linha em gold_access_grants
 * (recebeu Ouro, e a Prata veio da revogação) ou alguma auditoria de
 * `acoesQueMudamNivel` sobre a conta. Sem origem registrada, a Prata é a que o
 * cadastro gravava para todas antes de 14/09. Lê só ids: nada pessoal sai daqui.
 */
export async function listarPrataParaReavaliacao(
  acoesQueMudamNivel: readonly string[],
): Promise<Array<{ id: number; origemRegistrada: boolean }>> {
  const db = await exigirDb();
  const prata = await db.select({ id: users.id }).from(users)
    .where(eq(users.role, "silver")).orderBy(asc(users.id));
  if (prata.length === 0) return [];
  const ids = prata.map(p => p.id);

  const comOuro = await db.selectDistinct({ id: goldAccessGrants.grantedTo }).from(goldAccessGrants)
    .where(inArray(goldAccessGrants.grantedTo, ids));
  const comMudancaAuditada = acoesQueMudamNivel.length === 0 ? [] : await db
    .selectDistinct({ id: auditLogs.resourceId }).from(auditLogs)
    .where(and(
      eq(auditLogs.resource, "users"),
      inArray(auditLogs.action, [...acoesQueMudamNivel]),
      inArray(auditLogs.resourceId, ids.map(String)),
    ));

  const registradas = new Set<string>([
    ...comOuro.map(l => String(l.id)),
    ...comMudancaAuditada.map(l => String(l.id)),
  ]);
  return ids.map(id => ({ id, origemRegistrada: registradas.has(String(id)) }));
}

/**
 * Prata → Bronze da reavaliação única. O UPDATE leva `role = 'silver'` no
 * WHERE: se no meio do caminho alguém concedeu Ouro ou mudou o nível à mão,
 * nada casa e nada muda. Devolve se rebaixou.
 */
export async function rebaixarPrataABronze(userId: number): Promise<boolean> {
  const db = await exigirDb();
  const resultado = await db.update(users).set({ role: "bronze" })
    .where(and(eq(users.id, userId), eq(users.role, "silver")));
  return linhasAfetadas(resultado) > 0;
}

// ─── Distribuidor do Smart Match ──────────────────────────────
// O poder é uma coluna de `users` (isDistributor), não uma tabela de concessões
// como o Ouro: a trilha de quem concedeu/revogou fica em audit_logs
// (DISTRIBUTOR_GRANTED / DISTRIBUTOR_REVOKED). Sem e-mail de contato aqui além do
// de login, que o Painel Ouro já mostra na gestão do Ouro.
export async function listarDistribuidores() {
  const db = await exigirDb();
  return db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive,
  }).from(users)
    .where(eq(users.isDistributor, true))
    .orderBy(asc(users.name));
}

/** Liga ou desliga o poder de distribuição. Quem chama já conferiu que a conta existe. */
export async function definirPoderDeDistribuicao(userId: number, temPoder: boolean) {
  const db = await exigirDb();
  await db.update(users).set({ isDistributor: temPoder }).where(eq(users.id, userId));
}

/** Ids de quem pode receber o aviso de "pedido esperando": distribuidores ativos. */
export async function idsDosDistribuidoresAtivos(): Promise<number[]> {
  const db = await exigirDb();
  const linhas = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.isDistributor, true), eq(users.isActive, true)));
  return linhas.map(l => l.id);
}

/** Ids da presidência ativa (president/admin), avisada quando não há distribuidor. */
export async function idsDaPresidenciaAtiva(): Promise<number[]> {
  const db = await exigirDb();
  const linhas = await db.select({ id: users.id }).from(users)
    .where(and(inArray(users.role, ["president", "admin"]), eq(users.isActive, true)));
  return linhas.map(l => l.id);
}

/** Quais destes ids são contas ativas. */
export async function idsDeContasAtivas(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const db = await exigirDb();
  const linhas = await db.select({ id: users.id }).from(users)
    .where(and(inArray(users.id, ids), eq(users.isActive, true)));
  return new Set(linhas.map(l => l.id));
}

// A fila do distribuidor mostra as DUAS partes com nome: é a leitura nominal que
// atravessa donas, como o acervo Ouro, e por isso o router a audita
// (DISTRIBUTOR_VIEW_QUEUE). O que nunca sai daqui: e-mail, telefone, cofre
// (encryptedSensitiveData), LinkedIn, site, avatar. A bio sai crua e o router a
// mascara (mascararContatosEmTexto) antes de responder.
const solicitante = alias(users, "solicitante");
const destinataria = alias(users, "destinataria");
const perfilDaSolicitante = alias(userProfiles, "perfil_da_solicitante");
const perfilDaDestinataria = alias(userProfiles, "perfil_da_destinataria");

function projecaoParaAnalise(
  conta: typeof solicitante | typeof destinataria,
  perfil: typeof perfilDaSolicitante | typeof perfilDaDestinataria,
) {
  return {
    name: conta.name,
    role: conta.role,
    isActive: conta.isActive,
    isVerified: conta.isVerified,
    onboardingCompleted: conta.onboardingCompleted,
    displayName: perfil.displayName,
    // A coluna antiga do perfil (preenchida pelo Onboarding até a consolidação)
    // vem antes da conta: sem ela, quem só respondeu o Onboarding saía sem cargo.
    company: sql<string | null>`COALESCE(${perfil.company}, ${perfil.currentCompany}, ${conta.company})`,
    jobTitle: sql<string | null>`COALESCE(${perfil.jobTitle}, ${perfil.currentRole}, ${conta.position})`,
    city: perfil.city,
    country: sql<string | null>`COALESCE(${perfil.country}, ${conta.country})`,
    sector: perfil.sector,
    primarySpecialty: perfil.primarySpecialty,
    bio: perfil.bio,
    whatIHave: perfil.whatIHave,
    whatINeed: perfil.whatINeed,
    seekingTypes: perfil.seekingTypes,
    // "Outra necessidade" é necessidade declarada: sem ela o distribuidor via serviço sem demanda num par que o portão liberou por esse texto.
    seekingOtherNeed: perfil.seekingOtherNeed,
    profileCompleteness: perfil.profileCompleteness,
  };
}

/**
 * Os pedidos esperando o distribuidor, mais antigos primeiro. Os pedidos em que
 * o próprio distribuidor é parte ficam de fora: ninguém decide o próprio match.
 * Os ids das partes saem para as travas do router (termo, portão) e PARAM lá.
 */
export async function listarPedidosEmAnalise(distribuidorId: number, limit = 50) {
  const db = await exigirDb();
  return db.select({
    connectionId: connections.id,
    requesterId: connections.requesterId,
    recipientId: connections.recipientId,
    createdAt: connections.createdAt,
    reciprocatedAt: connections.reciprocatedAt,
    solicitante: projecaoParaAnalise(solicitante, perfilDaSolicitante),
    destinataria: projecaoParaAnalise(destinataria, perfilDaDestinataria),
    // A nota do Smart Match na direção do pedido (quem clicou → quem recebe).
    compatibilidade: {
      overallScore: matches.overallScore,
      specialtyScore: matches.specialtyScore,
      objectivesScore: matches.objectivesScore,
      incomeScore: matches.incomeScore,
      locationScore: matches.locationScore,
      valuesScore: matches.valuesScore,
      aiInsight: matches.aiInsight,
    },
  })
    .from(connections)
    .innerJoin(solicitante, eq(solicitante.id, connections.requesterId))
    .innerJoin(destinataria, eq(destinataria.id, connections.recipientId))
    .leftJoin(perfilDaSolicitante, eq(perfilDaSolicitante.userId, connections.requesterId))
    .leftJoin(perfilDaDestinataria, eq(perfilDaDestinataria.userId, connections.recipientId))
    .leftJoin(matches, and(eq(matches.userId, connections.requesterId), eq(matches.matchedUserId, connections.recipientId)))
    .where(and(
      eq(connections.status, "in_review"),
      ne(connections.requesterId, distribuidorId),
      ne(connections.recipientId, distribuidorId),
    ))
    .orderBy(asc(connections.createdAt))
    .limit(limit);
}

/** A linha crua do pedido, para o router conferir as travas antes de decidir. */
export async function lerPedidoDeMatch(connectionId: number) {
  const db = await exigirDb();
  const [linha] = await db.select({
    id: connections.id,
    requesterId: connections.requesterId,
    recipientId: connections.recipientId,
    status: connections.status,
    reciprocatedAt: connections.reciprocatedAt,
  })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  return linha ?? null;
}

/**
 * A decisão do distribuidor num único UPDATE com trava otimista: só sai do
 * `in_review`. Devolve se a linha ainda estava em análise (1) ou se alguém
 * decidiu antes (0) — quem chama só produz efeitos (avisos, revelação,
 * auditoria) com 1.
 */
export async function decidirPedidoDeMatch(
  connectionId: number,
  decisao: { statusFinal: "pending" | "accepted" | "not_forwarded"; moderatedBy: number; moderationNote: string | null },
): Promise<boolean> {
  const db = await exigirDb();
  const [resultado] = await db.update(connections)
    .set({
      status: decisao.statusFinal,
      moderatedBy: decisao.moderatedBy,
      moderationNote: decisao.moderationNote,
      moderatedAt: new Date(),
    })
    .where(and(eq(connections.id, connectionId), eq(connections.status, "in_review")));
  return linhasAfetadas(resultado) === 1;
}

/** As últimas decisões, mais recentes primeiro. `resultado` é o status ATUAL da linha. */
export async function listarHistoricoDeDistribuicao(limit = 50) {
  const db = await exigirDb();
  const distribuidor = alias(users, "distribuidor");
  return db.select({
    connectionId: connections.id,
    decididoEm: connections.moderatedAt,
    decididoPor: { id: distribuidor.id, name: distribuidor.name },
    resultado: connections.status,
    nota: connections.moderationNote,
    reciprocado: sql<boolean>`${connections.reciprocatedAt} IS NOT NULL`,
    solicitanteNome: solicitante.name,
    destinatariaNome: destinataria.name,
  })
    .from(connections)
    .innerJoin(solicitante, eq(solicitante.id, connections.requesterId))
    .innerJoin(destinataria, eq(destinataria.id, connections.recipientId))
    .leftJoin(distribuidor, eq(distribuidor.id, connections.moderatedBy))
    .where(sql`${connections.moderatedAt} IS NOT NULL`)
    .orderBy(desc(connections.moderatedAt))
    .limit(limit);
}

// ─── Sessions ────────────────────────────────────────────────
export async function createSession(data: typeof sessions.$inferInsert) {
  const db = await exigirDb();
  await db.insert(sessions).values(data);
}

export async function getSession(token: string) {
  const db = await exigirDb();
  const rows = await db.select().from(sessions)
    .where(and(eq(sessions.sessionToken, token), eq(sessions.isActive, true))).limit(1);
  return rows[0] ?? null;
}

export async function invalidateSession(token: string) {
  const db = await exigirDb();
  await db.update(sessions).set({ isActive: false }).where(eq(sessions.sessionToken, token));
}

export async function invalidateAllUserSessions(userId: number) {
  const db = await exigirDb();
  await db.update(sessions).set({ isActive: false }).where(eq(sessions.userId, userId));
}

// ─── Audit Logs ──────────────────────────────────────────────
export async function logAudit(data: {
  userId?: number;
  action: string;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  status?: "success" | "failure" | "blocked";
  riskLevel?: "low" | "medium" | "high" | "critical";
}) {
  try {
    const db = await exigirDb();
    await db.insert(auditLogs).values({
      ...data,
      status: data.status ?? "success",
      riskLevel: data.riskLevel ?? "low",
    });
  } catch { /* audit failures never crash the app */ }
}

// ─── Login Attempts ──────────────────────────────────────────
export async function checkLoginRateLimit(identifier: string, ip: string): Promise<{ blocked: boolean; blockedUntil?: Date }> {
  const db = await exigirDb();
  const rows = await db.select().from(loginAttempts)
    .where(and(eq(loginAttempts.identifier, identifier), eq(loginAttempts.ipAddress, ip))).limit(1);
  const record = rows[0];
  if (!record) return { blocked: false };
  if (record.blockedUntil && record.blockedUntil > new Date()) return { blocked: true, blockedUntil: record.blockedUntil };
  return { blocked: false };
}

export async function recordLoginAttempt(identifier: string, ip: string, success: boolean) {
  const db = await exigirDb();
  const rows = await db.select().from(loginAttempts)
    .where(and(eq(loginAttempts.identifier, identifier), eq(loginAttempts.ipAddress, ip))).limit(1);
  const record = rows[0];
  if (success) {
    if (record) await db.delete(loginAttempts).where(eq(loginAttempts.id, record.id));
    return;
  }
  if (!record) {
    await db.insert(loginAttempts).values({ identifier, ipAddress: ip, success: false, attemptCount: 1 });
    return;
  }
  const newCount = (record.attemptCount ?? 0) + 1;
  const blockedUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : undefined;
  await db.update(loginAttempts)
    .set({ attemptCount: newCount, blockedUntil: blockedUntil ?? record.blockedUntil, success: false })
    .where(eq(loginAttempts.id, record.id));
}

// ─── Notifications ────────────────────────────────────────────
export async function createNotification(data: typeof platformNotifications.$inferInsert) {
  const db = await exigirDb();
  await db.insert(platformNotifications).values(data);
}

export async function getNotifications(userId: number, limit = 20) {
  const db = await exigirDb();
  return db.select().from(platformNotifications)
    .where(eq(platformNotifications.userId, userId))
    .orderBy(desc(platformNotifications.createdAt))
    .limit(limit);
}

export async function markNotificationsRead(userId: number) {
  const db = await exigirDb();
  await db.update(platformNotifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(platformNotifications.userId, userId), eq(platformNotifications.isRead, false)));
}

// ─── Admin ────────────────────────────────────────────────────
/**
 * O WHERE da listagem de usuárias, compartilhado entre a página e a contagem:
 * as duas precisam das MESMAS condições, senão "Mostrando 100 de N" mente
 * (molde de listPrivateContacts, que já conta com a tag da página).
 */
function condicoesDeUsuarias(filters: { role?: string; roles?: string[]; search?: string }) {
  const conditions: any[] = [];
  if (filters.role) conditions.push(eq(users.role, filters.role as any));
  // Vários níveis de uma vez: a Gestão Ouro lista Bronze E Prata, porque o Ouro
  // é adesão à categoria premium, não degrau depois da Prata (Governança, 14/09).
  if (filters.roles && filters.roles.length > 0) conditions.push(inArray(users.role, filters.roles as any));
  if (filters.search) {
    // `%` e `_` são curingas do LIKE: sem escapar, "a_L" casava "abL" e "%"
    // casava todo mundo. O escape é `\` (o padrão do MySQL), e a barra em si
    // também é escapada para o termo "\" não engolir o curinga seguinte.
    const termo = `%${filters.search.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(or(like(users.name, termo), like(users.email, termo)));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listUsers(filters: { role?: string; roles?: string[]; search?: string; limit?: number; offset?: number }) {
  const db = await exigirDb();
  return db.select({
    id: users.id, name: users.name, email: users.email, role: users.role,
    country: users.country, company: users.company, isActive: users.isActive,
    isVerified: users.isVerified, onboardingCompleted: users.onboardingCompleted,
    createdAt: users.createdAt, lastSignedIn: users.lastSignedIn,
  }).from(users)
    .where(condicoesDeUsuarias(filters))
    .orderBy(desc(users.createdAt))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

/** Quantas usuárias casam com os filtros — o total real, não o tamanho da página. */
export async function contarUsuarias(filters: { role?: string; roles?: string[]; search?: string }) {
  const db = await exigirDb();
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(condicoesDeUsuarias(filters));
  return Number(row?.count ?? 0);
}

export async function getAuditLogs(filters: { userId?: number; action?: string; limit?: number; offset?: number }) {
  const db = await exigirDb();
  const conditions: any[] = [];
  if (filters.userId) conditions.push(eq(auditLogs.userId, filters.userId));
  if (filters.action) conditions.push(eq(auditLogs.action, filters.action));
  return db.select().from(auditLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

// ─── Matches (sistema original MMM) ────────────────────────────────────────────────
/**
 * A projeção ANÔNIMA do cruzamento de perfis.
 *
 * Regra da cliente (12/09/2026): o nome de uma membra não aparece para outra
 * antes do interesse mútuo. Como privacidade aqui é regra de CONSULTA e não de
 * tela (docs/arquitetura/privacidade.md), o que identifica não é escondido no
 * componente — não é lido do banco. Ficaram de fora, de propósito:
 * `displayName`, `avatarUrl`, `bio`, `users.name` (nome civil), `users.company`,
 * `users.position`, `currentCompany`, `currentRole`, `sectors`,
 * `profileCompleteness`, `experienceYears` e `workStyle`. Boa parte deles nunca
 * foi desenhada em tela nenhuma: trafegavam na resposta tRPC para ninguém ver,
 * legíveis por quem abrisse o devtools.
 *
 * A identidade entra pelo outro lado, em `getConnectionsForUser`, e só quando a
 * conexão está `accepted` — que é onde o interesse mútuo fica registrado.
 *
 * `matchedUserId` CONTINUA aqui porque três travas do servidor dependem dele:
 * o consentimento dos dois lados, o portão da demanda expressa e a contagem de
 * `redeAguardando` (server/routers/profileMatches.ts). Ele é recortado no
 * router, depois dos filtros, e não chega ao navegador — id real na mão de uma
 * conta Ouro é deanonimização de um salto, porque toda conta Ouro tem o painel
 * administrativo, que lista usuárias por nome.
 *
 * O `aiInsight` pode ficar: o prompt que o gera (server/matching.ts) monta os
 * dois perfis só com especialidade, busca, setor e valores — nome nunca entra.
 */
/**
 * `souDestinataria` é `sql<boolean>`, mas o mysql2 entrega o tinyint do MySQL
 * como 1/0 e o drizzle não converte expressão de SQL cru: o valor saía daqui
 * como NÚMERO. Na tela isso virou um "0" solto abaixo do setor — `status ===
 * "pending" && conn.souDestinataria` valia `0`, e o React desenha o zero. A
 * conversão mora AQUI, na camada de dados, e não no componente: quem consumir a
 * consulta amanhã (outro router, o exame de produção, um script) recebe o
 * booleano que o tipo promete, sem precisar saber do driver.
 */
function comSouDestinatariaBooleana<T extends { souDestinataria: unknown }>(linhas: T[]): (Omit<T, "souDestinataria"> & { souDestinataria: boolean })[] {
  return linhas.map(linha => ({ ...linha, souDestinataria: Boolean(linha.souDestinataria) }));
}

/**
 * As conexões sugeridas que a dona não dispensou, na ordem do motor de perfis
 * (server/matching.ts, `ordemDasMelhores`): a nota mais alta primeiro e, na
 * mesma nota, a outra usuária de id menor. Com o desempate a ordem é estável e as
 * páginas (`pulo`) se emendam sem empate solto entre elas: o par (dona, outra) é
 * único em `matches`. Uma rodada do motor que regrave notas no meio da leitura
 * ainda mexe na ordem; quem lê em páginas descarta a linha repetida. As travas da
 * leitura (o termo e o portão da demanda expressa) ficam com quem chama
 * (routers/profileMatches.ts).
 */
export async function getMatchesForUser(userId: number, limit = 20, pulo = 0) {
  const db = await exigirDb();
  const linhas = await db.select({
    matchId: matches.id,
    matchedUserId: matches.matchedUserId,
    overallScore: matches.overallScore,
    specialtyScore: matches.specialtyScore,
    objectivesScore: matches.objectivesScore,
    incomeScore: matches.incomeScore,
    locationScore: matches.locationScore,
    valuesScore: matches.valuesScore,
    aiInsight: matches.aiInsight,
    userSeen: matches.userSeen,
    userDismissed: matches.userDismissed,
    createdAt: matches.createdAt,
    city: userProfiles.city,
    country: userProfiles.country,
    // Campos de matching
    primarySpecialty: userProfiles.primarySpecialty,
    seekingTypes: userProfiles.seekingTypes,
    businessInterests: userProfiles.businessInterests,
    values: userProfiles.values,
    sector: userProfiles.sector,
    // O estado do interesse vem do SERVIDOR, resolvido aqui. A tela não tem como
    // cruzar match e conexão por conta própria — e é bom que não tenha: para
    // cruzar, precisaria do id da outra usuária, que é justamente o que não pode
    // atravessar. `connectionId` é id de conexão, não de pessoa.
    connectionId: connections.id,
    connectionStatus: connections.status,
    souDestinataria: sql<boolean>`${connections.recipientId} = ${userId}`,
    // O MESMO predicado do portão de `getConnectionsForUser`: nome só com aceite.
    displayName: sql<string | null>`CASE WHEN ${connections.status} = 'accepted' THEN ${userProfiles.displayName} ELSE NULL END`,
  })
    .from(matches)
    .innerJoin(userProfiles, eq(userProfiles.userId, matches.matchedUserId!))
    // O join com `users` não traz mais coluna nenhuma: ele sobrevive só como
    // garantia de que a conta existe — conta excluída (server/exclusao-de-conta.ts)
    // não pode deixar match órfão apontando para linha que sumiu.
    .innerJoin(users, eq(users.id, matches.matchedUserId!))
    .leftJoin(connections, and(
      or(
        and(eq(connections.requesterId, userId), eq(connections.recipientId, matches.matchedUserId!)),
        and(eq(connections.requesterId, matches.matchedUserId!), eq(connections.recipientId, userId)),
      ),
      // O passo do distribuidor é invisível para a destinatária: a linha em
      // análise (ou não encaminhada) não entra no join — para ela é como se
      // não houvesse pedido. Regra de consulta, não de tela.
      pedidoVisivelPara(userId),
    ))
    .where(and(eq(matches.userId, userId), eq(matches.userDismissed, false)))
    .orderBy(desc(matches.overallScore), asc(matches.matchedUserId))
    .limit(limit)
    .offset(pulo);
  return comSouDestinatariaBooleana(linhas);
  // A13 (histórico): a `bio` era texto livre da OUTRA usuária chegando a esta, e
  // saía daqui mascarada contra telefone/e-mail. Ela deixou de ser lida — proteção
  // maior, não menor: o que não é selecionado não precisa ser mascarado. A máscara
  // `mascararContatosEmTexto` segue viva e em uso no resto do produto.
}

export async function dismissMatch(userId: number, matchId: number) {
  const db = await exigirDb();
  await db.update(matches)
    .set({ userDismissed: true })
    .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
}

export async function regenerateMatches(userId: number): Promise<number> {
  const { generateMatchesForUser } = await import("./matching");
  return generateMatchesForUser(userId);
}

/**
 * A alça do cartão anônimo: de `matchId` para a usuária do outro lado.
 *
 * Com o `matchedUserId` fora do payload, o navegador age pelo `matchId` — que ele
 * já recebia para dispensar. Quem protege não é a opacidade do número e sim o
 * predicado de posse: a linha tem de ser um match DESTA usuária. Enumerar id
 * alheio devolve `null` e não escreve nada.
 *
 * Conserta de passagem um buraco antigo: `connections.send` aceitava qualquer
 * `targetUserId`, match ou não. Somado ao `connections.list`, que devolvia nome e
 * empresa de qualquer pendente, isso permitia varrer a base inteira de qualquer
 * conta autenticada.
 */
export async function resolverAlvoDoMatch(userId: number, matchId: number): Promise<number | null> {
  const db = await exigirDb();
  const linha = await db.select({ matchedUserId: matches.matchedUserId })
    .from(matches)
    .where(and(
      eq(matches.id, matchId),
      eq(matches.userId, userId),
      eq(matches.userDismissed, false),
    ))
    .limit(1);
  return linha[0]?.matchedUserId ?? null;
}

// ─── Connections ────────────────────────────────────────────────────────────────
/**
 * O PORTÃO DA REVELAÇÃO MÚTUA.
 *
 * Esta é a única consulta do painel que devolve identidade de outra membra, e
 * ela só devolve quando a conexão está `accepted` — o registro de que as duas
 * quiseram. Enquanto está `pending`, as duas pontas recebem exatamente a mesma
 * projeção anônima: quem pediu não se expõe sozinha, e quem recebeu decide pelo
 * que o perfil diz, não por quem a pessoa é.
 *
 * A simetria não depende de disciplina de quem escreve o código: é UMA linha e
 * UMA coluna `status`, lida pelo mesmo predicado pelos dois lados. Não existe
 * estado "revelado para A e não para B".
 *
 * `requesterId` e `recipientId` NÃO saem enquanto está pendente — são o id real
 * da outra parte. No lugar deles vai `souDestinataria`, que é o que a tela
 * precisa para saber de que lado está. `outraParteId` só volta depois do aceite,
 * porque a mensagem direta de Ouro precisa dele.
 *
 * O bilhete (`message`) também espera o aceite: o bloqueio A13 barra telefone e
 * e-mail, não nome — "oi, aqui é a Ana da Vinícola X" atravessaria o portão
 * inteiro numa linha de texto livre.
 */
export async function getConnectionsForUser(userId: number) {
  const db = await exigirDb();
  const outraParte = sql`CASE WHEN ${connections.requesterId} = ${userId} THEN ${connections.recipientId} ELSE ${connections.requesterId} END`;
  const aceita = sql`${connections.status} = 'accepted'`;
  const linhas = await db.select({
    id: connections.id,
    status: connections.status,
    createdAt: connections.createdAt,
    souDestinataria: sql<boolean>`${connections.recipientId} = ${userId}`,
    // Anônimo dos dois lados, sempre: é com isto que se decide aceitar.
    city: userProfiles.city,
    primarySpecialty: userProfiles.primarySpecialty,
    // Só depois do aceite.
    outraParteId: sql<number | null>`CASE WHEN ${aceita} THEN ${outraParte} ELSE NULL END`,
    message: sql<string | null>`CASE WHEN ${aceita} THEN ${connections.message} ELSE NULL END`,
    displayName: sql<string | null>`CASE WHEN ${aceita} THEN ${userProfiles.displayName} ELSE NULL END`,
    avatarUrl: sql<string | null>`CASE WHEN ${aceita} THEN ${userProfiles.avatarUrl} ELSE NULL END`,
    userName: sql<string | null>`CASE WHEN ${aceita} THEN ${users.name} ELSE NULL END`,
    userCompany: sql<string | null>`CASE WHEN ${aceita} THEN ${users.company} ELSE NULL END`,
  })
    .from(connections)
    .innerJoin(userProfiles, sql`${userProfiles.userId} = CASE WHEN ${connections.requesterId} = ${userId} THEN ${connections.recipientId} ELSE ${connections.requesterId} END`)
    .innerJoin(users, sql`${users.id} = CASE WHEN ${connections.requesterId} = ${userId} THEN ${connections.recipientId} ELSE ${connections.requesterId} END`)
    .where(and(
      or(eq(connections.requesterId, userId), eq(connections.recipientId, userId)),
      // O MESMO predicado de getMatchesForUser: em análise ou não encaminhado
      // não existe para a destinatária.
      pedidoVisivelPara(userId),
    ))
    .orderBy(desc(connections.createdAt))
    .limit(50);
  return comSouDestinatariaBooleana(linhas);
}

/**
 * O passo do distribuidor (in_review) e o seu desfecho negativo (not_forwarded)
 * são invisíveis para a DESTINATÁRIA: ela só fica sabendo do pedido depois que
 * ele é encaminhado. A exceção é quando ela mesma também clicou enquanto o
 * pedido estava em análise (`reciprocatedAt`): aí o pedido é dela também.
 * Compartilhado por getMatchesForUser e getConnectionsForUser, para não existir
 * "a lista de matches esconde e a de conexões mostra".
 */
function pedidoVisivelPara(userId: number) {
  return sql`NOT (${connections.status} IN ('in_review', 'not_forwarded') AND ${connections.recipientId} = ${userId} AND ${connections.reciprocatedAt} IS NULL)`;
}

/**
 * Quantas linhas o UPDATE alcançou (cópia da função de match-service.ts, que
 * importa este módulo). O mysql2 liga CLIENT_FOUND_ROWS: conta a linha que o
 * WHERE ENCONTROU, não a que mudou de valor — o que uma trava otimista quer.
 */
function linhasAfetadas(resultado: unknown) {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return (cabecalho as { affectedRows?: number } | null | undefined)?.affectedRows ?? 0;
}

/**
 * Demonstrar interesse — olhando os DOIS sentidos.
 *
 * A versão anterior só procurava `(requesterId = eu, recipientId = ela)`. Se as
 * duas clicassem em "Demonstrar Interesse" no cartão uma da outra, nasciam DUAS
 * linhas pendentes: as duas tinham demonstrado interesse e nenhuma via nenhuma —
 * exatamente o que a regra do interesse mútuo promete que não acontece. Agora a
 * linha invertida pendente é o próprio aceite.
 *
 * A resposta é DELIBERADAMENTE a mesma em todos os casos que não são erro. Antes,
 * uma linha existente virava `CONFLICT` distinguível, o que transformava a rota
 * num oráculo: dava para descobrir que alguém recusou ou bloqueou.
 */
/**
 * O clique em "Demonstrar Interesse". Quatro desfechos, todos com a MESMA resposta
 * para o navegador (connections.send não distingue):
 * - par novo → nasce `in_review`, esperando o distribuidor (`emAnalise: true`,
 *   para o router avisar quem distribui);
 * - a outra parte já tinha pedido e o pedido está `in_review` → grava só
 *   `reciprocatedAt`: uma linha por par, e a aprovação já revela os dois nomes;
 * - a outra parte já tinha pedido e o pedido está `pending` (encaminhado) →
 *   interesse mútuo, vira `accepted`;
 * - qualquer outra linha existente (recusada, não encaminhada, repetida) → nada.
 * Os UPDATEs levam o status lido no WHERE: duas abas não revelam duas vezes.
 */
export async function sendConnectionRequest(requesterId: number, recipientId: number) {
  const db = await exigirDb();
  const par = await db.select({
    id: connections.id,
    requesterId: connections.requesterId,
    status: connections.status,
    reciprocatedAt: connections.reciprocatedAt,
  })
    .from(connections)
    .where(or(
      and(eq(connections.requesterId, requesterId), eq(connections.recipientId, recipientId)),
      and(eq(connections.requesterId, recipientId), eq(connections.recipientId, requesterId)),
    ))
    .limit(2);

  const invertida = par.find(l => l.requesterId === recipientId);
  if (invertida?.status === "pending") {
    const [resultado] = await db.update(connections)
      .set({ status: "accepted" })
      .where(and(eq(connections.id, invertida.id), eq(connections.status, "pending")));
    return { revelou: linhasAfetadas(resultado) === 1, connectionId: invertida.id, emAnalise: false };
  }
  if (invertida?.status === "in_review" && invertida.reciprocatedAt === null) {
    await db.update(connections)
      .set({ reciprocatedAt: new Date() })
      .where(and(eq(connections.id, invertida.id), eq(connections.status, "in_review"), isNull(connections.reciprocatedAt)));
    return { revelou: false, connectionId: invertida.id, emAnalise: false };
  }
  if (par.length > 0) return { revelou: false, connectionId: par[0].id, emAnalise: false };

  const [inserido] = await db.insert(connections).values({ requesterId, recipientId, status: "in_review" });
  const connectionId = (inserido as { insertId?: number } | undefined)?.insertId ?? null;
  return { revelou: false, connectionId, emAnalise: true };
}

/** Devolve se o aceite realmente aconteceu, para a trilha de auditoria saber. */
export async function respondToConnection(connectionId: number, userId: number, accept: boolean) {
  const db = await exigirDb();
  const linha = await db.select({
    id: connections.id,
    requesterId: connections.requesterId,
    status: connections.status,
  })
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.recipientId, userId)))
    .limit(1);
  if (linha.length === 0 || linha[0].status !== "pending") return { revelou: false, contraparte: null };

  // Status no WHERE: a segunda aba que aceita depois da primeira não afeta linha
  // nenhuma e não revela (nem audita) de novo.
  const [resultado] = await db.update(connections)
    .set({ status: accept ? "accepted" : "declined" })
    .where(and(eq(connections.id, connectionId), eq(connections.recipientId, userId), eq(connections.status, "pending")));
  if (linhasAfetadas(resultado) !== 1) return { revelou: false, contraparte: null };
  return { revelou: accept, contraparte: linha[0].requesterId };
}

// ─── Private Contacts (Minha Rede de Relacionamentos) ─────────────────────────
// TODOS os helpers aplicam RLS: WHERE ownerId = :ownerId obrigatório

export async function createPrivateContact(
  ownerId: string,
  data: Omit<InsertPrivateContact, "id" | "ownerId" | "createdAt" | "updatedAt">,
  // A transação de quem cria o contato junto com outras escritas (a pessoa
  // da reunião e as pendências dela, em meetings.decideContactSuggestion).
  transacao?: Pick<Awaited<ReturnType<typeof exigirDb>>, "insert">,
): Promise<number> {
  const db = transacao ?? await exigirDb();
  const now = Date.now();
  // Meu Network Inteligente (item 13): o contato nasce com o ID anônimo. A
  // colisão do índice único, rara, grava de novo com outro código.
  const { comCodigoAnonimo } = await import("./network-codigo-anonimo");
  const [result] = await comCodigoAnonimo(codigoAnonimo => db.insert(privateContacts).values({
    ...data,
    codigoAnonimo,
    ownerId,
    createdAt: now,
    updatedAt: now,
  }));
  return (result as any).insertId as number;
}

export async function listPrivateContacts(
  ownerId: string,
  opts: { q?: string; tag?: string; country?: string; page?: number; limit?: number }
): Promise<{ data: PrivateContact[]; total: number }> {
  const db = await exigirDb();
  const { q, tag, country, page = 1, limit = 20 } = opts;
  const offset = (page - 1) * limit;

  // Condições base — RLS sempre presente
  const conditions = [eq(privateContacts.ownerId, ownerId)];
  if (q) {
    conditions.push(
      or(
        like(privateContacts.fullName, `%${q}%`),
        like(privateContacts.company, `%${q}%`),
        like(privateContacts.jobTitle, `%${q}%`)
      )!
    );
  }
  if (country) conditions.push(eq(privateContacts.country, country));
  // A tag entra na CONSULTA, não num filtro em memória depois do LIMIT: a
  // versão anterior lia a página de 20 mais recentes e só então filtrava, e o
  // COUNT ignorava a tag — o chip "Diplomata" mostrava "Nenhum contato" ao
  // lado de "25 contatos encontrados / Página 1 de 2" (auditoria de 04/09).
  // JSON_CONTAINS + JSON_QUOTE casam o valor inteiro (MariaDB e MySQL 8);
  // parâmetro pelo template `sql`, nunca sql.raw. O CONVERT é para o MariaDB
  // (local e CI): lá a coluna "json" é texto no charset da tabela e o
  // JSON_CONTAINS compara bytes contra o utf8mb4 do JSON_QUOTE — numa tabela
  // latin1, "Saúde" nunca casaria. No MySQL 8 da produção é só uma conversão
  // do JSON para texto, sem efeito.
  if (tag) {
    conditions.push(sql`JSON_CONTAINS(CONVERT(${privateContacts.profileTags} USING utf8mb4), JSON_QUOTE(${tag}))`);
  }

  const rows = await db
    .select()
    .from(privateContacts)
    .where(and(...conditions))
    .orderBy(desc(privateContacts.updatedAt))
    .limit(limit)
    .offset(offset);

  // Count total com as MESMAS condições da página (inclusive a tag).
  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(privateContacts)
    .where(and(...conditions));

  return { data: rows, total: Number(countRow?.count ?? 0) };
}

export async function getPrivateContactById(
  ownerId: string,
  contactId: number
): Promise<PrivateContact | null> {
  const db = await exigirDb();
  const [row] = await db
    .select()
    .from(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/**
 * Outro contato da MESMA dona ainda aponta para esta imagem (foto ou cartão)?
 * Uma duplicata pode nascer com a mesma chave no bucket (o modal de edição
 * chegou a criar uma; um cadastro repetido a partir da mesma foto faria o
 * mesmo). Apagar o objeto ao excluir ou trocar a foto de UM contato quebraria
 * a foto do outro: o proxy assina, o bucket devolve 404. Filtrado por ownerId
 * como toda consulta da rede: a pergunta é sobre a rede desta dona, não sobre
 * o bucket inteiro.
 */
export async function imagemUsadaPorOutroContato(
  ownerId: string,
  storagePath: string,
  exceptoId: number
): Promise<boolean> {
  const db = await exigirDb();
  const [row] = await db
    .select({ id: privateContacts.id })
    .from(privateContacts)
    .where(and(
      eq(privateContacts.ownerId, ownerId),
      or(eq(privateContacts.photoUrl, storagePath), eq(privateContacts.cardImageUrl, storagePath)),
      ne(privateContacts.id, exceptoId),
    ))
    .limit(1);
  return Boolean(row);
}

export async function updatePrivateContact(
  ownerId: string,
  contactId: number,
  data: Partial<Omit<InsertPrivateContact, "id" | "ownerId" | "createdAt">>
): Promise<boolean> {
  const db = await exigirDb();
  const [result] = await db
    .update(privateContacts)
    .set({ ...data, updatedAt: Date.now() })
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)));
  return (result as any).affectedRows > 0;
}

/**
 * O rastro que um contato deixa fora da própria linha — e que a exclusão
 * precisa levar junto. Exportada com o `db` como parâmetro para os testes
 * executarem a lógica de verdade, sem banco.
 *
 * A revisão de 01/09 pegou o buraco: a primeira versão limpava possui/procura
 * e sugestões de match, mas deixava intactos o vínculo com contextos e as
 * tabelas do ENRIQUECIMENTO — justamente onde mora o dado pessoal extraído
 * pela IA (telefone, instagram, empresa) e a conversa inteira sobre a pessoa.
 * "Dado apagado não deixa fantasma" vale para LGPD, não só para a tela.
 */
export async function apagarRastroDoContato(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ownerId: string,
  contactId: number,
): Promise<void> {
  await db.delete(contactAssets)
    .where(and(eq(contactAssets.ownerId, ownerId), eq(contactAssets.contactId, contactId)));
  await db.delete(contactNeeds)
    .where(and(eq(contactNeeds.ownerId, ownerId), eq(contactNeeds.contactId, contactId)));
  await db.delete(aiMatchSuggestions)
    .where(and(
      eq(aiMatchSuggestions.ownerId, ownerId),
      drizzleOr(
        eq(aiMatchSuggestions.pairLowContactId, contactId),
        eq(aiMatchSuggestions.pairHighContactId, contactId),
      ),
    ));
  // Onde e como a pessoa foi conhecida: o vínculo é do contato, morre com ele.
  await db.delete(contactContexts)
    .where(and(eq(contactContexts.ownerId, ownerId), eq(contactContexts.contactId, contactId)));
  // A sugestão de contato extraída da REUNIÃO guarda nome, cargo, empresa,
  // telefone e e-mail que a IA tirou da gravação — a classe de dado que o
  // cartão manda levar junto. A linha inteira sai: sem o contato, ela é só um
  // fichário do que a IA ouviu sobre uma pessoa que a dona mandou apagar.
  await db.delete(meetingContactSuggestions)
    .where(and(
      eq(meetingContactSuggestions.ownerId, ownerId),
      eq(meetingContactSuggestions.existingContactId, contactId),
    ));
  // Meu Network Inteligente: as pendências da IA sobre a pessoa (Quem Sou, O
  // Que Tenho, O Que Preciso, com o trecho da fonte) saem com ela. Nas
  // conexões registradas o ponteiro para o contato é anulado e o ID anônimo
  // fica: é a prova comercial de que a conexão existiu, sem dado da pessoa.
  await db.delete(networkSugestoes)
    .where(and(eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.contactId, contactId)));
  await db.update(conexoesParticipantes).set({ contactId: null, updatedAt: Date.now() })
    .where(and(eq(conexoesParticipantes.ownerId, ownerId), eq(conexoesParticipantes.contactId, contactId)));
  // O enriquecimento: sugestões apontam o contato direto; as mensagens só
  // conhecem a sessão, então primeiro a lista de sessões, depois as mensagens
  // delas, e as sessões por último — nenhuma ordem deixa órfão se cair no meio.
  await db.delete(enrichmentSuggestions)
    .where(and(eq(enrichmentSuggestions.ownerId, ownerId), eq(enrichmentSuggestions.contactId, contactId)));
  const sessoes = await db.select({ id: enrichmentSessions.id })
    .from(enrichmentSessions)
    .where(and(eq(enrichmentSessions.ownerId, ownerId), eq(enrichmentSessions.contactId, contactId)));
  if (sessoes.length) {
    await db.delete(enrichmentMessages)
      .where(and(
        eq(enrichmentMessages.ownerId, ownerId),
        inArray(enrichmentMessages.sessionId, sessoes.map(sessao => sessao.id)),
      ));
    await db.delete(enrichmentSessions)
      .where(and(eq(enrichmentSessions.ownerId, ownerId), eq(enrichmentSessions.contactId, contactId)));
  }
  // Ponteiros que sobrevivem por direito: a REUNIÃO e o PARTICIPANTE do
  // contexto são registro da própria dona e continuam existindo. Só o vínculo
  // com o contato apagado é anulado — deixá-lo apontando para um id que não
  // existe é o mesmo "Contato A fantasma" que motivou o cartão.
  await db.update(meetings).set({ contactId: null })
    .where(and(eq(meetings.ownerId, ownerId), eq(meetings.contactId, contactId)));
  await db.update(contextParticipants).set({ convertedContactId: null })
    .where(and(eq(contextParticipants.ownerId, ownerId), eq(contextParticipants.convertedContactId, contactId)));
  // As próximas ações (H5a) também são da dona: ficam, sem o contato.
  await db.update(proximasAcoes).set({ contactId: null, updatedAt: Date.now() })
    .where(and(eq(proximasAcoes.ownerId, ownerId), eq(proximasAcoes.contactId, contactId)));
}

export async function deletePrivateContact(
  ownerId: string,
  contactId: number
): Promise<boolean> {
  const db = await exigirDb();
  // A posse é conferida ANTES de tocar em qualquer coisa: contato de outra
  // dona (ou inexistente) sai por aqui sem apagar nada.
  const [alvo] = await db.select({ id: privateContacts.id })
    .from(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)))
    .limit(1);
  if (!alvo) return false;

  // O RASTRO SAI PRIMEIRO, e é por isso: são vários statements sem transação
  // (o driver não abre uma aqui), e a ordem decide o que sobra se a conexão
  // cair no meio. Apagando o contato antes, uma falha deixaria possui/procura
  // vivos alimentando o cruzamento e o enriquecimento órfão PARA SEMPRE — a
  // segunda tentativa não acharia mais o contato e a limpeza nunca rodaria.
  // Nesta ordem, a falha deixa o contato de pé: a dona tenta de novo e a
  // limpeza recomeça do zero, porque cada delete é idempotente.
  await apagarRastroDoContato(db, ownerId, contactId);

  const [result] = await db
    .delete(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)));
  return (result as any).affectedRows > 0;
}

/**
 * Etapa 10 — a parte pura do filtro de autorização da dona, separada para os
 * testes executarem de verdade (não só lerem o fonte): contato de dona órfã
 * (conta apagada) sai; contato de dona sem o termo vigente sai.
 */
export function filtrarAcervoPorAutorizacao<T extends { ownerId: string }>(
  compartilhados: T[],
  donaPorOpenId: Map<string, { id: number }>,
  autorizadas: Set<number>,
): T[] {
  return compartilhados.filter(contato => {
    const dona = donaPorOpenId.get(contato.ownerId);
    return dona !== undefined && autorizadas.has(dona.id);
  });
}

/**
 * Etapa 10 — o acervo Ouro: os contatos que as donas marcaram como
 * "Compartilhado com Usuários Ouro" (nivelVisibilidade = 'ouro').
 *
 * Duas autorizações se encontram aqui, e as duas são reavaliadas A CADA
 * requisição, no banco — revogar qualquer uma tira o acesso na hora:
 *  1. A da dona, por contato: o filtro por nível roda em tempo de leitura;
 *     voltar o contato para 'privado' o remove na requisição seguinte.
 *  2. A da dona, pela plataforma: o termo_acesso_ouro (padrão da etapa 11 —
 *     sem versão publicada não há o que consentir e a leitura libera; texto
 *     jurídico com a Cris). Revogar o termo esconde a base inteira da dona.
 * (Quem PODE ler é decidido na rota: goldProcedure, só Status Ouro.)
 *
 * A projeção segue o cartão da etapa 10: nome, empresa e cargo, segmento
 * (tags do perfil), local e possui/procura — e NADA de telefone, whatsapp,
 * e-mail, redes, foto, cartão ou notas: sem mecanismo de "dados pessoais
 * disponibilizados" campo a campo, os canais pessoais ficam de fora. Os
 * níveis não são cumulativos: 'publico' mora na vitrine, não aqui.
 */
export async function listAcervoOuro() {
  const db = await exigirDb();
  // Ordem determinística (mais recentes primeiro) e folga de leitura: o corte
  // final de 200 acontece DEPOIS dos filtros de dona/termo, senão linhas que
  // serão descartadas consumiriam o teto e material autorizado sumiria ao
  // acaso. A folga de 2x mantém a consulta limitada — o acervo é uma tela.
  const compartilhados = await db
    .select({
      id: privateContacts.id,
      fullName: privateContacts.fullName,
      jobTitle: privateContacts.jobTitle,
      company: privateContacts.company,
      country: privateContacts.country,
      city: privateContacts.city,
      profileTags: privateContacts.profileTags,
      ownerId: privateContacts.ownerId,
    })
    .from(privateContacts)
    .where(eq(privateContacts.nivelVisibilidade, "ouro"))
    .orderBy(desc(privateContacts.updatedAt))
    .limit(400);
  if (!compartilhados.length) return [];

  const donasOpenIds = Array.from(new Set(compartilhados.map(contato => contato.ownerId)));
  const donas = await db
    .select({ id: users.id, openId: users.openId, name: users.name })
    .from(users)
    .where(inArray(users.openId, donasOpenIds));
  // Import dinâmico: consent.ts importa exigirDb daqui; estático viraria ciclo.
  const { usersComConsentimento } = await import("./routers/consent");
  const autorizadas = await usersComConsentimento(donas.map(dona => dona.id), "termo_acesso_ouro");
  const donaPorOpenId = new Map(donas.map(dona => [dona.openId, dona]));
  const visiveis = filtrarAcervoPorAutorizacao(compartilhados, donaPorOpenId, autorizadas).slice(0, 200);
  if (!visiveis.length) return [];

  const ids = visiveis.map(contato => contato.id);
  const [possuiTudo, procuraTudo] = await Promise.all([
    db.select({ contactId: contactAssets.contactId, label: contactAssets.tagLabel, category: contactAssets.category })
      .from(contactAssets).where(inArray(contactAssets.contactId, ids)),
    db.select({ contactId: contactNeeds.contactId, label: contactNeeds.tagLabel, category: contactNeeds.category })
      .from(contactNeeds).where(inArray(contactNeeds.contactId, ids)),
  ]);
  // Referência opaca com sal PRÓPRIO: nem correlaciona com o id sequencial,
  // nem com a referência que o mesmo contato teria na vitrine coletiva.
  const referenciaOpaca = (id: number) =>
    nodeCrypto.createHash("sha256").update(`acervo-ouro:${ENV.cookieSecret}:${id}`).digest("hex").slice(0, 10);
  return visiveis.map(contato => ({
    contatoRef: referenciaOpaca(contato.id),
    fullName: contato.fullName,
    jobTitle: contato.jobTitle,
    company: contato.company,
    country: contato.country,
    city: contato.city,
    profileTags: contato.profileTags ?? [],
    compartilhadoPor: donaPorOpenId.get(contato.ownerId)?.name ?? null,
    possui: possuiTudo.filter(item => item.contactId === contato.id).map(({ label, category }) => ({ label, category })),
    procura: procuraTudo.filter(item => item.contactId === contato.id).map(({ label, category }) => ({ label, category })),
  }));
}

/**
 * Etapa 8 — a vitrine coletiva do ecossistema.
 *
 * O escopo é explícito: de um contato público "não pode aparecer os dados
 * pessoais do contato, só as oportunidades". Não basta filtrar linhas — as
 * colunas pessoais (nome, empresa, cargo, telefone, whatsapp, email, linkedin,
 * instagram, foto, cartão) NEM SÃO SELECIONADAS aqui, seguindo a projeção de
 * privacidade.md. Sai só: uma referência opaca, país, cidade e o que o contato
 * possui/procura. O filtro por nível roda no banco a cada leitura, então
 * voltar para 'privado' remove da vitrine na requisição seguinte.
 */
export async function listVitrineColetiva() {
  const db = await exigirDb();
  // Teto de leitura: a vitrine é uma tela, não uma exportação. Sem o limite,
  // cada visita carregaria o ecossistema inteiro.
  const publicos = await db
    .select({ id: privateContacts.id, country: privateContacts.country, city: privateContacts.city })
    .from(privateContacts)
    .where(eq(privateContacts.nivelVisibilidade, "publico"))
    .limit(200);
  if (!publicos.length) return [];
  const ids = publicos.map(publico => publico.id);
  const [possui, procura] = await Promise.all([
    db.select({ contactId: contactAssets.contactId, label: contactAssets.tagLabel, category: contactAssets.category })
      .from(contactAssets).where(inArray(contactAssets.contactId, ids)),
    db.select({ contactId: contactNeeds.contactId, label: contactNeeds.tagLabel, category: contactNeeds.category })
      .from(contactNeeds).where(inArray(contactNeeds.contactId, ids)),
  ]);
  // A referência precisa ser OPACA de verdade: o id sequencial da tabela conta
  // quantos contatos existem e permite correlação com qualquer outro endpoint
  // que um dia exponha ids. Um hash com sal de servidor identifica o item na
  // tela sem entregar nada — e continua estável entre leituras.
  const referenciaOpaca = (id: number) =>
    nodeCrypto.createHash("sha256").update(`vitrine:${ENV.cookieSecret}:${id}`).digest("hex").slice(0, 10);
  return publicos.map(publico => ({
    contatoRef: referenciaOpaca(publico.id),
    country: publico.country,
    city: publico.city,
    possui: possui.filter(item => item.contactId === publico.id).map(({ label, category }) => ({ label, category })),
    procura: procura.filter(item => item.contactId === publico.id).map(({ label, category }) => ({ label, category })),
  }));
}

// ─── Contextos (Onde e Como Conheceu) ─────────────────────────────────────────

export async function listContextTypes(): Promise<ContextType[]> {
  const db = await exigirDb();
  const tipos = await db.select().from(contextTypes).where(eq(contextTypes.isActive, true)).orderBy(contextTypes.sortOrder);
  return tipos.map(tipo => ({ ...tipo, name: nomeDoTipoDeContexto(tipo.slug, tipo.name) }));
}

export async function listContexts(
  ownerId: string,
  opts: { q?: string; typeSlug?: string; year?: number; country?: string; page?: number; limit?: number }
): Promise<{ data: (Context & { typeName?: string; typeColor?: string; typeSlug?: string; contactCount: number })[]; total: number }> {
  const db = await exigirDb();
  const { q, typeSlug, year, country, page = 1, limit = 20 } = opts;
  const offset = (page - 1) * limit;

  // Buscar contextos do usuário + globais
  const rows = await db
    .select({
      ctx: contexts,
      typeName: contextTypes.name,
      typeColor: contextTypes.colorToken,
      typeSlug: contextTypes.slug,
    })
    .from(contexts)
    .leftJoin(contextTypes, eq(contexts.contextTypeId, contextTypes.id))
    .where(
      and(
        drizzleOr(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId)),
        typeSlug ? eq(contextTypes.slug, typeSlug) : undefined,
        country ? like(contexts.country, `%${country}%`) : undefined,
        q ? drizzleOr(like(contexts.name, `%${q}%`), like(contexts.notes, `%${q}%`)) : undefined,
      )
    )
    .orderBy(desc(contexts.createdAt))
    .limit(limit)
    .offset(offset);

  // Contar contatos por contexto
  const contextIds = rows.map(r => r.ctx.id);
  const countMap: Record<string, number> = {};
  if (contextIds.length > 0) {
    for (const ctxId of contextIds) {
      const [c] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(contactContexts)
        .where(and(eq(contactContexts.contextId, ctxId), eq(contactContexts.ownerId, ownerId)));
      countMap[ctxId] = Number(c?.count ?? 0);
    }
  }

  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(contexts)
    .leftJoin(contextTypes, eq(contexts.contextTypeId, contextTypes.id))
    .where(
      and(
        drizzleOr(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId)),
        typeSlug ? eq(contextTypes.slug, typeSlug) : undefined,
        country ? like(contexts.country, `%${country}%`) : undefined,
        q ? drizzleOr(like(contexts.name, `%${q}%`), like(contexts.notes, `%${q}%`)) : undefined,
      )
    );

  return {
    data: rows.map(r => ({
      ...r.ctx,
      typeName: nomeDoTipoDeContexto(r.typeSlug, r.typeName) ?? undefined,
      typeColor: r.typeColor ?? undefined,
      // Sem o slug a tela não acha o ícone do tipo e — pior — o formulário de
      // edição abre com o tipo vazio e salvar apaga o tipo do contexto.
      typeSlug: r.typeSlug ?? undefined,
      contactCount: countMap[r.ctx.id] ?? 0,
    })),
    total: Number(countRow?.count ?? 0),
  };
}

export async function createContext(
  ownerId: string,
  data: Omit<typeof contexts.$inferInsert, "id" | "ownerId" | "createdAt" | "updatedAt" | "isCustom">
): Promise<string> {
  const db = await exigirDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(contexts).values({ ...data, id, ownerId, isCustom: true, createdAt: now, updatedAt: now });
  return id;
}

export async function getContextById(ownerId: string, contextId: string) {
  const db = await exigirDb();
  const [row] = await db
    .select({ ctx: contexts, typeName: contextTypes.name, typeColor: contextTypes.colorToken, typeSlug: contextTypes.slug, typeIcon: contextTypes.iconName })
    .from(contexts)
    .leftJoin(contextTypes, eq(contexts.contextTypeId, contextTypes.id))
    .where(and(eq(contexts.id, contextId), drizzleOr(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId))))
    .limit(1);
  if (!row) return null;

  const links = await db.select().from(contactContexts)
    .where(and(eq(contactContexts.contextId, contextId), eq(contactContexts.ownerId, ownerId)));
  // O nome de quem foi vinculado — sem ele a tela mostrava "Contato #42".
  const idsVinculados = Array.from(new Set(links.map(l => l.contactId)));
  const nomes = idsVinculados.length
    ? await db.select({ id: privateContacts.id, fullName: privateContacts.fullName }).from(privateContacts)
        .where(and(eq(privateContacts.ownerId, ownerId), inArray(privateContacts.id, idsVinculados)))
    : [];
  const nomePorContato = new Map(nomes.map(n => [n.id, n.fullName]));
  const participants = await db.select().from(contextParticipants)
    .where(and(eq(contextParticipants.contextId, contextId), eq(contextParticipants.ownerId, ownerId)));
  const media = await db.select().from(contextMedia)
    .where(and(eq(contextMedia.contextId, contextId), eq(contextMedia.ownerId, ownerId)))
    .orderBy(contextMedia.sortOrder, contextMedia.createdAt);

  return {
    ...row.ctx, typeName: nomeDoTipoDeContexto(row.typeSlug, row.typeName), typeColor: row.typeColor, typeSlug: row.typeSlug, typeIcon: row.typeIcon,
    links: links.map(l => ({ ...l, contactName: nomePorContato.get(l.contactId) ?? null })),
    participants, media,
  };
}

export async function updateContext(ownerId: string, contextId: string, data: Partial<typeof contexts.$inferInsert>): Promise<boolean> {
  const db = await exigirDb();
  const [r] = await db.update(contexts)
    .set({ ...data, updatedAt: Date.now() })
    .where(and(eq(contexts.id, contextId), eq(contexts.ownerId, ownerId), eq(contexts.isCustom, true)));
  return (r as any).affectedRows > 0;
}

export async function deleteContext(ownerId: string, contextId: string): Promise<boolean> {
  const db = await exigirDb();
  // A posse decide ANTES de qualquer outra escrita: o próprio DELETE em
  // contexts (dela E personalizado, a mesma régua do updateContext) é a
  // checagem. Na ordem inversa, um id do catálogo (owner_id NULL, que
  // contextIsVisible e uploadMedia aceitam de propósito) apagava os anexos da
  // dona em context_media, e só depois o DELETE em contexts afetava 0 linhas —
  // a resposta dizia NOT_FOUND com as linhas já perdidas (reverificação de
  // 04/09, etapa 5).
  //
  // Tudo numa transação (H7c do plano do gravador): o contexto, os registros
  // dos anexos e o ponteiro das reuniões da dona que estavam nele. Com um
  // commit por passo, a falha no meio deixava registro de mídia sem contexto,
  // ou reunião apontando para um contexto que não existe mais.
  return db.transaction(async tx => {
    const [r] = await tx.delete(contexts)
      .where(and(eq(contexts.id, contextId), eq(contexts.ownerId, ownerId), eq(contexts.isCustom, true)));
    if (!((r as any).affectedRows > 0)) return false;
    // Os registros de anexos saem junto: não há FK/cascade no schema herdado, e
    // linha de mídia órfã esconderia arquivo que continua existindo no bucket.
    await tx.delete(contextMedia)
      .where(and(eq(contextMedia.contextId, contextId), eq(contextMedia.ownerId, ownerId)));
    // A reunião fica, sem o contexto: é registro da própria dona, como no
    // contato excluído (apagarRastroDoContato, acima). Só as reuniões DELA: o
    // contexto personalizado é dela, e o índice (dona, contexto) acha as linhas.
    // O updated_at da reunião não muda: é a ficha de quem a processa
    // (server/meeting-service.ts).
    await tx.update(meetings).set({ contextId: null })
      .where(and(eq(meetings.ownerId, ownerId), eq(meetings.contextId, contextId)));
    // Fora de escopo (pendência registrada): os vínculos em contact_contexts e
    // os participantes em context_participants do contexto apagado continuam
    // na base — listContextsByContact os esconde pelo innerJoin em contexts,
    // mas as linhas não são limpas aqui. O arquivo no bucket o router só apaga
    // depois do commit.
    return true;
  });
}

export async function listContextMediaByContext(ownerId: string, contextId: string) {
  const db = await exigirDb();
  return db.select().from(contextMedia)
    .where(and(eq(contextMedia.contextId, contextId), eq(contextMedia.ownerId, ownerId)));
}

export async function linkContactToContext(
  ownerId: string,
  data: { contactId: number; contextId: string; eventDate?: string | null; city?: string | null; country?: string | null; notes?: string | null; relationshipType?: string }
): Promise<{ id: string; created: boolean }> {
  const db = await exigirDb();
  // Vincular duas vezes não duplica: o vínculo existente é atualizado com o
  // que veio e devolvido. Jogar fora o que a usuária digitou (data, cidade,
  // notas) com um toast de sucesso seria mentir para ela. Em data, cidade, país
  // e notas, null (ou vazio) APAGA o valor gravado e undefined o mantém: a
  // edição do vínculo manda null no campo que a dona esvaziou.
  const [jaExiste] = await db.select({ id: contactContexts.id }).from(contactContexts)
    .where(and(
      eq(contactContexts.ownerId, ownerId),
      eq(contactContexts.contactId, data.contactId),
      eq(contactContexts.contextId, data.contextId),
    ))
    .limit(1);
  if (jaExiste) {
    const atualiza: Record<string, unknown> = {};
    if (data.eventDate !== undefined) atualiza.eventDate = data.eventDate || null;
    if (data.city !== undefined) atualiza.city = data.city || null;
    if (data.country !== undefined) atualiza.country = data.country || null;
    if (data.notes !== undefined) atualiza.notes = data.notes || null;
    if (data.relationshipType) atualiza.relationshipType = data.relationshipType;
    if (Object.keys(atualiza).length > 0) {
      await db.update(contactContexts).set({ ...atualiza, updatedAt: Date.now() })
        .where(and(eq(contactContexts.id, jaExiste.id), eq(contactContexts.ownerId, ownerId)));
    }
    return { id: jaExiste.id, created: false };
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(contactContexts).values({
    id, ownerId,
    contactId: data.contactId,
    contextId: data.contextId,
    eventDate: data.eventDate ?? null,
    city: data.city ?? null,
    country: data.country ?? null,
    notes: data.notes ?? null,
    relationshipType: data.relationshipType ?? "profissional",
    visibility: "private",
    createdAt: now,
    updatedAt: now,
  });
  return { id, created: true };
}

export async function unlinkContactFromContext(ownerId: string, linkId: string): Promise<boolean> {
  const db = await exigirDb();
  const [r] = await db.delete(contactContexts)
    .where(and(eq(contactContexts.id, linkId), eq(contactContexts.ownerId, ownerId)));
  return (r as any).affectedRows > 0;
}

/** Os contextos em que um contato apareceu — é o que o perfil do contato exibe. */
export async function listContextsByContact(ownerId: string, contactId: number) {
  const db = await exigirDb();
  const rows = await db
    .select({
      link: contactContexts,
      ctxName: contexts.name,
      typeName: contextTypes.name,
      typeColor: contextTypes.colorToken,
      typeSlug: contextTypes.slug,
    })
    .from(contactContexts)
    .innerJoin(contexts, eq(contactContexts.contextId, contexts.id))
    .leftJoin(contextTypes, eq(contexts.contextTypeId, contextTypes.id))
    // A regra de dona vale para o CONTEXTO também (dela, ou do catálogo), a
    // mesma de getContextById/contextIsVisible: um vínculo apontando para
    // contexto alheio — gravado antes da checagem do router, ou legado — não
    // pode trazer o nome e o tipo do contexto de outra pessoa.
    .where(and(
      eq(contactContexts.ownerId, ownerId),
      eq(contactContexts.contactId, contactId),
      drizzleOr(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId)),
    ))
    .orderBy(desc(contactContexts.createdAt));
  return rows.map(r => ({
    linkId: r.link.id,
    contextId: r.link.contextId,
    name: r.ctxName,
    eventDate: r.link.eventDate,
    city: r.link.city,
    country: r.link.country,
    relationshipType: r.link.relationshipType,
    typeName: nomeDoTipoDeContexto(r.typeSlug, r.typeName) ?? undefined,
    typeColor: r.typeColor ?? undefined,
    typeSlug: r.typeSlug ?? undefined,
  }));
}

export async function addContextParticipant(
  ownerId: string,
  data: { contextId: string; name: string; company?: string; role?: string; notes?: string }
): Promise<string> {
  const db = await exigirDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(contextParticipants).values({ id, ownerId, ...data, createdAt: now, updatedAt: now });
  return id;
}

// ─── Mídia de contextos (fotos e documentos do encontro) ──────────────────────

/** O contexto está visível para esta dona? (dela mesma, ou do catálogo global) */
export async function contextIsVisible(ownerId: string, contextId: string): Promise<boolean> {
  const db = await exigirDb();
  const [row] = await db.select({ id: contexts.id }).from(contexts)
    .where(and(eq(contexts.id, contextId), drizzleOr(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId))))
    .limit(1);
  return Boolean(row);
}

export async function addContextMedia(
  ownerId: string,
  data: {
    contextId: string; storagePath: string; fileType: string; fileSize: number;
    originalName: string; caption?: string | null;
  }
): Promise<string> {
  const db = await exigirDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(contextMedia).values({
    id, ownerId,
    contextId: data.contextId,
    storagePath: data.storagePath,
    fileType: data.fileType,
    fileSize: data.fileSize,
    originalName: data.originalName,
    caption: data.caption ?? null,
    uploadedBy: ownerId,
    createdAt: now, updatedAt: now,
  });
  return id;
}

export async function getContextMediaById(ownerId: string, mediaId: string) {
  const db = await exigirDb();
  const [row] = await db.select().from(contextMedia)
    .where(and(eq(contextMedia.id, mediaId), eq(contextMedia.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function deleteContextMedia(ownerId: string, mediaId: string): Promise<boolean> {
  const db = await exigirDb();
  const [r] = await db.delete(contextMedia)
    .where(and(eq(contextMedia.id, mediaId), eq(contextMedia.ownerId, ownerId)));
  return (r as any).affectedRows > 0;
}

// ─── Enriquecimento com IA (Etapa 4) ──────────────────────────────────────────

export async function getActiveEnrichmentSession(ownerId: string, contactId: number) {
  const db = await exigirDb();
  const [row] = await db.select().from(enrichmentSessions)
    .where(and(eq(enrichmentSessions.ownerId, ownerId), eq(enrichmentSessions.contactId, contactId), eq(enrichmentSessions.status, "active")))
    .limit(1);
  return row ?? null;
}

export async function getEnrichmentSessionById(sessionId: string, ownerId: string) {
  const db = await exigirDb();
  const [row] = await db.select().from(enrichmentSessions)
    .where(and(eq(enrichmentSessions.id, sessionId), eq(enrichmentSessions.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/**
 * Avança exatamente uma etapa do roteiro: a que o chamador LEU
 * (`etapaEsperada`, o questionsAnswered da sessão no momento em que ele
 * decidiu que não sobrava cartão). Retorna null quando a sessão não está
 * ativa — ou quando OUTRA aba já avançou esta mesma etapa.
 *
 * Não relê a sessão de propósito: a versão que relia aqui dentro fazia duas
 * abas confirmando os dois últimos cartões da etapa avançarem o roteiro DUAS
 * vezes (cada uma relia o valor já avançado pela outra e passava no WHERE),
 * pulando a pergunta seguinte — reproduzido com banco real em 04/09. O WHERE
 * exige o valor que o chamador leu; quem chega depois não pega linha e recebe
 * null. O contador de puladas anda no próprio UPDATE, sem leitura antes.
 */
/**
 * Avança o roteiro da etapa lida (`etapaEsperada`) para `destino` (por padrão,
 * a seguinte). O destino maior pula as perguntas que o contato já tem
 * respondidas (T45, 24/11; ver proximaEtapaAPerguntar em
 * server/routers/enrichment.ts): só a pergunta da vez conta como pulada.
 */
export async function advanceEnrichmentSession(sessionId: string, ownerId: string, etapaEsperada: number, skipped = false, destino = etapaEsperada + 1) {
  const db = await exigirDb();
  const now = Date.now();
  const questionsAnswered = Math.max(destino, etapaEsperada + 1);
  const [r] = await db.update(enrichmentSessions)
    .set({
      questionsAnswered,
      ...(skipped ? { questionsSkipped: sql`${enrichmentSessions.questionsSkipped} + 1` } : {}),
      lastActivityAt: now, updatedAt: now,
    })
    .where(and(
      eq(enrichmentSessions.id, sessionId), eq(enrichmentSessions.ownerId, ownerId),
      eq(enrichmentSessions.status, "active"), eq(enrichmentSessions.questionsAnswered, etapaEsperada),
    ));
  if (((r as any)?.affectedRows ?? 0) === 0) return null;

  return { questionsAnswered };
}

export async function createEnrichmentSession(ownerId: string, contactId: number, etapaInicial = 0): Promise<string> {
  const db = await exigirDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(enrichmentSessions).values({ id, ownerId, contactId, status: "active", questionsAnswered: etapaInicial, questionsSkipped: 0, lastActivityAt: now, createdAt: now, updatedAt: now });
  // Atualizar enrichment_status no contato
  await db.update(privateContacts).set({ enrichmentStatus: "active" }).where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)));
  return id;
}

/**
 * As perguntas do Chat de Enriquecimento que o contato já tem respondidas
 * (T45, 24/11: o chat perguntava de novo o que a ficha já tinha). Os nomes são
 * os do roteiro (server/enrichment-flow.ts): "phone" (o telefone ou o
 * WhatsApp), "company", "assets" e "needs" (ao menos um item no possui ou no
 * procura), "how_met" (a anotação "Como se conheceram:" que o chat grava, ou
 * um contexto ligado) e "relationship_type" (a anotação "Relacionamento:").
 * Só do contato da dona; o contato de outra dona, ou apagado, não tem nada.
 */
export async function camposPreenchidosDoContato(ownerId: string, contactId: number): Promise<string[]> {
  const db = await exigirDb();
  const [contato] = await db.select({ phone: privateContacts.phone, whatsapp: privateContacts.whatsapp, company: privateContacts.company, notes: privateContacts.notes })
    .from(privateContacts).where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId))).limit(1);
  if (!contato) return [];
  const [possui] = await db.select({ id: contactAssets.id }).from(contactAssets)
    .where(and(eq(contactAssets.ownerId, ownerId), eq(contactAssets.contactId, contactId))).limit(1);
  const [procura] = await db.select({ id: contactNeeds.id }).from(contactNeeds)
    .where(and(eq(contactNeeds.ownerId, ownerId), eq(contactNeeds.contactId, contactId))).limit(1);
  const [contexto] = await db.select({ id: contactContexts.id }).from(contactContexts)
    .where(and(eq(contactContexts.ownerId, ownerId), eq(contactContexts.contactId, contactId))).limit(1);
  const preenchido = (valor: string | null | undefined) => !!valor && valor.trim().length > 0;
  const notas = contato.notes ?? "";
  const campos: string[] = [];
  if (preenchido(contato.phone) || preenchido(contato.whatsapp)) campos.push("phone");
  if (preenchido(contato.company)) campos.push("company");
  if (possui) campos.push("assets");
  if (procura) campos.push("needs");
  if (notas.includes("Como se conheceram:") || contexto) campos.push("how_met");
  if (notas.includes("Relacionamento:")) campos.push("relationship_type");
  return campos;
}

export async function getEnrichmentMessages(sessionId: string, ownerId: string, limit = 10) {
  const db = await exigirDb();
  return db.select().from(enrichmentMessages)
    .where(and(eq(enrichmentMessages.sessionId, sessionId), eq(enrichmentMessages.ownerId, ownerId)))
    // Da mais nova para a mais velha. No MESMO instante (a resposta de "não
    // sei" e a pergunta seguinte são gravadas em sequência e podem empatar em
    // created_at), a da usuária vem antes da resposta da IA na conversa —
    // aqui, em ordem decrescente, a da IA primeiro. Sem o desempate a ordem
    // dependia do plano do banco e a conversa podia reabrir trocada.
    .orderBy(desc(enrichmentMessages.createdAt), desc(sql`CASE WHEN ${enrichmentMessages.role} = 'user' THEN 0 ELSE 1 END`))
    .limit(limit);
}

export async function saveEnrichmentMessage(data: {
  sessionId: string; ownerId: string; role: string; content: string; metadata?: unknown; tokenCount?: number;
  /** Quando a mensagem aconteceu, se não for agora (a resposta da usuária é gravada depois de a IA responder, mas veio antes). */
  createdAt?: number;
}): Promise<string> {
  const db = await exigirDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(enrichmentMessages).values({ id, sessionId: data.sessionId, ownerId: data.ownerId, role: data.role, content: data.content, metadata: data.metadata ?? null, tokenCount: data.tokenCount ?? null, createdAt: data.createdAt ?? now, updatedAt: now });
  // Atualizar last_activity_at da sessão
  await db.update(enrichmentSessions).set({ lastActivityAt: now, updatedAt: now }).where(eq(enrichmentSessions.id, data.sessionId));
  return id;
}

export async function saveEnrichmentSuggestions(suggestions: Array<{
  sessionId: string; messageId: string; ownerId: string; contactId: number;
  fieldType: string; suggestedValue: string; confidence: number; tagIsNew?: boolean; tagId?: string;
}>): Promise<string[]> {
  const db = await exigirDb();
  const ids: string[] = [];
  const now = Date.now();
  // Os N cartões de uma etapa de lista nascem na ordem em que a IA os listou;
  // com o mesmo created_at, reabrir o contato os devolvia em ordem qualquer.
  // Um milissegundo por posição preserva a ordem sem mais uma coluna.
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const id = crypto.randomUUID();
    await db.insert(enrichmentSuggestions).values({ id, sessionId: s.sessionId, messageId: s.messageId, ownerId: s.ownerId, contactId: s.contactId, fieldType: s.fieldType, suggestedValue: s.suggestedValue, confidence: String(s.confidence), status: "pending", tagIsNew: s.tagIsNew ?? false, tagId: s.tagId ?? null, createdAt: now + i, updatedAt: now + i });
    ids.push(id);
  }
  return ids;
}

export async function getEnrichmentSuggestion(id: string, ownerId: string) {
  const db = await exigirDb();
  const [row] = await db.select().from(enrichmentSuggestions)
    .where(and(eq(enrichmentSuggestions.id, id), eq(enrichmentSuggestions.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/**
 * Grava no contato a resposta que a usuária confirmou no chat de enriquecimento.
 *
 * Cada tipo de resposta tem um destino, e "assets" e "needs" são os que mais
 * importam: caem em contact_assets/contact_needs, que é de onde o Cruzamento
 * Inteligente lê. É isto que torna o chat o caminho automático de alimentar o
 * match — a pessoa conversa, e o possui/procura do contato se preenche sozinho.
 *
 * A versão anterior deste código marcava tudo como "applied" e só gravava os
 * campos simples de perfil (telefone, empresa...). assets, needs, how_met e
 * relationship_type não estavam no mapa e eram jogados fora em silêncio — 18
 * respostas confirmadas se perderam assim, e scripts/recuperar-enriquecimento.mjs
 * existe para reaplicá-las. A ordem também importava e estava errada: o status
 * virava "applied" ANTES de qualquer escrita, então uma falha na escrita deixava
 * a sugestão mentindo que foi aplicada. Agora grava primeiro, marca depois.
 */
export async function applyEnrichmentSuggestion(id: string, ownerId: string, editedValue?: string): Promise<boolean> {
  const db = await exigirDb();
  const sug = await getEnrichmentSuggestion(id, ownerId);
  if (!sug || sug.status !== "pending") return false;
  const finalValue = (editedValue ?? sug.suggestedValue).trim();
  const now = Date.now();

  // O snapshot nasce ANTES da escrita (é o valor que a escrita vai cobrir) e
  // vai para o banco no MESMO UPDATE que marca "applied": sugestão aplicada
  // sem snapshot é, por definição, uma que não dá para desfazer.
  let undoSnapshot: UndoSnapshot | null = null;
  await aplicarRespostaAoContato(db, ownerId, sug.contactId, sug.fieldType, finalValue, now, s => { undoSnapshot = s; });

  // Só marca o que AINDA está pendente: duas confirmações concorrentes do
  // mesmo cartão passam as duas pela leitura acima, e a segunda regravaria o
  // retrato com "anterior = o valor já aplicado" (ou inseriu:false) por cima
  // do bom — e desfazer não voltaria a nada. A segunda não pega linha e o
  // router responde NOT_FOUND, que a tela já trata recarregando a conversa.
  const [r] = await db.update(enrichmentSuggestions)
    .set({ status: "applied", appliedValue: finalValue, undoSnapshot, actionedAt: now, actionedBy: "user", updatedAt: now })
    .where(and(eq(enrichmentSuggestions.id, id), eq(enrichmentSuggestions.ownerId, ownerId), eq(enrichmentSuggestions.status, "pending")));
  return ((r as any)?.affectedRows ?? 0) > 0;
}

/**
 * O que "Desfazer" precisa saber para reverter uma resposta aplicada, por tipo
 * de destino. É gravado em enrichment_suggestions.undo_snapshot na confirmação.
 */
export type UndoSnapshot =
  | { kind: "campo"; coluna: string; anterior: string | null; aplicado: string }
  | { kind: "tag"; tabela: "contact_assets" | "contact_needs"; inseriu: boolean; linhaId: number | null; slug: string; rotulo: string }
  // contextoId é null quando a resposta não correspondeu a contexto nenhum e
  // ficou só na nota. Os retratos gravados antes disso trazem o id e o
  // contextoCriado true; o desfazer lê os dois formatos (só usa linhaDeNota e
  // vinculoId), então nada precisa ser migrado.
  // contextoCriadoPelaDona: o contexto nasceu do "Criar" explícito da dona na
  // pergunta "Criar o contexto X?" (criarContextoOferecido). É marca separada de
  // propósito: contextoCriado true identifica os contextos-frase do defeito
  // antigo, que o script de limpeza apaga.
  | { kind: "how_met"; linhaDeNota: string | null; contextoId: string | null; contextoCriado: boolean; vinculoId: string | null; contextoCriadoPelaDona?: boolean }
  | { kind: "nota"; linhaDeNota: string | null };

// Colunas simples do perfil que o chat preenche. A chave é o field_type da
// sugestão; o valor é a coluna do drizzle (para ler o valor anterior) e o nome
// da propriedade (para o UPDATE).
const COLUNAS_SIMPLES = {
  phone: privateContacts.phone, whatsapp: privateContacts.whatsapp, email: privateContacts.email,
  company: privateContacts.company, jobTitle: privateContacts.jobTitle, city: privateContacts.city,
  country: privateContacts.country, linkedinUrl: privateContacts.linkedinUrl,
  instagram: privateContacts.instagram,
} as const;
type ColunaSimples = keyof typeof COLUNAS_SIMPLES;

/**
 * A chave de comparação de nome de contexto. Mínima de propósito: espaços das
 * pontas fora, espaço interno repetido colapsado, e a normalização CENTRAL do
 * projeto (`normalizar`, de shared/direcao-do-termo — a mesma que slugifyMatchTag
 * usa) para caixa e acento. Nada além disso: "Feira de Milão" e "Feira de Bolonha"
 * são contextos DIFERENTES, e aproximar frases parecidas seria reintroduzir o
 * defeito por outro caminho.
 *
 * A comparação é feita em JS, não no WHERE, por dois motivos: a igualdade do
 * MySQL depende da collation da coluna (que `contexts` não declara, então herda
 * a do servidor, e produção e CI não rodam o mesmo motor), e a alternativa de
 * empurrar a normalização para o SQL exigiria `sql.raw` (proibido) ou coluna
 * nova (migração, fora do escopo).
 */
export function chaveDoNomeDeContexto(nome: string) {
  return normalizar(nome.trim().replace(/\s+/g, " "));
}

/**
 * O contexto que corresponde a este nome, ou undefined. Ponto único de busca de
 * contexto POR NOME: quem precisar oferecer a criação explícita para a dona
 * pergunta aqui primeiro, em vez de repetir a comparação.
 *
 * Enxerga o catálogo global (ownerId null) além dos contextos da própria dona —
 * senão uma resposta como "CPHI" ignoraria o contexto global homônimo. Havendo
 * os dois, o da dona vence, como antes.
 */
async function acharContextoPeloNome(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ownerId: string,
  nome: string,
): Promise<string | undefined> {
  const chave = chaveDoNomeDeContexto(nome);
  if (!chave) return undefined;
  const candidatos = await db.select({ id: contexts.id, name: contexts.name, ownerId: contexts.ownerId })
    .from(contexts)
    .where(drizzleOr(eq(contexts.ownerId, ownerId), isNull(contexts.ownerId)))
    .orderBy(desc(contexts.ownerId));
  return candidatos.find(c => chaveDoNomeDeContexto(c.name) === chave)?.id;
}

/**
 * O destino de cada resposta. Devolve true quando gravou e false quando não
 * havia nada a fazer (valor vazio, item já existente, linha já anotada) — é o
 * que deixa o script de recuperação relatar a verdade em vez de contar de novo
 * o que já estava lá. Exportada porque o script replays as respostas antigas
 * por aqui — mesmo caminho, mesma de-duplicação.
 *
 * `registrarSnapshot`, quando dado, recebe o retrato do que a escrita vai
 * cobrir (valor anterior do campo, id da tag inserida, linha de nota...), ANTES
 * de gravar — é o que undoEnrichmentSuggestion usa para reverter. Parâmetro
 * opcional e final de propósito: o script de recuperação e os chamadores
 * antigos continuam com a mesma assinatura e o mesmo boolean.
 */
export async function aplicarRespostaAoContato(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  ownerId: string,
  contactId: number,
  fieldType: string,
  valor: string,
  now: number,
  registrarSnapshot?: (s: UndoSnapshot) => void,
): Promise<boolean> {
  if (!valor || !valor.trim()) return false;

  // Contato apagado no meio da conversa não pode voltar a existir em pedaços:
  // sem esta guarda, a resposta confirmada depois da exclusão recriava
  // possui/procura órfãos — combustível novo para match fantasma.
  const [contatoVivo] = await db.select({ id: privateContacts.id }).from(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)))
    .limit(1);
  if (!contatoVivo) return false;

  // ── campos simples do perfil do contato ────────────────────────────────────
  const fieldMap: Record<string, ColunaSimples> = {
    phone: "phone", whatsapp: "whatsapp", email: "email",
    company: "company", job_title: "jobTitle", city: "city",
    country: "country", linkedin_url: "linkedinUrl",
    // A coluna chama-se `instagram`; o mapa antigo apontava para uma coluna
    // inexistente e a primeira sugestão de instagram confirmada quebraria aqui.
    instagram_handle: "instagram",
  };
  const dbField = fieldMap[fieldType];
  if (dbField) {
    if (registrarSnapshot) {
      // O valor que vai ser coberto: sem ele, "desfazer" não teria para onde voltar.
      const [linha] = await db.select({ atual: COLUNAS_SIMPLES[dbField] }).from(privateContacts)
        .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)))
        .limit(1);
      const anterior = linha?.atual;
      registrarSnapshot({ kind: "campo", coluna: dbField, anterior: anterior == null ? null : String(anterior), aplicado: valor });
    }
    await db.update(privateContacts).set({ [dbField]: valor, updatedAt: now } as any)
      .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)));
    return true;
  }

  // ── o que o contato possui / procura: o combustível do cruzamento ──────────
  if (fieldType === "assets" || fieldType === "needs") {
    const tabela = fieldType === "assets" ? contactAssets : contactNeeds;
    const nomeDaTabela = fieldType === "assets" ? "contact_assets" : "contact_needs";
    const slug = slugifyMatchTag(valor);
    if (!slug) return false;
    // Confirmar duas vezes a mesma resposta não pode duplicar o item — as
    // sugestões antigas têm repetição real ("fabrica" cinco vezes no mesmo
    // contato) e o script de recuperação passa por aqui. Compara pelo slug OU
    // pelo rótulo: linha gravada antes do conserto da escrita não latina tem
    // tag_slug "" (e "Nº 5" tinha "n-5", hoje "no-5") — só o rótulo a reconhece.
    const [existente] = await db.select({ id: tabela.id }).from(tabela)
      .where(and(
        eq(tabela.ownerId, ownerId), eq(tabela.contactId, contactId),
        drizzleOr(eq(tabela.tagSlug, slug), eq(tabela.tagLabel, valor)),
      ))
      .limit(1);
    if (existente) {
      // Já estava lá antes da confirmação: desfazer não pode apagar o que a
      // dona (ou outra resposta) já tinha registrado.
      registrarSnapshot?.({ kind: "tag", tabela: nomeDaTabela, inseriu: false, linhaId: existente.id, slug, rotulo: valor });
      return false;
    }
    const [inserido] = await db.insert(tabela).values({
      ownerId, contactId, tagSlug: slug, tagLabel: valor, createdAt: now, updatedAt: now,
    });
    const linhaId = Number((inserido as any)?.insertId);
    registrarSnapshot?.({ kind: "tag", tabela: nomeDaTabela, inseriu: true, linhaId: Number.isFinite(linhaId) && linhaId > 0 ? linhaId : null, slug, rotulo: valor });
    return true;
  }

  // ── como se conheceram: anotação + contexto de verdade (etapa 5) ───────────
  if (fieldType === "how_met") {
    const linha = `Como se conheceram: ${valor}`;
    const [contato] = await db.select({ notes: privateContacts.notes }).from(privateContacts)
      .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)))
      .limit(1);
    if (!contato) return false;

    let gravouNota = false;
    if (!contato.notes?.includes(linha)) {
      const notas = contato.notes ? `${contato.notes}
${linha}` : linha;
      await db.update(privateContacts).set({ notes: notas, updatedAt: now })
        .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)));
      gravouNota = true;
    }

    // A resposta LIGA o contato a um contexto que JÁ EXISTE; ela nunca inventa
    // um. O PR #29 usava `valor.slice(0, 100)` como nome de contexto novo, e
    // com isso "Fomos apresentadas por uma amiga em comum" virava um item na
    // tela de Contextos como se a dona o tivesse criado — cada variação da
    // mesma frase gerando outro. Sem correspondência a resposta fica só na
    // nota acima; propor um contexto novo é decisão da dona, pelo fluxo
    // explícito de criação (contexts.create), nunca efeito colateral do chat.
    // Vale igual para o reprocessamento em lote
    // (scripts/recuperar-enriquecimento.ts), que passa por aqui: ele completa
    // vínculo com contexto existente e não cria nenhum.
    const idContexto = await acharContextoPeloNome(db, ownerId, valor);
    let vinculoId: string | null = null;
    if (idContexto) {
      const [vinculoExistente] = await db.select({ id: contactContexts.id }).from(contactContexts)
        .where(and(
          eq(contactContexts.ownerId, ownerId),
          eq(contactContexts.contactId, contactId),
          eq(contactContexts.contextId, idContexto),
        ))
        .limit(1);
      if (!vinculoExistente) {
        vinculoId = crypto.randomUUID();
        await db.insert(contactContexts).values({
          id: vinculoId, ownerId, contactId, contextId: idContexto,
          relationshipType: "profissional", visibility: "private", createdAt: now, updatedAt: now,
        });
      }
    }
    // `contextoCriado` continua no retrato por compatibilidade: os snapshots
    // gravados antes desta mudança têm o campo, e undoEnrichmentSuggestion lê
    // os antigos e os novos pelo mesmo caminho. Daqui para a frente é sempre
    // false — este ponto não cria mais contexto.
    registrarSnapshot?.({ kind: "how_met", linhaDeNota: gravouNota ? linha : null, contextoId: idContexto ?? null, contextoCriado: false, vinculoId });
    return gravouNota || vinculoId !== null;
  }

  // ── tipo de relacionamento: vai para as anotações do contato ───────────────
  if (fieldType === "relationship_type") {
    const linha = `Relacionamento: ${valor}`;
    const [contato] = await db.select({ notes: privateContacts.notes }).from(privateContacts)
      .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)))
      .limit(1);
    if (!contato) return false;
    if (contato.notes?.includes(linha)) {
      registrarSnapshot?.({ kind: "nota", linhaDeNota: null });
      return false;
    }
    const notas = contato.notes ? `${contato.notes}
${linha}` : linha;
    registrarSnapshot?.({ kind: "nota", linhaDeNota: linha });
    await db.update(privateContacts).set({ notes: notas, updatedAt: now })
      .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId)));
    return true;
  }

  // Tipo desconhecido: não há onde gravar, e fingir que gravou é o defeito que
  // este código existe para não repetir.
  throw new Error(`Tipo de resposta sem destino: ${fieldType}`);
}

export type ResultadoDoContextoOferecido =
  | { resultado: "indisponivel" }
  | { resultado: "criado" | "ja_existia"; contextoId: string; nome: string };

/**
 * O "Criar" da pergunta "Criar o contexto X?" do chat de enriquecimento. Só é
 * chamada pela confirmação explícita da dona (enrichment.createSuggestedContext):
 * nenhum outro caminho cria contexto a partir de resposta do chat.
 *
 * O nome é o que a sugestão aplicou, relido aqui, nunca um texto vindo da tela.
 * Procura de novo antes de criar: se o contexto passou a existir enquanto a
 * pergunta estava aberta (outra aba, tela de Contextos), só vincula. O retrato
 * do desfazer ganha o contexto e o vínculo; desfazer tira o vínculo e o contexto
 * fica, como no caso de contexto existente. `contextoCriado` continua false.
 */
export async function criarContextoOferecido(suggestionId: string, ownerId: string): Promise<ResultadoDoContextoOferecido> {
  const db = await exigirDb();
  const sug = await getEnrichmentSuggestion(suggestionId, ownerId);
  const nome = contextoParaOferecer(sug);
  if (!sug || !nome) return { resultado: "indisponivel" };
  const retrato = sug.undoSnapshot as Extract<UndoSnapshot, { kind: "how_met" }>;

  const [contatoVivo] = await db.select({ id: privateContacts.id }).from(privateContacts)
    .where(and(eq(privateContacts.id, sug.contactId), eq(privateContacts.ownerId, ownerId)))
    .limit(1);
  if (!contatoVivo) return { resultado: "indisponivel" };

  const now = Date.now();
  let contextoId = await acharContextoPeloNome(db, ownerId, nome);
  const criado = !contextoId;
  if (!contextoId) {
    contextoId = crypto.randomUUID();
    await db.insert(contexts).values({
      id: contextoId, ownerId, contextTypeId: null, name: nome,
      isCustom: true, visibility: "private", createdAt: now, updatedAt: now,
    });
  }

  const [vinculoExistente] = await db.select({ id: contactContexts.id }).from(contactContexts)
    .where(and(
      eq(contactContexts.ownerId, ownerId),
      eq(contactContexts.contactId, sug.contactId),
      eq(contactContexts.contextId, contextoId),
    ))
    .limit(1);
  let vinculoId: string | null = null;
  if (!vinculoExistente) {
    vinculoId = crypto.randomUUID();
    await db.insert(contactContexts).values({
      id: vinculoId, ownerId, contactId: sug.contactId, contextId: contextoId,
      relationshipType: "profissional", visibility: "private", createdAt: now, updatedAt: now,
    });
  }

  const novoRetrato: UndoSnapshot = { ...retrato, contextoId, vinculoId, contextoCriado: false, contextoCriadoPelaDona: criado };
  await db.update(enrichmentSuggestions)
    .set({ undoSnapshot: novoRetrato, updatedAt: now })
    .where(and(
      eq(enrichmentSuggestions.id, suggestionId),
      eq(enrichmentSuggestions.ownerId, ownerId),
      eq(enrichmentSuggestions.status, "applied"),
    ));

  return { resultado: criado ? "criado" : "ja_existia", contextoId, nome };
}

// Tira a linha exata que o chat acrescentou às anotações (e só ela). Devolve
// undefined quando a linha não está mais lá — a dona já a apagou à mão.
function semALinhaDeNota(notes: string | null, linha: string): string | null | undefined {
  const partes = (notes ?? "").split("\n");
  const indice = partes.indexOf(linha);
  if (indice === -1) return undefined;
  partes.splice(indice, 1);
  return partes.length ? partes.join("\n") : null;
}

export type ResultadoDoDesfazer =
  | { resultado: "nao_encontrada" }
  /** Já estava desfeita (pela dona, antes; ou por outra aba, agora). */
  | { resultado: "ja_desfeita" }
  /** Ignorada, ou aplicada antes de existir o retrato: não há o que reverter. */
  | { resultado: "indisponivel" }
  | { resultado: "desfeita"; kind: UndoSnapshot["kind"]; fieldType: string; reverted: boolean; motivo: "valor_alterado_depois" | null };

/**
 * Reverte o que uma sugestão aplicada gravou no contato, usando o snapshot da
 * confirmação, e marca a sugestão como "undone".
 *
 * Reverter é voltar ao retrato de antes, nunca apagar o que a dona fez depois:
 * um campo só volta ao valor anterior se ainda tem o valor que a IA aplicou
 * (se a dona o editou depois, fica como está e a sugestão só muda de status);
 * uma tag só sai se foi ESTA confirmação que a inseriu; uma nota perde só a
 * linha exata acrescentada; o vínculo com o contexto some, o contexto fica.
 * A escrita vem antes da marcação (como no aplicar): o status nunca diz
 * "desfeito" sobre um dado que continua aplicado.
 */
export async function undoEnrichmentSuggestion(id: string, ownerId: string): Promise<ResultadoDoDesfazer> {
  const db = await exigirDb();
  const sug = await getEnrichmentSuggestion(id, ownerId);
  if (!sug) return { resultado: "nao_encontrada" };
  // Já desfeita tem resposta própria: a tela mostra o botão de uma lista
  // desatualizada e precisa ouvir "já tinha sido desfeita" (e recarregar o
  // histórico), não um erro genérico com o botão ainda ligado.
  if (sug.status === "undone") return { resultado: "ja_desfeita" };
  const snapshot = sug.undoSnapshot as UndoSnapshot | null;
  if (sug.status !== "applied" || !snapshot || typeof snapshot !== "object" || !("kind" in snapshot)) {
    return { resultado: "indisponivel" };
  }
  const now = Date.now();
  const contactId = sug.contactId;
  const doContato = and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId));
  let reverted = true;
  let motivo: "valor_alterado_depois" | null = null;

  if (snapshot.kind === "campo") {
    const coluna = COLUNAS_SIMPLES[snapshot.coluna as ColunaSimples];
    if (!coluna) return { resultado: "indisponivel" };
    const [linha] = await db.select({ atual: coluna }).from(privateContacts).where(doContato).limit(1);
    const atual = linha?.atual == null ? null : String(linha.atual);
    if (atual === snapshot.aplicado) {
      await db.update(privateContacts).set({ [snapshot.coluna]: snapshot.anterior, updatedAt: now } as any).where(doContato);
    } else {
      reverted = false;
      motivo = "valor_alterado_depois";
    }
  } else if (snapshot.kind === "tag") {
    if (snapshot.inseriu && snapshot.linhaId != null) {
      const tabela = snapshot.tabela === "contact_assets" ? contactAssets : contactNeeds;
      await db.delete(tabela).where(and(
        eq(tabela.id, snapshot.linhaId), eq(tabela.ownerId, ownerId), eq(tabela.contactId, contactId),
      ));
    }
  } else if (snapshot.kind === "how_met" || snapshot.kind === "nota") {
    if (snapshot.linhaDeNota) {
      const [contato] = await db.select({ notes: privateContacts.notes }).from(privateContacts).where(doContato).limit(1);
      const notas = contato ? semALinhaDeNota(contato.notes, snapshot.linhaDeNota) : undefined;
      if (notas !== undefined) {
        await db.update(privateContacts).set({ notes: notas, updatedAt: now }).where(doContato);
      }
    }
    if (snapshot.kind === "how_met" && snapshot.vinculoId) {
      await db.delete(contactContexts).where(and(
        eq(contactContexts.id, snapshot.vinculoId), eq(contactContexts.ownerId, ownerId), eq(contactContexts.contactId, contactId),
      ));
    }
  }

  const [r] = await db.update(enrichmentSuggestions)
    .set({ status: "undone", actionedAt: now, actionedBy: "user", updatedAt: now })
    .where(and(eq(enrichmentSuggestions.id, id), eq(enrichmentSuggestions.ownerId, ownerId), eq(enrichmentSuggestions.status, "applied")));
  // Outra aba desfez no meio do caminho: as reversões acima são idempotentes
  // (mesmo retrato), e quem chegou depois ouve "já tinha sido desfeita".
  if (((r as any)?.affectedRows ?? 0) === 0) return { resultado: "ja_desfeita" };
  return { resultado: "desfeita", kind: snapshot.kind, fieldType: sug.fieldType, reverted, motivo };
}

export async function ignoreEnrichmentSuggestion(id: string, ownerId: string): Promise<boolean> {
  const db = await exigirDb();
  const now = Date.now();
  const [r] = await db.update(enrichmentSuggestions)
    .set({ status: "ignored", actionedAt: now, actionedBy: "user", updatedAt: now })
    .where(and(eq(enrichmentSuggestions.id, id), eq(enrichmentSuggestions.ownerId, ownerId), eq(enrichmentSuggestions.status, "pending")));
  return (r as any).affectedRows > 0;
}

export async function completeEnrichmentSession(sessionId: string, ownerId: string, summary: string): Promise<boolean> {
  const db = await exigirDb();
  const session = await getEnrichmentSessionById(sessionId, ownerId);
  if (!session) return false;
  // Encerramento idempotente: uma sessão já concluída não gera efeitos colaterais nem mensagens extras.
  if (session.status === "completed") return true;
  if (session.status !== "active") return false;
  const now = Date.now();
  const [r] = await db.update(enrichmentSessions)
    .set({ status: "completed", summary, completedAt: now, updatedAt: now })
    .where(and(eq(enrichmentSessions.id, sessionId), eq(enrichmentSessions.ownerId, ownerId), eq(enrichmentSessions.status, "active")));
  if ((r as any).affectedRows > 0) {
    // Atualizar status no contato
    const [sess] = await db.select().from(enrichmentSessions).where(eq(enrichmentSessions.id, sessionId)).limit(1);
    if (sess) {
      await db.update(privateContacts).set({ enrichmentStatus: "completed" })
        .where(and(eq(privateContacts.id, sess.contactId), eq(privateContacts.ownerId, ownerId)));
    }
  }
  return (r as any).affectedRows > 0;
}

/**
 * Sugestões da sessão que ainda esperam a decisão da dona. É o que permite
 * fechar e reabrir o detalhe do contato e encontrar o cartão onde estava:
 * antes, o cartão só existia no estado da tela, e getEnrichmentHistory lista,
 * de propósito, só o que já foi decidido (applied/ignored/undone).
 */
export async function getPendingEnrichmentSuggestions(sessionId: string, ownerId: string) {
  const db = await exigirDb();
  return db.select().from(enrichmentSuggestions)
    .where(and(eq(enrichmentSuggestions.sessionId, sessionId), eq(enrichmentSuggestions.ownerId, ownerId), eq(enrichmentSuggestions.status, "pending")))
    // Todas, da mais nova para a mais velha: o router decide, pela ETAPA da
    // sessão, qual é a da vez (bloqueia e vira cartão) e quais são órfãs de
    // etapa anterior (o defeito antigo deixou sessões com mais de uma).
    .orderBy(desc(enrichmentSuggestions.createdAt));
}

export async function getEnrichmentHistory(ownerId: string, contactId: number, limit = 20, offset = 0) {
  const db = await exigirDb();
  const rows = await db.select().from(enrichmentSuggestions)
    .where(and(eq(enrichmentSuggestions.ownerId, ownerId), eq(enrichmentSuggestions.contactId, contactId), sql`${enrichmentSuggestions.status} IN ('applied', 'ignored', 'undone')`))
    .orderBy(desc(enrichmentSuggestions.createdAt))
    .limit(limit).offset(offset);
  const [c] = await db.select({ count: sql<number>`COUNT(*)` }).from(enrichmentSuggestions)
    .where(and(eq(enrichmentSuggestions.ownerId, ownerId), eq(enrichmentSuggestions.contactId, contactId), sql`${enrichmentSuggestions.status} IN ('applied', 'ignored', 'undone')`));
  // A tela só precisa saber SE dá para desfazer; o retrato em si (valor
  // anterior de telefone, e-mail...) é dado do contato e fica no servidor.
  const data = rows.map(({ undoSnapshot, ...resto }) => ({
    ...resto,
    podeDesfazer: resto.status === "applied" && undoSnapshot != null,
  }));
  return { data, total: Number(c?.count ?? 0) };
}
