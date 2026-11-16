import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Meu Network Inteligente — QUEM SOU, O QUE TENHO e O QUE PRECISO a partir de
 * uma conversa (spec da Glenda de 14/09, itens 5 a 10).
 *
 * O que se trava:
 * 1. A IA não inventa: item sem trecho literal na fonte cai, e também o de
 *    trecho de uma palavra só, negado pela fonte, ou cujo texto acrescenta o
 *    que o trecho não diz; telefone que não é um número inteiro da fonte,
 *    e-mail que não aparece inteiro e nome que a fonte não sustenta caem.
 * 2. QUEM SOU é só identificação: o schema da resposta tem nome, telefone,
 *    e-mail e tipo de pessoa — e mais nada.
 * 3. Nada entra sozinho: o que passa vira pendência 'pendente', com origem e
 *    confiança; confirmar grava no contato UMA vez (status no WHERE, tomada e
 *    escrita na mesma transação: falhou, rollback) e não duplica o item que o
 *    contato já tem.
 * 4. O que o contato já tem não vira pendência, nem a que já está aberta;
 *    valor diferente vira (a dona decide, nada é sobrescrito sem ela).
 * 5. Tenho/Preciso não carregam nome, empresa, telefone ou e-mail do contato:
 *    podem circular sem identificação na rede global.
 */

type Resposta = unknown[][] | { affectedRows: number };
const estado = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  responder: (_sql: string, _params: unknown[]): unknown => undefined,
}));

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      estado.consultas.push({ sql: config.sql, params });
      const resposta = estado.responder(config.sql, params);
      if (resposta instanceof Error) throw resposta;
      if (resposta && !Array.isArray(resposta)) return [resposta as Resposta, []];
      if (/^\s*(insert|update|delete)/i.test(config.sql)) return [{ affectedRows: 1 }, []];
      return [resposta ?? [], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM }));

const extracao = await import("./network-extracao");
const {
  trechoEstaNaFonte, telefoneEstaNaFonte, emailEstaNaFonte, nomeEstaNaFonte, filtrarPelaFonte,
  ESQUEMA_DO_PERFIL, interpretarComplemento, pendenciasDaProposta, semRepeticao, gravarPendencias,
  confirmarPendencia, ignorarPendencia, valorParaGravar, PendenciaNaoEncontrada, ValorInvalido,
  decidirPendenciasDaPessoaSugerida, pendenciasDaPessoaNaReuniao, textoSustentadoPeloTrecho, itemIdentificaOContato,
  MENSAGEM_ITEM_COM_IDENTIFICACAO,
} = extracao;
const { exigirDb } = await import("./db");

const TRANSCRICAO = `Oi, eu sou a Maria Silva, da Farmabras Distribuidora. A gente atua na distribuição de medicamentos em todo o Brasil.
Meu telefone é (11) 98765-4321 e o e-mail é maria arroba farmabras ponto com ponto br.
Estamos procurando novos fornecedores internacionais, principalmente da Índia.`;

beforeEach(() => {
  estado.consultas = [];
  estado.responder = () => undefined;
  invokeLLM.mockReset();
});

