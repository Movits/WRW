import { descreverErroDeBanco } from "./banco-indisponivel";
import { limparGravacoesVencidas, type ResultadoDaVarredura } from "./meeting-service";
import { createAuditLog } from "./security";

/**
 * O laço que cumpre o prazo do áudio das reuniões (30 dias, MEETING_AUDIO_TTL_MS
 * em meeting-service.ts): uma passada de limparGravacoesVencidas no boot e outra
 * 5 min depois do fim de cada passada, no próprio processo.
 *
 * Antes dele, nada chamava a varredura: o endpoint de cron
 * (/api/scheduled/cleanup-recordings) nunca teve agendador, e o áudio só saía
 * quando a dona reabria a reunião, enquanto o aviso de gravação promete que ele
 * expira em 30 dias. A promessa é sobre a voz de TODAS as participantes, que não
 * têm login e não vão reabrir a reunião.
 *
 * - Boot: a primeira passada começa na hora e não é aguardada, então a subida
 *   não espera o bucket. Uma por vez: a seguinte só é agendada quando a
 *   anterior termina, e um bucket lento nunca põe duas passadas juntas.
 * - No plano Free do Render a instância dorme sem tráfego, e o laço dorme com
 *   ela: o áudio vencido sai na passada do boot seguinte, quando ela acorda.
 * - Sem STORAGE_BUCKET (dev com banco e sem bucket) não há o que apagar: a
 *   passada é pulada, em vez de deixar cada áudio vencido como aviso no log.
 * - Toda passada que apagou algo vai para a auditoria (CRON_CLEANUP_RECORDINGS,
 *   com a origem): é a prova de que o prazo foi cumprido. A que não apagou nada
 *   não enche audit_logs.
 * - Desligamento (SIGTERM do Render): pararVarreduraDeGravacoes, chamado no
 *   desligar de server/_core/index.ts junto com as filas.
 */

/** Intervalo entre o fim de uma passada e o começo da seguinte. */
export const INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS = 5 * 60_000;

/**
 * Quanto o desligamento espera a passada em curso terminar o áudio que está
 * tirando do bucket. Cortar no meio não deixa voz sem ponteiro (a linha só sai
 * depois do objeto, e a passada seguinte retoma), então a espera é curta: o
 * Render mata o processo 30 s depois do SIGTERM de todo jeito.
 */
export const ESPERA_DA_PASSADA_NO_DESLIGAMENTO_MS = 5_000;

let parada = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let passadaEmCurso: Promise<void> | null = null;

type Origem = "Boot" | "Varredura";

async function umaPassada(origem: Origem): Promise<ResultadoDaVarredura | null> {
  if (!process.env.STORAGE_BUCKET) return null;
  const resultado = await limparGravacoesVencidas({ deveParar: () => parada });
  if (resultado.encontradas) {
    console.warn(`[${origem}] Gravações de reunião vencidas: ${resultado.apagadas} de ${resultado.encontradas} apagadas do bucket.`);
  }
  if (resultado.apagadas > 0) {
    await createAuditLog({
      userId: null,
      action: "CRON_CLEANUP_RECORDINGS",
      resource: "meeting_recordings",
      status: "success",
      riskLevel: "low",
      details: { ...resultado, origem },
    }).catch(() => {});
  }
  return resultado;
}

/**
 * Liga o laço (no boot do servidor, com banco). Devolve na hora: a primeira
 * passada segue sem ser aguardada, e nenhuma passada rejeita solta, porque uma
 * rejeição sem tratamento derrubaria o processo. Todo erro vira log, e a
 * passada seguinte tenta de novo.
 */
export function iniciarVarreduraDeGravacoes(intervaloMs = INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS): void {
  parada = false;
  const rodar = (origem: Origem) => {
    passadaEmCurso = umaPassada(origem)
      .then(() => undefined, erro => {
        console.error(`[${origem}] Não foi possível limpar as gravações de reunião vencidas:`, descreverErroDeBanco(erro));
      })
      .finally(() => {
        passadaEmCurso = null;
        agendar();
      });
  };
  const agendar = () => {
    if (parada) return;
    timer = setTimeout(() => rodar("Varredura"), intervaloMs);
    timer.unref?.();
  };
  rodar("Boot");
}

/**
 * Desligamento: nenhuma passada nova começa, a em curso para antes do próximo
 * áudio (deveParar), e a espera por ela tem teto
 * (ESPERA_DA_PASSADA_NO_DESLIGAMENTO_MS). Diz se havia uma passada em curso e
 * se ela terminou dentro da espera.
 */
export async function pararVarreduraDeGravacoes(esperaMs = ESPERA_DA_PASSADA_NO_DESLIGAMENTO_MS): Promise<{ emCurso: boolean; terminou: boolean }> {
  parada = true;
  clearTimeout(timer);
  const atual = passadaEmCurso;
  if (!atual) return { emCurso: false, terminou: true };
  let prazo: ReturnType<typeof setTimeout> | undefined;
  const terminou = await Promise.race([
    atual.then(() => true),
    new Promise<boolean>(resolver => {
      prazo = setTimeout(() => resolver(false), esperaMs);
      prazo.unref?.();
    }),
  ]);
  clearTimeout(prazo);
  return { emCurso: true, terminou };
}
