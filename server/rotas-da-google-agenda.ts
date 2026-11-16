import type { CookieOptions, Express, Request, Response } from "express";
import { parse as lerCookies } from "cookie";
import {
  ROTA_CONECTAR_GOOGLE_AGENDA,
  ROTA_RETORNO_GOOGLE_AGENDA,
  rotaDoResultadoNoPerfil,
  type ResultadoDaGoogleAgenda,
} from "@shared/google-agenda";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "./banco-indisponivel";
import { contaGoogleEmUso, gravarConexaoGoogle } from "./google-agenda";
import {
  abrirIda,
  CAMINHO_DO_COOKIE_DA_IDA,
  COOKIE_DA_IDA,
  configuracaoDaGoogleAgenda,
  fetchGlobal,
  gerarPkce,
  gerarState,
  googleAgendaLiberadaPara,
  identidadeDoIdToken,
  mesmoState,
  PRAZO_DA_IDA_MS,
  RecusaDaGoogle,
  revogarToken,
  selarIda,
  temEscopoDaAgenda,
  trocarCodigo,
  urlDeAutorizacao,
  type ConfiguracaoDaGoogleAgenda,
  type Fetch,
  type TokensDaGoogle,
} from "./google-oauth";
import { ipDaCliente } from "./ip-da-cliente";

/**
 * As duas rotas da conexão com a Google Agenda (H16b do plano do gravador),
 * Express e não tRPC: a ida e a volta são navegação GET de página inteira, e
 * cada uma termina num redirecionamento (à Google, ou de volta ao Perfil com
 * `?google=`, que a tela traduz). Montadas em server/_core/index.ts perto das
 * rotas do link aberto. As dependências entram por parâmetro só para o teste
 * trocá-las (molde: server/_core/rota-das-partes.ts).
 *
 * - `GET /api/google-agenda/conectar`: confere o endereço e a sessão, gera o
 *   state e o PKCE, guarda os dois no cookie da ida (cifrado, HttpOnly, 10 min)
 *   e manda à tela de consentimento da Google.
 * - `GET /api/google-agenda/retorno`: confere o cookie (que sai na hora), o
 *   state e a conta; troca o código com o verificador; exige a permissão da
 *   agenda e a conta Google (o `sub` do id_token); grava a conexão com a prova;
 *   revoga a conexão anterior quando a gravação manda.
 *
 * Sem as variáveis (configuracaoDaGoogleAgenda), as duas dão 404: a função some.
 * Com elas, a conta fora de GOOGLE_AGENDA_LIBERADA_PARA também recebe 404.
 * Nenhuma resposta vai para cache, e nenhum log leva token.
 */

type ContaDaSessao = { id: number; onboardingCompleted?: boolean | null; isCron?: boolean };

export type DependenciasDaGoogleAgenda = {
  configuracao: () => ConfiguracaoDaGoogleAgenda | null;
  autenticar: (req: Request) => Promise<ContaDaSessao>;
  buscar: Fetch;
  gravar: typeof gravarConexaoGoogle;
  contaGoogleEmUso: typeof contaGoogleEmUso;
  agora: () => number;
};

const PADRAO: DependenciasDaGoogleAgenda = {
  configuracao: () => configuracaoDaGoogleAgenda(),
  autenticar: req => sdk.authenticateRequest(req),
  buscar: fetchGlobal,
  gravar: gravarConexaoGoogle,
  contaGoogleEmUso,
  agora: () => Date.now(),
};

/** As opções do cookie da sessão (HttpOnly, SameSite=Lax, Secure no https), só no caminho destas rotas. */
function opcoesDoCookieDaIda(req: Request): CookieOptions {
  return { ...getSessionCookieOptions(req), path: CAMINHO_DO_COOKIE_DA_IDA };
}

/**
 * A conta da sessão, ou null depois de responder. Sem sessão vai ao login;
 * cadastro incompleto, ao cadastro; banco fora do ar NÃO é "sem sessão": volta
 * ao Perfil com o erro. Cron não conecta agenda de ninguém.
 */
