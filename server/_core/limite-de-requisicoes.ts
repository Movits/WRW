import type { NextFunction, Request, RequestHandler, Response } from "express";
import net from "node:net";
import rateLimit from "express-rate-limit";
import { parse as parseCookieHeader } from "cookie";
import { jwtVerify } from "jose";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import { COOKIE_NAME } from "@shared/const";
import { ENV } from "./env";
import { chaveDeRede, ipDaCliente } from "../ip-da-cliente";

// ============================================================
// LIMITE DE REQUISIÇÕES POR MINUTO
// ============================================================
// Antes: 200/min por IP no limite geral (contando cada arquivo estático) e
// 100/min por IP na API, com a chave em `req.ip` — que no Render é um proxy
// interno dividido por TODAS as visitantes. No lançamento de 16/09 (~200
// pessoas, muitas no mesmo wi-fi) isso dava 4 a 6 pessoas por minuto.
//
// Agora a chave é a CONTA quando há sessão válida (cada pessoa logada tem o
// seu balde, e o IP compartilhado deixa de importar) e o IP real da visitante
// quando não há (ver ip-da-cliente.ts). Contadores em memória: a instância é
// única e eles zeram a cada deploy.

export const JANELA_DO_LIMITE_MS = 60_000;

export type Limites = { usuaria: number; ip: number };

/**
 * API: 300/min por conta dá ~5 vezes o pico de uma pessoa pesada (sino e salas
 * a cada 30 s, navegação, foco de janela). 1200/min por IP cobre ~120 pessoas
 * fazendo no mesmo minuto a fase anônima inteira (home, cadastro, login,
 * esqueci a senha: 6 a 10 pedidos cada).
 */
export const LIMITES_DA_API: Limites = { usuaria: 300, ip: 1200 };
/** Geral (index.html, /manus-storage, cron): os estáticos e a API ficam fora. */
export const LIMITES_GERAIS: Limites = { usuaria: 600, ip: 600 };

export const MENSAGEM_DO_LIMITE = "Muitas requisições em pouco tempo. Aguarde alguns segundos e tente de novo.";

type TipoDeChave = "usuaria" | "ip";

/**
 * Conta com sessão válida conta pela conta; o resto, pelo IP. Só confere a
 * assinatura e a validade do JWT (HMAC, sem banco): não dá para criar um sem o
 * JWT_SECRET. Sessão revogada no banco mas com JWT ainda válido ganha balde
 * próprio — um por conta, e criar conta tem teto. Silenciosa de propósito: o
 * `sdk.verifySession` escreve aviso no log a cada pedido sem cookie.
 */
export async function chaveDoLimite(
  req: Pick<Request, "headers" | "ip" | "socket">,
  segredo: string = ENV.cookieSecret,
  ambiente: NodeJS.ProcessEnv = process.env,
): Promise<{ chave: string; tipo: TipoDeChave }> {
  const sessao = req.headers.cookie ? parseCookieHeader(req.headers.cookie)[COOKIE_NAME] : undefined;
  if (sessao && segredo) {
    try {
      const { payload } = await jwtVerify(sessao, new TextEncoder().encode(segredo), { algorithms: ["HS256"] });
      if (typeof payload.openId === "string" && payload.openId.length > 0) {
        return { chave: `usuaria:${payload.openId}`, tipo: "usuaria" };
      }
    } catch {
      // Inválido ou vencido: conta pelo IP, como quem não tem sessão.
    }
  }
  return { chave: `ip:${chaveDeRede(ipDaCliente(req, ambiente))}`, tipo: "ip" };
}

export function ehRotaDaApi(caminho: string): boolean {
  return caminho === "/api/trpc" || caminho.startsWith("/api/trpc/") || caminho.startsWith("/api/trpc?");
}

const PREFIXOS_ESTATICOS = ["/assets/", "/brand/", "/images/"];
// O manifest do app instalável mora na raiz de client/public. O Chrome o
// busca ao abrir o site, e sem cookie, porque o link não pede credenciais:
// ele contaria no limite do IP, o mesmo de uma sala inteira no mesmo wi-fi.
const ARQUIVOS_ESTATICOS_NA_RAIZ = ["/manifest.webmanifest"];

/**
 * Arquivos do build (/assets, com hash) e de client/public (/brand, /images e
 * o manifest do app instalável): é tudo o que dist/public tem além do
 * index.html. Uma primeira visita pede 10 a 15 deles; contados no limite
 * geral, uma sala no mesmo wi-fi estourava só abrindo a home. Servi-los é
 * barato e a Cloudflare guarda /assets em cache. Caminho que não existe ali
 * (/favicon.ico, /robots.txt) cai no index.html e conta como página.
 */
export function ehArquivoEstatico(req: Pick<Request, "method" | "path">): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (ARQUIVOS_ESTATICOS_NA_RAIZ.includes(req.path)) return true;
  return PREFIXOS_ESTATICOS.some(prefixo => req.path.startsWith(prefixo));
}

