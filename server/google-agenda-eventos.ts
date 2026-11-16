import type { ParticipanteDaAgenda } from "@shared/agenda";
import { PRAZO_DAS_CHAMADAS_MS, RecusaDaGoogle, type Fetch } from "./google-oauth";

/**
 * Os eventos das reuniões marcadas na Google Agenda conectada da dona (H16c do
 * plano do gravador), sem biblioteca, como a conexão (server/google-oauth.ts):
 * criar, mudar e tirar o evento da agenda principal (`primary`) da conta Google,
 * pela API Calendar v3. O banco e a ordem das coisas ficam em
 * server/agenda-na-google.ts; aqui só a conversa com a Google.
 *
 * - O id do evento é o id da reunião da agenda sem os hífens: 32 caracteres de
 *   0-9 e a-f, dentro do que a Google aceita (base32hex, de 5 a 1024). Não há
 *   coluna para ele, e criar o que já existe dá 409, que vira PATCH: a resposta
 *   perdida de uma criação nunca duplica o evento.
 * - Os convidados são os participantes com e-mail. A Google só manda o convite
 *   (e depois os avisos de mudança e de cancelamento) quando a dona marcou
 *   "A Google manda o convite pela sua conta" (sendUpdates=all); desmarcado, o
 *   padrão, sendUpdates=none.
 * - Os convidados não veem os e-mails uns dos outros (guestsCanSeeOtherGuests
 *   falso), como no e-mail do convite da H16a, que os põe em cópia oculta.
 * - O lembrete é um aviso (popup) na agenda da dona; sem lembrete na WRW,
 *   nenhum lá (sem os lembretes padrão da agenda dela).
 * - O PATCH manda todos os campos que a WRW cuida, os vazios inclusive: o
 *   local apagado na WRW sai da Google. O que a dona pôs na própria Google
 *   (descrição, cor, anexos) fica como está.
 * - 401: a Google não aceitou o token de acesso guardado; ele é renovado UMA
 *   vez por operação, e a chamada se repete.
 * - Excluir: 404 e 410 contam como sucesso (o evento já não existe lá).
 * - Desconectar a Google Agenda e excluir a conta da WRW não apagam os eventos:
 *   eles estão na agenda da dona, na conta Google dela (o Perfil avisa isso ao
 *   desconectar).
 *
 * Nada daqui escreve token, título, e-mail ou o corpo da resposta em log ou em
 * mensagem de erro: o erro leva só o motivo que a Google deu (`reason`, como
 * "rateLimitExceeded") ou o status HTTP. O token vai no cabeçalho, nunca na URL.
 */

export const URL_DOS_EVENTOS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** O id do evento na Google: o id da reunião da agenda (um UUID) sem os hífens. */
export function idDoEventoNaGoogle(agendaId: string): string {
  return agendaId.replace(/-/g, "").toLowerCase();
}

/** O que a Google precisa de uma reunião da agenda. */
export type ReuniaoParaGoogle = {
  id: string;
  titulo: string;
  inicioEm: number;
  duracaoMinutos: number;
  fuso: string;
  local: string | null;
  participantes: ParticipanteDaAgenda[];
  lembreteMinutos: number | null;
};

/**
 * O corpo do evento (sem o id, que só vai na criação). A hora vai em UTC, com o
 * fuso em que a reunião foi marcada: quem abre o evento vê a hora certa e o
 * fuso dela.
 */
export function corpoDoEvento(reuniao: ReuniaoParaGoogle) {
  const fimEm = reuniao.inicioEm + reuniao.duracaoMinutos * 60_000;
  // O mesmo e-mail duas vezes na lista vira um convidado só.
  const vistos = new Set<string>();
  const convidados: Array<{ email: string; displayName?: string }> = [];
  for (const participante of reuniao.participantes) {
    const email = participante.email?.trim().toLowerCase();
    if (!email || vistos.has(email)) continue;
    vistos.add(email);
    const nome = participante.nome?.trim();
    convidados.push(nome ? { email, displayName: nome } : { email });
  }
  return {
    summary: reuniao.titulo,
    location: reuniao.local?.trim() ?? "",
    start: { dateTime: new Date(reuniao.inicioEm).toISOString(), timeZone: reuniao.fuso },
    end: { dateTime: new Date(fimEm).toISOString(), timeZone: reuniao.fuso },
    attendees: convidados,
    guestsCanSeeOtherGuests: false,
    reminders: {
      useDefault: false,
      overrides: reuniao.lembreteMinutos === null ? [] : [{ method: "popup", minutes: reuniao.lembreteMinutos }],
    },
    // Na criação é o padrão. No PATCH (depois do 409), traz de volta o evento
    // que a dona apagou na Google: a reunião continua na agenda da WRW.
    status: "confirmed",
  };
}

type Metodo = "POST" | "PATCH" | "DELETE";
/** A resposta da Google reduzida ao que decide: o status e o motivo, para o log. */
type Resposta = { status: number; motivo: string };

