import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A tradução do resumo guardado (H11). O banco é um dublê em memória com a
 * forma de server/traducao-do-resumo-banco.ts (as consultas de verdade estão em
 * traducao-do-resumo.integracao.test.ts), e a IA é um dublê de pedirJsonAIA que
 * lê o JSON enviado e devolve o que cada teste combina.
 */

type Item = {
  id: string; section: "action" | "focus" | "task" | "decision" | "blocker" | "question";
  subject: string | null; text: string; assignee: string | null; due: string | null;
  excerpt: string; startSeconds: number | null; status: "pending" | "confirmed" | "ignored";
  origin: "ai" | "owner"; editedAt: number | null;
};

const banco = vi.hoisted(() => ({
  resposta: "pronto" as "pronto" | "original" | "sem_resumo",
  resumoId: "resumo-1",
  versao: 1,
  // O resumo sendo refeito (H4d): o banco manda servir só a tradução guardada.
  soGuardada: false,
  idiomaOriginal: "pt-BR",
  itens: [] as Item[],
  rotulos: [] as string[],
  // O conteúdo guardado por idioma, como volta da coluna JSON, e de que resumo e versão ele saiu.
  guardados: {} as Record<string, { conteudo: unknown; resumoId: string; versao: number }>,
  gravarDevolve: true,
  erroAoGravar: null as unknown,
  gravacoes: [] as Array<{ alvo: Record<string, unknown>; conteudo: unknown; modelo: string | null }>,
  leituras: 0,
}));
const copia = <T>(valor: T): T => JSON.parse(JSON.stringify(valor ?? null));

vi.mock("./traducao-do-resumo-banco", () => ({
  lerResumoParaTraduzir: vi.fn(async (_ownerId: string, _meetingId: string, idioma: string) => {
    banco.leituras += 1;
    if (banco.resposta !== "pronto") return { estado: banco.resposta };
    if (idioma === banco.idiomaOriginal) return { estado: "original" };
    const guardada = banco.guardados[idioma];
    const vale = !!guardada && guardada.resumoId === banco.resumoId && guardada.versao === banco.versao;
    return {
      estado: "pronto", resumoId: banco.resumoId, versao: banco.versao, idiomaOriginal: banco.idiomaOriginal,
      itens: copia(banco.itens), rotulosDoMapa: [...banco.rotulos], guardado: vale ? copia(guardada.conteudo) : null, soGuardada: banco.soGuardada,
    };
  }),
  gravarTraducaoDoResumo: vi.fn(async (alvo: { idioma: string; resumoId: string; versao: number }, montar: (atual: unknown) => unknown, modelo: string | null) => {
    if (banco.erroAoGravar) throw banco.erroAoGravar;
    if (!banco.gravarDevolve) return false;
    const guardada = banco.guardados[alvo.idioma];
    const atual = guardada && guardada.resumoId === alvo.resumoId && guardada.versao === alvo.versao ? copia(guardada.conteudo) : null;
    // A volta pela coluna JSON.
    const conteudo = copia(montar(atual));
    banco.guardados[alvo.idioma] = { conteudo, resumoId: alvo.resumoId, versao: alvo.versao };
    banco.gravacoes.push({ alvo, conteudo, modelo });
    return true;
  }),
}));

const pedirJsonAIA = vi.fn();
vi.mock("./ia-em-json", async importOriginal => ({
  ...await importOriginal<typeof import("./ia-em-json")>(),
  pedirJsonAIA: (...args: unknown[]) => pedirJsonAIA(...args),
}));

// O trecho de cada item pelo link, com a transcrição editada pela dona (H18,
// server/editar-transcricao.ts): o dublê esvazia os trechos que o teste diz
// que não estão mais na transcrição. A consulta de verdade está em
// editar-transcricao.integracao.test.ts.
const trechos = vi.hoisted(() => ({ fora: new Set<string>(), pedidos: [] as Array<{ ownerId: string; meetingId: string; trechos: string[] }> }));
vi.mock("./editar-transcricao", async importOriginal => ({
  ...await importOriginal<typeof import("./editar-transcricao")>(),
  trechosNaTranscricaoDeAgora: async (ownerId: string, meetingId: string, itens: Array<{ excerpt: string }>) => {
    trechos.pedidos.push({ ownerId, meetingId, trechos: itens.map(i => i.excerpt) });
    return itens.map(i => (trechos.fora.has(i.excerpt) ? { ...i, excerpt: "", trechoForaDaTranscricao: true } : { ...i, trechoForaDaTranscricao: false }));
  },
}));

