import type { CookieOptions, Express, Request, Response } from "express";
import { parse as lerCookies } from "cookie";
import { TRPCError } from "@trpc/server";
import {
  CAMINHO_DAS_ROTAS_DE_ENTRAR_COM_GOOGLE,
  MODOS_DE_ENTRAR_COM_GOOGLE,
  ROTA_IR_ENTRAR_COM_GOOGLE,
  ROTA_RETORNO_ENTRAR_COM_GOOGLE,
  rotaDoResultadoDaContaGoogle,
  telaDoModo,
  type ModoDeEntrarComGoogle,
  type ResultadoDaContaGoogle,
} from "@shared/entrar-com-google";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { criarTeto } from "./assistente-de-texto";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import {
  abrirIdaDaEntrada,
  COOKIE_DA_IDA_DA_ENTRADA,
  configuracaoDaEntradaComGoogle,
  entrarComGoogle,
  gerarNonce,
  lerIdentidadeDaEntrada,
  ligarContaGoogle,
  PRAZO_DA_IDA_DA_ENTRADA_MS,
  selarIdaDaEntrada,
  sessaoPodeLigar,
  urlDeAutorizacaoDaEntrada,
  voltarAceitavel,
  type ConfiguracaoDaEntradaComGoogle,
} from "./entrar-com-google";
import { fetchGlobal, gerarPkce, gerarState, mesmoState, RecusaDaGoogle, trocarCodigo, type Fetch, type TokensDaGoogle } from "./google-oauth";
import { chaveDeRede, ipDaCliente } from "./ip-da-cliente";
import { gravarCookieDaSessao, sessionTokenDoPedido } from "./sessao";

/**
 * As duas rotas de "Continuar com Google" (A8), Express e não tRPC: a ida e a
 * volta são navegação GET de página inteira, como na Google Agenda
 * (server/rotas-da-google-agenda.ts). Montadas em server/_core/index.ts.
 *
 * - `GET /api/entrar-com-google/ir?modo=entrar|cadastrar|ligar`: confere o
 *   host, o teto da rede e, no `ligar`, a sessão recente; guarda state, PKCE,
 *   nonce e modo no cookie da ida (cifrado, HttpOnly, 10 min) e manda à Google.
 * - `GET /api/entrar-com-google/retorno`: o cookie sai na hora; confere o
 *   state, troca o código, lê o id_token (nonce, e-mail verificado) e entra,
 *   cria ou liga. O fim é sempre um redirecionamento à tela do modo, com
 *   `?conta-google=` quando há o que dizer.
 *
 * Sem a configuração, as duas dão 404. Nenhuma resposta vai para cache, e
 * nenhum log leva token, código ou e-mail.
 */

/** Idas e voltas por rede (IPv6 no /56), contadas juntas: cada entrada gasta duas. */
export const PEDIDOS_DE_ENTRAR_COM_GOOGLE_POR_REDE = 60;
export const JANELA_DE_ENTRAR_COM_GOOGLE_MS = 15 * 60_000;
export const tetoDeEntrarComGoogle = criarTeto(
  PEDIDOS_DE_ENTRAR_COM_GOOGLE_POR_REDE,
  JANELA_DE_ENTRAR_COM_GOOGLE_MS,
  "Muitas entradas com o Google a partir desta rede.",
);

type ContaDaSessao = { id: number; isCron?: boolean };

export type DependenciasDeEntrarComGoogle = {
  configuracao: () => ConfiguracaoDaEntradaComGoogle | null;
  autenticar: (req: Request) => Promise<ContaDaSessao>;
  buscar: Fetch;
  agora: () => number;
};

const PADRAO: DependenciasDeEntrarComGoogle = {
  configuracao: () => configuracaoDaEntradaComGoogle(),
  autenticar: req => sdk.authenticateRequest(req),
  buscar: fetchGlobal,
  agora: () => Date.now(),
};