async function contaDaSessao(req: Request, res: Response, deps: DependenciasDaGoogleAgenda): Promise<ContaDaSessao | null> {
  let conta: ContaDaSessao;
  try {
    conta = await deps.autenticar(req);
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) {
      console.error(`[Google Agenda] banco fora do ar ao ler a sessão: ${descreverErroDeBanco(erro)}`);
      res.redirect(302, rotaDoResultadoNoPerfil("erro"));
      return null;
    }
    res.redirect(302, "/login");
    return null;
  }
  if (conta.isCron) {
    res.status(403).type("text/plain").send("Proibido.");
    return null;
  }
  if (!conta.onboardingCompleted) {
    res.redirect(302, "/onboarding");
    return null;
  }
  return conta;
}

function naoExiste(res: Response) {
  res.status(404).type("text/plain").send("Não encontrado.");
}

/** O que foi feito da autorização que a Google deu e que não vai ficar. */
type Descarte = "revogada" | "mantida" | "falhou";

/**
 * A autorização que a Google acabou de dar não vai ficar (sem a agenda, sem o
 * refresh token, sem a conta Google ou a gravação falhou). A Google revoga por
 * conta Google e projeto, não por token: revogar o token novo derrubaria
 * também a conexão gravada que usa a mesma conta Google (desta conta da WRW,
 * numa reconexão, ou de outra), e a tela continuaria dizendo "conectada".
 * Então só revoga quando nenhuma conexão usa a mesma conta. Sem o banco para
 * conferir, não revoga: a autorização fica na Google sem ninguém com o token,
 * o que é melhor que derrubar uma conexão às escondidas. Sem a conta Google
 * (o id_token não veio), revoga: não há o que conferir. Nunca lança, e o log
 * não leva token.
 */
async function descartarAutorizacao(token: string, sub: string | null, deps: DependenciasDaGoogleAgenda): Promise<Descarte> {
  if (sub) {
    let emUso: boolean;
    try {
      emUso = await deps.contaGoogleEmUso(sub);
    } catch (erro) {
      console.warn(`[Google Agenda] a autorização que não ficou não foi revogada: sem o banco, não deu para saber se outra conexão usa a mesma conta Google (${descreverErroDeBanco(erro)})`);
      return "mantida";
    }
    if (emUso) {
      console.warn("[Google Agenda] a autorização que não ficou não foi revogada: outra conexão usa a mesma conta Google");
      return "mantida";
    }
  }
  if (await revogarToken(token, deps.buscar)) return "revogada";
  console.warn("[Google Agenda] a Google não confirmou a revogação da autorização que não ficou");
  return "falhou";
}

/**
 * O Express 4 não pega a rejeição de um handler assíncrono, e uma rejeição
 * solta derruba o processo. O que escapar volta ao Perfil como erro, com o
 * log sem token (descreverErroDeBanco tira os parâmetros das consultas).
 */
function protegida(rota: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await rota(req, res);
    } catch (erro) {
      console.error(`[Google Agenda] falha inesperada: ${descreverErroDeBanco(erro)}`);
      if (!res.headersSent) res.redirect(302, rotaDoResultadoNoPerfil("erro"));
    }
  };
}

