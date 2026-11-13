import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Meu Network Inteligente — o network particular diante da rede global (spec
 * da Glenda de 14/09, itens 13, 14, 15B, 17, 18 e 26). Drizzle de verdade
 * sobre um cliente mysql2 falso que responde por SQL e captura cada comando.
 *
 * O que se trava:
 * 1. PRIVACIDADE É REGRA DE CONSULTA: a leitura que atravessa donas seleciona
 *    só id, dona e ID anônimo de private_contacts — nome, telefone, e-mail,
 *    notas, foto e redes nem são lidos — e só contatos com SIM.
 * 2. A dona e a membra precisam do termo do Smart Match vigente.
 * 3. O cruzamento é o de scoreMatch: concorrentes não casam; serviço sem
 *    necessidade declarada não casa pela categoria.
 * 4. A busca registra NETWORK_NETWORK_MATCH (as duas donas originadoras) e
 *    NETWORK_PLATFORM_MATCH, e devolve só IDs anônimos e itens.
 * 5. SIM/NÃO é da dona: owner no WHERE; contato alheio é "não encontrado".
 * 6. Conta desativada (dona ou membra) sai do cruzamento, como no motor de perfis.
 * 7. "Outra necessidade" vale como "O que preciso" da membra.
 * 8. Tetos de trabalho: buscas por conta, itens por lado, orçamento de
 *    comparações e conexões por contraparte numa rodada.
 */

type Resposta = unknown[][] | { affectedRows: number };
const estado = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  responder: (_sql: string, _params: unknown[]): unknown => [],
}));

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      estado.consultas.push({ sql: config.sql, params });
      const resposta = estado.responder(config.sql, params) as Resposta | undefined;
      if (resposta && !Array.isArray(resposta)) return [resposta, []];
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

const usersComConsentimento = vi.hoisted(() => vi.fn(async (ids: number[], _tipo: string) => new Set(ids)));
vi.mock("./routers/consent", () => ({ usersComConsentimento, hasValidConsent: async () => true }));

const {
  definirDisponibilidade, encontrosEntre, lerRedeGlobalAnonima, procurarConexoesNaRedeGlobal, projecaoAnonima, ContatoNaoEncontrado,
  tetoDeBuscaNaRedeGlobal, BUSCAS_NA_REDE_GLOBAL_POR_JANELA, TETO_DE_ITENS_POR_LADO, TETO_POR_CONTRAPARTE_POR_RODADA, ORCAMENTO_DE_COMPARACOES,
} = await import("./network-rede-global");

const DONA = "dona-1";
const OUTRA = "dona-2";

/**
 * A rede de teste: contato 1 é da dona; 2 é de outra dona; a membra 30 declarou no perfil.
 * O falso só aplica o filtro de conta ativa quando o SQL o traz: sem ele, a conta desativada volta.
 */
