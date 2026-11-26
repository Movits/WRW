import crypto from "node:crypto";

/**
 * O único módulo do servidor que fala com o Daily, o fornecedor da sala de
 * vídeo (V1 do estudo docs/arquitetura/sala-de-video.md; decisão do Roberto de
 * 24/11/2026). Faz quatro coisas: lê a configuração do ambiente, cria a sala,
 * emite a ficha de entrada de cada pessoa e apaga a sala; e confere a
 * assinatura e lê o corpo dos avisos (webhook) que o Daily manda. Trocar de
 * fornecedor (o LiveKit, por exemplo) refaz este módulo e a tela da sala, não
 * as regras de server/sala-de-video.ts.
 *
 * Formatos conferidos na documentação do Daily em 26/11/2026 (docs.daily.co,
 * REST API: rooms, meeting-tokens e webhooks). Pontos que só a conta de verdade
 * prova, e por isso ficam para o teste com a conta (a V1 se testa com a API
 * dublada):
 * - `max_participants` é marcado como de plano pago: exige o cartão na conta;
 * - a unidade do cabeçalho X-Webhook-Timestamp não está escrita: aceitamos
 *   segundos ou milissegundos;
 * - a assinatura é conferida sobre o corpo CRU (a documentação mostra o
 *   JSON.stringify do corpo, que é o mesmo texto quando o Daily não reformata).
 *
 * A suíte nunca chama o Daily de verdade: quem cria o cliente passa o `fetch`,
 * e o padrão (o fetch global) recusa rodar dentro do Vitest.
 */

const API = "https://api.daily.co/v1";
/** O servidor de vídeo de São Paulo (região `geo` da sala, decisão de 24/11). */
export const REGIAO_DA_SALA = "sa-east-1";
/** Quanto o servidor espera o Daily responder antes de desistir (a tela pede de novo). */
const ESPERA_MS = 10_000;
/** A janela em que o aviso assinado vale, contra reenvio de um aviso antigo. */
const JANELA_DO_AVISO_MS = 10 * 60_000;

/** Nome da sala no Daily: letras, números e hífen, como o que o servidor gera (`sala-` + 24 hex). */
const NOME_DA_SALA = /^[a-z0-9-]{1,64}$/;
/** O subdomínio da conta no Daily (a parte antes de .daily.co). */
const SUBDOMINIO = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type ConfiguracaoDoDaily = {
  chave: string;
  /** O subdomínio da conta: o endereço da sala é https://<dominio>.daily.co/<nome>. */
  dominio: string;
  /** O segredo (em base64) com que o Daily assina os avisos; sem ele, a rota do webhook não aceita nada. */
  segredoDoWebhook: string | null;
};

const avisosDados = new Set<string>();
function avisarUmaVez(mensagem: string) {
  if (avisosDados.has(mensagem)) return;
  avisosDados.add(mensagem);
  console.warn(`[Sala de vídeo] ${mensagem}`);
}

/** Só para os testes: esquece os avisos já dados. */
export function esquecerAvisosDoDaily(): void {
  avisosDados.clear();
}

/**
 * A configuração, lida do ambiente a cada chamada: DAILY_API_KEY e
 * DAILY_DOMINIO, as duas juntas. Sem elas (ou com o domínio inválido), null, e
 * a sala some: os procedimentos recusam com SALA_INDISPONIVEL e o estado diz que
 * a função não existe. DAILY_WEBHOOK_SEGREDO é opcional: sem ela, a sala abre,
 * mas o orçamento conta cada sala pelo teto (8 pessoas por 120 minutos), porque
 * não há aviso confiável de quem entrou e saiu.
 *
 * O domínio aceita o subdomínio puro ("marquesa") ou com o resto
 * ("https://marquesa.daily.co"); guarda o subdomínio.
 */
export function configuracaoDoDaily(ambiente: NodeJS.ProcessEnv = process.env): ConfiguracaoDoDaily | null {
  const chave = (ambiente.DAILY_API_KEY ?? "").trim();
  const dominioCru = (ambiente.DAILY_DOMINIO ?? "").trim().toLowerCase();
  if (!chave && !dominioCru) return null;
  if (!chave || !dominioCru) {
    avisarUmaVez(chave
      ? "DAILY_API_KEY está definida sem DAILY_DOMINIO; as duas vão juntas. A sala de vídeo fica desligada."
      : "DAILY_DOMINIO está definida sem DAILY_API_KEY; as duas vão juntas. A sala de vídeo fica desligada.");
    return null;
  }
  const dominio = dominioCru.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.daily\.co$/, "");
  if (!SUBDOMINIO.test(dominio)) {
    avisarUmaVez(`DAILY_DOMINIO inválido ("${dominioCru}"): é o subdomínio da conta no Daily, como "marquesa" ou "marquesa.daily.co". A sala de vídeo fica desligada.`);
    return null;
  }
  const segredo = (ambiente.DAILY_WEBHOOK_SEGREDO ?? "").trim();
  let segredoDoWebhook: string | null = null;
  if (segredo) {
    if (Buffer.from(segredo, "base64").length < 16) {
      avisarUmaVez("DAILY_WEBHOOK_SEGREDO não é um segredo em base64 de 16 bytes ou mais. Os avisos do Daily ficam recusados, e o orçamento conta cada sala pelo teto.");
    } else {
      segredoDoWebhook = segredo;
    }
  }
  return { chave, dominio, segredoDoWebhook };
}