describe("o portão — o que não está na fonte não passa", () => {
  it("trecho: literal (sem acento, pontuação ou caixa), com reticência cada pedaço; inventado não passa", () => {
    expect(trechoEstaNaFonte("atua na distribuição de medicamentos", TRANSCRICAO)).toBe(true);
    expect(trechoEstaNaFonte("\"ATUA NA DISTRIBUICAO de medicamentos\"", TRANSCRICAO)).toBe(true);
    expect(trechoEstaNaFonte("procurando novos fornecedores … da Índia", TRANSCRICAO)).toBe(true);
    expect(trechoEstaNaFonte("possui rede de clínicas", TRANSCRICAO)).toBe(false);
    // pedaço de palavra não conta como a palavra
    expect(trechoEstaNaFonte("distribui", TRANSCRICAO)).toBe(false);
    expect(trechoEstaNaFonte("", TRANSCRICAO)).toBe(false);
    expect(trechoEstaNaFonte(null, TRANSCRICAO)).toBe(false);
  });

  it("trecho: uma palavra solta não prova nada — nem preposição, nem substantivo", () => {
    const fonte = "Oi, sou a Joana. Estou aqui para conhecer pessoas.";
    expect(trechoEstaNaFonte("para", fonte)).toBe(false);
    expect(trechoEstaNaFonte("pessoas", fonte)).toBe(false);
    expect(trechoEstaNaFonte("conhecer pessoas", fonte)).toBe(true);
  });

  it("trecho: o que a fonte nega não sustenta nada — antes do trecho ou dentro dele; 'não só' não nega", () => {
    expect(trechoEstaNaFonte("temos distribuidor no Chile", "A gente ainda não temos distribuidor no Chile.")).toBe(false);
    expect(trechoEstaNaFonte("distribuidor no Chile", "A gente ainda não tem um distribuidor no Chile.")).toBe(false);
    expect(trechoEstaNaFonte("distribuidor no Chile", "Hoje estamos sem distribuidor no Chile.")).toBe(false);
    expect(trechoEstaNaFonte("não precisamos de investidores", "Não precisamos de investidores agora.")).toBe(false);
    expect(trechoEstaNaFonte("distribuímos medicamentos", "Não só distribuímos medicamentos como fabricamos.")).toBe(true);
    // a negação de outra oração não alcança o trecho
    expect(trechoEstaNaFonte("distribuímos medicamentos", "Não temos fábrica, distribuímos medicamentos.")).toBe(true);
  });

  it("texto do item: resume o trecho, nunca acrescenta palavra ou número que o trecho não diz", () => {
    // resumo e nominalização passam; "no Brasil" vem logo depois do trecho
    expect(textoSustentadoPeloTrecho("Distribuição de medicamentos no Brasil", "atua na distribuição de medicamentos", TRANSCRICAO)).toBe(true);
    expect(textoSustentadoPeloTrecho("Fabricação de cosméticos", "fabricamos cosméticos veganos", "Nós fabricamos cosméticos veganos.")).toBe(true);
    expect(textoSustentadoPeloTrecho("Venda de café especial", "vendemos café especial", "A gente vendemos café especial.")).toBe(true);
    // trecho verdadeiro não é passe para texto inventado
    expect(textoSustentadoPeloTrecho("Fundo de investimento com R$ 50 milhões", "atua na distribuição de medicamentos", TRANSCRICAO)).toBe(false);
    expect(textoSustentadoPeloTrecho("Investidores internacionais", "procurando novos fornecedores internacionais", TRANSCRICAO)).toBe(false);
    // número que o trecho não diz
    expect(textoSustentadoPeloTrecho("Café especial: 2 toneladas", "vendemos café especial", "A gente vendemos café especial.")).toBe(false);
    // texto sem palavra nenhuma
    expect(textoSustentadoPeloTrecho("...", "atua na distribuição de medicamentos", TRANSCRICAO)).toBe(false);
  });

  it("telefone: os dígitos precisam estar na fala (o +55 omitido na fala é aceito); número inventado não passa", () => {
    expect(telefoneEstaNaFonte("(11) 98765-4321", TRANSCRICAO)).toBe(true);
    expect(telefoneEstaNaFonte("+55 11 98765-4321", TRANSCRICAO)).toBe(true);
    expect(telefoneEstaNaFonte("+55 11 91234-5678", TRANSCRICAO)).toBe(false);
    expect(telefoneEstaNaFonte("4321", TRANSCRICAO)).toBe(false);
  });

  it("telefone: DDD que a fonte não diz, pedaço de outro número ou do CNPJ não passam; o código de país dito na fonte, sim", () => {
    expect(telefoneEstaNaFonte("(21) 98765-4321", "O celular dela é 98765-4321.")).toBe(false);
    expect(telefoneEstaNaFonte("9876-5432", TRANSCRICAO)).toBe(false);
    expect(telefoneEstaNaFonte("5678-0001", "CNPJ 12.345.678/0001-90")).toBe(false);
    expect(telefoneEstaNaFonte("1234-5678", "CNPJ 12.345.678/0001-90")).toBe(false);
    expect(telefoneEstaNaFonte("(11) 98765-4321", "Fone: +55 11 98765-4321.")).toBe(true);
    expect(telefoneEstaNaFonte("415 555 0100", "Call me at +1 415 555 0100.")).toBe(true);
    // " / " separa dois números: cada um vale inteiro
    expect(telefoneEstaNaFonte("(11) 91234-5678", "Fones 11 98765-4321 / 11 91234-5678")).toBe(true);
  });

  it("e-mail: escrito ou ditado ('arroba', 'ponto'); montado a partir do nome da empresa não passa", () => {
    expect(emailEstaNaFonte("maria@farmabras.com.br", TRANSCRICAO)).toBe(true);
    expect(emailEstaNaFonte("contato@farmabras.com.br", TRANSCRICAO)).toBe(false);
    expect(emailEstaNaFonte("isso não é e-mail", TRANSCRICAO)).toBe(false);
    // endereço truncado não passa; o ponto final da frase não faz parte do endereço
    expect(emailEstaNaFonte("maria@farmabras.com", TRANSCRICAO)).toBe(false);
    expect(emailEstaNaFonte("aria@farmabras.com.br", "e-mail: maria@farmabras.com.br")).toBe(false);
    expect(emailEstaNaFonte("maria@x.com", "O e-mail é maria@x.com.")).toBe(true);
  });

  it("nome: toda palavra de 3+ letras aparece na fonte", () => {
    expect(nomeEstaNaFonte("Maria Silva", TRANSCRICAO)).toBe(true);
    expect(nomeEstaNaFonte("Maria da Silva", TRANSCRICAO)).toBe(true);
    expect(nomeEstaNaFonte("Mariana Souza", TRANSCRICAO)).toBe(false);
  });

  it("filtrarPelaFonte deixa só o que a fonte sustenta — e nunca devolve cargo ou setor em QUEM SOU", () => {
    const filtrado = filtrarPelaFonte({
      quemSou: { tipoPessoa: "fisica", nome: "Maria Silva", telefone: "+55 11 90000-0000", email: "maria@farmabras.com.br" },
      oQueTenho: [
        { texto: "Distribuição de medicamentos no Brasil", categoria: "Distribuição", trecho: "atua na distribuição de medicamentos em todo o Brasil", confianca: 0.9 },
        { texto: "Rede de clínicas", categoria: null, trecho: "possui rede de clínicas", confianca: 0.9 },
      ],
      oQuePreciso: [{ texto: "Fornecedores internacionais", categoria: null, trecho: "procurando novos fornecedores internacionais", confianca: 1.7 }],
    }, TRANSCRICAO);
    expect(filtrado.quemSou).toEqual({ tipoPessoa: "fisica", nome: "Maria Silva", telefone: null, email: "maria@farmabras.com.br" });
    expect(filtrado.oQueTenho.map(i => i.texto)).toEqual(["Distribuição de medicamentos no Brasil"]);
    expect(filtrado.oQuePreciso).toEqual([{ texto: "Fornecedores internacionais", categoria: null, trecho: "procurando novos fornecedores internacionais", confianca: 1 }]);
  });

  it("Tenho/Preciso sem identificação: nome, empresa, telefone ou e-mail derrubam o item; palavra solta do nome, não", () => {
    expect(itemIdentificaOContato("Farmabras: distribuição de medicamentos", { nomes: ["Farmabras"] })).toBe(true);
    expect(itemIdentificaOContato("Maria Silva: genéricos", { nomes: ["Maria da Silva"] })).toBe(true);
    expect(itemIdentificaOContato("Genéricos (11) 98765-4321", {})).toBe(true);
    expect(itemIdentificaOContato("Genéricos, 98765-4321", { telefones: ["+55 11 98765-4321"] })).toBe(true);
    expect(itemIdentificaOContato("Genéricos — maria@farmabras.com.br", {})).toBe(true);
    expect(itemIdentificaOContato("Distribuição de medicamentos no Brasil", { nomes: ["Medicamentos Brasil"] })).toBe(false);
    expect(itemIdentificaOContato("Capital de R$ 1.000.000.000 para a safra 2024-2025", {})).toBe(false);

    const filtrado = filtrarPelaFonte({
      quemSou: { tipoPessoa: "juridica", nome: "Farmabras Distribuidora", telefone: null, email: null },
      oQueTenho: [
        { texto: "Farmabras Distribuidora: medicamentos no Brasil", categoria: null, trecho: "atua na distribuição de medicamentos em todo o Brasil", confianca: 0.9 },
        { texto: "Distribuição de medicamentos no Brasil", categoria: null, trecho: "atua na distribuição de medicamentos em todo o Brasil", confianca: 0.9 },
      ],
      oQuePreciso: [{ texto: "Maria Silva: fornecedores internacionais", categoria: null, trecho: "procurando novos fornecedores internacionais", confianca: 0.9 }],
    }, TRANSCRICAO, { nomes: ["Maria Silva"] });
    expect(filtrado.oQueTenho.map(i => i.texto)).toEqual(["Distribuição de medicamentos no Brasil"]);
    expect(filtrado.oQuePreciso).toEqual([]);
  });

  it("o schema pedido ao modelo: QUEM SOU tem só tipo de pessoa, nome, telefone e e-mail", () => {
    expect(Object.keys(ESQUEMA_DO_PERFIL.properties.quemSou.properties).sort()).toEqual(["email", "nome", "telefone", "tipoPessoa"]);
    expect(ESQUEMA_DO_PERFIL.properties.oQueTenho.items.required).toContain("trecho");
  });
});

