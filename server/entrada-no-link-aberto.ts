import { and, eq } from "drizzle-orm";
import type { ResultadoDaEntradaNoLink } from "@shared/senha-do-link";
import { auditLogs, meetings, users } from "../drizzle/schema";
import { exigirDb } from "./db";
import { chaveDeRede } from "./ip-da-cliente";
import { FORMATO_DO_TOKEN } from "./link-aberto-da-reuniao";
import {
  comMaisUmaFalha,
  cookieDaEntrada,
  criarFreioPorRede,
  esperaRestante,
  hashDaSenhaDoLink,
  segundosDeEspera,
  senhaConfere,
  type CookieDaEntrada,
} from "./senha-do-link-aberto";

/**
 * A entrada no link aberto com senha (H23): quem recebeu o link digita os 6
 * dígitos e, acertando, leva o cookie que abre a reunião (as regras da senha,
 * do cookie e do freio estão em server/senha-do-link-aberto.ts).
 *
 * Contra a força bruta, dois freios, os dois cobrados ANTES de conferir a
 * senha, e a senha certa devolve a cobrança:
 * - o da rede de quem tenta, em memória, conferido antes de qualquer consulta:
 *   a rajada não chega ao banco nem ao scrypt;
 * - o do link, no banco (as colunas share_password_* de `meetings`), cobrado
 *   com a linha travada: as tentativas em paralelo entram uma de cada vez, e a
 *   6ª já encontra a espera. É ele que segura quem troca de rede a cada
 *   tentativa, e o deploy não o zera.
 *
 * A resposta não diz se o link existe: o link que não existe, o desligado, o
 * de conta inativa e o que não tem senha respondem "senha", como a senha
 * errada, depois de um scrypt contra um hash qualquer (o tempo fica parecido),
 * e cada um desses pedidos gasta uma falha da rede. O começo da espera do link
 * vai à auditoria, na mesma transação que a grava, com o IP de quem tentou.
 */

export const ACAO_LINK_BLOQUEADO = "MEETING_OPEN_LINK_PASSWORD_LOCKED";

export const freioDaEntradaPorRede = criarFreioPorRede();

let hashQualquer: Promise<string> | null = null;
/** Um hash de verdade, de uma senha que ninguém digita, só para gastar o mesmo scrypt. */
function hashParaGastarTempo(): Promise<string> {
  hashQualquer ??= hashDaSenhaDoLink("x").catch(erro => {
    hashQualquer = null;
    throw erro;
  });
  return hashQualquer;
}

type Alvo =
  | { tipo: "link"; id: string; hash: string }
  | { tipo: "espera"; esperaMs: number }
  | { tipo: "nenhum" };

/**
 * Acha o link com senha e cobra a falha dele, ou diz que não há link (o que
 * não existe, o desligado, o da reunião que não está pronta, o de conta
 * inativa e o sem senha) ou que ele está na espera. A primeira leitura, sem
 * trava, é pelo índice do token: o token que não existe não abre transação nem
 * trava nada. A segunda trava a linha pela chave primária e confere tudo de
 * novo, já com a linha só para si.
 */
async function cobrarDoLink(token: string, ip: string, agora: number): Promise<Alvo> {
  if (!FORMATO_DO_TOKEN.test(token)) return { tipo: "nenhum" };
  const db = await exigirDb();
  const [achado] = await db.select({ id: meetings.id, shareToken: meetings.shareToken }).from(meetings)
    .where(eq(meetings.shareToken, token)).limit(1);
  // A coluna não distingue maiúsculas: a igualdade exata do token é em JS.
  if (!achado || achado.shareToken !== token) return { tipo: "nenhum" };
  return db.transaction(async tx => {
    const [linha] = await tx.select({
      ownerId: meetings.ownerId, status: meetings.status, shareToken: meetings.shareToken, hash: meetings.sharePasswordHash,
      falhas: meetings.sharePasswordFailures, ultimaFalhaEm: meetings.sharePasswordFailedAt, bloqueadoAte: meetings.sharePasswordLockedUntil,
    }).from(meetings).where(eq(meetings.id, achado.id)).limit(1).for("update");
    if (!linha || linha.shareToken !== token || linha.status !== "ready" || linha.hash === null) return { tipo: "nenhum" as const };
    const [conta] = await tx.select({ ativa: users.isActive }).from(users).where(eq(users.openId, linha.ownerId)).limit(1);
    if (!conta?.ativa) return { tipo: "nenhum" as const };
    const estado = { falhas: linha.falhas, ultimaFalhaEm: linha.ultimaFalhaEm, bloqueadoAte: linha.bloqueadoAte };
    const espera = esperaRestante(estado, agora);
    if (espera) return { tipo: "espera" as const, esperaMs: espera };
    const novo = comMaisUmaFalha(estado, agora);
    await tx.update(meetings).set({
      sharePasswordFailures: novo.falhas, sharePasswordFailedAt: novo.ultimaFalhaEm, sharePasswordLockedUntil: novo.bloqueadoAte,
    }).where(eq(meetings.id, achado.id));
    // Esta tentativa abre a espera. Se for a senha certa, a espera se desfaz
    // logo adiante; a linha fica, como registro de que o link chegou ao limite.
    if (novo.bloqueadoAte !== null) {
      await tx.insert(auditLogs).values({
        userId: null, action: ACAO_LINK_BLOQUEADO, resource: "meetings", resourceId: achado.id,
        details: { falhasSeguidas: novo.falhas, esperaSegundos: segundosDeEspera(novo.bloqueadoAte - agora) },
        ipAddress: ip.substring(0, 45), status: "blocked", riskLevel: "medium",
      });
    }
    return { tipo: "link" as const, id: achado.id, hash: linha.hash };
  });
}

/** O freio do link volta a zero com a senha certa, se a senha ainda for a mesma que acabou de conferir. */
async function zerarFreioDoLink(id: string, hash: string) {
  const db = await exigirDb();
  await db.update(meetings).set({ sharePasswordFailures: 0, sharePasswordFailedAt: null, sharePasswordLockedUntil: null })
    .where(and(eq(meetings.id, id), eq(meetings.sharePasswordHash, hash)));
}

export type EntradaNoLink = Exclude<ResultadoDaEntradaNoLink, { entrou: true }> | { entrou: true; cookie: CookieDaEntrada };

/**
 * Confere a senha digitada no link e, certa, devolve o cookie que o router
 * grava. `ip` é o de quem tenta (ipDaCliente). Banco fora do ar sobe como
 * erro, e a falha cobrada da rede volta: a queda não pode deixar ninguém na
 * espera.
 */
export async function entrarNoLink(token: string, senha: string, ip: string, agora = Date.now()): Promise<EntradaNoLink> {
  const cobranca = freioDaEntradaPorRede.cobrar(chaveDeRede(ip), agora);
  if (!cobranca.aceita) return { entrou: false, motivo: "espera", segundos: segundosDeEspera(cobranca.esperaMs) };
  try {
    const alvo = await cobrarDoLink(token, ip, agora);
    if (alvo.tipo === "espera") return { entrou: false, motivo: "espera", segundos: segundosDeEspera(alvo.esperaMs) };
    const confere = await senhaConfere(senha, alvo.tipo === "link" ? alvo.hash : await hashParaGastarTempo());
    if (alvo.tipo !== "link" || !confere) return { entrou: false, motivo: "senha" };
    await zerarFreioDoLink(alvo.id, alvo.hash);
    cobranca.devolver();
    return { entrou: true, cookie: cookieDaEntrada(token, alvo.hash, agora) };
  } catch (erro) {
    cobranca.devolver();
    throw erro;
  }
}