function redeDeTeste(opcoes: {
  outraSemTermo?: boolean; outraInativa?: boolean; membraInativa?: boolean; membraSoComOutraNecessidade?: boolean;
  ativoDaDona?: string; outraNecessidadeDaMembra?: string;
  /** O perfil da membra 30 por inteiro (colunas JSON como texto, como vêm do driver), no lugar dos dois padrões. */
  membra?: Record<string, unknown>;
} = {}) {
  const filtraAtivas = (sql: string) => sql.includes("`users`.`isActive` = ?");
  usersComConsentimento.mockImplementation(async (ids: number[]) =>
    new Set(ids.filter(id => !(opcoes.outraSemTermo && id === 20))));
  estado.responder = (sql, params) => {
    if (/from `private_contacts`/.test(sql) && /is null/.test(sql)) return []; // garantirCodigosAnonimos
    if (/from `private_contacts`/.test(sql) && /`ownerId` <> \?/.test(sql)) return [[2, OUTRA, "NW-BBBBBB"]];
    if (/from `private_contacts`/.test(sql)) return [[1, DONA, "NW-AAAAAA"]];
    if (/from `users`/.test(sql)) return opcoes.outraInativa && filtraAtivas(sql) ? [[10, DONA]] : [[10, DONA], [20, OUTRA]];
    if (/from `contact_assets`/.test(sql)) {
      return [
        ...(params.includes(1) ? [[1, opcoes.ativoDaDona ?? "Distribuição de medicamentos", null]] : []),
        ...(params.includes(2) ? [[2, "Capital para expansão", null]] : []),
      ];
    }
    if (/from `contact_needs`/.test(sql)) {
      return [
        ...(params.includes(1) ? [[1, "Capital para expansão", null]] : []),
        ...(params.includes(2) ? [[2, "Parceiro de marketing", null]] : []),
      ];
    }
    if (/from `user_profiles`/.test(sql)) {
      // A linha sai na ordem das colunas do SELECT: coluna nova no select não desalinha o falso.
      const colunas = [...(sql.split(/ from /)[0].matchAll(/`user_profiles`\.`(\w+)`/g))].map(m => m[1]);
      const linha = (perfil: Record<string, unknown>) => colunas.map(coluna => perfil[coluna] ?? null);
      const membra30 = opcoes.membra ?? (opcoes.membraSoComOutraNecessidade
        ? { userId: 30, whatIHave: "[]", whatINeed: "[]", seekingTypes: JSON.stringify(["outra_necessidade"]), seekingOtherNeed: opcoes.outraNecessidadeDaMembra ?? " Distribuição de medicamentos " }
        : { userId: 30, whatIHave: JSON.stringify(["Consultoria"]), whatINeed: JSON.stringify(["Distribuição de medicamentos"]) });
      return [
        ...(opcoes.membraInativa && filtraAtivas(sql) ? [] : [linha(membra30)]),
        linha({ userId: 31, whatIHave: "[]", whatINeed: "[]" }),
      ];
    }
    if (/from `conexoes_registradas`/.test(sql)) return [[`conexao-${estado.consultas.length}`]];
    return undefined;
  };
}

beforeEach(() => {
  tetoDeBuscaNaRedeGlobal.esquecer();
  estado.consultas = [];
  estado.responder = () => undefined;
  usersComConsentimento.mockReset();
  usersComConsentimento.mockImplementation(async (ids: number[]) => new Set(ids));
});

const COLUNAS_PESSOAIS = ["fullName", "phone", "whatsapp", "email", "notes", "photoUrl", "cardImageUrl", "linkedinUrl", "instagram", "cardOcrText", "company", "jobTitle"];

describe("rede global — privacidade é regra de consulta", () => {
  it("de private_contacts só saem id, dona e ID anônimo, só com SIM e com ID; nenhuma coluna pessoal é lida", async () => {
    redeDeTeste();
    await lerRedeGlobalAnonima({ excetoDona: DONA });
    const leituras = estado.consultas.filter(c => /from `private_contacts`/.test(c.sql));
    expect(leituras).toHaveLength(1);
    const [leitura] = leituras;
    expect(leitura.sql).toMatch(/^select `id`, `ownerId`, `codigo_anonimo` from `private_contacts`/);
    expect(leitura.sql).toContain("`private_contacts`.`disponivel_rede_global` = ?");
    expect(leitura.sql).toContain("`private_contacts`.`codigo_anonimo` is not null");
    for (const coluna of COLUNAS_PESSOAIS) expect(leitura.sql).not.toContain(`\`${coluna}\``);
  });

  it("a projeção que pode sair tem só ID anônimo, O que tenho e O que preciso", async () => {
    redeDeTeste();
    const [contato] = await lerRedeGlobalAnonima({ excetoDona: DONA });
    expect(Object.keys(projecaoAnonima(contato)).sort()).toEqual(["codigoAnonimo", "preciso", "tenho"]);
    expect(JSON.stringify(projecaoAnonima(contato))).not.toContain(OUTRA);
  });

  it("dona sem o termo do Smart Match: os contatos dela ficam fora da rede global", async () => {
    redeDeTeste({ outraSemTermo: true });
    expect(await lerRedeGlobalAnonima({ excetoDona: DONA })).toEqual([]);
    expect(usersComConsentimento).toHaveBeenCalledWith([10, 20], "termo_smart_match");
  });
});

