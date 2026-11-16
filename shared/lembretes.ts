/**
 * Os lembretes e os avisos do gravador no sino (H15 do plano do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): as regras que o servidor
 * (server/lembretes.ts) e a tela (o sino, client/src/lib/aviso-do-sino.ts)
 * dividem. Nada aqui lê banco, rede ou process.env (shared/CLAUDE.md).
 *
 * - A próxima ação com prazo (H5a) avisa às 9h do dia do prazo, no fuso do
 *   aparelho de quem marcou o prazo, e o aviso vale até o fim desse dia.
 * - A reunião da agenda com lembrete (H16a) avisa os minutos escolhidos antes do
 *   início, e o aviso vale até o fim da reunião.
 * - A reunião gravada avisa quando a transcrição e o resumo terminam.
 *
 * O servidor não escreve texto de tela: o aviso guarda os parâmetros (o texto da
 * ação e o prazo; o título, o início e o fuso da reunião), e o sino escreve a
 * frase no idioma de quem lê, com a data e a hora no formato dele.
 */
import { prazoValido, ROTA_DAS_PROXIMAS_ACOES } from "./proximas-acoes";

/** O parâmetro da página das próximas ações que destaca uma delas. */
export const PARAMETRO_DA_ACAO = "acao";

/** A próxima ação na página delas, destacada (/proximas-acoes?acao=<id>): é o link do lembrete. */
export function rotaDaProximaAcao(acaoId: string): string {
  return `${ROTA_DAS_PROXIMAS_ACOES}?${PARAMETRO_DA_ACAO}=${encodeURIComponent(acaoId)}`;
}

/** A hora do lembrete da próxima ação, no relógio de quem marcou o prazo. */
export const HORA_DO_LEMBRETE_DA_ACAO = 9;

/**
 * O fuso de quem marca o prazo sem mandar o do aparelho: a tela aberta antes do
 * deploy desta função, que ainda não manda. É o da maioria das contas da WRW.
 */
export const FUSO_PADRAO_DOS_LEMBRETES = "America/Sao_Paulo";

/** Quando o aviso sai e até quando ele ainda serve, em ms UTC. */
export type HorarioDoLembrete = { dispararEm: number; expiraEm: number };

const FORMATOS_POR_FUSO = new Map<string, Intl.DateTimeFormat>();