const modulo = await import("./traducao-do-resumo");
const {
  _paraTestes, aplicarTraducao, conferirLote, emLotes, impressaoDoItem, juntarConteudo, lerConteudo, MENSAGEM_TRADUCAO_DO_RESUMO_INDISPONIVEL,
  oQueFalta, paraGuardar, rotulosDeVoz, traduzirResumoDaDona, traduzirResumoPeloLink,
} = modulo;
const { FalhaDaIA } = await import("./ia-em-json");

type Pedido = { sistema: string; usuario: string; nome: string; funcao: unknown };
type Enviado = { itens: Array<{ chave: string; assunto: string | null; texto: string; prazo: string | null }>; rotulos: Array<{ chave: string; rotulo: string }> };
const enviadoEm = (pedido: Pedido): Enviado => JSON.parse(pedido.usuario.slice(pedido.usuario.indexOf("{")));

/** A IA dublada: traduz cada campo com `traduzir`, mantendo as chaves. */
function tradutor(traduzir: (texto: string) => string) {
  return async (pedido: Pedido) => {
    const { itens, rotulos } = enviadoEm(pedido);
    return {
      dados: {
        itens: itens.map(item => ({ chave: item.chave, assunto: item.assunto && traduzir(item.assunto), texto: traduzir(item.texto), prazo: item.prazo && traduzir(item.prazo) })),
        rotulos: rotulos.map(r => ({ chave: r.chave, rotulo: traduzir(r.rotulo) })),
      },
      modelo: "gemini-3.6-flash",
    };
  };
}
const paraIngles = (texto: string) => `EN ${texto}`;

function item(id: string, extra: Partial<Item> = {}): Item {
  return { id, section: "decision", subject: null, text: `Texto ${id}`, assignee: null, due: null, excerpt: `trecho literal ${id} da transcrição`, startSeconds: 12, status: "pending", origin: "ai", editedAt: null, ...extra };
}

/** Um adiado que o teste resolve na hora que quiser: a IA "ainda traduzindo". */
function adiado<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (erro: unknown) => void;
  const promessa = new Promise<T>((ok, falha) => { resolver = ok; rejeitar = falha; });
  return { promessa, resolver, rejeitar };
}