/** O que o limite geral não conta. */
export function pularNoLimiteGeral(
  req: Pick<Request, "method" | "path" | "url">,
  ambiente: NodeJS.ProcessEnv = process.env,
): boolean {
  const url = req.url || "";
  // Módulos e HMR do Vite (`/@vite`, `/node_modules`, `*.hot-update.js`): só
  // em dev, e a regra logo abaixo já os cobre. Em produção não se pula nada
  // por eles: `req.url` traz a query string, e `/manus-storage/x?a=.hot-update.js`
  // passava sem contar.
  //
  // Em DEV o Vite serve CADA módulo do próprio app como uma requisição HTTP
  // separada, e são milhares (o build transforma ~5900 módulos). A lista
  // antiga cobria só `/@...` e `/node_modules/...`: os arquivos do app
  // (`/client/src/**`) contavam no limite, e a PRIMEIRA abertura de qualquer
  // tela estourava os 200/min — a página vinha pela metade e o navegador
  // recebia {"error":"Muitas requisições. Tente novamente em breve."}.
  // Isso inviabilizava o smoke manual que toda PR exige ("abrir cada tela
  // afetada com pnpm dev, logado com o nível certo"). Achado ao rodar a carga
  // da planilha de ponta a ponta (F9) e tentar abrir o app logado.
  if (ambiente.NODE_ENV === "development" && !url.startsWith("/api/")) return true;
  // A API tem limite próprio: contar aqui também gastaria o geral duas vezes.
  if (ehRotaDaApi(req.path)) return true;
  return ehArquivoEstatico(req);
}

/**
 * O 429 no formato que o cliente tRPC entende. O corpo antigo
 * ({"error":"Muitas requisições..."}) não tem `error.json.code` numérico, e o
 * httpBatchLink lançava "Unable to transform response from server" (tela em
 * branco). Com o envelope do superjson, vira TRPCClientError com a mensagem e
 * `data.code`, que `mensagemDeErroParaTela` (client/src/lib) mostra. Corpo
 * que não é lista vale para todas as operações do lote.
 */
export function responderLimite(req: Pick<Request, "originalUrl">, res: Response): void {
  if (ehRotaDaApi(req.originalUrl || "")) {
    res.status(429).json({
      error: {
        json: {
          message: MENSAGEM_DO_LIMITE,
          code: TRPC_ERROR_CODES_BY_KEY.TOO_MANY_REQUESTS,
          data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 },
        },
      },
    });
    return;
  }
  res.status(429).type("text/plain; charset=utf-8").send(MENSAGEM_DO_LIMITE);
}

export function criarLimitador(opcoes: {
  limites: Limites;
  janelaMs?: number;
  pular?: (req: Request) => boolean;
  /** Só para os testes; em produção é o JWT_SECRET. */
  segredo?: string;
  ambiente?: NodeJS.ProcessEnv;
}): RequestHandler {
  const { limites, janelaMs = JANELA_DO_LIMITE_MS, pular, segredo, ambiente } = opcoes;
  // O `limit` do express-rate-limit roda depois do gerador de chave, no mesmo
  // pedido, mas não recebe a chave: o tipo passa por aqui.
  const tipos = new WeakMap<Request, TipoDeChave>();
  return rateLimit({
    windowMs: janelaMs,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...(pular ? { skip: (pedido: Request) => pular(pedido) } : {}),
    keyGenerator: async (pedido: Request) => {
      const { chave, tipo } = await chaveDoLimite(pedido, segredo ?? ENV.cookieSecret, ambiente ?? process.env);
      tipos.set(pedido, tipo);
      return chave;
    },
    limit: (pedido: Request) => (tipos.get(pedido) === "usuaria" ? limites.usuaria : limites.ip),
    handler: (pedido: Request, resposta: Response) => responderLimite(pedido, resposta),
  });
}

type OpcoesDeTeste = { segredo?: string; ambiente?: NodeJS.ProcessEnv };

/** O limite geral de server/_core/index.ts. */
export function criarLimiteGeral(opcoes: OpcoesDeTeste = {}): RequestHandler {
  const ambiente = opcoes.ambiente ?? process.env;
  return criarLimitador({ limites: LIMITES_GERAIS, pular: req => pularNoLimiteGeral(req, ambiente), ...opcoes });
}

/** O limite de /api/trpc de server/_core/index.ts. */
export function criarLimiteDaApi(opcoes: OpcoesDeTeste = {}): RequestHandler {
  return criarLimitador({ limites: LIMITES_DA_API, ...opcoes });
}

/**
 * Diagnóstico para depois do deploy, sem dado pessoal: nos primeiros pedidos à
 * API, quantos trouxeram CF-Connecting-IP válido e quantos têm o mesmo valor
 * do primeiro item do X-Forwarded-For (para quem não forja, é o IP da
 * visitante). Uma linha só no log do Render prova que o cabeçalho chega e que
 * não é um endereço fixo da borda — sem precisar testar de outra rede.
 */
export function criarDiagnosticoDoIp(
  amostra = 50,
  registrar: (linha: string) => void = linha => console.info(linha),
): RequestHandler {
  let vistos = 0;
  let comCabecalho = 0;
  let iguaisAoXff = 0;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (vistos < amostra) {
      vistos += 1;
      const cabecalho = req.headers["cf-connecting-ip"];
      const valor = typeof cabecalho === "string" ? cabecalho.trim() : "";
      if (net.isIP(valor)) {
        comCabecalho += 1;
        const xff = req.headers["x-forwarded-for"];
        const primeiro = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
        if (primeiro === valor) iguaisAoXff += 1;
      }
      if (vistos === amostra) {
        registrar(
          `[Limite] Nos primeiros ${amostra} pedidos à API: ${comCabecalho} com CF-Connecting-IP válido, ${iguaisAoXff} iguais ao primeiro item do X-Forwarded-For.`,
        );
      }
    }
    next();
  };
}