describe("rede global — o cruzamento é o do motor privado", () => {
  const item = (label: string, category: string | null = null) => ({ label, category });

  it("mesmo objeto em direções opostas casa; os dois querendo exportar não casa", () => {
    expect(encontrosEntre({ tenho: [item("Exportar vinho")], preciso: [] }, { tenho: [], preciso: [item("Importar vinho")] }).pontuacao).toBe(100);
    expect(encontrosEntre({ tenho: [item("Exportar vinho")], preciso: [] }, { tenho: [], preciso: [item("Exportar vinho")] }).pontuacao).toBe(0);
  });

  it("serviço sem necessidade declarada não casa pela categoria em comum", () => {
    const r = encontrosEntre(
      { tenho: [item("Advocacia tributária", "Serviços")], preciso: [] },
      { tenho: [], preciso: [item("Distribuidor para a África", "Serviços")] },
    );
    expect(r.pontuacao).toBe(0);
    expect(r.encontros).toEqual([]);
  });

  it("cada um tem o que o outro procura: mútuo, com os dois sentidos", () => {
    const r = encontrosEntre(
      { tenho: [item("Distribuição de medicamentos")], preciso: [item("Capital para expansão")] },
      { tenho: [item("Capital para expansão")], preciso: [item("Distribuição de medicamentos")] },
    );
    expect(r.mutuo).toBe(true);
    expect(r.encontros.map(e => e.de).sort()).toEqual(["a", "b"]);
  });
});

describe("rede global — contato escrito no texto livre não atravessa donas (A13)", () => {
  const item = (label: string, category: string | null = null) => ({ label, category });
  const TELEFONE = "(11) 99999-8888";
  const EMAIL = "ana@exemplo.com";
  const DEMANDA_COM_CONTATO = `Precisamos revisar nossos tributos e identificar créditos fiscais. Fale comigo ${TELEFONE} ou ${EMAIL}`;

  it("o encontro casa pelo texto inteiro, mas o rótulo sai com telefone e e-mail mascarados", () => {
    const r = encontrosEntre(
      { tenho: [item("Advocacia tributária")], preciso: [] },
      { tenho: [], preciso: [item(DEMANDA_COM_CONTATO)] },
    );
    expect(r.pontuacao).toBeGreaterThanOrEqual(50);
    expect(r.encontros).toHaveLength(1);
    const texto = JSON.stringify(r.encontros);
    expect(texto).toContain("revisar nossos tributos");
    expect(texto).not.toContain("99999-8888");
    expect(texto).not.toContain(EMAIL);
  });

  it("telefone e e-mail escritos dentro do item saem mascarados: o ID anônimo sozinho não protege", () => {
    const projetado = projecaoAnonima({
      codigoAnonimo: "NW-BBBBBB",
      tenho: [{ label: DEMANDA_COM_CONTATO, category: "servicos" }],
      preciso: [{ label: `Distribuidores — ${EMAIL}`, category: null }],
    });
    const saida = JSON.stringify(projetado);
    expect(saida).not.toContain(TELEFONE);
    expect(saida).not.toContain(EMAIL);
    expect(projetado.tenho[0].label).toContain("revisar nossos tributos");
    expect(projetado.preciso[0].label).toContain("Distribuidores");
    expect(projetado.codigoAnonimo).toBe("NW-BBBBBB");
  });

  it("a categoria também é texto digitado: sai pela mesma máscara", () => {
    // O campo de categoria é um input aberto (IntelligentMatches), e a
    // projeção promete que "os itens passam pela máscara" — os itens inteiros.
    const projetado = projecaoAnonima({
      codigoAnonimo: "NW-BBBBBB",
      tenho: [{ label: "Advocacia tributária", category: `falar com Ana ${TELEFONE}` }],
      preciso: [{ label: "Distribuidores", category: EMAIL }],
    });

    const saida = JSON.stringify(projetado);
    expect(saida).not.toContain(TELEFONE);
    expect(saida).not.toContain(EMAIL);
  });

  it("procurar na rede global: nem a resposta nem o que é gravado leva o contato que a membra escreveu", async () => {
    redeDeTeste({ membraSoComOutraNecessidade: true, ativoDaDona: "Advocacia tributária", outraNecessidadeDaMembra: DEMANDA_COM_CONTATO });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });

    const comMembra = resposta.conexoes.find(c => c.origem === "NETWORK_PLATFORM_MATCH");
    expect(comMembra, "a demanda com contato precisa casar para o teste provar a máscara").toBeTruthy();
    expect(comMembra!.encontros[0].precisa).toContain("revisar nossos tributos");
    expect(JSON.stringify(resposta)).not.toContain("99999-8888");
    expect(JSON.stringify(resposta)).not.toContain(EMAIL);

    // Itens e motivo de conexoes_registradas, participantes: nada que foi ao banco carrega o contato.
    const gravado = estado.consultas.filter(c => /^insert/i.test(c.sql)).map(c => JSON.stringify(c.params)).join(" ");
    expect(gravado).toContain("NW-AAAAAA");
    expect(gravado).not.toContain("99999-8888");
    expect(gravado).not.toContain(EMAIL);
  });
});