describe("interpretar texto ou voz", () => {
  it("a resposta do modelo passa pelo portão antes de sair: o que ele inventou não chega a quem chama", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      quemSou: { tipoPessoa: "juridica", nome: "Farmabras Distribuidora", telefone: "(11) 3333-3333", email: null },
      oQueTenho: [{ texto: "Indústria de cosméticos", categoria: null, trecho: "fabricamos cosméticos", confianca: 0.8 }],
      oQuePreciso: [{ texto: "Fornecedores internacionais", categoria: null, trecho: "Estamos procurando novos fornecedores internacionais", confianca: 0.8 }],
    }) } }] });
    const proposta = await interpretarComplemento(TRANSCRICAO, { nomeDoContato: "Maria Silva" });
    expect(proposta.quemSou).toEqual({ tipoPessoa: "juridica", nome: "Farmabras Distribuidora", telefone: null, email: null });
    expect(proposta.oQueTenho).toEqual([]);
    expect(proposta.oQuePreciso.map(i => i.texto)).toEqual(["Fornecedores internacionais"]);
    const [{ messages, response_format }] = invokeLLM.mock.calls[0];
    expect(messages[0].content).toContain("NÃO INVENTE");
    expect(messages[0].content).toContain("SOMENTE identificação");
    expect(messages[0].content).toContain("NUNCA levam nome de pessoa, razão social");
    expect(response_format.json_schema.strict).toBe(true);
  });

  it("resposta que não é JSON: erro, nunca proposta vazia fingindo que nada foi dito", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "não sei" } }] });
    await expect(interpretarComplemento("texto", { nomeDoContato: "X" })).rejects.toThrow("interpretação válida");
  });
});