const deuCerto = (status: number) => status >= 200 && status < 300;

async function chamar(buscar: Fetch, metodo: Metodo, url: string, token: string, corpo?: unknown): Promise<Resposta> {
  let resposta: Response;
  try {
    resposta = await buscar(url, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(PRAZO_DAS_CHAMADAS_MS),
    });
  } catch {
    // A mensagem do erro de rede fica de fora: o log diz só "rede".
    throw new RecusaDaGoogle("rede", null);
  }
  let motivo = `http_${resposta.status}`;
  try {
    if (deuCerto(resposta.status)) {
      // O evento que volta não interessa; o corpo é lido só para liberar a conexão.
      await resposta.arrayBuffer();
    } else {
      // O erro da Google: { error: { code, message, errors: [{ reason }] } }. Só o reason sai daqui.
      const lido = await resposta.json() as { error?: { errors?: Array<{ reason?: unknown }> } } | null;
      const reason = lido?.error?.errors?.[0]?.reason;
      if (typeof reason === "string" && /^[A-Za-z_]{1,40}$/.test(reason)) motivo = reason;
    }
  } catch {
    // Corpo vazio ou fora do JSON (o 204 da exclusão vem vazio).
  }
  return { status: resposta.status, motivo };
}

/**
 * As chamadas de uma operação (gravar ou tirar um evento) com o token de
 * acesso da dona. O primeiro token vem de fora: quem chama já o pediu, e foi
 * assim que soube que a Google Agenda está conectada. No 401, `renovar` pede
 * outro (ver tokenDeAcessoDaGoogleAgenda, em server/google-agenda.ts) uma vez
 * só; o segundo 401 sai como recusa.
 */
export type SessaoDaGoogle = { chamar: (metodo: Metodo, url: string, corpo?: unknown) => Promise<Resposta> };

export function sessaoDaGoogle(primeiroToken: string, renovar: () => Promise<string>, buscar: Fetch): SessaoDaGoogle {
  let token = primeiroToken;
  let renovou = false;
  return {
    async chamar(metodo, url, corpo) {
      const resposta = await chamar(buscar, metodo, url, token, corpo);
      if (resposta.status !== 401 || renovou) return resposta;
      renovou = true;
      token = await renovar();
      return chamar(buscar, metodo, url, token, corpo);
    },
  };
}

const envio = (avisarConvidados: boolean) => `sendUpdates=${avisarConvidados ? "all" : "none"}`;
const urlDoEvento = (id: string, avisarConvidados: boolean) => `${URL_DOS_EVENTOS}/${encodeURIComponent(id)}?${envio(avisarConvidados)}`;

/**
 * Cria o evento da reunião, ou o muda quando ele já existe (409 vira PATCH).
 * Com `criar` falso (a reunião que já acabou, em server/agenda-na-google.ts),
 * só muda o evento que já está lá: o que não existe (404 ou 410) não é criado,
 * e a resposta é "ausente". Lança RecusaDaGoogle quando a Google recusa ou não
 * responde, e o que o `renovar` da sessão lançar (ConexaoGoogleRevogada, por
 * exemplo).
 */
export async function gravarEventoNaGoogle(
  sessao: SessaoDaGoogle,
  reuniao: ReuniaoParaGoogle,
  avisarConvidados: boolean,
  criar = true,
): Promise<"gravado" | "ausente"> {
  const id = idDoEventoNaGoogle(reuniao.id);
  const corpo = corpoDoEvento(reuniao);
  if (criar) {
    const criacao = await sessao.chamar("POST", `${URL_DOS_EVENTOS}?${envio(avisarConvidados)}`, { id, ...corpo });
    if (deuCerto(criacao.status)) return "gravado";
    if (criacao.status !== 409) throw new RecusaDaGoogle(criacao.motivo, criacao.status);
  }
  // O id já existe: o evento foi criado antes (a reunião mudou, ou a resposta
  // da criação se perdeu). Muda o que está lá.
  const mudanca = await sessao.chamar("PATCH", urlDoEvento(id, avisarConvidados), corpo);
  if (deuCerto(mudanca.status)) return "gravado";
  if (!criar && (mudanca.status === 404 || mudanca.status === 410)) return "ausente";
  throw new RecusaDaGoogle(mudanca.motivo, mudanca.status);
}

/** Tira o evento da reunião. O evento que já não existe (404 ou 410) conta como tirado. */
export async function excluirEventoNaGoogle(sessao: SessaoDaGoogle, agendaId: string, avisarConvidados: boolean): Promise<void> {
  const resposta = await sessao.chamar("DELETE", urlDoEvento(idDoEventoNaGoogle(agendaId), avisarConvidados));
  if (deuCerto(resposta.status) || resposta.status === 404 || resposta.status === 410) return;
  throw new RecusaDaGoogle(resposta.motivo, resposta.status);
}