export function registrarRotasDaGoogleAgenda(app: Express, deps: DependenciasDaGoogleAgenda = PADRAO) {
  app.get(ROTA_CONECTAR_GOOGLE_AGENDA, protegida(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const config = deps.configuracao();
    if (!config) return naoExiste(res);
    // O cookie da ida é do host, e a Google volta ao FRONTEND_URL: quem começa
    // por outro endereço (o do Render, por exemplo) voltaria sem o cookie.
    if ((req.headers.host ?? "").toLowerCase() !== config.host) {
      return res.redirect(302, rotaDoResultadoNoPerfil("endereco"));
    }
    const conta = await contaDaSessao(req, res, deps);
    if (!conta) return;
    // Em modo Teste, a Google só deixa autorizar as contas Google da lista de
    // teste: as outras contas da WRW parariam numa página de erro da Google.
    if (!googleAgendaLiberadaPara(config, conta.id)) return naoExiste(res);
    const state = gerarState();
    const { verificador, desafio } = gerarPkce();
    res.cookie(COOKIE_DA_IDA, selarIda({ state, verificador, userId: conta.id, expiraEm: deps.agora() + PRAZO_DA_IDA_MS }), {
      ...opcoesDoCookieDaIda(req),
      maxAge: PRAZO_DA_IDA_MS,
    });
    return res.redirect(302, urlDeAutorizacao(config, { state, desafio }));
  }));

  app.get(ROTA_RETORNO_GOOGLE_AGENDA, protegida(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const config = deps.configuracao();
    if (!config) return naoExiste(res);
    const cookieDaIda = lerCookies(req.headers.cookie ?? "")[COOKIE_DA_IDA];
    // O cookie vale uma volta só: sai já, dê no que der. Sem maxAge aqui: no
    // Express 4 ele refaria a validade e o cookie não sairia.
    res.clearCookie(COOKIE_DA_IDA, opcoesDoCookieDaIda(req));
    const voltar = (resultado: ResultadoDaGoogleAgenda) => res.redirect(302, rotaDoResultadoNoPerfil(resultado));

    const conta = await contaDaSessao(req, res, deps);
    if (!conta) return;
    if (!googleAgendaLiberadaPara(config, conta.id)) return naoExiste(res);

    const aberta = abrirIda(cookieDaIda, deps.agora());
    if (!aberta.ok) return voltar(aberta.motivo === "adulterada" ? "erro" : "expirou");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    // O state prova que a volta é desta ida; a conta, que quem volta é quem foi.
    if (!mesmoState(state, aberta.ida.state) || aberta.ida.userId !== conta.id) return voltar("erro");

    const erroDaGoogle = typeof req.query.error === "string" ? req.query.error : "";
    if (erroDaGoogle) return voltar(erroDaGoogle === "access_denied" ? "negada" : "erro");
    const codigo = typeof req.query.code === "string" ? req.query.code : "";
    if (!codigo || codigo.length > 2048) return voltar("erro");

    let tokens: TokensDaGoogle;
    try {
      tokens = await trocarCodigo(config, { codigo, verificador: aberta.ida.verificador }, deps.buscar, deps.agora());
    } catch (erro) {
      console.error(`[Google Agenda] a troca do código falhou: ${erro instanceof RecusaDaGoogle ? erro.codigo : "erro inesperado"}`);
      return voltar("erro");
    }

    // A conta Google decide o que se pode revogar (descartarAutorizacao).
    const identidade = identidadeDoIdToken(tokens.idToken, config.clientId);
    const descartar = (token: string) => descartarAutorizacao(token, identidade?.sub ?? null, deps);
    // Quando a Google não confirma a revogação, a dona fica sabendo que a
    // autorização pode ter ficado na conta Google dela.
    const voltarComErro = (descarte: Descarte) => voltar(descarte === "falhou" ? "erro-acesso-ficou" : "erro");

    // O consentimento granular da Google deixa desmarcar a agenda. Sem ela a
    // conexão não serve para nada, e o que a Google deu sai revogado.
    if (!temEscopoDaAgenda(tokens.escopos)) {
      await descartar(tokens.refreshToken ?? tokens.accessToken);
      return voltar("sem-permissao");
    }
    if (!tokens.refreshToken) {
      console.error("[Google Agenda] a Google não mandou o refresh token");
      return voltarComErro(await descartar(tokens.accessToken));
    }
    if (!identidade) {
      // Sem a conta Google, a WRW não saberia depois o que pode revogar.
      console.error("[Google Agenda] o id_token não trouxe a conta Google");
      return voltarComErro(await descartar(tokens.refreshToken));
    }

    let anterior: string | null;
    try {
      ({ anterior } = await deps.gravar(conta.id, {
        refreshToken: tokens.refreshToken,
        sub: identidade.sub,
        email: identidade.email,
        escopos: tokens.escopos,
        acesso: { token: tokens.accessToken, expiraEm: tokens.expiraEm },
      }, { ipAddress: ipDaCliente(req), userAgent: req.headers["user-agent"] }, deps.agora()));
    } catch (erro) {
      // Sem a linha e a prova, a conexão não vale: a autorização nova sai.
      console.error(`[Google Agenda] a conexão não foi gravada: ${descreverErroDeBanco(erro)}`);
      return voltarComErro(await descartar(tokens.refreshToken));
    }

    // A gravação só devolve o anterior quando ele era de outra conta Google
    // que ninguém mais usa (gravarConexaoGoogle). Ele sai por melhor esforço:
    // a nova já vale. O mesmo refresh token nunca é revogado: derrubaria a nova.
    if (anterior && anterior !== tokens.refreshToken && !(await revogarToken(anterior, deps.buscar))) {
      console.warn("[Google Agenda] a Google não confirmou a revogação da conexão anterior");
    }
    return voltar("conectada");
  }));
}