describe("pendências — nada entra sozinho", () => {
  it("a proposta vira linhas por campo; tipo não informado não vira pendência", () => {
    const linhas = pendenciasDaProposta({
      quemSou: { tipoPessoa: "nao_informado", nome: "Maria Silva", telefone: null, email: "maria@farmabras.com.br" },
      oQueTenho: [{ texto: "Distribuição de medicamentos", categoria: null, trecho: "t", confianca: 0.9 }],
      oQuePreciso: [],
    });
    expect(linhas.map(l => l.campo)).toEqual(["nome", "email", "tenho"]);
  });

  it("o que o contato já tem não vira pendência; valor diferente vira; repetido na proposta entra uma vez", () => {
    const atual = { fullName: "Maria Silva", phone: "+55 11 98765-4321", whatsapp: null, email: "antigo@x.com", tipoPessoa: null, tenho: ["Distribuição de medicamentos"], preciso: [] };
    const linhas = semRepeticao([
      { campo: "nome", valor: "maria silva", categoria: null, trecho: null, confianca: 1 },
      { campo: "telefone", valor: "(11) 98765-4321", categoria: null, trecho: null, confianca: 1 },
      { campo: "email", valor: "maria@farmabras.com.br", categoria: null, trecho: null, confianca: 1 },
      { campo: "tenho", valor: "Distribuição de Medicamentos", categoria: null, trecho: null, confianca: 1 },
      { campo: "preciso", valor: "Fornecedores", categoria: null, trecho: null, confianca: 1 },
      { campo: "preciso", valor: "fornecedores", categoria: null, trecho: null, confianca: 1 },
    ], atual);
    expect(linhas.map(l => `${l.campo}:${l.valor}`)).toEqual(["email:maria@farmabras.com.br", "preciso:Fornecedores"]);
  });

  it("gravar: status 'pendente', origem e confiança, sempre com o owner", async () => {
    const db = await exigirDb();
    await gravarPendencias(db, {
      ownerId: "dona-1", origem: "voz", contactId: 5,
      linhas: [{ campo: "tenho", valor: "Distribuição", categoria: null, trecho: "a distribuição", confianca: 0.75 }],
    });
    const insert = estado.consultas.find(c => /^insert into `network_sugestoes`/.test(c.sql))!;
    expect(insert.params).toEqual(expect.arrayContaining(["dona-1", 5, "voz", "tenho", "Distribuição", "a distribuição", "0.750", "pendente"]));
  });

  it("gravar: a pendência que o contato já tem aberta não abre de novo, nem repetida na mesma leva", async () => {
    // campo, valor das pendências abertas do contato
    estado.responder = sql => (/from `network_sugestoes`/.test(sql) ? [["tenho", "Distribuição de medicamentos"], ["telefone", "(11) 98765-4321"]] : undefined);
    const db = await exigirDb();
    const criadas = await gravarPendencias(db, {
      ownerId: "dona-1", origem: "texto", contactId: 5,
      linhas: [
        { campo: "tenho", valor: "distribuição de Medicamentos", categoria: null, trecho: "t", confianca: 0.9 },
        { campo: "telefone", valor: "11 98765 4321", categoria: null, trecho: null, confianca: 0.9 },
        { campo: "preciso", valor: "Fornecedores", categoria: null, trecho: "t", confianca: 0.9 },
        { campo: "preciso", valor: "fornecedores", categoria: null, trecho: "t", confianca: 0.9 },
      ],
    });
    expect(criadas).toBe(1);
    const [leitura] = estado.consultas;
    expect(leitura.sql).toMatch(/^select .* from `network_sugestoes`/);
    expect(leitura.params).toEqual(expect.arrayContaining(["dona-1", 5, "pendente"]));
    const insert = estado.consultas.find(c => /^insert into `network_sugestoes`/.test(c.sql))!;
    expect(insert.params).toContain("Fornecedores");
    expect(insert.params).not.toContain("distribuição de Medicamentos");
    expect(insert.params).not.toContain("fornecedores");
  });

  it("a pessoa sugerida pela reunião: só o que a transcrição sustenta vira pendência", () => {
    const linhas = pendenciasDaPessoaNaReuniao({
      tipoPessoa: "juridica",
      oQueTenho: [{ texto: "Distribuição de medicamentos", categoria: null, trecho: "distribuição de medicamentos em todo o Brasil", confianca: 0.9 }],
      oQuePreciso: [{ texto: "Investidores", categoria: null, trecho: "procuramos investidores", confianca: 0.9 }],
    }, TRANSCRICAO);
    expect(linhas.map(l => `${l.campo}:${l.valor}`)).toEqual(["tipo_pessoa:juridica", "tenho:Distribuição de medicamentos"]);
    // resposta antiga, sem os campos novos: nada quebra, nada é criado
    expect(pendenciasDaPessoaNaReuniao({}, TRANSCRICAO)).toEqual([]);
  });

  it("a pessoa sugerida pela reunião: trecho de uma palavra não sustenta texto inventado, e o nome/empresa dela não entra no item", () => {
    expect(pendenciasDaPessoaNaReuniao({
      oQueTenho: [{ texto: "Fundo de investimento com R$ 50 milhões", categoria: null, trecho: "para", confianca: 1 }],
      oQuePreciso: [{ texto: "Distribuidores na Europa", categoria: null, trecho: "pessoas", confianca: 1 }],
    }, "Oi, sou a Joana. Estou aqui para conhecer pessoas.")).toEqual([]);

    const linhas = pendenciasDaPessoaNaReuniao({
      fullName: "Maria Silva", company: "Farmabras", phone: "(11) 98765-4321",
      oQueTenho: [
        { texto: "Farmabras: distribuição de medicamentos no Brasil", categoria: null, trecho: "distribuição de medicamentos em todo o Brasil", confianca: 0.9 },
        { texto: "Distribuição de medicamentos no Brasil", categoria: null, trecho: "distribuição de medicamentos em todo o Brasil", confianca: 0.9 },
      ],
    }, TRANSCRICAO);
    expect(linhas.map(l => l.valor)).toEqual(["Distribuição de medicamentos no Brasil"]);
  });
});

