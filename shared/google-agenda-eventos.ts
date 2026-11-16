/**
 * A reunião da agenda na Google Agenda conectada da dona (H16c do plano do
 * gravador): o estado guardado em `agenda_reunioes.google` e o resultado que as
 * rotas da agenda devolvem à tela, que escolhe a frase pelo código
 * (client/src/pages/Agenda.tsx). Nada aqui lê o ambiente: o mesmo código roda
 * no navegador.
 */

/**
 * O estado da reunião na Google; nulo (fora da lista) quando ela nunca foi
 * mandada para lá, porque a dona não tinha a Google Agenda conectada.
 * - `pendente`: o banco gravou, e a Google ainda não respondeu (ou a resposta
 *   se perdeu);
 * - `ok`: a Google tem a versão que está no banco;
 * - `falhou`: a Google não tem; a tela mostra "Tentar de novo".
 */
export const ESTADOS_NA_GOOGLE = ["pendente", "ok", "falhou"] as const;
export type EstadoNaGoogle = (typeof ESTADOS_NA_GOOGLE)[number];

/** O valor da coluna, ou null quando não é um dos estados (a coluna é varchar). */
export function estadoNaGoogle(valor: unknown): EstadoNaGoogle | null {
  return typeof valor === "string" && (ESTADOS_NA_GOOGLE as readonly string[]).includes(valor) ? valor as EstadoNaGoogle : null;
}

/**
 * Por que a Google não recebeu a reunião (ou não a tirou):
 * - `nao-conectada`: a Google Agenda não está conectada, ou a função não está
 *   disponível para a conta;
 * - `revogada`: a conexão parou de funcionar; só reconectar no Perfil resolve;
 * - `google`: a Google recusou ou não respondeu; tentar de novo pode resolver.
 */
export const MOTIVOS_SEM_GOOGLE = ["nao-conectada", "revogada", "google"] as const;
export type MotivoSemGoogle = (typeof MOTIVOS_SEM_GOOGLE)[number];

/**
 * O que aconteceu na Google nesta chamada. `null` quando nada foi tentado: a
 * dona não tem a Google Agenda conectada, ou a reunião nunca foi para lá.
 */
export type ResultadoNaGoogle =
  | { naGoogle: null }
  | { naGoogle: "ok" }
  | { naGoogle: "falhou"; motivo: MotivoSemGoogle };
