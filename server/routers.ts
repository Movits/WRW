import { systemRouter } from "./_core/systemRouter";
import { router } from "./_core/trpc";
import { authRouter } from "./routers/auth";
import { contaRouter } from "./routers/conta";
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

// ============================================================
// ROUTER PRINCIPAL — cada área vive em server/routers/<área>.ts
// ============================================================
export const appRouter = router({
  system: systemRouter,
  dealRoom: dealRoomRouter,
  sivc: sivcRouter,
  auth: authRouter,
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
});

export type AppRouter = typeof appRouter;