describe("pendências — confirmar e ignorar", () => {
  // id, owner_id, contact_id, meeting_id, meeting_suggestion_id, origem, campo, valor, categoria, trecho, confianca, status, decidida_em, created_at, updated_at
  const linha = (campo: string, valor: string, contactId: number | null = 5) =>
    ["p-1", "dona-1", contactId, null, null, "texto", campo, valor, null, "trecho", "0.900", "pendente", null, 1, 1];

  // id, fullName, company, phone, whatsapp
  const contato = [[5, "Maria Silva", "Farmabras", "+55 11 98765-4321", null]];

  it("tenho: na mesma transação, toma a pendência (status no WHERE) primeiro e grava em contact_assets da dona", async () => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("tenho", "Distribuição de medicamentos")];
      if (/from `private_contacts`/.test(sql)) return contato;
      return undefined;
    };
    const r = await confirmarPendencia("dona-1", "0b3f0e4e-0000-4000-8000-000000000001");
    expect(r).toEqual({ campo: "tenho", contactId: 5, mudouTenhoOuPreciso: true });
    const daTransacao = estado.consultas.map(c => c.sql).slice(estado.consultas.findIndex(c => c.sql === "begin"));
    expect(daTransacao[0]).toBe("begin");
    expect(daTransacao[1]).toMatch(/^update `network_sugestoes` set `valor` = \?, `status` = \?/);
    expect(daTransacao[1]).toContain("`network_sugestoes`.`status` = ?");
    expect(daTransacao[2]).toMatch(/^select .* from `contact_assets`/);
    expect(daTransacao[3]).toMatch(/^insert into `contact_assets`/);
    expect(daTransacao.at(-1)).toBe("commit");
    const insert = estado.consultas.find(c => /^insert into `contact_assets`/.test(c.sql))!;
    expect(insert.params).toEqual(expect.arrayContaining(["dona-1", 5, "Distribuição de medicamentos"]));
  });

  it("categoria que a IA propôs não vira dado: nem o esquema pede, nem o portão deixa passar, nem a confirmação grava", async () => {
    expect(Object.keys(ESQUEMA_DO_PERFIL.properties.oQueTenho.items.properties)).not.toContain("categoria");
    expect(Object.keys(ESQUEMA_DO_PERFIL.properties.oQuePreciso.items.properties)).not.toContain("categoria");
    const filtrado = filtrarPelaFonte({
      quemSou: { tipoPessoa: "nao_informado", nome: null, telefone: null, email: null },
      oQueTenho: [{ texto: "Distribuição de medicamentos no Brasil", categoria: "Saúde", trecho: "atua na distribuição de medicamentos em todo o Brasil", confianca: 0.9 }],
      oQuePreciso: [],
    }, TRANSCRICAO);
    expect(filtrado.oQueTenho).toHaveLength(1);
    expect(filtrado.oQueTenho[0].categoria).toBeNull();

    // Pendência gravada antes desta correção, ainda com a categoria do modelo na coluna.
    const comCategoria = ["p-1", "dona-1", 5, null, null, "texto", "tenho", "Distribuição de medicamentos", "Saúde", "trecho", "0.900", "pendente", null, 1, 1];
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [comCategoria];
      if (/from `private_contacts`/.test(sql)) return contato;
      return undefined;
    };
    await confirmarPendencia("dona-1", "p-1");
    const insert = estado.consultas.find(c => /^insert into `contact_assets`/.test(c.sql))!;
    expect(insert.params).not.toContain("Saúde");
  });

  it("tenho que o contato já tem (mesmo slug ou mesmo rótulo): confirma sem inserir de novo e não pede recálculo", async () => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("tenho", "Distribuição de Medicamentos")];
      if (/from `private_contacts`/.test(sql)) return contato;
      if (/from `contact_assets`/.test(sql)) return [[31]];
      return undefined;
    };
    const r = await confirmarPendencia("dona-1", "p-1");
    expect(r).toEqual({ campo: "tenho", contactId: 5, mudouTenhoOuPreciso: false });
    const conferencia = estado.consultas.find(c => /from `contact_assets`/.test(c.sql))!;
    expect(conferencia.sql).toContain("`contact_assets`.`tag_slug` = ? or `contact_assets`.`tag_label` = ?");
    expect(conferencia.params).toEqual(expect.arrayContaining(["dona-1", 5, "distribuicao-de-medicamentos", "Distribuição de Medicamentos"]));
    expect(estado.consultas.some(c => /^insert into `contact_assets`/.test(c.sql))).toBe(false);
    expect(estado.consultas.some(c => /^update `network_sugestoes`/.test(c.sql))).toBe(true);
    expect(estado.consultas.at(-1)!.sql).toBe("commit");
  });

  it("tenho/preciso só de pontuação: recusado antes de qualquer escrita (tag_slug vazio)", async () => {
    expect(() => valorParaGravar("preciso", "...")).toThrow(ValorInvalido);
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("preciso", "Fornecedores")];
      if (/from `private_contacts`/.test(sql)) return contato;
      return undefined;
    };
    await expect(confirmarPendencia("dona-1", "p-1", "…!")).rejects.toBeInstanceOf(ValorInvalido);
    expect(estado.consultas.some(c => /^(update|insert|begin)/.test(c.sql))).toBe(false);
  });

  it("tenho/preciso com nome, empresa ou telefone do contato: recusado antes de qualquer escrita", async () => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("tenho", "Farmabras: distribuição de medicamentos")];
      if (/from `private_contacts`/.test(sql)) return contato;
      return undefined;
    };
    await expect(confirmarPendencia("dona-1", "p-1")).rejects.toThrow(MENSAGEM_ITEM_COM_IDENTIFICACAO);
    await expect(confirmarPendencia("dona-1", "p-1", "Medicamentos — ligar 98765-4321")).rejects.toBeInstanceOf(ValorInvalido);
    await expect(confirmarPendencia("dona-1", "p-1", "Maria Silva distribui medicamentos")).rejects.toBeInstanceOf(ValorInvalido);
    expect(estado.consultas.some(c => /^(update|insert|begin)/.test(c.sql))).toBe(false);
    // a dona corrige e confirma
    await confirmarPendencia("dona-1", "p-1", "Distribuição de medicamentos");
    expect(estado.consultas.some(c => /^insert into `contact_assets`/.test(c.sql))).toBe(true);
  });

  it("telefone corrigido pela dona: o valor dela é o gravado, só no contato dela", async () => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("telefone", "(11) 98765-4321")];
      if (/from `private_contacts`/.test(sql)) return [[5]];
      return undefined;
    };
    await confirmarPendencia("dona-1", "p-1", "+55 11 98765-4321");
    const update = estado.consultas.find(c => /^update `private_contacts`/.test(c.sql))!;
    expect(update.sql).toContain("`phone` = ?");
    expect(update.sql).toContain("`private_contacts`.`ownerId` = ?");
    expect(update.params).toEqual(expect.arrayContaining(["+55 11 98765-4321", 5, "dona-1"]));
  });

  it("dois cliques: a segunda tomada acha 0 linhas e não grava de novo", async () => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("preciso", "Fornecedores")];
      if (/from `private_contacts`/.test(sql)) return [[5]];
      if (/^update `network_sugestoes`/.test(sql)) return { affectedRows: 0 };
      return undefined;
    };
    await expect(confirmarPendencia("dona-1", "p-1")).rejects.toBeInstanceOf(PendenciaNaoEncontrada);
    expect(estado.consultas.some(c => /^insert into `contact_needs`/.test(c.sql))).toBe(false);
  });

  it("a escrita no contato falhou (banco caiu no meio): rollback desfaz a tomada, sem reversão manual, e o erro sobe", async () => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("tenho", "Distribuição")];
      if (/from `private_contacts`/.test(sql)) return contato;
      if (/^insert into `contact_assets`/.test(sql)) return Object.assign(new Error("Connection lost"), { code: "PROTOCOL_CONNECTION_LOST" });
      return undefined;
    };
    // o drizzle embrulha o erro do driver (DrizzleQueryError, com o original em `cause`)
    await expect(confirmarPendencia("dona-1", "p-1")).rejects.toThrow(/insert into `contact_assets`/);
    const sqls = estado.consultas.map(c => c.sql);
    expect(sqls.indexOf("begin")).toBeLessThan(sqls.findIndex(sql => /^update `network_sugestoes`/.test(sql)));
    expect(sqls.at(-1)).toBe("rollback");
    expect(sqls).not.toContain("commit");
    // a tomada foi a única escrita em network_sugestoes: quem desfaz é o rollback
    expect(estado.consultas.filter(c => /^update `network_sugestoes`/.test(c.sql))).toHaveLength(1);
  });

  it("dois cliques: a segunda tomada acha 0 linhas dentro da transação, que é desfeita sem gravar no contato", async () => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [linha("nome", "Maria Silva")];
      if (/from `private_contacts`/.test(sql)) return contato;
      if (/^update `network_sugestoes`/.test(sql)) return { affectedRows: 0 };
      return undefined;
    };
    await expect(confirmarPendencia("dona-1", "p-1", "Maria S. Silva")).rejects.toBeInstanceOf(PendenciaNaoEncontrada);
    expect(estado.consultas.some(c => /^update `private_contacts`/.test(c.sql))).toBe(false);
    expect(estado.consultas.at(-1)!.sql).toBe("rollback");
  });

  it("pendência ainda sem contato (pessoa da reunião não criada): não confirma", async () => {
    estado.responder = sql => (/from `network_sugestoes`/.test(sql) ? [linha("tenho", "X", null)] : undefined);
    await expect(confirmarPendencia("dona-1", "p-1")).rejects.toBeInstanceOf(PendenciaNaoEncontrada);
  });

  it("valor inválido na correção: recusa antes de escrever", () => {
    expect(() => valorParaGravar("email", "sem-arroba")).toThrow(ValorInvalido);
    expect(() => valorParaGravar("telefone", "123")).toThrow(ValorInvalido);
    expect(() => valorParaGravar("tipo_pessoa", "empresa")).toThrow(ValorInvalido);
    expect(valorParaGravar("email", " Maria@X.com ")).toBe("maria@x.com");
  });

  it("ignorar: condicional à pendência ainda aberta e da dona", async () => {
    await ignorarPendencia("dona-1", "p-1");
    const [update] = estado.consultas;
    expect(update.sql).toContain("`network_sugestoes`.`owner_id` = ?");
    expect(update.sql).toContain("`network_sugestoes`.`status` = ?");
    expect(update.params).toEqual(expect.arrayContaining(["ignorada", "p-1", "dona-1", "pendente"]));
  });
});

