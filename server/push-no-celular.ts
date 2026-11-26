import { and, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { pushNoCelular as ar } from "../client/src/i18n/locales/ar.json";
import { pushNoCelular as de } from "../client/src/i18n/locales/de.json";
import { pushNoCelular as en } from "../client/src/i18n/locales/en.json";
import { pushNoCelular as es } from "../client/src/i18n/locales/es.json";
import { pushNoCelular as fr } from "../client/src/i18n/locales/fr.json";
import { pushNoCelular as hi } from "../client/src/i18n/locales/hi.json";
import { pushNoCelular as ja } from "../client/src/i18n/locales/ja.json";
import { pushNoCelular as ptBR } from "../client/src/i18n/locales/pt-BR.json";
import { pushNoCelular as ru } from "../client/src/i18n/locales/ru.json";
import { pushNoCelular as zh } from "../client/src/i18n/locales/zh.json";
import { dispositivosDePush, platformNotifications, sessions } from "../drizzle/schema";
import { IDIOMAS_DA_REUNIAO, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { lerParametrosDaReuniaoPronta, lerParametrosDoLembrete } from "@shared/lembretes";
import { descreverErroDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";

/**
 * O push no celular (cartão "App: aviso no celular (push) de reunião pronta e
 * de lembretes"). Os avisos continuam nascendo no sino (server/lembretes.ts);
 * este módulo só os leva ao aparelho de quem usa o app das lojas.
 *
 * - **O aparelho:** o app pede a permissão, lê o token no Expo e o manda pelo
 *   `pushNoCelular.registrar`. O token fica preso à SESSÃO do pedido: sair da
 *   conta, redefinir a senha ou ter a conta desativada derruba a sessão, e o
 *   push para de ir sem precisar apagar nada.
 * - **O envio:** a cada 30 s o laço pega os avisos do gravador dos últimos
 *   10 minutos que ainda não foram por push, reserva cada um (UPDATE
 *   condicional: com duas instâncias, só uma envia) e manda pelo serviço de
 *   push do Expo. Fica de fora das transações que gravam o aviso, de propósito:
 *   o push que falha não desfaz o aviso, e o aviso de antes do deploy não sai.
 * - **O texto:** genérico, no idioma da tela do app (as chaves `pushNoCelular.*`
 *   dos 10 idiomas). Nada da reunião vai no push (nem o título, nem o texto da
 *   ação): ele passa pelos servidores do Expo, do Google e da Apple. O app abre
 *   o endereço do aviso, e a tela mostra o resto depois do login.
 *
 * Sem token nenhum, o laço não envia nada. Banco fora do ar é erro, nunca
 * "nada a enviar" (server/CLAUDE.md).
 */

export type TextosDoPush = typeof ptBR;

export const TEXTOS_DO_PUSH: Record<IdiomaDaReuniao, TextosDoPush> = {
  "pt-BR": ptBR, en, es, fr, de, ar, zh, hi, ja, ru,
};

/** O endereço do serviço de push do Expo. */
export const ENDERECO_DO_EXPO = "https://exp.host/--/api/v2/push/send";
/** De quanto em quanto tempo o laço procura avisos novos. */
const INTERVALO_DO_LACO_MS = 30_000;
/** Aviso mais velho que isto não vai por push: chegaria fora de hora. */
export const JANELA_DO_PUSH_MINUTOS = 10;
/** Quantos avisos uma rodada pega. */
export const AVISOS_POR_RODADA = 50;
/** O Expo aceita até 100 mensagens por pedido. */
const MENSAGENS_POR_PEDIDO = 100;
/** Quantos aparelhos uma conta mantém; o mais antigo sai quando passa disso. */
export const APARELHOS_POR_CONTA = 10;
/** Os avisos que vão por push: os do gravador. */
const TIPOS_DO_PUSH = ["lembrete", "reuniao_pronta"] as const;

const FORMATO_DO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/;

export type Plataforma = "ios" | "android";

/** O token tem a forma do Expo? */
export function tokenValido(token: string): boolean {
  return FORMATO_DO_TOKEN.test(token);
}

/** O idioma da tela do app, ou o padrão; "pt" e "en-US" viram "pt-BR" e "en". */
export function idiomaDoPush(bruto: string | null | undefined): IdiomaDaReuniao {
  if (!bruto) return "pt-BR";
  const exato = IDIOMAS_DA_REUNIAO.find(idioma => idioma.toLowerCase() === bruto.toLowerCase());
  if (exato) return exato;
  const base = bruto.split(/[-_]/)[0].toLowerCase();
  if (base === "pt") return "pt-BR";
  return IDIOMAS_DA_REUNIAO.find(idioma => idioma === base) ?? "pt-BR";
}

export type AvisoDoPush = {
  type: (typeof TIPOS_DO_PUSH)[number];
  actionUrl: string | null;
  parametros: unknown;
};

export type MensagemDoPush = { title: string; body: string; url: string | null };

/**
 * O texto do push de um aviso, no idioma do aparelho. Sem o título da reunião
 * nem o texto da ação, de propósito; da reunião da agenda, só a hora, no fuso
 * em que ela foi marcada. Parâmetros fora da forma: null, e o aviso não vai.
 */
export function mensagemDoAviso(aviso: AvisoDoPush, idioma: IdiomaDaReuniao): MensagemDoPush | null {
  const textos = TEXTOS_DO_PUSH[idioma];
  if (aviso.type === "reuniao_pronta") {
    const pronta = lerParametrosDaReuniaoPronta(aviso.parametros);
    if (!pronta) return null;
    return { title: pronta.resumo === "pronto" ? textos.reuniaoPronta : textos.reuniaoProntaSemResumo, body: textos.corpo, url: aviso.actionUrl };
  }
  const lembrete = lerParametrosDoLembrete(aviso.parametros);
  if (!lembrete) return null;
  if (lembrete.origem === "acao") return { title: textos.lembreteDaAcao, body: textos.corpo, url: aviso.actionUrl };
  let hora: string;
  try {
    hora = new Intl.DateTimeFormat(idioma, { hour: "2-digit", minute: "2-digit", timeZone: lembrete.fuso }).format(lembrete.inicioEm);
  } catch {
    // Fuso que o Intl não conhece: a hora no padrão dos lembretes.
    hora = new Intl.DateTimeFormat(idioma, { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(lembrete.inicioEm);
  }
  return { title: textos.lembreteDaReuniao.replace("{{hora}}", hora), body: textos.corpo, url: aviso.actionUrl };
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

export type ErroDoPush = "TOKEN_INVALIDO" | "SEM_SESSAO";

/**
 * Guarda o token do aparelho, preso à sessão do pedido. O mesmo token em outra
 * conta ou sessão (o celular trocou de dona, ou entrou de novo) passa para esta.
 * A conta fica com no máximo APARELHOS_POR_CONTA; o mais antigo sai.
 */
export async function registrarDispositivo(params: {
  userId: number;
  sessionToken: string | null;
  token: string;
  plataforma: Plataforma;
  idioma: string;
  agora?: number;
}): Promise<{ ok: true } | { ok: false; erro: ErroDoPush }> {
  if (!tokenValido(params.token)) return { ok: false, erro: "TOKEN_INVALIDO" };
  if (!params.sessionToken) return { ok: false, erro: "SEM_SESSAO" };
  const db = await exigirDb();
  const agora = params.agora ?? Date.now();
  const [sessao] = await db.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.sessionToken, params.sessionToken),
    eq(sessions.userId, params.userId),
    eq(sessions.isActive, true),
    gt(sessions.expiresAt, new Date(agora)),
  )).limit(1);
  if (!sessao) return { ok: false, erro: "SEM_SESSAO" };
  const idioma = idiomaDoPush(params.idioma);
  await db.insert(dispositivosDePush).values({
    userId: params.userId, sessaoId: sessao.id, token: params.token, plataforma: params.plataforma, idioma,
    createdAt: agora, updatedAt: agora,
  }).onDuplicateKeyUpdate({
    set: { userId: params.userId, sessaoId: sessao.id, plataforma: params.plataforma, idioma, updatedAt: agora },
  });
  const daConta = await db.select({ id: dispositivosDePush.id }).from(dispositivosDePush)
    .where(eq(dispositivosDePush.userId, params.userId))
    .orderBy(desc(dispositivosDePush.updatedAt), desc(dispositivosDePush.id));
  const sobra = daConta.slice(APARELHOS_POR_CONTA).map(linha => linha.id);
  if (sobra.length) await db.delete(dispositivosDePush).where(inArray(dispositivosDePush.id, sobra));
  return { ok: true };
}

/** Tira o token do aparelho desta conta (o app chama ao desligar o aviso). Devolve se tirou. */
export async function removerDispositivo(params: { userId: number; token: string }): Promise<boolean> {
  if (!tokenValido(params.token)) return false;
  const db = await exigirDb();
  const resultado = await db.delete(dispositivosDePush).where(and(
    eq(dispositivosDePush.token, params.token),
    eq(dispositivosDePush.userId, params.userId),
  ));
  return linhasAfetadas(resultado) > 0;
}

export type MensagemDoExpo = { to: string; title: string; body: string; sound: "default"; data: { url: string | null } };
/** O que o Expo devolve por mensagem, na mesma ordem. */
export type ReciboDoExpo = { status: "ok" | "error"; details?: { error?: string } };
export type EnviarAoExpo = (mensagens: MensagemDoExpo[]) => Promise<ReciboDoExpo[]>;

/**
 * Manda ao Expo. `EXPO_ACCESS_TOKEN` (opcional) é o token de acesso do Expo,
 * para quando a organização liga a segurança extra do push.
 */
export const enviarAoExpo: EnviarAoExpo = async mensagens => {
  const cabecalhos: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const tokenDeAcesso = process.env.EXPO_ACCESS_TOKEN?.trim();
  if (tokenDeAcesso) cabecalhos.Authorization = `Bearer ${tokenDeAcesso}`;
  const resposta = await fetch(ENDERECO_DO_EXPO, {
    method: "POST", headers: cabecalhos, body: JSON.stringify(mensagens), signal: AbortSignal.timeout(15_000),
  });
  if (!resposta.ok) throw new Error(`o Expo respondeu ${resposta.status}`);
  const corpo = await resposta.json() as { data?: ReciboDoExpo[] };
  return Array.isArray(corpo.data) ? corpo.data : [];
};

/**
 * Uma rodada: pega os avisos novos do gravador, reserva cada um e manda ao
 * aparelho das sessões vivas da dona. O token que o Expo diz não existir mais
 * (DeviceNotRegistered) sai. Também tira os tokens de sessões que caíram.
 * `escopo.userIds` limita a rodada a essas contas: é para os testes, que
 * dividem o banco com outros; em produção é o laço de iniciarPush.
 */
export async function rodarPushUmaVez(
  enviar: EnviarAoExpo = enviarAoExpo,
  agora: number = Date.now(),
  escopo: { userIds?: number[] } = {},
): Promise<{ enviados: number }> {
  if (escopo.userIds && !escopo.userIds.length) return { enviados: 0 };
  const db = await exigirDb();
  const momento = new Date(agora);
  // O token de sessão que caiu (saiu, senha redefinida, conta desativada) sai daqui.
  const vivas = db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.isActive, true), gt(sessions.expiresAt, momento)));
  await db.delete(dispositivosDePush).where(and(
    notInArray(dispositivosDePush.sessaoId, vivas),
    escopo.userIds ? inArray(dispositivosDePush.userId, escopo.userIds) : undefined,
  ));

  const avisos = await db.select({
    id: platformNotifications.id, userId: platformNotifications.userId, type: platformNotifications.type,
    actionUrl: platformNotifications.actionUrl, parametros: platformNotifications.parametros,
  }).from(platformNotifications).where(and(
    escopo.userIds ? inArray(platformNotifications.userId, escopo.userIds) : undefined,
    inArray(platformNotifications.type, [...TIPOS_DO_PUSH]),
    isNull(platformNotifications.pushEnviadoEm),
    // O relógio é o do banco, o mesmo do createdAt do aviso.
    sql`${platformNotifications.createdAt} >= NOW() - INTERVAL ${JANELA_DO_PUSH_MINUTOS} MINUTE`,
  )).orderBy(platformNotifications.id).limit(AVISOS_POR_RODADA);
  if (!avisos.length) return { enviados: 0 };

  const mensagens: MensagemDoExpo[] = [];
  for (const aviso of avisos) {
    // A reserva: com duas instâncias, só uma alcança a linha.
    const reservado = await db.update(platformNotifications).set({ pushEnviadoEm: sql`NOW()` })
      .where(and(eq(platformNotifications.id, aviso.id), isNull(platformNotifications.pushEnviadoEm)));
    if (!linhasAfetadas(reservado)) continue;
    const aparelhos = await db.select({ token: dispositivosDePush.token, idioma: dispositivosDePush.idioma })
      .from(dispositivosDePush)
      .innerJoin(sessions, eq(sessions.id, dispositivosDePush.sessaoId))
      .where(and(
        eq(dispositivosDePush.userId, aviso.userId),
        eq(sessions.userId, aviso.userId),
        eq(sessions.isActive, true),
        gt(sessions.expiresAt, momento),
      ));
    for (const aparelho of aparelhos) {
      const mensagem = mensagemDoAviso({ type: aviso.type as AvisoDoPush["type"], actionUrl: aviso.actionUrl, parametros: aviso.parametros }, idiomaDoPush(aparelho.idioma));
      if (mensagem) mensagens.push({ to: aparelho.token, title: mensagem.title, body: mensagem.body, sound: "default", data: { url: mensagem.url } });
    }
  }

  let enviados = 0;
  for (let inicio = 0; inicio < mensagens.length; inicio += MENSAGENS_POR_PEDIDO) {
    const lote = mensagens.slice(inicio, inicio + MENSAGENS_POR_PEDIDO);
    let recibos: ReciboDoExpo[];
    try {
      recibos = await enviar(lote);
    } catch (erro) {
      // O aviso já está no sino; o push perdido não volta (chegaria fora de hora).
      console.error("[Push] o Expo não recebeu o lote:", erro instanceof Error ? erro.message : String(erro));
      continue;
    }
    const sumiram: string[] = [];
    lote.forEach((mensagem, i) => {
      const recibo = recibos[i];
      if (recibo?.status === "ok") enviados += 1;
      else if (recibo?.details?.error === "DeviceNotRegistered") sumiram.push(mensagem.to);
    });
    if (sumiram.length) await db.delete(dispositivosDePush).where(inArray(dispositivosDePush.token, sumiram));
  }
  return { enviados };
}

let parado = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Liga o laço do push (no boot do servidor, com banco). */
export function iniciarPush(intervaloMs = INTERVALO_DO_LACO_MS) {
  parado = false;
  const proxima = () => {
    if (parado) return;
    timer = setTimeout(() => {
      // Uma rodada por vez, e ela nunca rejeita solta (derrubaria o processo).
      rodarPushUmaVez()
        .catch(erro => console.error("[Push] a rodada falhou:", descreverErroDeBanco(erro)))
        .finally(proxima);
    }, intervaloMs);
    timer.unref?.();
  };
  proxima();
}

/** Desligamento: para de procurar avisos. A reserva é por aviso, então não há o que devolver. */
export function pararPush() {
  parado = true;
  clearTimeout(timer);
}
