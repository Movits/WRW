import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { parse as lerCookies } from "cookie";
import { DIGITOS_DA_SENHA_DO_LINK, FORMATO_DA_SENHA_DO_LINK } from "@shared/senha-do-link";
import { requireSecret } from "./_core/env";

/**
 * A senha de 6 dígitos do link aberto da reunião (H23, HN-57 do HiNoter): a
 * parte que não fala com o banco. Quem grava e lê as colunas é
 * server/link-aberto-da-reuniao.ts (a dona liga, troca e tira a senha) e
 * server/entrada-no-link-aberto.ts (quem recebeu o link digita a senha).
 *
 * - A senha é do servidor: 6 algarismos sorteados por `crypto.randomInt`, sem
 *   as sequências que parecem de propósito (000000, 123456, 987654).
 * - O banco guarda só o hash, scrypt com sal aleatório. A senha em texto sai
 *   uma vez, para a dona, na hora de criar ou trocar. Com 6 dígitos, quem lê o
 *   banco acharia a senha pelo hash em algumas horas de máquina; mas quem lê o
 *   banco já lê a transcrição e o token. O hash tira a senha do alcance de quem
 *   olha a tabela; o que protege o link é o freio das tentativas, abaixo.
 * - Quem acerta a senha leva um cookie HttpOnly de 12 horas, preso ao token e à
 *   senha da vez: assinado com uma chave derivada do JWT_SECRET sobre o token, o
 *   hash guardado e o vencimento. Trocar ou tirar a senha muda o hash, e o
 *   cookie de antes deixa de valer; desligar o link apaga o token. Não é JWT: só
 *   server/sessao.ts assina JWT (server/sessao-guarda.test.ts).
 * - O freio: a cada tentativa, o link e a rede de quem tenta (o IP; o IPv6 pelo
 *   /56) ganham uma falha ANTES de a senha ser conferida, e a senha certa a
 *   devolve. Da 5ª falha seguida em diante, espera de 1 minuto que dobra a cada
 *   falha (1, 2, 4... até 60 minutos); as falhas se esquecem depois de 24 horas
 *   sem nenhuma. Na espera, a senha nem é conferida.
 */

// ─── A senha ──────────────────────────────────────────────────────────────

const POSSIBILIDADES = 10 ** DIGITOS_DA_SENHA_DO_LINK;

/** Seis algarismos iguais, ou seguidos para cima ou para baixo (com a volta do 9 ao 0). */
export function senhaObvia(senha: string): boolean {
  const algarismos = senha.split("").map(Number);
  const passo = (diferenca: number) => algarismos.every((valor, i) => i === 0 || valor === (algarismos[i - 1] + diferenca) % 10);
  return passo(0) || passo(1) || passo(9);
}

/**
 * Uma senha nova, sorteada de modo uniforme entre as 1 milhão possíveis, menos
 * as óbvias (30 delas: sem elas, a dona estranharia um "123456" sorteado). O
 * sorteio entra por parâmetro só para o teste.
 */
export function gerarSenhaDoLink(sortear: (limite: number) => number = limite => crypto.randomInt(limite)): string {
  for (;;) {
    const senha = String(sortear(POSSIBILIDADES)).padStart(DIGITOS_DA_SENHA_DO_LINK, "0");
    if (FORMATO_DA_SENHA_DO_LINK.test(senha) && !senhaObvia(senha)) return senha;
  }
}

// O custo padrão do scrypt no Node (16 MiB de memória, ~25 ms nesta máquina):
// a senha é conferida só depois do freio, então o custo não vira porta de abuso.
const SCRYPT = { N: 16_384, r: 8, p: 1 };
const BYTES_DO_SAL = 16;
const BYTES_DO_HASH = 32;

function derivar(senha: string, sal: Buffer, parametros: { N: number; r: number; p: number }, tamanho: number): Promise<Buffer> {
  return new Promise((resolver, rejeitar) => {
    crypto.scrypt(senha, sal, tamanho, { ...parametros, maxmem: 64 * 1024 * 1024 }, (erro, chave) => (erro ? rejeitar(erro) : resolver(chave)));
  });
}

/** O hash que vai para `meetings.share_password_hash`: "scrypt$N$r$p$sal$hash", em base64url. */
export async function hashDaSenhaDoLink(senha: string): Promise<string> {
  const sal = crypto.randomBytes(BYTES_DO_SAL);
  const hash = await derivar(senha, sal, SCRYPT, BYTES_DO_HASH);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, sal.toString("base64url"), hash.toString("base64url")].join("$");
}

/**
 * Se a senha bate com o hash guardado, em tempo constante na comparação. Hash
 * em outro formato, ou com parâmetros fora dos de um scrypt nosso, não confere
 * (e não manda o servidor gastar memória à toa).
 */