describe("a pessoa sugerida pela reunião — criar, vincular, ignorar", () => {
  it("ignorar a pessoa ignora tudo que veio dela", async () => {
    const db = await exigirDb();
    await decidirPendenciasDaPessoaSugerida(db, { ownerId: "dona-1", meetingSuggestionId: "s-1", meetingId: "m-1", acao: "ignore", contactId: null });
    const [update] = estado.consultas;
    expect(update.params).toEqual(expect.arrayContaining(["ignorada", "dona-1", "s-1", "pendente"]));
  });

  it("vincular a um contato existente: o QUEM SOU que difere vira pendência; o igual não", async () => {
    estado.responder = sql => {
      // id, fullName, phone, whatsapp, email, tipoPessoa
      if (/from `private_contacts`/.test(sql)) return [[7, "Maria Silva", "+55 11 98765-4321", null, null, null]];
      return [];
    };
    const db = await exigirDb();
    await decidirPendenciasDaPessoaSugerida(db, {
      ownerId: "dona-1", meetingSuggestionId: "s-1", meetingId: "m-1", acao: "link", contactId: 7,
      quemSouDaSugestao: { fullName: "Maria Silva", phone: "(11) 98765-4321", email: "maria@farmabras.com.br", confianca: "0.870" },
    });
    const [vinculo] = estado.consultas;
    expect(vinculo.sql).toMatch(/^update `network_sugestoes` set `contact_id` = \?/);
    const insert = estado.consultas.find(c => /^insert into `network_sugestoes`/.test(c.sql))!;
    expect(insert.params).toContain("maria@farmabras.com.br");
    // a confiança é a que a extração deu à pessoa, e não um número fixo
    expect(insert.params).toContain("0.870");
    expect(insert.params).not.toContain("Maria Silva");
    expect(insert.params).not.toContain("(11) 98765-4321");
  });
});

/**
 * Achado 6 da bancada de 16/11: cargo e empresa que a IA deu à pessoa da
 * reunião iam sozinhos para o contato no "Criar contato". Agora viram
 * pendências do contato — criado ou vinculado — e só entram com a dona.
 */