beforeEach(() => {
  Object.assign(banco, {
    resposta: "pronto", resumoId: "resumo-1", versao: 1, soGuardada: false, idiomaOriginal: "pt-BR", itens: [], rotulos: [],
    guardados: {}, gravarDevolve: true, erroAoGravar: null, gravacoes: [], leituras: 0,
  });
  trechos.fora.clear();
  trechos.pedidos = [];
  pedirJsonAIA.mockReset();
  _paraTestes.limpar();
  // Nos testes, a IA dublada responde na hora: o pedido espera até 1 s por ela.
  _paraTestes.definirEspera(1_000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("as peças puras", () => {
  it("a impressão digital muda com qualquer texto do item e não com o resto", () => {
    const base = { subject: "Lojas", text: "{F2} publica o app", due: "sexta" };
    expect(impressaoDoItem(base)).toBe(impressaoDoItem({ ...base }));
    expect(impressaoDoItem({ ...base, text: "{F2} publica o app hoje" })).not.toBe(impressaoDoItem(base));
    expect(impressaoDoItem({ ...base, subject: null })).not.toBe(impressaoDoItem(base));
    expect(impressaoDoItem({ ...base, due: null })).not.toBe(impressaoDoItem(base));
  });

  it("os rótulos de voz são contados com as chaves; F1 solto, {F0} e {f1} não são rótulo", () => {
    expect(rotulosDeVoz("{F2} e {F1} falaram com {F2}")).toBe("{F1},{F2},{F2}");
    expect(rotulosDeVoz("F1 {F0} {f1} {F100}")).toBe("");
    expect(rotulosDeVoz(null)).toBe("");
  });

  describe("conferirLote", () => {
    const enviadas = [
      { tipo: "item" as const, chave: "i1", id: "a", assunto: "Lojas", texto: "{F2} publica o app até sexta", prazo: "até sexta" },
      { tipo: "item" as const, chave: "i2", id: "b", assunto: null, texto: "Decidimos com {F1} e {F3}", prazo: null },
      { tipo: "rotulo" as const, chave: "m1", rotulo: "Prazos" },
    ];

    it("aceita o item com os mesmos rótulos de voz, e o campo null volta null mesmo que a IA invente", () => {
      const aceitas = conferirLote(enviadas, {
        itens: [
          { chave: "i1", assunto: " Stores ", texto: "{F2}  publishes the app by Friday", prazo: "by Friday" },
          { chave: "i2", assunto: "inventado", texto: "We decided with {F3} and {F1}", prazo: "amanhã" },
        ],
        rotulos: [{ chave: "m1", rotulo: "Deadlines" }],
      });
      expect(aceitas.get("i1")).toEqual({ subject: "Stores", text: "{F2} publishes the app by Friday", due: "by Friday" });
      expect(aceitas.get("i2")).toEqual({ subject: null, text: "We decided with {F3} and {F1}", due: null });
      expect(aceitas.get("m1")).toBe("Deadlines");
    });

    it("recusa a tradução que perde, troca, inventa ou traduz um rótulo de voz", () => {
      for (const texto of ["Ana publishes the app by Friday", "{F3} publishes the app by Friday", "{F2} and {F1} publish the app", "{Speaker 2} publishes the app", "{F2 publishes the app"]) {
        expect(conferirLote(enviadas, { itens: [{ chave: "i1", assunto: "Stores", texto, prazo: "by Friday" }], rotulos: [] }).has("i1"), texto).toBe(false);
      }
      // O rótulo do mapa não tem voz, e a tradução também não pode ter.
      expect(conferirLote(enviadas, { itens: [], rotulos: [{ chave: "m1", rotulo: "{F1} deadlines" }] }).has("m1")).toBe(false);
    });

    it("recusa chave que não foi enviada, o tipo trocado, texto vazio, campo que some e tradução comprida demais", () => {
      const aceitas = conferirLote(enviadas, {
        itens: [
          { chave: "i9", assunto: null, texto: "intruso", prazo: null },
          { chave: "m1", assunto: null, texto: "rótulo como item", prazo: null },
          { chave: "i2", assunto: null, texto: "   ", prazo: null },
          { chave: "i1", assunto: null, texto: "{F2} publishes the app by Friday", prazo: "by Friday" },
        ],
        rotulos: [{ chave: "i1", rotulo: "item como rótulo" }, { chave: "m1", rotulo: "x".repeat(5 * 6 + 51) }],
      });
      expect(Array.from(aceitas.keys())).toEqual([]);
    });

    it("vale a primeira resposta de cada chave", () => {
      const aceitas = conferirLote(enviadas, { itens: [], rotulos: [{ chave: "m1", rotulo: "Deadlines" }, { chave: "m1", rotulo: "Outra" }] });
      expect(aceitas.get("m1")).toBe("Deadlines");
    });
  });

  it("os lotes respeitam o tamanho, a ordem e deixam a entrada grande sozinha", () => {
    const entradas = ["a", "b", "c", "d"].map((id, i) => ({ tipo: "item" as const, chave: `i${i + 1}`, id, assunto: null, texto: id === "c" ? "x".repeat(300) : "curto", prazo: null }));
    const lotes = emLotes(entradas, 200);
    expect(lotes.map(lote => lote.map(entrada => entrada.chave))).toEqual([["i1", "i2"], ["i3"], ["i4"]]);
  });

  it("o conteúdo guardado é lido com desconfiança, e um rótulo '__proto__' não vira protótipo", () => {
    const conteudo = lerConteudo({
      itens: { a: { h: "h1", subject: null, text: "ok", due: null }, b: { h: 1, text: "sem impressão" }, c: "lixo" },
      mapa: { Prazos: "Deadlines", ruim: 3 },
    });
    expect(Array.from(conteudo.itens.keys())).toEqual(["a"]);
    expect(Array.from(conteudo.mapa)).toEqual([["Prazos", "Deadlines"]]);
    expect(lerConteudo(null).itens.size).toBe(0);
    expect(lerConteudo([1, 2]).mapa.size).toBe(0);

    const comProto = lerConteudo({ itens: {}, mapa: {} });
    comProto.mapa.set("__proto__", "Protótipo");
    const voltou = lerConteudo(JSON.parse(JSON.stringify(paraGuardar(comProto))));
    expect(voltou.mapa.get("__proto__")).toBe("Protótipo");
    expect(Object.getPrototypeOf(paraGuardar(comProto).mapa)).toBe(Object.prototype);
  });

  it("item editado não acha a tradução: falta traduzir, e a tela vê o texto novo, não a tradução velha", () => {
    const original = item("a", { text: "Texto antigo" });
    const guardado = lerConteudo({ itens: { a: { h: impressaoDoItem(original), subject: null, text: "Old text", due: null } }, mapa: { Prazos: "Deadlines" } });
    expect(aplicarTraducao([original], guardado)[0].text).toBe("Old text");

    const editado = { ...original, text: "Texto novo" };
    expect(oQueFalta([editado], ["Prazos", "Riscos", "Riscos"], guardado)).toEqual({ itens: [editado], rotulos: ["Riscos"] });
    expect(aplicarTraducao([editado], guardado)[0].text).toBe("Texto novo");
  });

  it("juntar fica com a tradução do texto atual, prefere a nova e tira o que saiu do resumo", () => {
    const a = item("a"), b = item("b");
    const guardado = lerConteudo({
      itens: {
        a: { h: impressaoDoItem(a), subject: null, text: "EN velho a", due: null },
        b: { h: "de-outro-texto", subject: null, text: "EN b de antes da edição", due: null },
        saiu: { h: "x", subject: null, text: "EN item apagado", due: null },
      },
      mapa: { Prazos: "Deadlines", Velho: "Old" },
    });
    const novo = lerConteudo({ itens: { b: { h: impressaoDoItem(b), subject: null, text: "EN b", due: null } }, mapa: { Riscos: "Risks" } });
    const junto = juntarConteudo(guardado, novo, [a, b], ["Prazos", "Riscos"]);
    expect(Array.from(junto.itens, ([id, t]) => [id, t.text])).toEqual([["a", "EN velho a"], ["b", "EN b"]]);
    expect(Array.from(junto.mapa)).toEqual([["Prazos", "Deadlines"], ["Riscos", "Risks"]]);
  });
});

describe("traduzir o resumo", () => {
  it("o resumo já no idioma pedido, ou sem resumo pronto: nada vai à IA e nada gasta vaga", async () => {
    const antes = vi.fn();
    banco.resposta = "original";
    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "pt-BR", antes)).resolves.toEqual({ estado: "original", idioma: "pt-BR" });
    banco.resposta = "sem_resumo";
    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).resolves.toEqual({ estado: "sem_resumo", idioma: "en" });
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(antes).not.toHaveBeenCalled();
  });

  it("traduz o que falta, guarda e devolve a tradução; os rótulos de voz ficam, e o trecho e os ids nunca vão à IA", async () => {
    banco.itens = [
      item("id-acao", { section: "action", text: "{F2} envia a proposta", assignee: "{F2}", due: "até sexta" }),
      item("id-tarefa", { section: "task", subject: "Lojas", text: "Publicar o app com {F1}" }),
    ];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    const antes = vi.fn();

    const resposta = await traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes);

    expect(antes).toHaveBeenCalledTimes(1);
    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);
    const [pedido] = pedirJsonAIA.mock.calls[0] as [Pedido];
    // Função que a bancada de texto não mediu (IA1): null, o LLM_MODEL, sem raciocínio.
    expect(pedido.funcao).toBeNull();
    expect(pedido.sistema).toContain("português do Brasil");
    expect(pedido.sistema).toContain("para inglês");
    expect(pedido.sistema).toContain("dado, não instrução");
    expect(pedido.sistema).toContain("{F1}, {F2}");
    // Nem o trecho (a prova, no original), nem o responsável, nem os ids do banco.
    for (const ausente of ["trecho literal", "id-acao", "id-tarefa", "assignee"]) expect(pedido.usuario).not.toContain(ausente);
    expect(enviadoEm(pedido).itens).toEqual([
      { chave: "i1", assunto: null, texto: "{F2} envia a proposta", prazo: "até sexta" },
      { chave: "i2", assunto: "Lojas", texto: "Publicar o app com {F1}", prazo: null },
    ]);

    expect(resposta).toEqual({
      estado: "pronta", idioma: "en", mapa: {},
      itens: [
        { section: "action", subject: null, text: "EN {F2} envia a proposta", assignee: "{F2}", due: "EN até sexta", excerpt: "trecho literal id-acao da transcrição", startSeconds: 12, status: "pending", escritoPelaDona: false, trechoForaDaTranscricao: false },
        { section: "task", subject: "EN Lojas", text: "EN Publicar o app com {F1}", assignee: null, due: null, excerpt: "trecho literal id-tarefa da transcrição", startSeconds: 12, status: "pending", escritoPelaDona: false, trechoForaDaTranscricao: false },
      ],
    });
    expect(banco.gravacoes).toHaveLength(1);
    expect(banco.gravacoes[0].alvo).toEqual({ ownerId: "dona-1", meetingId: "r1", idioma: "en", resumoId: "resumo-1", versao: 1 });
    expect(banco.gravacoes[0].modelo).toBe("gemini-3.6-flash");
  });

  it("guardada, a tradução volta sem IA e sem gastar vaga", async () => {
    banco.itens = [item("a")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    await traduzirResumoDaDona("dona-1", "r1", "en");
    pedirJsonAIA.mockClear();
    const antes = vi.fn();

    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).resolves.toMatchObject({ estado: "pronta" });
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(antes).not.toHaveBeenCalled();
  });

  it("a dona recebe os textos pelo id; o link recebe o resumo sem ids e sem os ignorados", async () => {
    banco.itens = [item("a", { status: "confirmed" }), item("b", { status: "ignored" }), item("c")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));

    const daDona = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(daDona).toEqual({
      estado: "pronta", idioma: "en", mapa: {},
      itens: ["a", "b", "c"].map(id => ({ id, subject: null, text: `EN Texto ${id}`, due: null })),
    });
    const peloLink = await traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", vi.fn());
    expect(peloLink.estado === "pronta" && peloLink.itens.map(i => i.text)).toEqual(["EN Texto a", "EN Texto c"]);
    expect(JSON.stringify(peloLink)).not.toMatch(/"id"|"done"|ignored|"origin"|"editedAt"/);
  });

  it("pelo link, o trecho que a dona tirou da transcrição (H18) vai vazio, com a marca, como no resumo pelo link; a dona recebe só os textos", async () => {
    banco.itens = [item("a", { status: "confirmed" }), item("b", { status: "ignored" }), item("c")];
    trechos.fora.add("trecho literal c da transcrição");
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    const peloLink = await traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", vi.fn());
    expect(peloLink.estado === "pronta" && peloLink.itens.map(i => [i.text, i.excerpt, i.trechoForaDaTranscricao])).toEqual([
      ["EN Texto a", "trecho literal a da transcrição", false], ["EN Texto c", "", true],
    ]);
    expect(JSON.stringify(peloLink)).not.toContain("trecho literal c");
    // A conferência é da reunião do link, pela dona dela, e só dos itens que o link mostra.
    expect(trechos.pedidos).toEqual([{ ownerId: "dona-1", meetingId: "r1", trechos: ["trecho literal a da transcrição", "trecho literal c da transcrição"] }]);
    // A tradução para a dona não leva trecho nenhum, e não passa pela conferência.
    trechos.pedidos = [];
    await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(trechos.pedidos).toEqual([]);
  });

  it("pelo link, o item que a dona escreveu ou editou (H4f) vai só com a marca, sem a origem nem a hora da edição", async () => {
    banco.itens = [item("a", { status: "confirmed", origin: "owner" }), item("b", { status: "confirmed", editedAt: 1_800_000_000_000 }), item("c")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    const peloLink = await traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", vi.fn());
    expect(peloLink.estado === "pronta" && peloLink.itens.map(i => [i.text, i.escritoPelaDona])).toEqual([
      ["EN Texto a", true], ["EN Texto b", true], ["EN Texto c", false],
    ]);
    expect(JSON.stringify(peloLink)).not.toMatch(/"origin"|"editedAt"|1800000000000/);
  });

  // A edição da dona (H4f) não muda a versão do resumo (server/resumo-guardado.ts):
  // o item editado volta com outra impressão digital na mesma versão. O caminho
  // de verdade, editarItemDoResumo e depois a tradução, está no teste de integração.
  it("item editado depois (outra impressão digital, a mesma versão) é traduzido sozinho; o resto vem guardado", async () => {
    banco.itens = [item("a"), item("b")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    await traduzirResumoDaDona("dona-1", "r1", "en");
    banco.itens = [item("a"), item("b", { text: "Texto b editado" })];
    pedirJsonAIA.mockClear();

    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido).itens.map(i => i.texto)).toEqual(["Texto b editado"]);
    expect(resposta.estado === "pronta" && resposta.itens.map(i => i.text)).toEqual(["EN Texto a", "EN Texto b editado"]);
  });

  it("a tradução de outra versão do resumo não vale: o resumo refeito é traduzido de novo", async () => {
    banco.itens = [item("a")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    await traduzirResumoDaDona("dona-1", "r1", "en");
    banco.versao = 2;
    banco.itens = [item("a2", { text: "Texto refeito" })];
    pedirJsonAIA.mockClear();

    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);
    expect(resposta.estado === "pronta" && resposta.itens).toEqual([{ id: "a2", subject: null, text: "EN Texto refeito", due: null }]);
    // O guardado da versão 1 não sobra na linha.
    expect(Object.keys((banco.guardados.en.conteudo as { itens: object }).itens)).toEqual(["a2"]);
  });

  it("o rótulo de voz perdido na primeira passada vai de novo; o que falha nas duas fica no original", async () => {
    banco.itens = [item("a", { text: "{F1} decidiu" }), item("b", { text: "{F2} recusou" })];
    let chamada = 0;
    pedirJsonAIA.mockImplementation(async (pedido: Pedido) => {
      chamada += 1;
      // "a" perde o rótulo só na primeira vez; "b" perde sempre.
      return tradutor(texto => (texto.includes("{F2}") || chamada === 1 ? texto.replace(/\{F\d\}/, "Ana") : `EN ${texto}`))(pedido);
    });

    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(pedirJsonAIA).toHaveBeenCalledTimes(2);
    expect(enviadoEm(pedirJsonAIA.mock.calls[1][0] as Pedido).itens.map(i => i.chave)).toEqual(["i1", "i2"]);
    expect(resposta.estado === "pronta" && resposta.itens.map(i => i.text)).toEqual(["EN {F1} decidiu", "{F2} recusou"]);
    // Guardado, para não pedir de novo a cada leitura.
    pedirJsonAIA.mockClear();
    await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(pedirJsonAIA).not.toHaveBeenCalled();
  });

  it("se nada passa nas duas passadas, é falha da IA: nada é guardado, e o erro sai com o código que a tela traduz", async () => {
    banco.itens = [item("a", { text: "{F1} decidiu" })];
    pedirJsonAIA.mockImplementation(tradutor(texto => texto.replace("{F1}", "Ana")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const erro = await traduzirResumoDaDona("dona-1", "r1", "en").catch(e => e);
    expect(erro).toBeInstanceOf(TRPCError);
    expect(erro).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: MENSAGEM_TRADUCAO_DO_RESUMO_INDISPONIVEL });
    expect(pedirJsonAIA).toHaveBeenCalledTimes(2);
    expect(banco.gravacoes).toEqual([]);
  });

  it("resposta cortada no teto de saída: o lote vai em duas metades; a entrada única que sempre corta, sem nada aceito, é falha", async () => {
    banco.itens = [item("a"), item("b")];
    pedirJsonAIA.mockImplementation(async (pedido: Pedido) => {
      if (enviadoEm(pedido).itens.length > 1) throw new FalhaDaIA("RESPOSTA_CORTADA");
      return tradutor(paraIngles)(pedido);
    });
    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(pedirJsonAIA).toHaveBeenCalledTimes(3);
    expect(resposta.estado === "pronta" && resposta.itens.map(i => i.text)).toEqual(["EN Texto a", "EN Texto b"]);

    _paraTestes.limpar();
    banco.guardados = {};
    banco.gravacoes = [];
    banco.itens = [item("c")];
    pedirJsonAIA.mockReset();
    pedirJsonAIA.mockRejectedValue(new FalhaDaIA("RESPOSTA_CORTADA"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(banco.gravacoes).toEqual([]);
  });

  it("a entrada que sozinha passa do teto de saída fica no original, sem levar as outras, e não volta à IA", async () => {
    banco.itens = [item("a"), item("b")];
    pedirJsonAIA.mockImplementation(async (pedido: Pedido) => {
      if (enviadoEm(pedido).itens.some(enviado => enviado.texto === "Texto b")) throw new FalhaDaIA("RESPOSTA_CORTADA");
      return tradutor(paraIngles)(pedido);
    });

    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    // [a, b] cortado; as metades [a] e [b]; e o [b] sozinho, que cortaria de novo, não vai à segunda passada.
    expect(pedirJsonAIA).toHaveBeenCalledTimes(3);
    expect(resposta.estado === "pronta" && resposta.itens.map(i => i.text)).toEqual(["EN Texto a", "Texto b"]);
    pedirJsonAIA.mockClear();
    await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(pedirJsonAIA).not.toHaveBeenCalled();
  });

  it("um lote que falha não leva os outros: o que voltou fica guardado, quem pediu recebe o erro, e o pedido seguinte manda à IA só o que faltou", async () => {
    // Três itens grandes: um lote para cada.
    const grande = (letra: string) => `${letra} ${"x".repeat(4_000)}`;
    banco.itens = [item("a", { text: grande("A") }), item("b", { text: grande("B") }), item("c", { text: grande("C") })];
    const letrasEnviadas = () => pedirJsonAIA.mock.calls.flatMap(([pedido]) => enviadoEm(pedido as Pedido).itens.map(enviado => enviado.texto[0]));
    // A IA traduz o lote do "a" e cai no do "b", já sem retentativas.
    pedirJsonAIA.mockImplementation(async (pedido: Pedido) => {
      if (enviadoEm(pedido).itens.some(enviado => enviado.texto.startsWith("B "))) throw new FalhaDaIA("IA_INDISPONIVEL");
      return tradutor(paraIngles)(pedido);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    // Com a IA fora, o lote do "c" nem foi.
    expect(letrasEnviadas()).toEqual(["A", "B"]);
    expect(banco.gravacoes).toHaveLength(1);
    expect(Object.keys((banco.gravacoes[0].conteudo as { itens: object }).itens)).toEqual(["a"]);

    // O "Tentar de novo": só o que ficou sem resposta vai à IA.
    pedirJsonAIA.mockReset();
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(letrasEnviadas()).toEqual(["B", "C"]);
    expect(resposta.estado === "pronta" && resposta.itens.map(i => i.text.slice(0, 4))).toEqual(["EN A", "EN B", "EN C"]);
  });

  it("a segunda passada que falha não leva o que a primeira aceitou", async () => {
    banco.itens = [item("a"), item("b", { text: "{F2} recusou" })];
    let chamada = 0;
    pedirJsonAIA.mockImplementation(async (pedido: Pedido) => {
      chamada += 1;
      if (chamada === 2) throw new FalhaDaIA("RESPOSTA_INVALIDA");
      // Na primeira passada, o "b" perde o rótulo de voz e vai à segunda.
      return tradutor(texto => `EN ${texto.replace("{F2}", "Ana")}`)(pedido);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(pedirJsonAIA).toHaveBeenCalledTimes(2);
    // O "b" ficou sem resposta na segunda passada: não é guardado nem como original.
    expect(Object.keys((banco.gravacoes[0].conteudo as { itens: object }).itens)).toEqual(["a"]);

    pedirJsonAIA.mockReset();
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido).itens.map(enviado => enviado.texto)).toEqual(["{F2} recusou"]);
    expect(resposta.estado === "pronta" && resposta.itens.map(i => i.text)).toEqual(["EN Texto a", "EN {F2} recusou"]);
  });

  it("o mapa mental vai junto, rótulo por rótulo, e volta como dicionário", async () => {
    banco.itens = [item("a")];
    banco.rotulos = ["Prazos", "Lojas", "Prazos"];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));

    const resposta = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido).rotulos).toEqual([{ chave: "m1", rotulo: "Prazos" }, { chave: "m2", rotulo: "Lojas" }]);
    expect(resposta.estado === "pronta" && resposta.mapa).toEqual({ Prazos: "EN Prazos", Lojas: "EN Lojas" });

    // Um rótulo novo no mapa (refeito pela H10) é traduzido sozinho.
    banco.rotulos = ["Prazos", "Riscos"];
    pedirJsonAIA.mockClear();
    const depois = await traduzirResumoDaDona("dona-1", "r1", "en");
    expect(enviadoEm(pedirJsonAIA.mock.calls[0][0] as Pedido)).toEqual({ itens: [], rotulos: [{ chave: "m1", rotulo: "Riscos" }] });
    expect(depois.estado === "pronta" && depois.mapa).toEqual({ Prazos: "EN Prazos", Riscos: "EN Riscos" });
  });

  it("a dona também gasta a vaga do teto só quando a IA é chamada: a guardada não gasta, e a recusa do teto não começa nada", async () => {
    banco.itens = [item("a")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    const antes = vi.fn();
    await expect(traduzirResumoDaDona("dona-1", "r1", "en", antes)).resolves.toMatchObject({ estado: "pronta" });
    expect(antes).toHaveBeenCalledTimes(1);
    await traduzirResumoDaDona("dona-1", "r1", "en", antes);
    expect(antes).toHaveBeenCalledTimes(1);

    banco.itens = [item("a"), item("b")];
    pedirJsonAIA.mockClear();
    const recusa = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitos pedidos à IA em sequência." });
    await expect(traduzirResumoDaDona("dona-1", "r1", "en", () => { throw recusa; })).rejects.toBe(recusa);
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(_paraTestes.emCurso.size).toBe(0);
  });

  it("o teto do link recusa antes da IA: nada começa, e o erro do teto sai como está", async () => {
    banco.itens = [item("a")];
    const recusa = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitos pedidos à IA em sequência." });
    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", () => { throw recusa; })).rejects.toBe(recusa);
    expect(pedirJsonAIA).not.toHaveBeenCalled();
    expect(_paraTestes.emCurso.size).toBe(0);
  });

  it("banco fora do ar ao gravar sobe como está (não vira 'IA indisponível')", async () => {
    banco.itens = [item("a")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    const queda = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    banco.erroAoGravar = queda;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).rejects.toBe(queda);
  });

  describe("o resumo sendo refeito (H4d): a versão anterior fica na tela, e só a tradução guardada dela vale", () => {
    it("com a tradução guardada: ela sai sem IA e sem vaga, e o item que ela não cobre fica no original", async () => {
      banco.itens = [item("a")];
      banco.rotulos = ["Prazos"];
      pedirJsonAIA.mockImplementation(tradutor(paraIngles));
      await traduzirResumoDaDona("dona-1", "r1", "en");
      banco.soGuardada = true;
      banco.itens = [item("a"), item("b", { status: "confirmed", origin: "owner" })];
      pedirJsonAIA.mockClear();
      const antes = vi.fn();

      await expect(traduzirResumoDaDona("dona-1", "r1", "en", antes)).resolves.toEqual({
        estado: "pronta", idioma: "en", mapa: { Prazos: "EN Prazos" },
        itens: [{ id: "a", subject: null, text: "EN Texto a", due: null }, { id: "b", subject: null, text: "Texto b", due: null }],
      });
      const peloLink = await traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes);
      expect(peloLink.estado === "pronta" && peloLink.itens.map(i => i.text)).toEqual(["EN Texto a", "Texto b"]);
      expect(pedirJsonAIA).not.toHaveBeenCalled();
      expect(antes).not.toHaveBeenCalled();
      expect(banco.gravacoes).toHaveLength(1);
    });

    it("sem tradução guardada: 'traduzindo', sem IA e sem vaga (a versão nova, quando chega, é traduzida)", async () => {
      banco.itens = [item("a")];
      banco.soGuardada = true;
      const antes = vi.fn();
      await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).resolves.toEqual({ estado: "traduzindo", idioma: "en" });
      expect(pedirJsonAIA).not.toHaveBeenCalled();
      expect(antes).not.toHaveBeenCalled();
      expect(_paraTestes.emCurso.size).toBe(0);
    });
  });

  it("o resumo mudou enquanto a IA traduzia: nada vale, e a resposta é 'traduzindo' (o próximo pedido traduz o novo)", async () => {
    banco.itens = [item("a")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    banco.gravarDevolve = false;
    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).resolves.toEqual({ estado: "traduzindo", idioma: "en" });
  });
});