describe("rede global — procurar registra e devolve só o que a dona pode ver", () => {
  it("registra NETWORK_NETWORK_MATCH (duas originadoras) e NETWORK_PLATFORM_MATCH; a resposta não tem dona, id nem nome alheios", async () => {
    redeDeTeste();
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });

    expect(resposta.contatosDisponiveis).toBe(1);
    expect(resposta.conexoes.map(c => c.origem).sort()).toEqual(["NETWORK_NETWORK_MATCH", "NETWORK_PLATFORM_MATCH"]);
    const entreNetworks = resposta.conexoes.find(c => c.origem === "NETWORK_NETWORK_MATCH")!;
    expect(entreNetworks).toMatchObject({ meuCodigo: "NW-AAAAAA", outroLado: { tipo: "contato", codigoAnonimo: "NW-BBBBBB" } });
    const comMembra = resposta.conexoes.find(c => c.origem === "NETWORK_PLATFORM_MATCH")!;
    expect(comMembra.outroLado).toEqual({ tipo: "membro", codigoAnonimo: null });

    const texto = JSON.stringify(resposta);
    expect(texto).not.toContain(OUTRA);
    expect(texto).not.toContain("\"contactId\"");
    expect(texto).not.toContain("userId");

    const cabecalhos = estado.consultas.filter(c => /^insert into `conexoes_registradas`/.test(c.sql));
    expect(cabecalhos.map(c => c.params.find(p => typeof p === "string" && p.endsWith("_MATCH")))).toEqual(["NETWORK_NETWORK_MATCH", "NETWORK_PLATFORM_MATCH"]);
    // O motivo registrado fala pelos IDs anônimos.
    for (const c of cabecalhos) expect(c.params.join(" ")).toContain("NW-AAAAAA");

    const participantes = estado.consultas.filter(c => /^insert into `conexoes_participantes`/.test(c.sql));
    expect(participantes).toHaveLength(2);
    // NETWORK_NETWORK: as duas pontas são contatos originadores (item 18).
    expect(participantes[0].params).toEqual(expect.arrayContaining([DONA, OUTRA, "NW-AAAAAA", "NW-BBBBBB"]));
    expect(participantes[0].params.filter(p => p === true)).toHaveLength(2);
    // NETWORK_PLATFORM: a membra entra pelo userId, sem ID anônimo nem originadora.
    expect(participantes[1].params).toEqual(expect.arrayContaining([30]));
  });

  it("membra sem nada declarado no perfil não entra no cruzamento", async () => {
    redeDeTeste();
    await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    const idsConferidos = usersComConsentimento.mock.calls.map(chamada => chamada[0]).flat();
    expect(idsConferidos).not.toContain(31);
  });

  it("a própria dona não é cruzada consigo mesma: a leitura dos outros exclui o owner dela e o perfil exclui o id dela", async () => {
    redeDeTeste();
    await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    const dosOutros = estado.consultas.find(c => /from `private_contacts`/.test(c.sql) && /`ownerId` <> \?/.test(c.sql))!;
    expect(dosOutros.params).toContain(DONA);
    const perfis = estado.consultas.find(c => /from `user_profiles`/.test(c.sql))!;
    expect(perfis.sql).toContain("`user_profiles`.`userId` <> ?");
    expect(perfis.params).toContain(10);
  });

  it("sem contato disponibilizado pela dona, nada é lido da rede alheia nem registrado", async () => {
    estado.responder = sql => (/from `private_contacts`/.test(sql) ? [] : undefined);
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    expect(resposta).toEqual({ contatosDisponiveis: 0, conexoes: [], completa: true });
    expect(estado.consultas.some(c => /`ownerId` <> \?/.test(c.sql))).toBe(false);
    expect(estado.consultas.some(c => /^insert/.test(c.sql))).toBe(false);
  });
});

