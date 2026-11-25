import crypto from "node:crypto";
import { ROTA_RETORNO_GOOGLE_AGENDA } from "@shared/google-agenda";
import { decryptData, encryptData } from "./security";

/**
 * A conversa com a Google para a agenda da dona (H16b do plano do gravador), sem
 * biblioteca: são quatro chamadas (autorizar, trocar o código, renovar e
 * revogar), e o Node 20 já tem fetch, AbortSignal.timeout e crypto. O
 * package.json não ganha google-auth-library, gaxios nem jws, e o fetch entra
 * por parâmetro para o teste dublá-lo.
 *
 * Nada daqui escreve token em log nem em mensagem de erro: o erro leva só o
 * código que a Google devolveu (invalid_grant, invalid_token...) e o status
 * HTTP. O token vai sempre no CORPO do POST, nunca na URL.
 *
 * Fora deste arquivo: o banco (server/google-agenda.ts) e as duas rotas da ida
 * e da volta (server/rotas-da-google-agenda.ts).
 */

export const URL_DE_AUTORIZACAO = "https://accounts.google.com/o/oauth2/v2/auth";
export const URL_DO_TOKEN = "https://oauth2.googleapis.com/token";
export const URL_DE_REVOGACAO = "https://oauth2.googleapis.com/revoke";

/** Criar, mudar e excluir eventos (a H16c). É o escopo que a conexão existe para ter. */
export const ESCOPO_DA_AGENDA = "https://www.googleapis.com/auth/calendar.events";
/** Os três cadastrados no Google Cloud: o e-mail só serve para a dona saber qual conta ligou. */
export const ESCOPOS_PEDIDOS = ["openid", "email", ESCOPO_DA_AGENDA] as const;
const EMISSORES_DO_ID_TOKEN = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** O mesmo piso de server/security.ts: abaixo dele, encryptData usa a chave derivada do JWT_SECRET. */
export const TAMANHO_MINIMO_DA_CHAVE_DO_COFRE = 32;
/** Prazo de cada chamada à Google. */
export const PRAZO_DAS_CHAMADAS_MS = 10_000;

export type Fetch = (entrada: string, init?: RequestInit) => Promise<Response>;

/** O fetch global lido na hora da chamada (o teste que troca o global também vale). */
export const fetchGlobal: Fetch = (entrada, init) => fetch(entrada, init);

export type ConfiguracaoDaGoogleAgenda = {
  clientId: string;
  clientSecret: string;
  /** A origem pública do site (FRONTEND_URL), sem caminho e sem barra no fim. */
  origem: string;
  /** O host da origem, em minúsculas: a ida e a volta só funcionam nele. */
  host: string;
  /** O URI de retorno cadastrado no cliente OAuth do Google Cloud. */
  redirectUri: string;
  /** Quem vê a função (GOOGLE_AGENDA_LIBERADA_PARA): todas as contas da WRW, ou só as da lista. */
  liberadaPara: "todas" | ReadonlySet<number>;
};

/**
 * As contas da WRW que veem a função, lidas de GOOGLE_AGENDA_LIBERADA_PARA:
 * "todas", ou os ids das contas separados por vírgula. Vazio, ausente ou sem
 * nenhum id válido é null, e a função some para todas.
 *
 * Por quê: enquanto o app do Google Cloud está em modo Teste, a Google só deixa
 * autorizar as contas Google da lista de usuários de teste (até 100). As outras
 * param numa página de erro da própria Google (Erro 403: access_denied), sem
 * voltar à WRW e sem aviso nosso. Então, até a Google verificar o app, a seção
 * aparece só para as contas da WRW cujas contas Google estão nessa lista; depois
 * da verificação, o valor vira "todas". Esquecer a variável deixa a função
 * escondida, e não um botão que não funciona diante de todo mundo.
 */
export function lerContasLiberadas(valor: string | undefined): "todas" | ReadonlySet<number> | null {
  const texto = valor?.trim() ?? "";
  if (!texto) return null;
  if (texto.toLowerCase() === "todas") return "todas";
  const ids = new Set<number>();
  for (const parte of texto.split(/[\s,;]+/)) {
    if (/^[1-9]\d{0,9}$/.test(parte)) ids.add(Number(parte));
  }
  return ids.size ? ids : null;
}

/** Esta conta da WRW vê a função? (Ver lerContasLiberadas.) */
export function googleAgendaLiberadaPara(config: ConfiguracaoDaGoogleAgenda, userId: number): boolean {
  return config.liberadaPara === "todas" || config.liberadaPara.has(userId);
}

