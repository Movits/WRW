import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A13 — bloquear e-mail e telefone para impedir acordos fora da plataforma.
 *
 * D3 (Glenda, 31/08): contatos das partes somente para o consultor de
 * negócios, jamais entre as partes. Os dois critérios do cartão:
 *  1. Dados de contato não são ENTREGUES PELO SERVIDOR — não basta esconder
 *     na tela (getRoom parou de selecionar users.email das partes).
 *  2. A TENTATIVA de contorno fica registrada (auditoria em todo bloqueio).
 *
 * E a regra que não está no cartão mas decide se o recurso presta: conversa
 * de negócio é cheia de números legítimos — preço, CNPJ, CEP, quantidade.
 * Falso positivo aqui bloquearia a proposta da usuária; o detector é de
 * precisão em primeiro lugar.
 */

import { encontrarContatosEmTexto, mascararTrecho, mascararContatosEmTexto } from "../shared/contato-em-texto";

describe("A13 — o detector acha contato de verdade", () => {
  const casos: Array<[string, string]> = [
    ["e-mail simples", "me escreve em ana.silva@empresa.com.br que combinamos"],
    ["e-mail com subdomínio", "contato: JOAO_2026@mail.vendas.example.org"],
    ["celular com DDI", "chama no +55 11 99999-8888"],
    ["DDI com espaços", "meu número é +55 (11) 98888 7777"],
    ["internacional", "call me at +351 912 345 678"],
    ["DDD entre parênteses", "liga no (11) 98765-4321"],
    ["DDD sem espaço", "tel (21)3456-7890"],
    ["DDD com espaços — a forma mais comum", "me chama no 11 99999 8888"],
    ["DDD com pontos", "liga no 11.99999.8888"],
    ["nono dígito separado", "meu zap é 11 9 9999 8888"],
    ["DDD + fixo hifenizado", "escritório 11 3456-7890"],
    ["celular hifenizado sem DDD", "zap 99999-8888"],
    ["celular cru com DDD", "me acha no 11987654321"],
    ["fixo cru com DDD", "recado no 1134567890"],
    // Quem digita no celular repete espaço sem querer, e `.trim()` não colapsa
    // espaço interno: com um separador só, este telefone saía inteiro do texto
    // que a plataforma mostra para outra pessoa.
    ["DDD com espaço duplo", "fale comigo 11  99999  8888"],
    ["parênteses com espaço duplo", "liga no (11)  99999-8888"],
    ["DDI com espaço duplo", "chama no +55  11  99999-8888"],
  ];
  for (const [nome, texto] of casos) {
    it(nome, () => {
      expect(encontrarContatosEmTexto(texto).length).toBeGreaterThan(0);
    });
  }

  it("classifica e-mail e telefone separadamente", () => {
    const achados = encontrarContatosEmTexto("ana@ex.com ou (11) 99999-8888");
    expect(achados.map(a => a.tipo).sort()).toEqual(["email", "telefone"]);
  });
});

describe("A13 — telefone DITADO por extenso também é contato", () => {
  const casos: Array<[string, string]> = [
    ["celular soletrado", "anota aí: nove nove nove nove nove oito oito oito oito"],
    ["com 'meia' do ditado brasileiro", "meu número é nove meia meia cinco quatro três dois um zero"],
    ["DDD como palavra (onze)", "chama no onze nove nove nove nove oito oito oito oito"],
    ["misto de palavra e algarismo solto", "onze 9 nove nove nove 8 oito oito oito"],
    ["separado por vírgulas", "liga: nove, nove, nove, nove, nove, oito, oito, oito, oito"],
  ];
  for (const [nome, texto] of casos) {
    it(nome, () => {
      const achados = encontrarContatosEmTexto(texto);
      expect(achados.length).toBeGreaterThan(0);
      expect(achados[0].tipo).toBe("telefone");
    });
  }

  const legitimos: Array<[string, string]> = [
    ["quantidade por extenso", "fecho dois mil e quinhentos sacos para a safra"],
    ["enumeração curta", "temos as opções um, dois e três disponíveis"],
    ["medidas e unidades", "cinco toneladas em seis contêineres de doze metros"],
    ["preço falado", "sai por nove e noventa a unidade, oito no atacado"],
    ["lista de tamanhos em dígitos", "temos tamanhos 36 38 40 42 no estoque"],
  ];
  for (const [nome, texto] of legitimos) {
    it(`não bloqueia: ${nome}`, () => {
      expect(encontrarContatosEmTexto(texto)).toEqual([]);
    });
  }

  it("o ditado mascarado na bio some por inteiro", () => {
    const bio = "Café premium. Zap nove nove nove nove nove oito oito oito oito, falou?";
    const mascarada = mascararContatosEmTexto(bio);
    expect(mascarada).toContain("Café premium");
    expect(mascarada).not.toContain("nove nove nove nove nove oito oito oito oito");
  });
});