describe("rede global — conta desativada não cruza", () => {
  it("dona desativada: a leitura das donas filtra conta ativa e os contatos dela ficam fora", async () => {
    redeDeTeste({ outraInativa: true });
    expect(await lerRedeGlobalAnonima({ excetoDona: DONA })).toEqual([]);
    const donas = estado.consultas.find(c => /from `users`/.test(c.sql))!;
    expect(donas.sql).toContain("`users`.`isActive` = ?");
  });

  it("membra desativada: o perfil dela não entra e nenhuma NETWORK_PLATFORM_MATCH é registrada", async () => {
    redeDeTeste({ membraInativa: true });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    expect(resposta.conexoes.map(c => c.origem)).toEqual(["NETWORK_NETWORK_MATCH"]);
    const perfis = estado.consultas.find(c => /from `user_profiles`/.test(c.sql))!;
    expect(perfis.sql).toContain("inner join `users`");
    expect(perfis.sql).toContain("`users`.`isActive` = ?");
    expect(usersComConsentimento.mock.calls.map(chamada => chamada[0]).flat()).not.toContain(30);
  });
});

describe("rede global — Outra necessidade vale como O que preciso", () => {
  it("membra só com o texto de Outra necessidade casa com o contato que tem aquilo", async () => {
    redeDeTeste({ membraSoComOutraNecessidade: true });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    const comMembra = resposta.conexoes.find(c => c.origem === "NETWORK_PLATFORM_MATCH");
    expect(comMembra?.encontros).toEqual([{ de: "meu", tem: "Distribuição de medicamentos", precisa: "Distribuição de medicamentos" }]);
    const perfis = estado.consultas.find(c => /from `user_profiles`/.test(c.sql))!;
    expect(perfis.sql).toContain("`seekingOtherNeed`");
  });
});

describe("rede global — a descrição que repete o serviço que a própria membra presta não é necessidade (item 1 da revisão do Nicolas na PR #135)", () => {
  const DESCRICAO_DA_PROPRIA_OFERTA = "Consultoria tributária para indústrias farmacêuticas do Nordeste";
  /** A consultora tributária que detalhou "Expansão / Internacionalização" com a descrição dada. */
  const membraConsultora = (description: string) => ({
    userId: 30, whatIHave: JSON.stringify(["Consultoria tributária"]), whatINeed: JSON.stringify(["expansao_internacionalizacao"]),
    whatINeedDetails: JSON.stringify([{ id: "d1", category: "expansao_internacionalizacao", description }]),
  });

  it("contato que só oferece o mesmo serviço não vira NETWORK_PLATFORM_MATCH com a membra que o presta", async () => {
    redeDeTeste({ ativoDaDona: "Consultoria tributária", membra: membraConsultora(DESCRICAO_DA_PROPRIA_OFERTA) });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    expect(resposta.conexoes.map(c => c.origem)).toEqual(["NETWORK_NETWORK_MATCH"]);
    expect(JSON.stringify(resposta)).not.toContain("indústrias farmacêuticas");
  });

  it("descrição que pede OUTRO serviço continua casando com o contato que o tem", async () => {
    redeDeTeste({ ativoDaDona: "Contabilidade para empresas", membra: membraConsultora("Preciso de um contador") });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    const comMembra = resposta.conexoes.find(c => c.origem === "NETWORK_PLATFORM_MATCH");
    expect(comMembra?.encontros).toEqual([{ de: "meu", tem: "Contabilidade para empresas", precisa: "Preciso de um contador" }]);
  });
});