/** O Daily não respondeu, respondeu fora do esperado ou recusou. A mensagem é para o log. */
export class FalhaDoDaily extends Error {
  constructor(mensagem: string, readonly status?: number) {
    super(mensagem);
    this.name = "FalhaDoDaily";
  }
}

type Busca = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const buscaPadrao: Busca = (url, init) => {
  // A suíte nunca chama o Daily de verdade: o teste passa o próprio fetch.
  if (process.env.VITEST) return Promise.reject(new FalhaDoDaily("A suíte de testes não chama o Daily de verdade: passe um fetch dublado."));
  return fetch(url, init) as ReturnType<Busca>;
};

/** Segundos desde a época, como o Daily pede em `exp`. */
const emSegundos = (ms: number) => Math.floor(ms / 1000);

export type ClienteDoDaily = {
  /**
   * Cria a sala privada (só entra quem tem ficha), no servidor de São Paulo, com
   * o fim em `expiraEm` (quem estiver dentro sai no fim) e o teto de pessoas.
   * Sem compartilhar a tela, sem chat e sem gravação no Daily: a V1 não tem
   * nenhum dos três (a gravação é a do aparelho da dona, na V4).
   */
  criarSala(opcoes: { nome: string; expiraEm: number; pessoasMax: number }): Promise<{ nome: string; url: string }>;
  /**
   * A ficha de entrada de uma pessoa: o nome que aparece na sala, o
   * identificador opaco (o id da presença, até 36 caracteres) e, para a dona, o
   * papel de dona da sala. Vale até `expiraEm`.
   */
  emitirFicha(opcoes: { sala: string; nome: string; idDaPessoa: string; dona: boolean; expiraEm: number }): Promise<string>;
  /** Apaga a sala: quem está dentro sai na hora. A sala que já não existe conta como apagada. */
  apagarSala(nome: string): Promise<void>;
  /** O endereço da sala para a tela entrar (o SDK do cliente usa o endereço e a ficha). */
  enderecoDaSala(nome: string): string;
};

export function criarClienteDoDaily(configuracao: ConfiguracaoDoDaily, busca: Busca = buscaPadrao): ClienteDoDaily {
  const enderecoDaSala = (nome: string) => `https://${configuracao.dominio}.daily.co/${nome}`;

  async function chamar(metodo: string, caminho: string, corpo?: unknown, aceitar404 = false): Promise<Record<string, unknown>> {
    let resposta: Awaited<ReturnType<Busca>>;
    try {
      resposta = await busca(`${API}${caminho}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${configuracao.chave}`, "Content-Type": "application/json" },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(ESPERA_MS),
      });
    } catch (erro) {
      if (erro instanceof FalhaDoDaily) throw erro;
      throw new FalhaDoDaily(`o Daily não respondeu (${metodo} ${caminho.split("/")[1]}): ${erro instanceof Error ? erro.name : "erro"}`);
    }
    if (aceitar404 && resposta.status === 404) return {};
    // A resposta de erro do Daily tem `error` e `info`; vai ao log sem a chave.
    const json = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      const detalhe = json && typeof json === "object" ? String((json as { error?: unknown }).error ?? "") : "";
      throw new FalhaDoDaily(`o Daily recusou ${metodo} ${caminho.split("/")[1]} com ${resposta.status}${detalhe ? ` (${detalhe.slice(0, 80)})` : ""}`, resposta.status);
    }
    if (!json || typeof json !== "object") throw new FalhaDoDaily(`o Daily respondeu ${metodo} ${caminho.split("/")[1]} sem JSON`);
    return json as Record<string, unknown>;
  }

  return {
    enderecoDaSala,

    async criarSala({ nome, expiraEm, pessoasMax }) {
      if (!NOME_DA_SALA.test(nome)) throw new FalhaDoDaily("nome de sala fora do formato");
      const resposta = await chamar("POST", "/rooms", {
        name: nome,
        privacy: "private",
        properties: {
          exp: emSegundos(expiraEm),
          eject_at_room_exp: true,
          max_participants: pessoasMax,
          geo: REGIAO_DA_SALA,
          enable_screenshare: false,
          enable_chat: false,
          enable_knocking: false,
        },
      });
      if (resposta.name !== nome) throw new FalhaDoDaily("o Daily criou a sala com outro nome");
      return { nome, url: enderecoDaSala(nome) };
    },

    async emitirFicha({ sala, nome, idDaPessoa, dona, expiraEm }) {
      if (!NOME_DA_SALA.test(sala)) throw new FalhaDoDaily("nome de sala fora do formato");
      if (idDaPessoa.length > 36) throw new FalhaDoDaily("o identificador da pessoa passa de 36 caracteres");
      const resposta = await chamar("POST", "/meeting-tokens", {
        properties: {
          room_name: sala,
          ...(nome ? { user_name: nome } : {}),
          user_id: idDaPessoa,
          is_owner: dona,
          exp: emSegundos(expiraEm),
          enable_screenshare: false,
        },
      });
      if (typeof resposta.token !== "string" || !resposta.token) throw new FalhaDoDaily("o Daily não devolveu a ficha");
      return resposta.token;
    },

    async apagarSala(nome) {
      if (!NOME_DA_SALA.test(nome)) throw new FalhaDoDaily("nome de sala fora do formato");
      await chamar("DELETE", `/rooms/${encodeURIComponent(nome)}`, undefined, true);
    },
  };
}