describe("em segundo plano, como a tradução da transcrição", () => {
  it("a IA demora: responde 'traduzindo'; quem pede de novo espera a mesma tradução, sem outra chamada nem outra vaga", async () => {
    banco.itens = [item("a")];
    const ia = adiado<unknown>();
    pedirJsonAIA.mockImplementation(async (pedido: Pedido) => { await ia.promessa; return tradutor(paraIngles)(pedido); });
    _paraTestes.definirEspera(0);
    const antes = vi.fn();

    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).resolves.toEqual({ estado: "traduzindo", idioma: "en" });
    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).resolves.toEqual({ estado: "traduzindo", idioma: "en" });
    expect(antes).toHaveBeenCalledTimes(1);
    expect(pedirJsonAIA).toHaveBeenCalledTimes(1);

    ia.resolver(undefined);
    await vi.waitFor(() => expect(_paraTestes.emCurso.size).toBe(0));
    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).resolves.toMatchObject({ estado: "pronta", itens: [{ text: "EN Texto a" }] });
    expect(antes).toHaveBeenCalledTimes(1);
  });

  it("a tradução que falha em segundo plano: o próximo pedido recebe o erro uma vez, e o seguinte recomeça", async () => {
    banco.itens = [item("a")];
    const ia = adiado<unknown>();
    pedirJsonAIA.mockImplementationOnce(async () => { await ia.promessa; throw new FalhaDaIA("IA_INDISPONIVEL"); });
    _paraTestes.definirEspera(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const antes = vi.fn();

    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).resolves.toMatchObject({ estado: "traduzindo" });
    ia.resolver(undefined);
    await vi.waitFor(() => expect(_paraTestes.falhas.size).toBe(1));

    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(antes).toHaveBeenCalledTimes(1);

    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    _paraTestes.definirEspera(1_000);
    await expect(traduzirResumoPeloLink({ id: "r1", ownerId: "dona-1" }, "en", antes)).resolves.toMatchObject({ estado: "pronta" });
    expect(antes).toHaveBeenCalledTimes(2);
  });

  it("quem esperou e viu a falha recebe o erro; o 'tentar de novo' recomeça sem receber o mesmo erro", async () => {
    banco.itens = [item("a")];
    pedirJsonAIA.mockRejectedValueOnce(new FalhaDaIA("IA_INDISPONIVEL"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(_paraTestes.falhas.size).toBe(0);

    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    await expect(traduzirResumoDaDona("dona-1", "r1", "en")).resolves.toMatchObject({ estado: "pronta" });
  });

  it("cada idioma é uma tradução própria", async () => {
    banco.itens = [item("a")];
    pedirJsonAIA.mockImplementation(tradutor(paraIngles));
    await traduzirResumoDaDona("dona-1", "r1", "en");
    await traduzirResumoDaDona("dona-1", "r1", "es");
    expect(pedirJsonAIA.mock.calls.map(([pedido]) => (pedido as Pedido).sistema.match(/para (\S+)\./)?.[1])).toEqual(["inglês", "espanhol"]);
  });
});