describe("rede global — a guarda de concorrência lê o serviço que a membra pôs na área de atuação (a tela não grava serviço em O que tenho)", () => {
  const DESCRICAO_DA_PROPRIA_OFERTA = "Consultoria tributária para indústrias do Nordeste";
  /** A consultora tributária com "O que tenho" VAZIO (o caso comum da tela) e o serviço só na área de atuação. */
  const consultoraPelaArea = (description: string) => ({
    userId: 30, whatIHave: "[]", activityArea: "Consultoria tributária", whatINeed: JSON.stringify(["expansao_internacionalizacao"]),
    whatINeedDetails: JSON.stringify([{ id: "d1", category: "expansao_internacionalizacao", description }]),
  });

  it("a leitura das membras traz área de atuação e especialidade, e o contato que só oferece o mesmo serviço não vira NETWORK_PLATFORM_MATCH", async () => {
    redeDeTeste({ ativoDaDona: "Consultoria tributária", membra: consultoraPelaArea(DESCRICAO_DA_PROPRIA_OFERTA) });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    const perfis = estado.consultas.find(c => /from `user_profiles`/.test(c.sql))!;
    expect(perfis.sql).toContain("`activityArea`");
    expect(perfis.sql).toContain("`primarySpecialty`");
    expect(resposta.conexoes.map(c => c.origem)).toEqual(["NETWORK_NETWORK_MATCH"]);
    expect(JSON.stringify(resposta)).not.toContain("indústrias do Nordeste");
  });

  it("descrição que pede OUTRO serviço continua casando com o contato que o tem", async () => {
    // Medido no scoreMatch: "Contabilidade" × "Preciso de um contador" dá 100; "Preciso de contador para a filial"
    // dá 0 com ou sem a guarda (regra do motor privado, não desta leitura).
    redeDeTeste({ ativoDaDona: "Contabilidade", membra: consultoraPelaArea("Preciso de um contador") });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    const comMembra = resposta.conexoes.find(c => c.origem === "NETWORK_PLATFORM_MATCH");
    expect(comMembra?.encontros).toEqual([{ de: "meu", tem: "Contabilidade", precisa: "Preciso de um contador" }]);
  });
});