function opcoesDoCookieDaIda(req: Request): CookieOptions {
  return { ...getSessionCookieOptions(req), path: CAMINHO_DAS_ROTAS_DE_ENTRAR_COM_GOOGLE };
}

function naoExiste(res: Response) {
  res.status(404).type("text/plain").send("Não encontrado.");
}

/** Reserva a vaga da rede; sem vaga, false. */
function cabeNoTeto(req: Request): boolean {
  try {
    tetoDeEntrarComGoogle.reservar(chaveDeRede(ipDaCliente(req)));
    return true;
  } catch (erro) {
    if (erro instanceof TRPCError && erro.code === "TOO_MANY_REQUESTS") return false;
    throw erro;
  }
}

/** O Express 4 não pega a rejeição de um handler assíncrono: o que escapar volta ao login como erro. */
function protegida(rota: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await rota(req, res);
    } catch (erro) {
      console.error(`[Entrar com Google] falha inesperada: ${descreverErroDeBanco(erro)}`);
      if (!res.headersSent) res.redirect(302, rotaDoResultadoDaContaGoogle("/login", "erro"));
    }
  };
}

/**
 * A conta da sessão, ou null (sem sessão ou cron). Banco fora do ar é erro,
 * nunca "sem sessão": sobe, e a rota volta com `?conta-google=erro` em vez de
 * mandar ao login quem está logada.
 */
async function contaDaSessao(req: Request, deps: DependenciasDeEntrarComGoogle): Promise<ContaDaSessao | null> {
  try {
    const conta = await deps.autenticar(req);
    return conta.isCron ? null : conta;
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    return null;
  }
}