/**
 * A configuração lida do ambiente A CADA CHAMADA, ou null. Sem qualquer uma das
 * cinco variáveis, a função some: a seção do Perfil não aparece e as rotas dão
 * 404. Só os nomes vão ao código; os valores ficam no painel do Render.
 *
 * A VAULT_ENCRYPTION_KEY é exigida, com 32 caracteres ou mais. Sem ela,
 * encryptData deriva a chave do JWT_SECRET (server/security.ts): trocar o
 * JWT_SECRET para derrubar as sessões apagaria todas as conexões, e um
 * vazamento dele abriria os tokens.
 *
 * O FRONTEND_URL vira o URI de retorno. Precisa ser https, menos na máquina de
 * quem desenvolve (http://localhost, que a Google aceita no cliente de dev).
 *
 * A GOOGLE_AGENDA_LIBERADA_PARA diz quem vê a função (lerContasLiberadas): a
 * configuração existe, e cada rota confere a conta com googleAgendaLiberadaPara.
 */
export function configuracaoDaGoogleAgenda(ambiente: NodeJS.ProcessEnv = process.env): ConfiguracaoDaGoogleAgenda | null {
  const clientId = ambiente.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = ambiente.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const frontendUrl = ambiente.FRONTEND_URL?.trim();
  const chaveDoCofre = ambiente.VAULT_ENCRYPTION_KEY ?? "";
  const liberadaPara = lerContasLiberadas(ambiente.GOOGLE_AGENDA_LIBERADA_PARA);
  if (!clientId || !clientSecret || !frontendUrl || chaveDoCofre.length < TAMANHO_MINIMO_DA_CHAVE_DO_COFRE || !liberadaPara) return null;
  let url: URL;
  try {
    url = new URL(frontendUrl);
  } catch {
    return null;
  }
  const naMaquina = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && naMaquina)) return null;
  return {
    clientId,
    clientSecret,
    origem: url.origin,
    host: url.host.toLowerCase(),
    redirectUri: `${url.origin}${ROTA_RETORNO_GOOGLE_AGENDA}`,
    liberadaPara,
  };
}

/** A configuração, só se esta conta vê a função; senão null, como se faltasse variável. */
export function configuracaoDaGoogleAgendaPara(userId: number, ambiente: NodeJS.ProcessEnv = process.env): ConfiguracaoDaGoogleAgenda | null {
  const config = configuracaoDaGoogleAgenda(ambiente);
  return config && googleAgendaLiberadaPara(config, userId) ? config : null;
}

// ── state e PKCE ────────────────────────────────────────────────────────────

/** O state da ida: 32 bytes aleatórios. Vai à Google e volta; o cookie guarda a cópia. */
export function gerarState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * O par do PKCE (RFC 7636, S256). O verificador (43 caracteres, o mínimo da
 * norma) fica no cookie da ida e só sai do servidor na troca do código; à Google
 * vai o desafio, que não deixa refazer o verificador.
 */
export function gerarPkce(): { verificador: string; desafio: string } {
  const verificador = crypto.randomBytes(32).toString("base64url");
  return { verificador, desafio: desafioDoPkce(verificador) };
}

/** base64url(sha256(verificador)), sem "=" no fim. */
export function desafioDoPkce(verificador: string): string {
  return crypto.createHash("sha256").update(verificador, "ascii").digest("base64url");
}

/** Os dois states são iguais? Em tempo constante. */
export function mesmoState(recebido: string, guardado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(guardado);
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * O endereço da tela de consentimento da Google.
 * - `access_type=offline` e `prompt=consent`: a Google só manda o refresh token
 *   assim, e manda um a cada conexão (reconectar troca o antigo).
 * - Sem `include_granted_scopes`: o `scope` que volta diz só o que a dona deu
 *   desta vez, e a volta confere a agenda nele.
 */
export function urlDeAutorizacao(config: ConfiguracaoDaGoogleAgenda, ida: { state: string; desafio: string }): string {
  const parametros = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: ESCOPOS_PEDIDOS.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: ida.state,
    code_challenge: ida.desafio,
    code_challenge_method: "S256",
  });
  return `${URL_DE_AUTORIZACAO}?${parametros.toString()}`;
}

// ── o cookie da ida ─────────────────────────────────────────────────────────

/** HttpOnly, SameSite=Lax (volta na navegação GET vinda da Google) e só no caminho das rotas. */
export const COOKIE_DA_IDA = "wrw_google_agenda";
export const CAMINHO_DO_COOKIE_DA_IDA = "/api/google-agenda";
export const PRAZO_DA_IDA_MS = 10 * 60_000;

export type Ida = { state: string; verificador: string; userId: number; expiraEm: number };

/** O cookie da ida, cifrado e autenticado (AES-256-GCM, encryptData): ninguém lê nem muda. */
export function selarIda(ida: Ida): string {
  return encryptData(JSON.stringify({ s: ida.state, v: ida.verificador, u: ida.userId, e: ida.expiraEm }));
}