describe("A13 — números legítimos de negócio NÃO são bloqueados", () => {
  const casos: Array<[string, string]> = [
    ["preço com milhares", "a proposta é de R$ 1.500.000,00 pelo lote"],
    ["quantidade", "consigo entregar 5000 unidades por mês em 2026"],
    ["CNPJ pontuado", "nosso CNPJ é 12.345.678/0001-95 para a nota"],
    ["CPF pontuado", "meu CPF é 123.456.789-01 para o contrato"],
    ["CPF sem pontuação", "meu CPF é 12345678901 para o contrato"],
    ["linha de boleto", "o código de barras é 84670000001"],
    ["valor redondo de 10 dígitos", "produção anual de 1000000000 grãos"],
    ["CEP", "o endereço do armazém tem CEP 01310-100"],
    ["intervalo de anos (safra)", "fornecemos na safra 2025-2026 direto do produtor"],
    ["vigência de contrato", "contrato com vigência 2024-2028 renovável"],
    ["faixa de quantidades", "lotes entre 1000-5000 unidades"],
    ["faixa de preço", "na faixa de 1500-2000 reais a tonelada"],
    ["número de processo", "consta no processo nº 0123-2025 da junta"],
    ["nota fiscal", "emitimos a NF 4482-2026 na sexta"],
    ["percentual e parcelas", "40% na assinatura e 60% em 12 vezes de 12500"],
    ["datas e horários", "fechamos em 10/09/2026 às 14:30"],
    ["código de produto", "o item é o SKU 4482 do catálogo 2025"],
  ];
  for (const [nome, texto] of casos) {
    it(nome, () => {
      expect(encontrarContatosEmTexto(texto)).toEqual([]);
    });
  }

  it("troca deliberada documentada: fixo 4-4 SEM DDD é indistinguível de faixa e passa", () => {
    // "3456-7890" sozinho não bloqueia (seria bloquear "safra 2025-2026"
    // junto); com DDD ("11 3456-7890") bloqueia — coberto acima.
    expect(encontrarContatosEmTexto("meu fixo é 3456-7890")).toEqual([]);
  });
});

describe("A13 — a máscara do registro não espalha o dado", () => {
  it("telefone com espaço duplo sai mascarado por inteiro, não pela metade", () => {
    const mascarado = mascararContatosEmTexto("Precisamos revisar tributos. Fale comigo 11  99999  8888 ou ana@exemplo.com");
    expect(mascarado).not.toContain("99999");
    expect(mascarado).not.toContain("8888");
    expect(mascarado).not.toContain("ana@exemplo.com");
    expect(mascarado).toContain("revisar tributos");
  });

  it("esconde o miolo e preserva só as pontas", () => {
    const mascarado = mascararTrecho("ana.silva@empresa.com.br");
    expect(mascarado.startsWith("an")).toBe(true);
    expect(mascarado.endsWith("br")).toBe(true);
    expect(mascarado).not.toContain("empresa");
    expect(mascarado).toContain("*");
  });

  it("a bio que circula nos matches sai com o contato mascarado, e só ele", () => {
    const bio = "Exportadora de café desde 2010. Me chama no (11) 99999-8888 ou ana@ex.com.";
    const mascarada = mascararContatosEmTexto(bio);
    expect(mascarada).toContain("Exportadora de café desde 2010");
    expect(mascarada).not.toContain("99999-8888");
    expect(mascarada).not.toContain("ana@ex.com");
  });

  it("bio limpa passa intocada pela máscara", () => {
    const bio = "Consultora de comércio exterior, safra 2025-2026, lotes 1000-5000.";
    expect(mascararContatosEmTexto(bio)).toBe(bio);
  });
});

