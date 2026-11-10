import { rotaDaReuniao } from "@shared/rotas";

type Fonte = { sourceType: string; metadata: Record<string, unknown> };

/**
 * Para onde o "Abrir fonte" da Memória leva. Reunião abre o próprio detalhe
 * pelo `meetingId`, que todo documento de reunião guarda: o href gravado nos
 * documentos indexados antes de esta mudança entrar no ar é a lista (/meetings)
 * e só muda quando a reunião é indexada de novo. As outras fontes seguem o href
 * gravado.
 */
export function destinoDaFonte(fonte: Fonte): string | null {
  const { meetingId, href } = fonte.metadata;
  if (fonte.sourceType === "meeting" && typeof meetingId === "string" && meetingId) return rotaDaReuniao(meetingId);
  return typeof href === "string" && href ? href : null;
}