export async function senhaConfere(senha: string, guardado: string): Promise<boolean> {
  const partes = guardado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const [N, r, p] = partes.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 17 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const sal = Buffer.from(partes[4], "base64url");
  const esperado = Buffer.from(partes[5], "base64url");
  if (sal.length < 8 || esperado.length < 16) return false;
  const calculado = await derivar(senha, sal, { N, r, p }, esperado.length);
  return crypto.timingSafeEqual(calculado, esperado);
}

// ─── O cookie de quem acertou ─────────────────────────────────────────────

export const DURACAO_DA_ENTRADA_MS = 12 * 60 * 60_000;

let chaveDaEntrada: Buffer | null = null;

/** A chave do cookie: derivada do JWT_SECRET, separada da assinatura da sessão pelo rótulo. */
function chave(): Buffer {
  chaveDaEntrada ??= crypto.createHmac("sha256", requireSecret("JWT_SECRET")).update("wrw:link-aberto:entrada:v1").digest();
  return chaveDaEntrada;
}

/**
 * O nome do cookie de um link: um por link, para quem abre dois links com
 * senha no mesmo navegador. Vem do hash do token, e não do token, para o
 * segredo não ir também no nome.
 */
export function nomeDoCookieDoLink(token: string): string {
  return `wrw_link_${crypto.createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
}

function assinatura(token: string, hash: string, venceEm: number): string {
  return crypto.createHmac("sha256", chave()).update(`${token}\n${hash}\n${venceEm}`).digest("base64url");
}

export type CookieDaEntrada = { nome: string; valor: string; maxAgeMs: number };

/** O cookie de quem acertou a senha do link: "vencimento.assinatura", com o vencimento em segundos. */
export function cookieDaEntrada(token: string, hash: string, agora = Date.now()): CookieDaEntrada {
  const venceEm = Math.floor((agora + DURACAO_DA_ENTRADA_MS) / 1000);
  return { nome: nomeDoCookieDoLink(token), valor: `${venceEm}.${assinatura(token, hash, venceEm)}`, maxAgeMs: DURACAO_DA_ENTRADA_MS };
}

const FORMATO_DO_COOKIE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/**
 * Se os cookies do pedido trazem a entrada deste link: assinada por nós, para
 * este token e para a senha que está guardada agora, e ainda no prazo. Um
 * vencimento mais longe que o prazo inteiro (com 1 minuto de folga) não vale:
 * não foi o servidor que o escreveu.
 */
export function entradaValida(token: string, hash: string, cabecalhoDeCookies: string | undefined, agora = Date.now()): boolean {
  if (!cabecalhoDeCookies) return false;
  let valor: string | undefined;
  try {
    valor = lerCookies(cabecalhoDeCookies)[nomeDoCookieDoLink(token)];
  } catch {
    return false;
  }
  const partes = valor ? FORMATO_DO_COOKIE.exec(valor) : null;
  if (!partes) return false;
  const venceEmMs = Number(partes[1]) * 1000;
  if (venceEmMs <= agora || venceEmMs > agora + DURACAO_DA_ENTRADA_MS + 60_000) return false;
  const esperada = Buffer.from(assinatura(token, hash, Number(partes[1])));
  const recebida = Buffer.from(partes[2]);
  return esperada.length === recebida.length && crypto.timingSafeEqual(esperada, recebida);
}

// Os cookies do pedido chegam a reuniaoDoLink (server/link-aberto-da-reuniao.ts)
// pelo contexto assíncrono do pedido, e não por parâmetro: a reunião do link é
// lida pela página, pelo resumo, pelo mapa, pelas traduções, pela pergunta e
// pela rota do áudio, em cinco módulos, e a senha é conferida no único ponto
// por onde todos passam. Um caminho novo pelo link não tem como esquecer a
// senha: sem o contexto, não há cookie, e o link com senha recusa.
const pedidoDoLink = new AsyncLocalStorage<{ cookies: string | undefined }>();

/** Roda o trabalho com os cookies do pedido à vista de reuniaoDoLink. */
export function comCookiesDoPedido<T>(cookies: string | undefined, trabalho: () => T): T {
  return pedidoDoLink.run({ cookies }, trabalho);
}

/** Os cookies do pedido em curso, ou undefined fora de um pedido do link. */
export function cookiesDoPedido(): string | undefined {
  return pedidoDoLink.getStore()?.cookies;
}

// ─── O freio da força bruta ───────────────────────────────────────────────

export const TENTATIVAS_LIVRES = 5;
export const ESPERA_INICIAL_MS = 60_000;
export const ESPERA_MAXIMA_MS = 60 * 60_000;
export const ESQUECER_FALHAS_DEPOIS_DE_MS = 24 * 60 * 60_000;

/** As falhas seguidas, a hora da última e até quando a entrada fica recusada. */
export type EstadoDoFreio = { falhas: number; ultimaFalhaEm: number | null; bloqueadoAte: number | null };

export const FREIO_ZERADO: EstadoDoFreio = { falhas: 0, ultimaFalhaEm: null, bloqueadoAte: null };

/** A espera depois de N falhas seguidas: nenhuma até a 4ª, 1 minuto na 5ª, o dobro a cada uma, até 60 minutos. */
export function esperaDepoisDe(falhas: number): number {
  if (falhas < TENTATIVAS_LIVRES) return 0;
  return Math.min(ESPERA_INICIAL_MS * 2 ** Math.min(falhas - TENTATIVAS_LIVRES, 30), ESPERA_MAXIMA_MS);
}

/** Quanto falta da espera agora, em ms; 0 quando a entrada está livre. */
export function esperaRestante(estado: EstadoDoFreio, agora: number): number {
  return estado.bloqueadoAte !== null && estado.bloqueadoAte > agora ? estado.bloqueadoAte - agora : 0;
}

/**
 * O estado depois de mais uma falha. As falhas de mais de 24 horas atrás se
 * esquecem: quem errou duas vezes na semana passada não começa na espera.
 */
export function comMaisUmaFalha(estado: EstadoDoFreio, agora: number): EstadoDoFreio {
  const recentes = estado.ultimaFalhaEm !== null && agora - estado.ultimaFalhaEm < ESQUECER_FALHAS_DEPOIS_DE_MS ? estado.falhas : 0;
  const falhas = Math.min(recentes + 1, 1_000_000);
  const espera = esperaDepoisDe(falhas);
  return { falhas, ultimaFalhaEm: agora, bloqueadoAte: espera ? agora + espera : null };
}

/** Os segundos inteiros que a tela mostra, nunca 0 enquanto há espera. */
export function segundosDeEspera(esperaMs: number): number {
  return Math.max(1, Math.ceil(esperaMs / 1000));
}

// O mesmo limite de memória dos tetos (MAXIMO_DE_CHAVES_POR_TETO, em
// assistente-de-texto.ts), sem importar aquele módulo, que puxa a IA.
const MAXIMO_DE_REDES_NO_FREIO = 5000;

export type CobrancaDoFreio =
  | { aceita: true; devolver: () => void }
  | { aceita: false; esperaMs: number };

/**
 * O freio por rede, em memória como os outros tetos (instância única no
 * Render; zera a cada deploy). O freio de cada link fica no banco, porque é
 * ele que segura quem troca de rede a cada tentativa. `cobrar` é síncrono:
 * nenhuma tentativa entra entre conferir e cobrar, e a rajada em paralelo
 * esbarra na espera já na 6ª.
 *
 * A senha certa devolve só a falha que ela mesma cobrou, e não zera a rede:
 * quem acertasse a senha de um link seu não ganharia tentativas novas no link
 * dos outros.
 */
export function criarFreioPorRede(maximoDeChaves = MAXIMO_DE_REDES_NO_FREIO) {
  const estados = new Map<string, EstadoDoFreio>();
  const guardar = (chave: string, estado: EstadoDoFreio) => {
    // Reinserir põe a chave no fim: quem sai primeiro é a rede parada há mais tempo.
    estados.delete(chave);
    estados.set(chave, estado);
    while (estados.size > maximoDeChaves) {
      const maisAntiga = estados.keys().next().value;
      if (maisAntiga === undefined) break;
      estados.delete(maisAntiga);
    }
  };
  return {
    cobrar(chave: string, agora = Date.now()): CobrancaDoFreio {
      const atual = estados.get(chave) ?? FREIO_ZERADO;
      const espera = esperaRestante(atual, agora);
      if (espera) return { aceita: false, esperaMs: espera };
      guardar(chave, comMaisUmaFalha(atual, agora));
      let devolvida = false;
      return {
        aceita: true,
        devolver: () => {
          if (devolvida) return;
          devolvida = true;
          const estado = estados.get(chave);
          if (!estado) return;
          const falhas = Math.max(0, estado.falhas - 1);
          // Abaixo do limite, a espera que esta cobrança abriu se desfaz.
          guardar(chave, { ...estado, falhas, bloqueadoAte: falhas >= TENTATIVAS_LIVRES ? estado.bloqueadoAte : null });
        },
      };
    },
    /** Só para os testes: o freio é estado de módulo. */
    esquecer() {
      estados.clear();
    },
  };
}
