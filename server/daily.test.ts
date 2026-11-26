import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assinaturaDoAvisoConfere, configuracaoDoDaily, criarClienteDoDaily, esquecerAvisosDoDaily, FalhaDoDaily, lerAvisoDoDaily, nomeNovoDeSala, REGIAO_DA_SALA,
} from "./daily";

/**
 * O módulo do Daily (sala de vídeo, V1) com a API dublada: a suíte nunca chama
 * o Daily de verdade. O `fetch` é um dublê que guarda o pedido e devolve a
 * resposta escrita a partir da documentação do Daily (REST API: rooms,
 * meeting-tokens e webhooks, conferida em 26/11/2026).
 */

const SEGREDO = Buffer.from("segredo-do-webhook-de-teste-32by").toString("base64");
const CONFIGURACAO = { chave: "chave-de-teste-nao-e-real", dominio: "marquesa", segredoDoWebhook: SEGREDO };

type Pedido = { url: string; method: string; headers: Record<string, string>; body?: string };
function dubleDoFetch(respostas: Array<{ status: number; json: unknown }>) {
  const pedidos: Pedido[] = [];
  const busca = vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    pedidos.push({ url, method: init.method, headers: init.headers, body: init.body });
    const resposta = respostas.shift() ?? { status: 500, json: { error: "sem resposta no dublê" } };
    return { ok: resposta.status >= 200 && resposta.status < 300, status: resposta.status, json: async () => resposta.json };
  });
  return { busca, pedidos };
}

beforeEach(() => {
  esquecerAvisosDoDaily();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("a configuração (sem as duas variáveis, a sala some)", () => {
  it("sem nenhuma: null, sem aviso no log", () => {
    expect(configuracaoDoDaily({})).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("só uma das duas: null, com o aviso de que vão juntas", () => {
    expect(configuracaoDoDaily({ DAILY_API_KEY: "x" })).toBeNull();
    expect(configuracaoDoDaily({ DAILY_DOMINIO: "marquesa" })).toBeNull();
    expect(JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)).toContain("as duas vão juntas");
  });

  it("o domínio aceita o subdomínio puro ou com https:// e .daily.co, e recusa o resto", () => {
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "marquesa" })?.dominio).toBe("marquesa");
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "https://Marquesa.daily.co/" })?.dominio).toBe("marquesa");
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "marquesa.daily.co" })?.dominio).toBe("marquesa");
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "mar quesa" })).toBeNull();
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "-marquesa" })).toBeNull();
  });

  it("o segredo do webhook é opcional; o curto demais fica de fora, com aviso", () => {
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "m" })?.segredoDoWebhook).toBeNull();
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "m", DAILY_WEBHOOK_SEGREDO: SEGREDO })?.segredoDoWebhook).toBe(SEGREDO);
    expect(configuracaoDoDaily({ DAILY_API_KEY: "k", DAILY_DOMINIO: "m", DAILY_WEBHOOK_SEGREDO: "YWJj" })?.segredoDoWebhook).toBeNull();
    expect(JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)).toContain("DAILY_WEBHOOK_SEGREDO");
  });
});

describe("criar a sala", () => {
  it("privada, em São Paulo, com o fim em segundos, quem está dentro saindo no fim, 8 pessoas, sem tela, chat nem gravação no Daily", async () => {
    const { busca, pedidos } = dubleDoFetch([{ status: 200, json: { id: "id-1", name: "sala-abc", privacy: "private", url: "https://marquesa.daily.co/sala-abc" } }]);
    const cliente = criarClienteDoDaily(CONFIGURACAO, busca);
    const expiraEm = 1_795_700_000_123;
    const sala = await cliente.criarSala({ nome: "sala-abc", expiraEm, pessoasMax: 8 });
    expect(sala).toEqual({ nome: "sala-abc", url: "https://marquesa.daily.co/sala-abc" });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].url).toBe("https://api.daily.co/v1/rooms");
    expect(pedidos[0].method).toBe("POST");
    expect(pedidos[0].headers.Authorization).toBe("Bearer chave-de-teste-nao-e-real");
    const corpo = JSON.parse(pedidos[0].body!);
    expect(corpo).toEqual({
      name: "sala-abc",
      privacy: "private",
      properties: {
        exp: 1_795_700_000, eject_at_room_exp: true, max_participants: 8, geo: "sa-east-1",
        enable_screenshare: false, enable_chat: false, enable_knocking: false,
      },
    });
    expect(REGIAO_DA_SALA).toBe("sa-east-1");
    // Nada de gravação no Daily: a gravação é a do aparelho da dona (V4).
    expect(corpo.properties).not.toHaveProperty("enable_recording");
  });

  it("o Daily recusa: FalhaDoDaily com o status, e a chave não vai à mensagem", async () => {
    const { busca } = dubleDoFetch([{ status: 400, json: { error: "invalid-request-error", info: "x" } }]);
    const erro = await criarClienteDoDaily(CONFIGURACAO, busca).criarSala({ nome: "sala-abc", expiraEm: Date.now(), pessoasMax: 8 }).catch(e => e);
    expect(erro).toBeInstanceOf(FalhaDoDaily);
    expect(erro.status).toBe(400);
    expect(erro.message).toContain("invalid-request-error");
    expect(erro.message).not.toContain(CONFIGURACAO.chave);
  });

  it("o Daily não responde: FalhaDoDaily", async () => {
    const busca = vi.fn(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); });
    const erro = await criarClienteDoDaily(CONFIGURACAO, busca).criarSala({ nome: "sala-abc", expiraEm: Date.now(), pessoasMax: 8 }).catch(e => e);
    expect(erro).toBeInstanceOf(FalhaDoDaily);
    expect(erro.message).toContain("TimeoutError");
  });

  it("o nome fora do formato nem sai do processo", async () => {
    const { busca } = dubleDoFetch([]);
    await expect(criarClienteDoDaily(CONFIGURACAO, busca).criarSala({ nome: "Sala Nova!", expiraEm: Date.now(), pessoasMax: 8 })).rejects.toBeInstanceOf(FalhaDoDaily);
    expect(busca).not.toHaveBeenCalled();
  });

  it("o nome novo é aleatório e não carrega nada da reunião", () => {
    const nomes = new Set(Array.from({ length: 20 }, () => nomeNovoDeSala()));
    expect(nomes.size).toBe(20);
    for (const nome of nomes) expect(nome).toMatch(/^sala-[0-9a-f]{24}$/);
  });
});

