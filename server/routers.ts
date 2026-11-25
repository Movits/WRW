import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import { authRouter } from "./routers/auth";
import { chavesDeAcessoRouter } from "./routers/chavesDeAcesso";
import { contaRouter } from "./routers/conta";
import { contaGoogleRouter } from "./routers/contaGoogle";
import { profileRouter } from "./routers/profile";
import { opportunitiesRouter } from "./routers/opportunities";
import { notificationsRouter } from "./routers/notifications";
import { vaultRouter } from "./routers/vault";
import { adminRouter } from "./routers/admin";
import { profileMatchesRouter } from "./routers/profileMatches";
import { connectionsRouter } from "./routers/connections";
import { presidentRouter } from "./routers/president";
import { matchingRouter } from "./routers/matching";
import { faqRouter } from "./routers/faq";
import { statsRouter } from "./routers/stats";
import { consentRouter } from "./routers/consent";
import { networkRouter } from "./routers/network";
import { contextsRouter } from "./routers/contexts";
import { enrichmentRouter } from "./routers/enrichment";
import { dealRoomRouter } from "./routers/dealRoom";
import { sivcRouter } from "./routers/sivc";
import { meetingsRouter } from "./routers/meetings";
import { reuniaoAbertaRouter } from "./routers/reuniaoAberta";
import { memoryRouter } from "./routers/memory";
import { intelligentMatchesRouter } from "./routers/matches";
import { distribuicaoRouter } from "./routers/distribuicao";
import { networkInteligenteRouter } from "./routers/networkInteligente";
import { assistenteTextoRouter } from "./routers/assistenteTexto";
import { proximasAcoesRouter } from "./routers/proximasAcoes";
import { agendaRouter } from "./routers/agenda";
import { equipesRouter } from "./routers/equipes";
import { googleAgendaRouter } from "./routers/googleAgenda";
import { perguntasEntreReunioesRouter } from "./routers/perguntasEntreReunioes";
import { consultaDeReunioesRouter } from "./routers/consultaDeReunioes";
import { perfilDeVozRouter } from "./routers/perfilDeVoz";

// ============================================================
// ROUTER PRINCIPAL — cada área vive em server/routers/<área>.ts
// ============================================================
export const appRouter = router({
  system: systemRouter,
  dealRoom: dealRoomRouter,
  sivc: sivcRouter,
  auth: authRouter,
  // Entrar com Face ID ou digital (chaves de acesso, A6): server/chaves-de-acesso.ts.
  chavesDeAcesso: chavesDeAcessoRouter,
  // Entrar com a conta Google (A8): server/entrar-com-google.ts.
  contaGoogle: contaGoogleRouter,
  conta: contaRouter,
  profile: profileRouter,
  opportunities: opportunitiesRouter,
  notifications: notificationsRouter,
  vault: vaultRouter,
  admin: adminRouter,
  matches: profileMatchesRouter,
  connections: connectionsRouter,
  president: presidentRouter,
  matching: matchingRouter,
  faq: faqRouter,
  stats: statsRouter,
  consent: consentRouter,
  network: networkRouter,
  contexts: contextsRouter,
  enrichment: enrichmentRouter,
  meetings: meetingsRouter,
  // O link aberto da reunião: público, sem sessão (12/11/2026).
  reuniaoAberta: reuniaoAbertaRouter,
  memory: memoryRouter,
  intelligentMatches: intelligentMatchesRouter,
  distribuicao: distribuicaoRouter,
  networkInteligente: networkInteligenteRouter,
  // "Gravar áudio" e "Revisar texto" dos campos livres (cadastro, Perfil, oportunidade).
  assistenteTexto: assistenteTextoRouter,
  // As próximas ações da dona (H5a): o que ela confirmou nos resumos e o que anotou.
  proximasAcoes: proximasAcoesRouter,
  // A agenda de reuniões (H16a): marcar, convidar e o "Gravar agora".
  agenda: agendaRouter,
  // A conexão com a Google Agenda (H16b): o estado e o desconectar. Conectar
  // é navegação (server/rotas-da-google-agenda.ts).
  googleAgenda: googleAgendaRouter,
  // O Pergunte a várias reuniões (H6c): escolher por etiqueta ou uma a uma, perguntar e avaliar.
  perguntasEntreReunioes: perguntasEntreReunioesRouter,
  // Os espaços de equipe (R2): a pasta com membras, as reuniões, as tarefas e a agenda da equipe.
  equipes: equipesRouter,
  // A consulta das reuniões pela administração (R1a): só admin e presidente, com motivo e auditoria.
  consultaDeReunioes: consultaDeReunioesRouter,
  // O perfil de voz da dona (H3d): gravar, ouvir, regravar e desligar, com o consentimento próprio.
  perfilDeVoz: perfilDeVozRouter,
});

export type AppRouter = typeof appRouter;