// ── Os canais: bloqueio EXECUTADO e tentativa registrada ────────────────────

const createAuditLog = vi.fn(async () => {});
vi.mock("./security", () => ({
  createAuditLog: (...args: unknown[]) => createAuditLog(...(args as [])),
  createNotification: async () => {},
}));

const inserido = vi.fn(async () => {});
const salaAtiva = { id: 7, ownerId: 1, interestedId: 2, opportunityId: 3, status: "active" };
vi.mock("./db", () => new Proxy({}, {
  has: () => true,
  get: (_alvo, prop) => {
    if (prop === "exigirDb") return async () => ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [salaAtiva] }) }) }),
      insert: () => ({ values: inserido }),
    });
    if (prop === "createNotification") return async () => {};
    if (prop === "expressInterest") return async () => ({ alreadyExists: false });
    if (prop === "sendConnectionRequest") return async () => ({ revelou: false, connectionId: 7, emAnalise: false });
    if (prop === "then" || prop === Symbol.toStringTag) return undefined;
    return async () => undefined;
  },
}));

const { dealRoomRouter } = await import("./routers/dealRoom");
const { connectionsRouter } = await import("./routers/connections");
const { opportunitiesRouter } = await import("./routers/opportunities");

const ctx = (id: number, role = "silver") => ({
  user: { id, openId: `u-${id}`, email: "t@local", role },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;

beforeEach(() => {
  createAuditLog.mockClear();
  inserido.mockClear();
});

describe("A13 — chat do Deal Room recusa contato e registra", () => {
  it("mensagem com telefone é recusada, nada é gravado, e a tentativa vai para a auditoria", async () => {
    const caller = dealRoomRouter.createCaller(ctx(1));
    await expect(caller.sendMessage({ roomId: 7, content: "fecha comigo direto: (11) 99999-8888" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Pelas regras da Marquesa Global Match, dados de contato") });
    expect(inserido).not.toHaveBeenCalled();
    // o registro diz QUEM tentou e PARA ONDE o contato iria (sala 7)
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CONTACT_EXCHANGE_BLOCKED", status: "blocked", resourceId: "7",
    }));
    // e o registro NÃO carrega o telefone em claro
    const detalhes = JSON.stringify(createAuditLog.mock.calls[0][0]);
    expect(detalhes).not.toContain("99999-8888");
  });

  it("mensagem limpa de negócio passa", async () => {
    const caller = dealRoomRouter.createCaller(ctx(1));
    await expect(caller.sendMessage({ roomId: 7, content: "Proponho R$ 1.500.000 por 5000 unidades, entrega em 2026." }))
      .resolves.toMatchObject({ success: true });
    expect(inserido).toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();
  });
});

describe("A13 — mensagem direta e pedido de conexão passam pela mesma porta", () => {
  it("mensagem direta com e-mail é recusada e registrada", async () => {
    const caller = connectionsRouter.createCaller(ctx(1, "gold"));
    await expect(caller.sendMessage({ recipientId: 2, content: "me chama em ana@ex.com" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CONTACT_EXCHANGE_BLOCKED" }));
  });

  // O bilhete do pedido de conexão deixou de existir (12/09/2026, regra do
  // interesse mútuo): o pedido é anônimo, e o detector A13 barra telefone e
  // e-mail — não barra NOME. "Oi, aqui é a Ana da Vinícola X" atravessaria o
  // anonimato inteiro numa linha de texto livre. Fechar o canal é mais forte do
  // que filtrá-lo, então o que se trava aqui é que ele continue fechado.
  it("o bilhete do pedido de conexão continua fechado, e a alça não é id de pessoa", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const fonte = readFileSync(join(__dirname, "routers", "connections.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("send: protectedProcedure"), fonte.indexOf("respond: protectedProcedure"));
    expect(corpo).toContain("matchId: z.number().int()");
    // O que não pode voltar é um CAMPO de texto livre na entrada (o `message:` de
    // um TRPCError é outra coisa, e legítimo).
    expect(corpo).not.toContain("message: z.string");
    expect(corpo).not.toContain("targetUserId");
  });

  it("a resposta de send é a MESMA para pedido novo, repetido, recusado ou bloqueado", () => {
    // Antes, linha existente virava CONFLICT distinguível — um oráculo que
    // respondia "essa pessoa já te recusou" a quem perguntasse.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const fonte = readFileSync(join(__dirname, "routers", "connections.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("send: protectedProcedure"), fonte.indexOf("respond: protectedProcedure"));
    // A palavra pode aparecer em comentário explicando por que ela saiu; o que
    // não pode voltar é o código do erro sendo lançado.
    expect(corpo).not.toContain('code: "CONFLICT"');
  });

  it("o registro fora do Deal Room também identifica o alvo", async () => {
    const caller = connectionsRouter.createCaller(ctx(1, "gold"));
    await expect(caller.sendMessage({ recipientId: 42, content: "me chama no 11 99999 8888" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ resourceId: "42" }));
  });
});

describe("A13 — mensagem de interesse na oportunidade (execução real)", () => {
  it("interesse com telefone é recusado e registrado com o alvo", async () => {
    const caller = opportunitiesRouter.createCaller(ctx(1));
    await expect(caller.expressInterest({ opportunityId: 42, message: "fechamos por fora? 11.99999.8888" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CONTACT_EXCHANGE_BLOCKED", resourceId: "42",
    }));
  });

  it("interesse limpo segue normal", async () => {
    const caller = opportunitiesRouter.createCaller(ctx(1));
    await expect(caller.expressInterest({ opportunityId: 42, message: "Tenho distribuição na Europa, interesse em 1000-5000 unidades." }))
      .resolves.toMatchObject({ success: true });
    expect(createAuditLog).not.toHaveBeenCalled();
  });
});

describe("A13 — os canais restantes passam pela mesma porta (pins de fonte)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");

  it("openRoom (mensagem de apresentação, chega ANTES do NDA)", () => {
    const fonte = readFileSync(join(__dirname, "routers", "dealRoom.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("openRoom:"), fonte.indexOf("acceptNDA:"));
    expect(corpo).toContain('exigirTextoSemContato(ctx.user.id, "deal_room.openRoom", input.message, input.opportunityId)');
  });

  it("uploadDocument (o NOME do arquivo é texto livre que a contraparte lê)", () => {
    const fonte = readFileSync(join(__dirname, "routers", "dealRoom.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("uploadDocument:"), fonte.indexOf("listDocuments:"));
    expect(corpo).toContain('exigirTextoSemContato(ctx.user.id, "deal_room.uploadDocument", input.name, input.roomId)');
  });

  it("opportunities.create (broadcast para o ecossistema inteiro)", () => {
    const fonte = readFileSync(join(__dirname, "routers", "opportunities.ts"), "utf8");
    expect(fonte).toContain('ctx.user.id, "opportunities.create"');
    expect(fonte).toContain("[input.title, input.description, ...input.tags].join");
  });

  it("a bio nem circula mais nos matches: deixou de ser lida (db.ts)", () => {
    // A asserção anterior exigia que a bio saísse MASCARADA contra telefone e
    // e-mail. Ela deixou de ser selecionada — proteção maior, não menor: o que
    // não é lido não precisa ser mascarado. A máscara segue viva e em uso no
    // resto do produto (Deal Room, oportunidades).
    const fonte = readFileSync(join(__dirname, "db.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("export async function getMatchesForUser"), fonte.indexOf("export async function dismissMatch"));
    expect(corpo).not.toContain("userProfiles.bio");
    for (const proibida of ["displayName: userProfiles.displayName", "avatarUrl", "users.name", "users.company", "users.position"]) {
      expect(corpo).not.toContain(proibida);
    }
    // O nome só existe na consulta atrás do portão do aceite — a forma crua
    // acima é que está proibida, não a condicionada.
    expect(corpo).toContain("CASE WHEN ${connections.status} = 'accepted'");
  });
});

describe("A13 — o servidor não entrega o e-mail das partes (critério 1)", () => {
  it("getRoom não seleciona users.email para owner/interested", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(join(__dirname, "routers", "dealRoom.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("getRoom:"), fonte.indexOf("listRooms:"));
    expect(corpo).not.toContain("users.email");
  });

  it("o payload executado de getRoom sai sem e-mail", async () => {
    const caller = dealRoomRouter.createCaller(ctx(1));
    const sala = await caller.getRoom({ roomId: 7 });
    // o fake devolve a mesma linha para todo select; o que importa é a forma
    expect(JSON.stringify(sala)).not.toContain("email");
  });
});