describe("a ficha de entrada", () => {
  it("o nome, o id opaco da presença, o papel de dona e a validade em segundos; sem compartilhar a tela", async () => {
    const { busca, pedidos } = dubleDoFetch([{ status: 200, json: { token: "ficha-1" } }]);
    const ficha = await criarClienteDoDaily(CONFIGURACAO, busca).emitirFicha({
      sala: "sala-abc", nome: "Ana", idDaPessoa: "11111111-2222-4333-8444-555555555555", dona: true, expiraEm: 1_795_700_600_999,
    });
    expect(ficha).toBe("ficha-1");
    expect(pedidos[0].url).toBe("https://api.daily.co/v1/meeting-tokens");
    expect(JSON.parse(pedidos[0].body!)).toEqual({
      properties: {
        room_name: "sala-abc", user_name: "Ana", user_id: "11111111-2222-4333-8444-555555555555", is_owner: true, exp: 1_795_700_600, enable_screenshare: false,
      },
    });
  });

  it("sem nome (conta sem nome), o user_name não vai; a participante não é dona", async () => {
    const { busca, pedidos } = dubleDoFetch([{ status: 200, json: { token: "ficha-2" } }]);
    await criarClienteDoDaily(CONFIGURACAO, busca).emitirFicha({ sala: "sala-abc", nome: "", idDaPessoa: "p-1", dona: false, expiraEm: Date.now() });
    const propriedades = JSON.parse(pedidos[0].body!).properties;
    expect(propriedades).not.toHaveProperty("user_name");
    expect(propriedades.is_owner).toBe(false);
  });

  it("o identificador acima de 36 caracteres (o teto do Daily) é recusado antes de sair", async () => {
    const { busca } = dubleDoFetch([]);
    await expect(criarClienteDoDaily(CONFIGURACAO, busca).emitirFicha({ sala: "sala-abc", nome: "A", idDaPessoa: "x".repeat(37), dona: false, expiraEm: Date.now() }))
      .rejects.toBeInstanceOf(FalhaDoDaily);
    expect(busca).not.toHaveBeenCalled();
  });

  it("a resposta sem a ficha é falha", async () => {
    const { busca } = dubleDoFetch([{ status: 200, json: {} }]);
    await expect(criarClienteDoDaily(CONFIGURACAO, busca).emitirFicha({ sala: "sala-abc", nome: "A", idDaPessoa: "p", dona: false, expiraEm: Date.now() }))
      .rejects.toBeInstanceOf(FalhaDoDaily);
  });
});

describe("apagar a sala", () => {
  it("DELETE pelo nome; a sala que já não existe (404) conta como apagada", async () => {
    const { busca, pedidos } = dubleDoFetch([{ status: 200, json: { deleted: true, name: "sala-abc" } }, { status: 404, json: { error: "not-found" } }]);
    const cliente = criarClienteDoDaily(CONFIGURACAO, busca);
    await cliente.apagarSala("sala-abc");
    await cliente.apagarSala("sala-abc");
    expect(pedidos.map(pedido => `${pedido.method} ${pedido.url}`)).toEqual([
      "DELETE https://api.daily.co/v1/rooms/sala-abc", "DELETE https://api.daily.co/v1/rooms/sala-abc",
    ]);
  });
});

describe("a suíte nunca chama o Daily de verdade", () => {
  it("o cliente sem fetch dublado recusa dentro do Vitest, antes de sair do processo", async () => {
    const real = vi.spyOn(globalThis, "fetch");
    const erro = await criarClienteDoDaily(CONFIGURACAO).criarSala({ nome: "sala-abc", expiraEm: Date.now(), pessoasMax: 8 }).catch(e => e);
    expect(erro).toBeInstanceOf(FalhaDoDaily);
    expect(erro.message).toContain("não chama o Daily de verdade");
    expect(real).not.toHaveBeenCalled();
  });
});