export type IdaAberta =
  | { ok: true; ida: Ida }
  | { ok: false; motivo: "ausente" | "adulterada" | "vencida" };

/** Abre o cookie da ida. Adulterado (ou cifrado com outra chave) não decifra: é recusado. */
export function abrirIda(valor: string | undefined, agora: number = Date.now()): IdaAberta {
  if (!valor) return { ok: false, motivo: "ausente" };
  let dados: unknown;
  try {
    dados = JSON.parse(decryptData(valor));
  } catch {
    return { ok: false, motivo: "adulterada" };
  }
  const { s, v, u, e } = (dados && typeof dados === "object" ? dados : {}) as Record<string, unknown>;
  if (typeof s !== "string" || typeof v !== "string" || typeof u !== "number" || typeof e !== "number") {
    return { ok: false, motivo: "adulterada" };
  }
  if (e <= agora) return { ok: false, motivo: "vencida" };
  return { ok: true, ida: { state: s, verificador: v, userId: u, expiraEm: e } };
}

// ── as chamadas ao servidor de tokens ──────────────────────────────────────

/** A Google recusou, ou não respondeu. `codigo` é o `error` dela (só letras e "_") ou "http_<status>", "rede", "resposta". */
export class RecusaDaGoogle extends Error {
  readonly codigo: string;
  readonly status: number | null;
  constructor(codigo: string, status: number | null) {
    super(`A Google recusou a chamada: ${codigo}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "RecusaDaGoogle";
    this.codigo = codigo;
    this.status = status;
  }
}

/**
 * O refresh token não vale mais (invalid_grant): a dona tirou o acesso da WRW na
 * conta Google, trocou a senha, ou o modo Teste do Google Cloud venceu (7 dias).
 */
export class ConexaoGoogleRevogada extends Error {
  constructor() {
    super("A Google não aceita mais o refresh token desta conexão.");
    this.name = "ConexaoGoogleRevogada";
  }
}

function codigoDoErro(corpo: Record<string, unknown>, status: number): string {
  const erro = corpo.error;
  return typeof erro === "string" && /^[a-z_]{1,40}$/.test(erro) ? erro : `http_${status}`;
}

async function postarFormulario(url: string, campos: Record<string, string>, buscar: Fetch) {
  let resposta: Response;
  try {
    resposta = await buscar(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(campos).toString(),
      signal: AbortSignal.timeout(PRAZO_DAS_CHAMADAS_MS),
    });
  } catch {
    // A mensagem do erro de rede fica de fora: o log diz só "rede".
    throw new RecusaDaGoogle("rede", null);
  }
  let corpo: Record<string, unknown> = {};
  try {
    const lido = await resposta.json();
    if (lido && typeof lido === "object") corpo = lido as Record<string, unknown>;
  } catch {
    // Corpo vazio ou fora do JSON (o 200 da revogação pode vir vazio).
  }
  return { ok: resposta.ok, status: resposta.status, corpo };
}

export type TokensDaGoogle = {
  accessToken: string;
  /** Quando o token de acesso vence, em ms desde 1970. */
  expiraEm: number;
  refreshToken: string | null;
  /** Os escopos que a Google deu, como ela os devolve ("email" volta como .../userinfo.email). */
  escopos: string[];
  idToken: string | null;
};

function lerTokens(corpo: Record<string, unknown>, status: number, agora: number): TokensDaGoogle {
  const accessToken = typeof corpo.access_token === "string" ? corpo.access_token : "";
  if (!accessToken) throw new RecusaDaGoogle("resposta", status);
  const segundos = typeof corpo.expires_in === "number" && Number.isFinite(corpo.expires_in) && corpo.expires_in > 0 ? corpo.expires_in : 3600;
  return {
    accessToken,
    expiraEm: agora + segundos * 1000,
    refreshToken: typeof corpo.refresh_token === "string" && corpo.refresh_token ? corpo.refresh_token : null,
    escopos: typeof corpo.scope === "string" ? corpo.scope.split(/\s+/).filter(Boolean) : [],
    idToken: typeof corpo.id_token === "string" && corpo.id_token ? corpo.id_token : null,
  };
}

/**
 * Troca o código da volta pelos tokens, com o verificador do PKCE. Serve à
 * Google Agenda e à entrada com o Google (A8, server/entrar-com-google.ts): as
 * duas usam o mesmo cliente OAuth, cada uma com o seu URI de retorno.
 */
export async function trocarCodigo(
  config: Pick<ConfiguracaoDaGoogleAgenda, "clientId" | "clientSecret" | "redirectUri">,
  dados: { codigo: string; verificador: string },
  buscar: Fetch = fetchGlobal,
  agora: number = Date.now(),
): Promise<TokensDaGoogle> {
  const { ok, status, corpo } = await postarFormulario(URL_DO_TOKEN, {
    grant_type: "authorization_code",
    code: dados.codigo,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code_verifier: dados.verificador,
  }, buscar);
  if (!ok) throw new RecusaDaGoogle(codigoDoErro(corpo, status), status);
  return lerTokens(corpo, status, agora);
}

/** Um token de acesso novo pelo refresh token. invalid_grant vira ConexaoGoogleRevogada. */
export async function renovarAcesso(
  config: ConfiguracaoDaGoogleAgenda,
  refreshToken: string,
  buscar: Fetch = fetchGlobal,
  agora: number = Date.now(),
): Promise<TokensDaGoogle> {
  const { ok, status, corpo } = await postarFormulario(URL_DO_TOKEN, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }, buscar);
  if (!ok) {
    const codigo = codigoDoErro(corpo, status);
    if (codigo === "invalid_grant") throw new ConexaoGoogleRevogada();
    throw new RecusaDaGoogle(codigo, status);
  }
  return lerTokens(corpo, status, agora);
}

/**
 * Revoga o token na Google. true quando a Google confirmou, ou quando o token já
 * não valia (400 invalid_token): nos dois casos ele não abre mais nada. false
 * na falha de rede ou de servidor; quem chama decide o que fazer com isso.
 * Nunca lança.
 *
 * ATENÇÃO: a Google revoga por conta Google e projeto do Google Cloud, não por
 * token. Revogar QUALQUER token, de acesso ou refresh, tira a autorização
 * inteira daquela conta Google no projeto, com todos os tokens de todos os
 * clientes do projeto ("Revocation removes all OAuth 2.0 scopes previously
 * granted to a project, invalidating any issued access or refresh tokens for
 * all clients registered under that project", na documentação do OAuth para
 * servidor web). Revogar o token de uma conexão derruba toda outra conexão com a
 * mesma conta Google: a nova, numa reconexão, ou a de outra conta da WRW. Quem
 * chama confere antes pelo `sub` da conta (server/google-agenda.ts).
 */
export async function revogarToken(token: string, buscar: Fetch = fetchGlobal): Promise<boolean> {
  try {
    const { ok, status, corpo } = await postarFormulario(URL_DE_REVOGACAO, { token }, buscar);
    if (ok) return true;
    return status === 400 && codigoDoErro(corpo, status) === "invalid_token";
  } catch {
    return false;
  }
}

/** A dona deu a permissão da agenda? O consentimento granular da Google deixa desmarcá-la. */
export function temEscopoDaAgenda(escopos: readonly string[]): boolean {
  return escopos.includes(ESCOPO_DA_AGENDA);
}

/** A conta Google de quem autorizou, tirada do id_token. */
export type IdentidadeGoogle = {
  /**
   * O id da conta Google: nunca muda nem é reusado (o e-mail pode mudar). É por
   * ele que a WRW sabe se duas conexões dividem a mesma autorização na Google.
   */
  sub: string;
  /** Só para a dona saber qual conta ligou; nada decide por ele. */
  email: string | null;
};

/**
 * A conta Google do id_token (o `sub` e o e-mail), ou null. O id_token veio
 * direto do endpoint de token da Google, pelo TLS, em troca do código e do
 * segredo do cliente: pela OpenID Connect (3.1.3.7), a assinatura pode ficar
 * sem conferir, mas o destinatário e o emissor são conferidos. Sem um `sub`
 * válido (até 255 caracteres ASCII visíveis, como a Google documenta), null: sem
 * ele, a WRW não saberia o que pode revogar.
 */
export function identidadeDoIdToken(idToken: string | null, clientId: string): IdentidadeGoogle | null {
  if (!idToken) return null;
  const partes = idToken.split(".");
  if (partes.length !== 3) return null;
  let dados: Record<string, unknown>;
  try {
    const lido = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
    if (!lido || typeof lido !== "object") return null;
    dados = lido as Record<string, unknown>;
  } catch {
    return null;
  }
  const destinatario = dados.aud;
  const paraNos = destinatario === clientId || (Array.isArray(destinatario) && destinatario.includes(clientId));
  if (!paraNos || !EMISSORES_DO_ID_TOKEN.has(String(dados.iss))) return null;
  const sub = typeof dados.sub === "string" ? dados.sub : "";
  if (!/^[\x21-\x7e]{1,255}$/.test(sub)) return null;
  const email = typeof dados.email === "string" ? dados.email.trim().toLowerCase() : "";
  return { sub, email: email && email.length <= 320 && email.includes("@") ? email : null };
}