describe("rede global — tetos de trabalho", () => {
  it("por conta: passada a cota da janela, a busca recusa com TOO_MANY_REQUESTS antes de ler o banco", async () => {
    estado.responder = sql => (/from `private_contacts`/.test(sql) ? [] : undefined);
    for (let i = 0; i < BUSCAS_NA_REDE_GLOBAL_POR_JANELA; i++) await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    estado.consultas = [];
    await expect(procurarConexoesNaRedeGlobal({ id: 10, openId: DONA })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(estado.consultas).toEqual([]);
    // A cota é de cada conta: outra dona segue buscando.
    await expect(procurarConexoesNaRedeGlobal({ id: 20, openId: OUTRA })).resolves.toMatchObject({ contatosDisponiveis: 0 });
  });

  /**
   * Uma dona com muitos contatos diante de muitos contatos de outras donas. Os
   * contatos alheios antes de `casamAPartirDe` não casam com nada; os de depois casam.
   */
  function redeGrande(opcoes: { meus: number; outros: number; donasDosOutros: number; itensPorContato: number; casamAPartirDe?: number }) {
    const meusIds = Array.from({ length: opcoes.meus }, (_, i) => i + 1);
    const outrosIds = Array.from({ length: opcoes.outros }, (_, i) => 10_000 + i);
    const donaDe = (id: number) => `dona-outra-${(id - 10_000) % opcoes.donasDosOutros}`;
    const itens = (ids: number[], rotulo: string) => ids.flatMap(id => Array.from({ length: opcoes.itensPorContato }, () => [id, rotulo, null]));
    const meusDe = (ids: number[]) => ids.filter(id => id < 10_000);
    const casam = (ids: number[]) => ids.filter(id => id >= 10_000 + (opcoes.casamAPartirDe ?? 0));
    const naoCasam = (ids: number[]) => ids.filter(id => id >= 10_000 && id < 10_000 + (opcoes.casamAPartirDe ?? 0));
    estado.responder = (sql, params) => {
      if (/from `private_contacts`/.test(sql) && /is null/.test(sql)) return [];
      if (/from `private_contacts`/.test(sql) && /`ownerId` <> \?/.test(sql)) return outrosIds.map(id => [id, donaDe(id), `NW-${id}`]);
      if (/from `private_contacts`/.test(sql)) return meusIds.map(id => [id, DONA, `NW-${id}`]);
      if (/from `users`/.test(sql)) {
        const donas = params.filter((p): p is string => typeof p === "string");
        return donas.map((openId, i) => [i + 1, openId]);
      }
      const ids = params.filter((p): p is number => typeof p === "number");
      if (/from `contact_assets`/.test(sql)) {
        return [...itens(meusDe(ids), "Distribuição de medicamentos"), ...itens(casam(ids), "Capital para expansão"), ...itens(naoCasam(ids), "Parafusos industriais")];
      }
      if (/from `contact_needs`/.test(sql)) {
        return [...itens(meusDe(ids), "Capital para expansão"), ...itens(casam(ids), "Distribuição de medicamentos"), ...itens(naoCasam(ids), "Tinta acrílica")];
      }
      if (/from `user_profiles`/.test(sql)) return [];
      if (/from `conexoes_registradas`/.test(sql)) return [[`conexao-${estado.consultas.length}`]];
      return undefined;
    };
  }

  it("itens por lado: um contato com lista enorme entra com no máximo o teto de itens", async () => {
    redeGrande({ meus: 1, outros: 1, donasDosOutros: 1, itensPorContato: TETO_DE_ITENS_POR_LADO + 15 });
    const [contato] = await lerRedeGlobalAnonima({ excetoDona: DONA });
    expect(contato.tenho).toHaveLength(TETO_DE_ITENS_POR_LADO);
    expect(contato.preciso).toHaveLength(TETO_DE_ITENS_POR_LADO);
  });

  it("por contraparte: a mesma outra dona recebe no máximo o teto de conexões numa rodada, e a rodada diz que ficou incompleta", async () => {
    redeGrande({ meus: TETO_POR_CONTRAPARTE_POR_RODADA + 5, outros: 1, donasDosOutros: 1, itensPorContato: 1 });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    expect(resposta.conexoes).toHaveLength(TETO_POR_CONTRAPARTE_POR_RODADA);
    expect(resposta.completa).toBe(false);
    expect(estado.consultas.filter(c => /^insert into `conexoes_registradas`/.test(c.sql))).toHaveLength(TETO_POR_CONTRAPARTE_POR_RODADA);
  });

  it("orçamento: passado o total de comparações, o cruzamento para antes de avaliar o resto e diz que ficou incompleto", async () => {
    // Itens no teto dos dois lados: 2 × 20 × 20 = 800 comparações por par.
    const porPar = 2 * TETO_DE_ITENS_POR_LADO * TETO_DE_ITENS_POR_LADO;
    const paresNoOrcamento = Math.floor(ORCAMENTO_DE_COMPARACOES / porPar);
    // Os pares dentro do orçamento não casam; os de depois casariam, se fossem avaliados.
    redeGrande({
      meus: 1, outros: paresNoOrcamento + 5, donasDosOutros: paresNoOrcamento + 5,
      itensPorContato: TETO_DE_ITENS_POR_LADO, casamAPartirDe: paresNoOrcamento,
    });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    expect(resposta.completa).toBe(false);
    expect(resposta.conexoes).toEqual([]);
    expect(estado.consultas.some(c => /^insert/.test(c.sql))).toBe(false);
  }, 60_000);

  it("dentro do orçamento, os mesmos contatos que casam viram conexão (o teto não esconde o que cabe)", async () => {
    redeGrande({ meus: 1, outros: 3, donasDosOutros: 3, itensPorContato: 2 });
    const resposta = await procurarConexoesNaRedeGlobal({ id: 10, openId: DONA });
    expect(resposta.completa).toBe(true);
    expect(resposta.conexoes).toHaveLength(3);
  });
});

describe("rede global — SIM/NÃO por contato", () => {
  it("o padrão do schema é NÃO", async () => {
    const { privateContacts } = await import("../drizzle/schema");
    expect(privateContacts.disponivelRedeGlobal.default).toBe(false);
  });

  it("muda só o contato DA dona (id E owner no WHERE) e carimba a data", async () => {
    estado.responder = () => undefined;
    await definirDisponibilidade(DONA, 5, false);
    const [update] = estado.consultas.filter(c => /^update `private_contacts`/.test(c.sql));
    expect(update.sql).toContain("`private_contacts`.`id` = ?");
    expect(update.sql).toContain("`private_contacts`.`ownerId` = ?");
    expect(update.sql).toContain("`disponibilidade_alterada_em` = ?");
    expect(update.params).toEqual(expect.arrayContaining([false, 5, DONA]));
  });

  it("contato de outra dona (0 linhas): não encontrado, sem revelar se existe", async () => {
    estado.responder = sql => (/^update/.test(sql) ? { affectedRows: 0 } : undefined);
    await expect(definirDisponibilidade(DONA, 999, true)).rejects.toBeInstanceOf(ContatoNaoEncontrado);
  });
});