describe("cargo e empresa da pessoa da reunião — pendência, nunca dado direto", () => {
  // A confiança como a coluna meeting_contact_suggestions.confidence a devolve.
  const PESSOA = { fullName: "Fernando Okada", phone: null, email: null, jobTitle: "mentor convidado", company: "Ponte Sul Consultoria", confianca: "0.930" };
  const DA_REUNIAO = "Boa noite. Eu sou o Fernando Okada, da Ponte Sul Consultoria, e vim como mentor convidado.";
  // A transcrição da reunião, lida pela dona e pela reunião da sugestão.
  const comTranscricao = (texto: string | null, contato?: unknown[]) => (sql: string) => {
    if (/from `meeting_transcripts`/.test(sql)) return texto === null ? [] : [[texto]];
    if (contato && /from `private_contacts`/.test(sql)) return [contato];
    return [];
  };

  it("criar a pessoa: cargo e empresa ditos viram pendências do contato novo, com origem e a confiança da sugestão; o QUEM SOU não volta", async () => {
    estado.responder = comTranscricao(DA_REUNIAO);
    const db = await exigirDb();
    await decidirPendenciasDaPessoaSugerida(db, {
      ownerId: "dona-1", meetingSuggestionId: "s-1", meetingId: "m-1", acao: "create", contactId: 9, quemSouDaSugestao: PESSOA,
    });
    const [vinculo] = estado.consultas;
    expect(vinculo.sql).toMatch(/^update `network_sugestoes` set `contact_id` = \?/);
    // a transcrição é a da reunião da sugestão, e da dona
    const leitura = estado.consultas.find(c => /from `meeting_transcripts`/.test(c.sql))!;
    expect(leitura.params).toEqual(expect.arrayContaining(["m-1", "dona-1"]));
    const insert = estado.consultas.find(c => /^insert into `network_sugestoes`/.test(c.sql))!;
    expect(insert.params).toEqual(expect.arrayContaining([
      "dona-1", 9, "m-1", "s-1", "reuniao", "cargo", "mentor convidado", "empresa", "Ponte Sul Consultoria", "0.930", "pendente",
    ]));
    // nenhum número que o modelo não deu
    expect(insert.params).not.toContain("0.800");
    expect(insert.params).not.toContain("Fernando Okada");
  });

  it("criar a pessoa sem cargo nem empresa: só o vínculo das pendências, nada lido nem inserido", async () => {
    const db = await exigirDb();
    await decidirPendenciasDaPessoaSugerida(db, {
      ownerId: "dona-1", meetingSuggestionId: "s-1", meetingId: "m-1", acao: "create", contactId: 9,
      quemSouDaSugestao: { ...PESSOA, jobTitle: null, company: "   " },
    });
    expect(estado.consultas.map(c => c.sql.split(" ")[0])).toEqual(["update"]);
  });

  // Revisão do pacote P2B: a sugestão gravada antes do portão da IA3 pode ter
  // um cargo que ninguém disse, e criar o contato o punha na fila da dona.
  it("sugestão de antes do portão: o cargo que a transcrição não diz ('fundadora') não vira pendência; a empresa dita, sim", async () => {
    estado.responder = comTranscricao(DA_REUNIAO);
    const db = await exigirDb();
    await decidirPendenciasDaPessoaSugerida(db, {
      ownerId: "dona-1", meetingSuggestionId: "s-1", meetingId: "m-1", acao: "create", contactId: 9,
      quemSouDaSugestao: { ...PESSOA, jobTitle: "fundadora" },
    });
    const insert = estado.consultas.find(c => /^insert into `network_sugestoes`/.test(c.sql))!;
    expect(insert.params).toEqual(expect.arrayContaining(["empresa", "Ponte Sul Consultoria"]));
    expect(insert.params).not.toContain("cargo");
    expect(insert.params).not.toContain("fundadora");
  });

  it("sem a transcrição da reunião não há como conferir: nem cargo nem empresa viram pendência", async () => {
    estado.responder = comTranscricao(null);
    const db = await exigirDb();
    await decidirPendenciasDaPessoaSugerida(db, {
      ownerId: "dona-1", meetingSuggestionId: "s-1", meetingId: "m-1", acao: "create", contactId: 9, quemSouDaSugestao: PESSOA,
    });
    expect(estado.consultas.some(c => /^insert/.test(c.sql))).toBe(false);
  });

  it("vincular: o cargo que difere do contato vira pendência; a empresa igual (sem caixa nem acento), não", async () => {
    // id, fullName, phone, whatsapp, email, tipoPessoa, jobTitle, company
    estado.responder = comTranscricao(DA_REUNIAO, [7, "Fernando Okada", null, null, null, null, null, "Ponte Sul Consultoria"]);
    const db = await exigirDb();
    await decidirPendenciasDaPessoaSugerida(db, {
      ownerId: "dona-1", meetingSuggestionId: "s-1", meetingId: "m-1", acao: "link", contactId: 7,
      quemSouDaSugestao: { ...PESSOA, company: "PONTE SUL CONSULTÓRIA" },
    });
    const insert = estado.consultas.find(c => /^insert into `network_sugestoes`/.test(c.sql))!;
    expect(insert.params).toEqual(expect.arrayContaining(["cargo", "mentor convidado", "0.930"]));
    expect(insert.params).not.toContain("empresa");
    expect(insert.params).not.toContain("Fernando Okada");
  });

  it("o que o contato já tem não vira pendência; cargo ou empresa diferentes viram", () => {
    const atual = { fullName: "Fernando Okada", jobTitle: "Mentor Convidado", company: null, tenho: [], preciso: [] };
    const linhas = semRepeticao([
      { campo: "cargo", valor: "mentor convidado", categoria: null, trecho: null, confianca: 0.8 },
      { campo: "empresa", valor: "Ponte Sul Consultoria", categoria: null, trecho: null, confianca: 0.8 },
    ], atual);
    expect(linhas.map(l => `${l.campo}:${l.valor}`)).toEqual(["empresa:Ponte Sul Consultoria"]);
  });

  // id, owner_id, contact_id, meeting_id, meeting_suggestion_id, origem, campo, valor, categoria, trecho, confianca, status, decidida_em, created_at, updated_at
  const pendencia = (campo: string, valor: string) => ["p-1", "dona-1", 5, "m-1", "s-1", "reuniao", campo, valor, null, null, "0.800", "pendente", null, 1, 1];

  it.each([
    ["cargo", "mentor convidado", "`jobTitle` = ?"],
    ["empresa", "Ponte Sul Consultoria", "`company` = ?"],
  ])("confirmar %s grava no campo do contato da dona, na transação da tomada", async (campo, valor, coluna) => {
    estado.responder = sql => {
      if (/from `network_sugestoes`/.test(sql)) return [pendencia(campo, valor)];
      // id, fullName, company, phone, whatsapp
      if (/from `private_contacts`/.test(sql)) return [[5, "Fernando Okada", null, null, null]];
      return undefined;
    };
    const r = await confirmarPendencia("dona-1", "p-1");
    expect(r).toEqual({ campo, contactId: 5, mudouTenhoOuPreciso: false });
    const sqls = estado.consultas.map(c => c.sql);
    const update = estado.consultas.find(c => /^update `private_contacts`/.test(c.sql))!;
    expect(update.sql).toContain(coluna);
    expect(update.sql).toContain("`private_contacts`.`ownerId` = ?");
    expect(update.params).toEqual(expect.arrayContaining([valor, 5, "dona-1"]));
    expect(sqls.indexOf("begin")).toBeLessThan(sqls.findIndex(sql => /^update `network_sugestoes`/.test(sql)));
    expect(sqls.at(-1)).toBe("commit");
  });

  it("valor de cargo ou empresa maior que a coluna é recusado; o corrigido pela dona vale aparado", () => {
    expect(() => valorParaGravar("cargo", "x".repeat(201))).toThrow(ValorInvalido);
    expect(() => valorParaGravar("empresa", "   ")).toThrow(ValorInvalido);
    expect(valorParaGravar("empresa", "  Ponte Sul Consultoria ")).toBe("Ponte Sul Consultoria");
  });
});