export function registrarRotasDeEntrarComGoogle(app: Express, deps: DependenciasDeEntrarComGoogle = PADRAO) {
  app.get(ROTA_IR_ENTRAR_COM_GOOGLE, protegida(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const config = deps.configuracao();
    if (!config) return naoExiste(res);
    const modoPedido = typeof req.query.modo === "string" ? req.query.modo : "";
    if (!(MODOS_DE_ENTRAR_COM_GOOGLE as readonly string[]).includes(modoPedido)) return naoExiste(res);
    const modo = modoPedido as ModoDeEntrarComGoogle;
    const tela = telaDoModo(modo);
    // O cookie da ida é do host, e a Google volta ao FRONTEND_URL.
    if ((req.headers.host ?? "").toLowerCase() !== config.host) {
      if (modo === "ligar") return res.redirect(302, rotaDoResultadoDaContaGoogle(tela, "endereco"));
      // No login e no cadastro, recomeça no endereço certo (sem sessão a perder).
      return res.redirect(302, `${config.origem}${req.originalUrl}`);
    }
    if (!cabeNoTeto(req)) return res.redirect(302, rotaDoResultadoDaContaGoogle(tela, "muitas-tentativas"));

    let userId: number | null = null;
    if (modo === "ligar") {
      const conta = await contaDaSessao(req, deps);
      if (!conta) return res.redirect(302, "/login");
      if ((await sessaoPodeLigar(conta.id, await sessionTokenDoPedido(req))) !== "ok") {
        return res.redirect(302, rotaDoResultadoDaContaGoogle(tela, "entre-de-novo"));
      }
      userId = conta.id;
    }
    const state = gerarState();
    const nonce = gerarNonce();
    const { verificador, desafio } = gerarPkce();
    const voltar = modo === "entrar" ? voltarAceitavel(req.query.voltar) : null;
    res.cookie(COOKIE_DA_IDA_DA_ENTRADA, selarIdaDaEntrada({
      state, verificador, nonce, modo, userId, voltar, expiraEm: deps.agora() + PRAZO_DA_IDA_DA_ENTRADA_MS,
    }), { ...opcoesDoCookieDaIda(req), maxAge: PRAZO_DA_IDA_DA_ENTRADA_MS });
    return res.redirect(302, urlDeAutorizacaoDaEntrada(config, { state, desafio, nonce }));
  }));

  app.get(ROTA_RETORNO_ENTRAR_COM_GOOGLE, protegida(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const config = deps.configuracao();
    if (!config) return naoExiste(res);
    const cookieDaIda = lerCookies(req.headers.cookie ?? "")[COOKIE_DA_IDA_DA_ENTRADA];
    // Uma volta só: o cookie sai já, dê no que der.
    res.clearCookie(COOKIE_DA_IDA_DA_ENTRADA, opcoesDoCookieDaIda(req));

    const aberta = abrirIdaDaEntrada(cookieDaIda, deps.agora());
    if (!aberta.ok) return res.redirect(302, rotaDoResultadoDaContaGoogle("/login", aberta.motivo === "adulterada" ? "erro" : "expirou"));
    const { ida } = aberta;
    const tela = telaDoModo(ida.modo);
    const voltar = (resultado: ResultadoDaContaGoogle) => res.redirect(302, rotaDoResultadoDaContaGoogle(tela, resultado));

    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!mesmoState(state, ida.state)) return voltar("erro");
    if (!cabeNoTeto(req)) return voltar("muitas-tentativas");
    const erroDaGoogle = typeof req.query.error === "string" ? req.query.error : "";
    if (erroDaGoogle) return voltar(erroDaGoogle === "access_denied" ? "negada" : "erro");
    const codigo = typeof req.query.code === "string" ? req.query.code : "";
    if (!codigo || codigo.length > 2048) return voltar("erro");

    // No ligar, quem volta é quem foi: a mesma conta, antes de gastar o código.
    let contaQueLiga: ContaDaSessao | null = null;
    if (ida.modo === "ligar") {
      contaQueLiga = await contaDaSessao(req, deps);
      if (!contaQueLiga || contaQueLiga.id !== ida.userId) return voltar("erro");
    }

    let tokens: TokensDaGoogle;
    try {
      tokens = await trocarCodigo(config, { codigo, verificador: ida.verificador }, deps.buscar, deps.agora());
    } catch (erro) {
      console.error(`[Entrar com Google] a troca do código falhou: ${erro instanceof RecusaDaGoogle ? erro.codigo : "erro inesperado"}`);
      return voltar("erro");
    }
    // O token de acesso não serve para nada aqui e não é guardado. Não é
    // revogado: a Google revoga por conta Google e projeto, e derrubaria a
    // conexão da Google Agenda da mesma conta Google.
    const lida = lerIdentidadeDaEntrada(tokens.idToken, { clientId: config.clientId, nonce: ida.nonce }, deps.agora());
    if (!lida.ok) {
      if (lida.motivo === "invalido") console.error("[Entrar com Google] o id_token não passou na conferência");
      return voltar(lida.motivo === "email-nao-verificado" ? "email-nao-verificado" : "erro");
    }
    const ip = ipDaCliente(req);
    const userAgent = req.headers["user-agent"];

    if (ida.modo === "ligar" && contaQueLiga) {
      const resultado = await ligarContaGoogle(contaQueLiga.id, await sessionTokenDoPedido(req), lida.identidade, { ip, userAgent }, deps.agora());
      return voltar(resultado);
    }

    const entrada = await entrarComGoogle(lida.identidade, ida.modo === "cadastrar" ? "cadastrar" : "entrar", { ip, rede: chaveDeRede(ip), userAgent }, deps.agora());
    if (!entrada.ok) {
      // Sem conta no login: o cadastro é quem cria, com o aviso de lá.
      if (entrada.resultado === "sem-conta") return res.redirect(302, rotaDoResultadoDaContaGoogle("/register", "sem-conta"));
      return voltar(entrada.resultado);
    }
    gravarCookieDaSessao(req, res, entrada.token);
    // O /login com a sessão viva segue sozinho ao destino (cadastro por concluir
    // vai ao /onboarding; o ?voltar= é conferido de novo pela tela).
    const destino = ida.voltar ? `/login?voltar=${encodeURIComponent(ida.voltar)}` : "/login";
    return res.redirect(302, destino);
  }));
}