function formatoDoFuso(fuso: string): Intl.DateTimeFormat {
  let formato = FORMATOS_POR_FUSO.get(fuso);
  if (!formato) {
    // hourCycle h23: meia-noite sai "0", e não "24", em todo motor.
    formato = new Intl.DateTimeFormat("en-US", {
      timeZone: fuso, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    FORMATOS_POR_FUSO.set(fuso, formato);
  }
  return formato;
}

/** Quanto o relógio do fuso está à frente do UTC num instante, em ms (−3 h em São Paulo). Lança se o Intl não conhece o fuso. */
export function deslocamentoDoFuso(instante: number, fuso: string): number {
  const partes = formatoDoFuso(fuso).formatToParts(new Date(instante));
  const valor = (tipo: Intl.DateTimeFormatPartTypes) => Number(partes.find(parte => parte.type === tipo)?.value);
  const comoSeFosseUtc = Date.UTC(valor("year"), valor("month") - 1, valor("day"), valor("hour"), valor("minute"), valor("second"));
  return comoSeFosseUtc - Math.floor(instante / 1000) * 1000;
}

/**
 * O instante (ms UTC) em que o relógio do fuso marca `hora`:00 do dia
 * "AAAA-MM-DD"; `hora` 24 é a meia-noite que fecha o dia. Duas passadas: perto
 * da troca do horário de verão, o deslocamento do palpite pode ser o do outro
 * lado da troca. Na hora que o fuso pula, o resultado sai uma hora fora (a
 * troca é de madrugada, longe das 9h). Dia inválido ou fuso que o Intl não
 * conhece: null.
 */
export function instanteNoFuso(dia: string, hora: number, fuso: string): number | null {
  if (!prazoValido(dia)) return null;
  const [ano, mes, numero] = dia.split("-").map(Number);
  const ingenuo = Date.UTC(ano, mes - 1, numero, hora);
  try {
    const palpite = ingenuo - deslocamentoDoFuso(ingenuo, fuso);
    return ingenuo - deslocamentoDoFuso(palpite, fuso);
  } catch {
    return null;
  }
}

/** O lembrete da próxima ação: às 9h do dia do prazo, até o fim do dia, no fuso dado. Sem prazo, nenhum. */
export function horarioDoLembreteDaAcao(prazo: string | null | undefined, fuso: string): HorarioDoLembrete | null {
  if (!prazo) return null;
  const dispararEm = instanteNoFuso(prazo, HORA_DO_LEMBRETE_DA_ACAO, fuso);
  const expiraEm = instanteNoFuso(prazo, 24, fuso);
  return dispararEm === null || expiraEm === null ? null : { dispararEm, expiraEm };
}

/** O lembrete da reunião da agenda: os minutos escolhidos antes do início, até o fim. Sem lembrete (nulo), nenhum. */
export function horarioDoLembreteDaAgenda(reuniao: { inicioEm: number; duracaoMinutos: number; lembreteMinutos: number | null | undefined }): HorarioDoLembrete | null {
  if (typeof reuniao.lembreteMinutos !== "number") return null;
  return {
    dispararEm: reuniao.inicioEm - reuniao.lembreteMinutos * 60_000,
    expiraEm: reuniao.inicioEm + reuniao.duracaoMinutos * 60_000,
  };
}

/**
 * O que o aviso 'lembrete' guarda para a tela. O texto da ação vem com os nomes
 * que a dona deu às vozes; a voz sem nome fica como rótulo ({F2}), e o sino
 * mostra "Falante 2" no idioma de quem lê (shared/vozes-no-texto.ts).
 */
export type ParametrosDoLembrete =
  | { origem: "acao"; texto: string; prazo: string }
  | { origem: "agenda"; titulo: string; inicioEm: number; fuso: string };

/** Como o resumo terminou quando a reunião ficou pronta: pronto, ou falhou de vez (a transcrição está lá). */
export type ResumoDaReuniaoPronta = "pronto" | "falhou";
/** O que o aviso 'reuniao_pronta' guarda para a tela. */
export type ParametrosDaReuniaoPronta = { titulo: string; resumo: ResumoDaReuniaoPronta };

/** A coluna JSON chega como objeto (ou como texto, no MariaDB sem a conversão): aqui só passa objeto. */
function comoObjeto(bruto: unknown): Record<string, unknown> | null {
  let valor = bruto;
  if (typeof valor === "string") {
    try {
      valor = JSON.parse(valor);
    } catch {
      return null;
    }
  }
  return valor && typeof valor === "object" && !Array.isArray(valor) ? valor as Record<string, unknown> : null;
}

/** Os parâmetros do lembrete, conferidos; o que não tem a forma certa é null (a tela mostra o título guardado). */
export function lerParametrosDoLembrete(bruto: unknown): ParametrosDoLembrete | null {
  const p = comoObjeto(bruto);
  if (!p) return null;
  if (p.origem === "acao" && typeof p.texto === "string" && typeof p.prazo === "string" && prazoValido(p.prazo)) {
    return { origem: "acao", texto: p.texto, prazo: p.prazo };
  }
  if (p.origem === "agenda" && typeof p.titulo === "string" && typeof p.inicioEm === "number" && Number.isFinite(p.inicioEm) && typeof p.fuso === "string") {
    return { origem: "agenda", titulo: p.titulo, inicioEm: p.inicioEm, fuso: p.fuso };
  }
  return null;
}

/** Os parâmetros do aviso de reunião pronta, conferidos; fora da forma, null. */
export function lerParametrosDaReuniaoPronta(bruto: unknown): ParametrosDaReuniaoPronta | null {
  const p = comoObjeto(bruto);
  if (!p || typeof p.titulo !== "string" || (p.resumo !== "pronto" && p.resumo !== "falhou")) return null;
  return { titulo: p.titulo, resumo: p.resumo };
}