describe("a assinatura dos avisos (webhook)", () => {
  const AGORA = 1_795_700_000_000;
  const assinar = (corpo: string, momento: string, segredo = SEGREDO) =>
    crypto.createHmac("sha256", Buffer.from(segredo, "base64")).update(`${momento}.${corpo}`).digest("base64");
  const CORPO = JSON.stringify({ type: "participant.left", payload: { room: "sala-abc" } });

  it("confere com o segredo decodificado do base64, sobre o momento e o corpo cru, em segundos ou milissegundos", () => {
    const emSegundos = String(AGORA / 1000);
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(CORPO), assinatura: assinar(CORPO, emSegundos), momento: emSegundos, segredo: SEGREDO, agora: AGORA })).toBe(true);
    const emMs = String(AGORA);
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(CORPO), assinatura: assinar(CORPO, emMs), momento: emMs, segredo: SEGREDO, agora: AGORA })).toBe(true);
  });

  it("recusa o corpo trocado, outro segredo, a falta de cabeçalho e o aviso velho (fora de 10 minutos)", () => {
    const momento = String(AGORA / 1000);
    const assinatura = assinar(CORPO, momento);
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(`${CORPO} `), assinatura, momento, segredo: SEGREDO, agora: AGORA })).toBe(false);
    const outro = Buffer.from("outro-segredo-de-teste-com-32-by").toString("base64");
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(CORPO), assinatura: assinar(CORPO, momento, outro), momento, segredo: SEGREDO, agora: AGORA })).toBe(false);
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(CORPO), assinatura: undefined, momento, segredo: SEGREDO, agora: AGORA })).toBe(false);
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(CORPO), assinatura, momento: undefined, segredo: SEGREDO, agora: AGORA })).toBe(false);
    const velho = String((AGORA - 11 * 60_000) / 1000);
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(CORPO), assinatura: assinar(CORPO, velho), momento: velho, segredo: SEGREDO, agora: AGORA })).toBe(false);
    expect(assinaturaDoAvisoConfere({ corpo: Buffer.from(CORPO), assinatura: assinar(CORPO, "ontem"), momento: "ontem", segredo: SEGREDO, agora: AGORA })).toBe(false);
  });
});

describe("o corpo dos avisos", () => {
  const corpo = (json: unknown) => Buffer.from(JSON.stringify(json));

  it("participant.joined: a sala, a pessoa (o id da presença), a sessão e a entrada em ms", () => {
    expect(lerAvisoDoDaily(corpo({
      version: "1.0.0", type: "participant.joined", id: "e1", event_ts: 1708972280.1,
      payload: { room: "sala-abc", session_id: "s-1", user_id: "p-1", user_name: "Ana", owner: false, joined_at: 1708972279.96 },
    }))).toEqual({ tipo: "entrou", sala: "sala-abc", pessoa: "p-1", sessao: "s-1", em: 1708972279960 });
  });

  it("participant.left: a saída é a entrada mais a duração que o Daily mediu (não a hora do envio)", () => {
    expect(lerAvisoDoDaily(corpo({
      type: "participant.left", event_ts: 1708975000,
      payload: { room: "sala-abc", session_id: "s-1", user_id: "p-1", joined_at: 1708972279.96, duration: 125 },
    }))).toEqual({ tipo: "saiu", sala: "sala-abc", pessoa: "p-1", sessao: "s-1", em: 1708972404960, segundos: 125 });
  });

  it("meeting.ended: a sala e o fim em ms", () => {
    expect(lerAvisoDoDaily(corpo({ type: "meeting.ended", payload: { room: "sala-abc", start_ts: 1708972000, end_ts: 1708975600, meeting_id: "m" } })))
      .toEqual({ tipo: "fim", sala: "sala-abc", em: 1708975600000 });
  });

  it("sem user_id (entrou sem ficha nossa), a pessoa é null", () => {
    expect(lerAvisoDoDaily(corpo({ type: "participant.joined", payload: { room: "sala-abc", session_id: "s", joined_at: 1 } })))
      .toMatchObject({ pessoa: null });
  });

  it("o teste do Daily ao criar o webhook, outro tipo de aviso e o corpo quebrado não mudam nada", () => {
    expect(lerAvisoDoDaily(corpo({ test: "test" }))).toBeNull();
    expect(lerAvisoDoDaily(corpo({ type: "recording.ready-to-download", payload: { room: "sala-abc" } }))).toBeNull();
    expect(lerAvisoDoDaily(corpo({ type: "participant.left", payload: { room: "sala-abc" } }))).toBeNull();
    expect(lerAvisoDoDaily(Buffer.from("{quebrado"))).toBeNull();
    expect(lerAvisoDoDaily(corpo({ type: "meeting.ended", payload: { room: "x".repeat(65), end_ts: 1 } }))).toBeNull();
  });
});