/** O nome aleatório de uma sala nova no Daily: `sala-` e 24 dígitos hexadecimais (96 bits), sem nada da reunião. */
export function nomeNovoDeSala(): string {
  return `sala-${crypto.randomBytes(12).toString("hex")}`;
}

/** O momento do cabeçalho X-Webhook-Timestamp, em ms; null se não for número. Aceita segundos ou milissegundos. */
function momentoDoAviso(cabecalho: string): number | null {
  if (!/^\d{9,14}(?:\.\d+)?$/.test(cabecalho)) return null;
  const numero = Number(cabecalho);
  return numero >= 1e12 ? numero : numero * 1000;
}

/**
 * Confere a assinatura de um aviso do Daily: HMAC-SHA256, com o segredo
 * decodificado do base64, sobre `<X-Webhook-Timestamp>.<corpo cru>`, em base64
 * no cabeçalho X-Webhook-Signature. Recusa o aviso fora da janela de 10 minutos
 * (reenvio de um aviso antigo). Comparação em tempo constante.
 */
export function assinaturaDoAvisoConfere(opcoes: {
  corpo: Buffer;
  assinatura: string | undefined;
  momento: string | undefined;
  segredo: string;
  agora?: number;
}): boolean {
  const { corpo, assinatura, momento, segredo } = opcoes;
  if (!assinatura || !momento) return false;
  const quando = momentoDoAviso(momento);
  if (quando === null || Math.abs((opcoes.agora ?? Date.now()) - quando) > JANELA_DO_AVISO_MS) return false;
  const esperada = crypto.createHmac("sha256", Buffer.from(segredo, "base64"))
    .update(Buffer.concat([Buffer.from(`${momento}.`, "utf8"), corpo]))
    .digest();
  const recebida = Buffer.from(assinatura, "base64");
  return recebida.length === esperada.length && crypto.timingSafeEqual(recebida, esperada);
}

/** Um aviso do Daily que muda a conta da sala. Os momentos em ms. */
export type AvisoDaSala =
  | { tipo: "entrou"; sala: string; pessoa: string | null; sessao: string; em: number }
  | { tipo: "saiu"; sala: string; pessoa: string | null; sessao: string; em: number; segundos: number | null }
  | { tipo: "fim"; sala: string; em: number };

const texto = (valor: unknown, max: number) => (typeof valor === "string" && valor.length > 0 && valor.length <= max ? valor : null);
const numero = (valor: unknown) => (typeof valor === "number" && Number.isFinite(valor) && valor >= 0 ? valor : null);

/**
 * Lê o corpo de um aviso do Daily (participant.joined, participant.left e
 * meeting.ended). Devolve null para o que não muda a conta: outro tipo de aviso,
 * o pedido de teste que o Daily manda ao criar o webhook (`{"test":"test"}`) e
 * o corpo fora do formato. Os momentos do Daily vêm em segundos (com fração).
 */
export function lerAvisoDoDaily(corpo: Buffer): AvisoDaSala | null {
  let json: unknown;
  try {
    json = JSON.parse(corpo.toString("utf8"));
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const { type, payload } = json as { type?: unknown; payload?: unknown };
  if (!payload || typeof payload !== "object") return null;
  const dados = payload as Record<string, unknown>;
  const sala = texto(dados.room, 64);
  if (!sala) return null;
  if (type === "meeting.ended") {
    const fim = numero(dados.end_ts);
    return fim === null ? null : { tipo: "fim", sala, em: Math.round(fim * 1000) };
  }
  if (type !== "participant.joined" && type !== "participant.left") return null;
  const sessao = texto(dados.session_id, 64);
  const entrouEm = numero(dados.joined_at);
  if (!sessao || entrouEm === null) return null;
  const pessoa = texto(dados.user_id, 36);
  if (type === "participant.joined") return { tipo: "entrou", sala, pessoa, sessao, em: Math.round(entrouEm * 1000) };
  // A saída é a entrada mais a duração, que o Daily mede; o event_ts é a hora do envio do aviso.
  const segundos = numero(dados.duration);
  return { tipo: "saiu", sala, pessoa, sessao, em: Math.round((entrouEm + (segundos ?? 0)) * 1000), segundos };
}