/**
 * Revisão da IA3: o contato criado pela reunião nasce sem empresa (ela espera
 * a dona como pendência). Sem olhar a reunião, "Chocolate da Cacau Tupinã"
 * passava na confirmação e no completar, e podia circular na rede global.
 */
describe("a empresa que a reunião deu ao contato, ainda não gravada nele, não entra em Tenho/Preciso", () => {
  // id, owner_id, contact_id, meeting_id, meeting_suggestion_id, origem, campo, valor, categoria, trecho, confianca, status, decidida_em, created_at, updated_at
  const pendencia = (valor: string) => ["p-1", "dona-1", 5, "m-1", "s-1", "texto", "tenho", valor, null, "trecho", "0.900", "pendente", null, 1, 1];

  function banco(opcoes: { daReuniao?: unknown[][]; pendenciasDoContato?: unknown[][] }) {
    estado.responder = sql => {
      // fullName, company, phone das pessoas da reunião ligadas ao contato
      if (/from `meeting_contact_suggestions`/.test(sql)) return opcoes.daReuniao ?? [];
      // campo, valor das pendências de nome, empresa e telefone do contato
      if (/from `network_sugestoes`/.test(sql) && /`campo` in \(/.test(sql)) return opcoes.pendenciasDoContato ?? [];
      if (/from `network_sugestoes`/.test(sql)) return [pendencia("Chocolate da Cacau Tupinã em barras")];
      // id, fullName, company, phone, whatsapp: criado pela reunião, sem empresa
      if (/from `private_contacts`/.test(sql)) return [[5, "Camila Duarte", null, null, null]];
      return undefined;
    };
  }

  it("confirmar: a empresa da pessoa da reunião que virou o contato recusa o item, também corrigido pela dona", async () => {
    banco({ daReuniao: [["Camila Duarte", "Cacau Tupinã", null]] });
    await expect(confirmarPendencia("dona-1", "p-1")).rejects.toThrow(MENSAGEM_ITEM_COM_IDENTIFICACAO);
    await expect(confirmarPendencia("dona-1", "p-1", "Barras de chocolate da Cacau Tupina")).rejects.toBeInstanceOf(ValorInvalido);
    expect(estado.consultas.some(c => /^(update|insert|begin)/.test(c.sql))).toBe(false);
    // posse no WHERE: a dona e o contato
    const daReuniao = estado.consultas.find(c => /from `meeting_contact_suggestions`/.test(c.sql))!;
    expect(daReuniao.sql).toContain("`meeting_contact_suggestions`.`existing_contact_id` = ?");
    expect(daReuniao.params).toEqual(expect.arrayContaining(["dona-1", 5]));
    // sem a empresa no texto, confirma
    await confirmarPendencia("dona-1", "p-1", "Chocolate de origem em barras");
    expect(estado.consultas.some(c => /^insert into `contact_assets`/.test(c.sql))).toBe(true);
  });

  it("confirmar: a pendência de empresa do contato, em qualquer status (ignorada também), recusa o item", async () => {
    banco({ pendenciasDoContato: [["empresa", "Cacau Tupinã"]] });
    await expect(confirmarPendencia("dona-1", "p-1")).rejects.toBeInstanceOf(ValorInvalido);
    const leitura = estado.consultas.find(c => /from `network_sugestoes`/.test(c.sql) && /`campo` in \(/.test(c.sql))!;
    expect(leitura.params).toEqual(expect.arrayContaining(["dona-1", 5, "nome", "empresa", "telefone"]));
    expect(leitura.sql).not.toContain("`status`");
  });

  it("completar por texto: a identificação que a chamada passa tira o item com a empresa", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      quemSou: { tipoPessoa: "nao_informado", nome: null, telefone: null, email: null },
      oQueTenho: [
        { texto: "Chocolate da Cacau Tupinã em barras", trecho: "vende chocolate da Cacau Tupinã em barras", confianca: 0.9 },
        { texto: "Chocolate em barras", trecho: "vende chocolate da Cacau Tupinã em barras", confianca: 0.9 },
      ],
      oQuePreciso: [],
    }) } }] });
    const proposta = await interpretarComplemento("A Camila vende chocolate da Cacau Tupinã em barras.", {
      nomeDoContato: "Camila Duarte", identificacao: { nomes: ["Cacau Tupinã"] },
    });
    expect(proposta.oQueTenho.map(i => i.texto)).toEqual(["Chocolate em barras"]);
  });
});
