import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Meu Network Inteligente — o registro das conexões (spec da Glenda de 14/09,
 * itens 16, 17 e 18). Drizzle de verdade sobre um cliente mysql2 falso.
 *
 * O que se trava:
 * 1. Toda sugestão interna vira conexão registrada PRIVATE_NETWORK_MATCH, uma
 *    vez só (a chave do par não tem direção), com motivo sem nome de ninguém.
 * 2. O lado alheio de uma conexão nunca expõe contact_id, owner ou userId.
 * 3. Etapas só avançam na ordem (a anterior vai no WHERE); fechar põe a
 *    comissão da plataforma e das originadoras em 'a_apurar' — sem valor.
 * 4. A plataforma só registra comissão devida/não devida depois do fechamento.
 * 5. Nenhum percentual, valor ou preço existe no schema do registro.
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
      const resposta = estado.responder(config.sql, params) as Resposta | Error | undefined;
      if (resposta instanceof Error) throw resposta;
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

// O termo do Smart Match de quem está do outro lado (item 26): null = todas as contas têm.
const termo = vi.hoisted(() => ({ autorizadas: null as Set<number> | null }));
vi.mock("./routers/consent", () => ({
  hasValidConsent: async () => true,
  usersComConsentimento: async (ids: number[]) => (termo.autorizadas ? new Set(ids.filter(id => termo.autorizadas!.has(id))) : new Set(ids)),
}));

const registro = await import("./network-registro");
const schema = await import("../drizzle/schema");
const {
  chaveDoPar, motivoAnonimo, sincronizarConexoesInternas, ladoParaSolicitante, listarConexoesDaSolicitante,
  avancarConexao, etapaAnteriorExigida, contarConexoes, definirStatusDeComissao,
  EtapaForaDeOrdem, ConexaoNaoEncontrada, ComissaoAntesDoFechamento, paginaDeConexoesDaSolicitante, CONEXOES_POR_PAGINA,
} = registro;

const DONA = { id: 9, openId: "dona-9" };

beforeEach(() => {
  estado.consultas = [];
  estado.responder = () => undefined;
  termo.autorizadas = null;
});

const participanteLinha = (p: Partial<typeof schema.conexoesParticipantes.$inferSelect>) => ({
  id: 1, conexaoId: "c-1", lado: "a" as const, tipo: "contato" as const, ownerId: null, userId: null, contactId: null,
  codigoAnonimo: null, originador: false, statusComissaoOriginador: null, createdAt: 1, updatedAt: 1,
  descartadaEm: null, fechamentoConfirmadoEm: null, ...p,
});

describe("registro — a chave do par e o motivo", () => {
  it("A×B e B×A são a mesma conexão; origens diferentes são registros diferentes", () => {
    const a = { tipo: "contato" as const, ownerId: "x", contactId: 3, codigoAnonimo: null, originador: false };
    const b = { tipo: "contato" as const, ownerId: "x", contactId: 12, codigoAnonimo: null, originador: false };
    expect(chaveDoPar("PRIVATE_NETWORK_MATCH", a, b)).toBe(chaveDoPar("PRIVATE_NETWORK_MATCH", b, a));
    expect(chaveDoPar("PRIVATE_NETWORK_MATCH", a, b)).not.toBe(chaveDoPar("NETWORK_NETWORK_MATCH", a, b));
  });

  it("o motivo fala pelos IDs anônimos e pelos itens — nunca pelo nome do contato", () => {
    const { motivo, itens } = motivoAnonimo(
      { matchType: "exact", matchedAssets: [{ slug: "d", label: "Distribuição farmacêutica" }], matchedNeeds: [{ slug: "d", label: "Distribuidores" }] },
      "NW-AAAAAA", "NW-BBBBBB",
    );
    expect(motivo).toBe("NW-AAAAAA tem Distribuição farmacêutica, que NW-BBBBBB procura.");
    expect(itens).toEqual([{ tem: "Distribuição farmacêutica", precisa: "Distribuidores", deCodigo: "NW-AAAAAA", paraCodigo: "NW-BBBBBB" }]);
    expect(motivoAnonimo({ matchType: "mutual", matchedAssets: [], matchedNeeds: [] }, "NW-A", "NW-B").motivo).toContain("se completam");
  });

  it("o rótulo é gravado como a dona escreveu: a máscara é da LEITURA da staff, não da escrita", () => {
    // Mascarar na escrita destrói o dado no banco, e num PRIVATE_NETWORK_MATCH
    // os dois lados são contatos da MESMA dona: ela leria a própria anotação
    // borrada, contra o contrato do módulo da máscara. E há falso positivo que
    // estragaria o registro ("Café arábica 14 6000-8000 sacas").
    const { motivo, itens } = motivoAnonimo(
      {
        matchType: "exact",
        matchedAssets: [{ slug: "v", label: "Vinho Malbec — chamar no (11) 98888-7777" }],
        matchedNeeds: [{ slug: "v", label: "Vinho importado — ana.souza@vinhos.com.br" }],
      },
      "NW-AAAAAA", "NW-BBBBBB",
    );

    expect(motivo).toContain("(11) 98888-7777");
    expect(itens[0].precisa).toContain("ana.souza@vinhos.com.br");
  });
});

describe("registro — toda conexão interna é informada à plataforma (item 16)", () => {
  function bancoComSugestoes(jaRegistrada = false) {
    estado.responder = (sql) => {
      if (/from `ai_match_suggestions`/.test(sql)) {
        // contactAId, contactBId, matchScore, matchType, matchedAssets, matchedNeeds
        return [
          [11, 12, 100, "exact", JSON.stringify([{ slug: "x", label: "Distribuição de medicamentos" }]), JSON.stringify([{ slug: "y", label: "Distribuidores" }])],
          [13, 11, 60, "category", JSON.stringify([{ slug: "z", label: "Vinho" }]), JSON.stringify([{ slug: "z", label: "Vinhos" }])],
        ];
      }
      if (/select `chave_do_par` from `conexoes_registradas`/.test(sql)) {
        return jaRegistradas(jaRegistrada);
      }
      if (/from `private_contacts`/.test(sql) && /is null/.test(sql)) return [];
      if (/from `private_contacts`/.test(sql)) return [[11, "NW-111111"], [12, "NW-121212"], [13, "NW-131313"]];
      if (/select `id` from `conexoes_registradas`/.test(sql)) return [["conexao-x"]];
      return undefined;
    };
  }
  const jaRegistradas = (sim: boolean) => (sim ? [["PRIVATE_NETWORK_MATCH|contato:11|contato:12"]] : []);

  it("registra cada sugestão como PRIVATE_NETWORK_MATCH, com os IDs anônimos e sem originadora", async () => {
    bancoComSugestoes();
    expect(await sincronizarConexoesInternas(DONA.openId)).toBe(2);

    const leitura = estado.consultas.find(c => /from `ai_match_suggestions`/.test(c.sql))!;
    expect(leitura.sql).toContain("`ai_match_suggestions`.`owner_id` = ?");
    expect(leitura.params).toEqual([DONA.openId]);

    const cabecalhos = estado.consultas.filter(c => /^insert into `conexoes_registradas`/.test(c.sql));
    expect(cabecalhos).toHaveLength(2);
    expect(cabecalhos[0].params).toEqual(expect.arrayContaining(["PRIVATE_NETWORK_MATCH", "PRIVATE_NETWORK_MATCH|contato:11|contato:12", "identificada", "sem_negocio"]));
    // o recálculo não rebaixa etapa: a duplicata só atualiza motivo, itens e pontuação
    expect(cabecalhos[0].sql).toMatch(/on duplicate key update `motivo` = \?, `itens` = \?, `pontuacao` = \?, `updated_at` = \?$/);

    const participantes = estado.consultas.filter(c => /^insert into `conexoes_participantes`/.test(c.sql));
    expect(participantes[0].params).toEqual(expect.arrayContaining([DONA.openId, 11, "NW-111111", 12, "NW-121212"]));
    expect(participantes[0].params.filter(p => p === true)).toHaveLength(0);
  });

  it("cabeçalho e participantes na MESMA transação: falha nos participantes desfaz o cabeçalho", async () => {
    bancoComSugestoes();
    const anterior = estado.responder;
    estado.responder = (sql, params) => (/^insert into `conexoes_participantes`/.test(sql)
      ? new Error("Lock wait timeout exceeded")
      : anterior(sql, params));
    await expect(sincronizarConexoesInternas(DONA.openId)).rejects.toMatchObject({ cause: { message: "Lock wait timeout exceeded" } });

    const sqls = estado.consultas.map(c => c.sql);
    const cabecalho = sqls.findIndex(s => /^insert into `conexoes_registradas`/.test(s));
    const participantes = sqls.findIndex(s => /^insert into `conexoes_participantes`/.test(s));
    expect(sqls.slice(0, cabecalho).lastIndexOf("begin")).toBeGreaterThanOrEqual(0);
    expect(sqls.slice(cabecalho, participantes)).not.toContain("commit");
    expect(sqls[participantes + 1]).toBe("rollback");
    expect(sqls).not.toContain("commit");
  });

  it("o que já está no registro não é gravado de novo", async () => {
    bancoComSugestoes(true);
    expect(await sincronizarConexoesInternas(DONA.openId)).toBe(1);
    const cabecalhos = estado.consultas.filter(c => /^insert into `conexoes_registradas`/.test(c.sql));
    expect(cabecalhos).toHaveLength(1);
    expect(cabecalhos[0].params).toContain("PRIVATE_NETWORK_MATCH|contato:11|contato:13");
  });

  it("sem sugestão nenhuma, nada além da leitura", async () => {
    estado.responder = () => undefined;
    expect(await sincronizarConexoesInternas(DONA.openId)).toBe(0);
    expect(estado.consultas).toHaveLength(1);
  });
});

describe("registro — o que cada participante vê", () => {
  it("o lado alheio sai só com tipo e ID anônimo: sem contact_id, owner ou userId", () => {
    const alheio = ladoParaSolicitante(participanteLinha({ lado: "b", ownerId: "dona-2", contactId: 99, codigoAnonimo: "NW-BBBBBB", originador: true, statusComissaoOriginador: "a_apurar" }), DONA);
    expect(alheio).toEqual({ lado: "b", tipo: "contato", contactId: null, codigoAnonimo: "NW-BBBBBB", meu: false, originador: false, statusComissaoOriginador: null });
    const membraAlheia = ladoParaSolicitante(participanteLinha({ tipo: "membro", userId: 30 }), DONA);
    expect(membraAlheia).toMatchObject({ tipo: "membro", codigoAnonimo: null, contactId: null, meu: false });
    const meu = ladoParaSolicitante(participanteLinha({ ownerId: DONA.openId, contactId: 11, codigoAnonimo: "NW-111111", originador: true, statusComissaoOriginador: "sem_negocio" }), DONA);
    expect(meu).toMatchObject({ contactId: 11, meu: true, originador: true, statusComissaoOriginador: "sem_negocio" });
  });

  it("a lista parte das participações DA solicitante (owner OU userId dela) e não vaza a dona do outro lado", async () => {
    estado.responder = (sql) => {
      if (/select `conexao_id` from `conexoes_participantes`/.test(sql)) return [["c-1"]];
      if (/from `conexoes_registradas`/.test(sql)) {
        return [["c-1", "NETWORK_NETWORK_MATCH", "k", "NW-111111 tem X, que NW-BBBBBB procura.", JSON.stringify([]), 100, "identificada", null, null, null, null, "sem_negocio", 5, 5]];
      }
      if (/from `conexoes_participantes`/.test(sql)) {
        return [
          [1, "c-1", "a", "contato", DONA.openId, null, 11, "NW-111111", true, "sem_negocio", 5, 5, null, null],
          [2, "c-1", "b", "contato", "dona-2", null, 99, "NW-BBBBBB", true, "sem_negocio", 5, 5, null, null],
        ];
      }
      return undefined;
    };
    const lista = await listarConexoesDaSolicitante(DONA);
    const [primeira] = estado.consultas;
    expect(primeira.sql).toContain("(`conexoes_participantes`.`owner_id` = ? or `conexoes_participantes`.`userId` = ?)");
    expect(primeira.params).toEqual([DONA.openId, DONA.id]);
    expect(lista).toHaveLength(1);
    expect(JSON.stringify(lista)).not.toContain("dona-2");
    expect(lista[0].lados[1]).toMatchObject({ contactId: null, codigoAnonimo: "NW-BBBBBB", meu: false });
  });

  describe("item 26: o outro lado retirou a autorização depois de a conexão nascer", () => {
    const ITENS = [{ tem: "Distribuição de medicamentos na África", precisa: "Distribuidores", deCodigo: "NW-BBBBBB", paraCodigo: "NW-111111" }];
    function conexaoComOutraDona(outro: { disponivel: boolean; ativa?: boolean }) {
      estado.responder = (sql) => {
        if (/select `conexao_id` from `conexoes_participantes`/.test(sql)) return [["c-1"]];
        if (/from `conexoes_registradas`/.test(sql)) {
          return [["c-1", "NETWORK_NETWORK_MATCH", "k", "NW-BBBBBB tem Distribuição de medicamentos na África, que NW-111111 procura.", JSON.stringify(ITENS), 100, "identificada", null, null, null, null, "sem_negocio", 5, 5]];
        }
        if (/from `conexoes_participantes`/.test(sql)) {
          return [
            [1, "c-1", "a", "contato", DONA.openId, null, 11, "NW-111111", true, "sem_negocio", 5, 5, null, null],
            [2, "c-1", "b", "contato", "dona-2", null, 99, "NW-BBBBBB", true, "sem_negocio", 5, 5, null, null],
          ];
        }
        // A leitura já filtra SIM e ID anônimo no WHERE: NÃO = nenhuma linha.
        if (/from `private_contacts`/.test(sql)) return outro.disponivel ? [[99, "dona-2"]] : [];
        if (/from `users`/.test(sql)) return outro.ativa === false ? [] : [[2, "dona-2"]];
        return undefined;
      };
    }

    it("com SIM, termo e conta ativa: o motivo e os itens saem", async () => {
      conexaoComOutraDona({ disponivel: true });
      const [conexao] = await listarConexoesDaSolicitante(DONA);
      expect(conexao.itens).toEqual(ITENS);
      expect(conexao.motivo).toContain("Distribuição de medicamentos na África");

      const contatos = estado.consultas.find(c => /from `private_contacts`/.test(c.sql))!;
      expect(contatos.sql).toContain("`private_contacts`.`disponivel_rede_global` = ?");
      expect(contatos.sql).toContain("`private_contacts`.`codigo_anonimo` is not null");
      expect(contatos.sql).not.toMatch(/full_name|phone|email|whatsapp/);
      const contas = estado.consultas.find(c => /from `users`/.test(c.sql))!;
      expect(contas.sql).toContain("`users`.`isActive` = ?");
    });

    it.each([
      ["a dona mudou o contato para NÃO", { disponivel: false }, null],
      ["a dona revogou o termo do Smart Match", { disponivel: true }, new Set<number>()],
      ["a conta da dona foi desativada", { disponivel: true, ativa: false }, null],
    ])("%s: o motivo e os itens do outro lado deixam de sair", async (_caso, outro, autorizadas) => {
      conexaoComOutraDona(outro);
      termo.autorizadas = autorizadas;
      const [conexao] = await listarConexoesDaSolicitante(DONA);
      expect(conexao.itens).toEqual([]);
      expect(conexao.motivo).toBe(registro.MOTIVO_SEM_AUTORIZACAO_DO_OUTRO_LADO);
      expect(JSON.stringify(conexao)).not.toContain("medicamentos");
      // O registro da conexão continua existindo para quem participa.
      expect(conexao).toMatchObject({ id: "c-1", origem: "NETWORK_NETWORK_MATCH", status: "identificada" });
    });

    it("conexão interna (mesma dona) não depende de autorização alheia", async () => {
      estado.responder = (sql) => {
        if (/select `conexao_id` from `conexoes_participantes`/.test(sql)) return [["c-1"]];
        if (/from `conexoes_registradas`/.test(sql)) {
          return [["c-1", "PRIVATE_NETWORK_MATCH", "k", "NW-111111 tem X, que NW-121212 procura.", JSON.stringify([{ tem: "X", precisa: "Y", deCodigo: null, paraCodigo: null }]), 100, "identificada", null, null, null, null, "sem_negocio", 5, 5]];
        }
        if (/from `conexoes_participantes`/.test(sql)) {
          return [
            [1, "c-1", "a", "contato", DONA.openId, null, 11, "NW-111111", false, null, 5, 5, null, null],
            [2, "c-1", "b", "contato", DONA.openId, null, 12, "NW-121212", false, null, 5, 5, null, null],
          ];
        }
        return undefined;
      };
      const [conexao] = await listarConexoesDaSolicitante(DONA);
      expect(conexao.itens).toHaveLength(1);
      expect(estado.consultas.some(c => /from `private_contacts`|from `users`/.test(c.sql))).toBe(false);
    });
  });

  it("a etapa sai do ponto de vista de quem pergunta: quem descartou vê 'descartada', o outro lado não", async () => {
    const responder = (descartouA: boolean) => (sql: string) => {
      if (/select `conexao_id` from `conexoes_participantes`/.test(sql)) return [["c-1"]];
      if (/from `conexoes_registradas`/.test(sql)) {
        return [["c-1", "NETWORK_NETWORK_MATCH", "k", "m", JSON.stringify([]), 100, "apresentacao", 7, null, null, null, "sem_negocio", 5, 5]];
      }
      if (/from `conexoes_participantes`/.test(sql)) {
        return [
          [1, "c-1", "a", "contato", DONA.openId, null, 11, "NW-111111", true, "sem_negocio", 5, 5, descartouA ? 8 : null, null],
          [2, "c-1", "b", "contato", "dona-2", null, 99, "NW-BBBBBB", true, "sem_negocio", 5, 5, null, 9],
        ];
      }
      if (/from `private_contacts`/.test(sql)) return [[99, "dona-2"]];
      if (/from `users`/.test(sql)) return [[2, "dona-2"]];
      return undefined;
    };
    estado.responder = responder(true);
    const [minha] = await listarConexoesDaSolicitante(DONA);
    expect(minha).toMatchObject({ status: "descartada", descartadaEm: 8, apresentacaoEm: 7 });
    expect(contarConexoes([minha]).oportunidades).toBe(0);

    estado.responder = responder(false);
    const [daOutra] = await listarConexoesDaSolicitante(DONA);
    expect(daOutra).toMatchObject({ status: "apresentacao", descartadaEm: null, fechamentoConfirmadoPorMim: false });
    // o que o outro lado declarou (a confirmação de fechamento da dona-2) não sai para mim
    expect(daOutra.lados.every(lado => !("fechamentoConfirmadoEm" in lado) && !("descartadaEm" in lado))).toBe(true);
  });
});

describe("registro — a lista paginada no servidor (decisão de 26/11)", () => {
  it("página de 10, da nota maior para a menor, com o id desempatando; a página pedida vira OFFSET", async () => {
    estado.responder = sql => (/^select count\(\*\)/.test(sql) ? [[30]] : undefined);
    const r = await paginaDeConexoesDaSolicitante(DONA, { pagina: 3 });
    expect(r).toMatchObject({ total: 30, pagina: 3, porPagina: CONEXOES_POR_PAGINA, paginas: 3 });
    expect(CONEXOES_POR_PAGINA).toBe(10);
    const pagina = estado.consultas.find(c => /limit \? offset \?/.test(c.sql))!;
    expect(pagina.sql).toContain("order by `conexoes_registradas`.`pontuacao` desc, `conexoes_registradas`.`created_at` desc, `conexoes_registradas`.`id` asc");
    // A participação da dona vai no IN (subconsulta): a conexão com os dois lados dela aparece uma vez só.
    expect(pagina.sql).toMatch(/`conexoes_registradas`\.`id` in \(select `conexao_id` from `conexoes_participantes`/);
    expect(pagina.params.slice(-2)).toEqual([10, 20]);
  });

  it("página além da última volta para a última; sem conexões, nem lê a página", async () => {
    estado.responder = sql => (/^select count\(\*\)/.test(sql) ? [[12]] : undefined);
    expect(await paginaDeConexoesDaSolicitante(DONA, { pagina: 99 })).toMatchObject({ pagina: 2, paginas: 2 });
    estado.consultas = [];
    estado.responder = sql => (/^select count\(\*\)/.test(sql) ? [[0]] : undefined);
    expect(await paginaDeConexoesDaSolicitante(DONA)).toMatchObject({ lista: [], total: 0, pagina: 1, paginas: 1 });
    expect(estado.consultas.some(c => /limit \? offset \?/.test(c.sql))).toBe(false);
  });

  it("U3: sem ver a nota entre membras, a ordem também não a revela (PLATFORM_MATCH entra como nota zero)", async () => {
    estado.responder = sql => (/^select count\(\*\)/.test(sql) ? [[5]] : undefined);
    await paginaDeConexoesDaSolicitante(DONA, { semNotaEntreMembras: true });
    const pagina = estado.consultas.find(c => /order by .* limit \?/.test(c.sql))!;
    expect(pagina.sql).toContain("order by case when `conexoes_registradas`.`origem` = ? then 0 else `conexoes_registradas`.`pontuacao` end desc");
    expect(pagina.params).toContain("PLATFORM_MATCH");
  });
});

describe("registro — apresentação, negociação, fechamento (itens 16 e 17)", () => {
  it("cada etapa exige a anterior; descartar vale antes do fechamento", () => {
    expect(etapaAnteriorExigida("apresentacao")).toEqual(["identificada"]);
    expect(etapaAnteriorExigida("negociacao")).toEqual(["apresentacao"]);
    expect(etapaAnteriorExigida("fechada")).toEqual(["negociacao"]);
    expect(etapaAnteriorExigida("descartada")).toEqual(["identificada", "apresentacao", "negociacao"]);
  });

  it("quem não participa: não encontrada, e nada é escrito", async () => {
    estado.responder = sql => (/from `conexoes_participantes`/.test(sql) ? [] : undefined);
    await expect(avancarConexao(DONA, "c-1", "apresentacao")).rejects.toBeInstanceOf(ConexaoNaoEncontrada);
    expect(estado.consultas.some(c => /^update/.test(c.sql))).toBe(false);
  });

  // O banco de uma conexão: a etapa do cabeçalho e os lados como a transação os lê
  // ([tipo, owner_id, userId, descartada_em, fechamento_confirmado_em]).
  type LadoNoBanco = [string, string | null, number | null, number | null, number | null];
  const DA_DONA = (descartadaEm: number | null = null, confirmadoEm: number | null = null): LadoNoBanco => ["contato", DONA.openId, null, descartadaEm, confirmadoEm];
  const DA_OUTRA_DONA = (descartadaEm: number | null = null, confirmadoEm: number | null = null): LadoNoBanco => ["contato", "dona-2", null, descartadaEm, confirmadoEm];
  const DA_MEMBRA = (descartadaEm: number | null = null, confirmadoEm: number | null = null): LadoNoBanco => ["membro", null, 30, descartadaEm, confirmadoEm];
  const MEMBRA = { id: 30, openId: "membra-30" };

  function conexaoNoBanco(status: string, lados: LadoNoBanco[], outra: (sql: string) => unknown = () => undefined) {
    estado.responder = sql => {
      const resposta = outra(sql);
      if (resposta !== undefined) return resposta;
      if (/^select `id` from `conexoes_participantes`/.test(sql)) return [[1]];
      if (/^select `status` from `conexoes_registradas`/.test(sql)) return [[status]];
      if (/^select `tipo`.* from `conexoes_participantes`/.test(sql)) return lados;
      return undefined;
    };
  }
  const updates = () => estado.consultas.filter(c => /^update/.test(c.sql));
  const sqls = () => estado.consultas.map(c => c.sql);
  // O valor que um UPDATE grava numa coluna do SET (os `?` do SET vêm antes dos do WHERE); undefined = a coluna não está no SET.
  const valorNoSet = (update: { sql: string; params: unknown[] }, coluna: string) => {
    const colunas = Array.from(update.sql.replace(/ where .*$/, "").matchAll(/`(\w+)` = \?/g), m => m[1]);
    const posicao = colunas.indexOf(coluna);
    return posicao === -1 ? undefined : update.params[posicao];
  };

  it("fora de ordem: a etapa é conferida com o cabeçalho TRAVADO, e nada é escrito", async () => {
    conexaoNoBanco("identificada", [DA_DONA(), DA_DONA()]);
    await expect(avancarConexao(DONA, "c-1", "fechada")).rejects.toBeInstanceOf(EtapaForaDeOrdem);
    expect(estado.consultas.find(c => /^select `status` from `conexoes_registradas`/.test(c.sql))!.sql).toMatch(/for update$/);
    expect(updates()).toHaveLength(0);
    expect(sqls()).toContain("rollback");
  });

  it("o UPDATE do cabeçalho ainda leva a etapa anterior no WHERE: 0 linhas é conflito, desfeito", async () => {
    conexaoNoBanco("apresentacao", [DA_DONA(), DA_DONA()], sql => (/^update `conexoes_registradas`/.test(sql) ? { affectedRows: 0 } : undefined));
    await expect(avancarConexao(DONA, "c-1", "negociacao")).rejects.toBeInstanceOf(EtapaForaDeOrdem);
    const [update] = updates();
    expect(update.sql).toContain("`conexoes_registradas`.`status` in (?)");
    expect(update.params).toContain("apresentacao");
    expect(sqls()).toContain("rollback");
    expect(sqls()).not.toContain("commit");
  });

  it("conexão interna (os dois lados da dona): um clique fecha, e plataforma e originadoras vão a 'a_apurar' na mesma transação", async () => {
    conexaoNoBanco("negociacao", [DA_DONA(), DA_DONA()]);
    expect(await avancarConexao(DONA, "c-1", "fechada")).toEqual({ status: "fechada", aguardandoOutroLado: false });
    const [confirmacao, cabecalho, originadoras] = updates();
    expect(confirmacao.sql).toMatch(/^update `conexoes_participantes` set `updated_at` = \?, `fechamento_confirmado_em` = \?|^update `conexoes_participantes` set `fechamento_confirmado_em` = \?/);
    expect(cabecalho.sql).toContain("`fechamento_em` = ?");
    expect(cabecalho.params).toEqual(expect.arrayContaining(["fechada", "a_apurar"]));
    expect(originadoras.sql).toMatch(/^update `conexoes_participantes` set `status_comissao_originador` = \?/);
    expect(originadoras.sql).toContain("`conexoes_participantes`.`originador` = ?");
    const ordem = sqls();
    expect(ordem.indexOf("begin")).toBeLessThan(ordem.indexOf(cabecalho.sql));
    expect(ordem.indexOf("commit")).toBeGreaterThan(ordem.indexOf(originadoras.sql));
  });

  it("entre contas: a primeira confirmação de fechamento fica só no lado de quem confirmou — sem comissão", async () => {
    conexaoNoBanco("negociacao", [DA_DONA(), DA_OUTRA_DONA()]);
    expect(await avancarConexao(DONA, "c-1", "fechada")).toEqual({ status: "negociacao", aguardandoOutroLado: true });
    const [confirmacao, ...outros] = updates();
    expect(outros).toHaveLength(0);
    expect(confirmacao.sql).toMatch(/^update `conexoes_participantes`/);
    expect(confirmacao.sql).toContain("`fechamento_confirmado_em` = ?");
    expect(confirmacao.sql).toContain("(`conexoes_participantes`.`owner_id` = ? or `conexoes_participantes`.`userId` = ?)");
    expect(confirmacao.params).toEqual(expect.arrayContaining(["c-1", DONA.openId, DONA.id]));
    expect(estado.consultas.flatMap(c => c.params)).not.toContain("a_apurar");
  });

  it("entre contas: a confirmação que faltava fecha a conexão", async () => {
    conexaoNoBanco("negociacao", [DA_DONA(), DA_OUTRA_DONA(null, 5)]);
    expect(await avancarConexao(DONA, "c-1", "fechada")).toEqual({ status: "fechada", aguardandoOutroLado: false });
    expect(updates().map(u => u.sql.slice(0, 40))).toEqual([
      expect.stringMatching(/^update `conexoes_participantes`/),
      expect.stringMatching(/^update `conexoes_registradas`/),
      expect.stringMatching(/^update `conexoes_participantes`/),
    ]);
  });

  it("confirmar o fechamento duas vezes: conflito", async () => {
    conexaoNoBanco("negociacao", [DA_DONA(null, 5), DA_OUTRA_DONA()]);
    await expect(avancarConexao(DONA, "c-1", "fechada")).rejects.toBeInstanceOf(EtapaForaDeOrdem);
    expect(updates()).toHaveLength(0);
  });

  it("descartar entre contas vale só para quem descartou; o outro lado segue registrando etapas", async () => {
    conexaoNoBanco("apresentacao", [DA_DONA(), DA_MEMBRA()]);
    expect(await avancarConexao(DONA, "c-1", "descartada")).toEqual({ status: "descartada", aguardandoOutroLado: false });
    const [descarte, ...outros] = updates();
    expect(outros).toHaveLength(0);
    expect(descarte.sql).toMatch(/^update `conexoes_participantes`/);
    expect(descarte.sql).toContain("`descartada_em` = ?");
    expect(estado.consultas.flatMap(c => c.params)).not.toContain("descartada");

    // A membra do outro lado não foi consultada e não perde nada: a negociação dela entra.
    estado.consultas = [];
    conexaoNoBanco("apresentacao", [DA_DONA(5), DA_MEMBRA()]);
    expect(await avancarConexao(MEMBRA, "c-1", "negociacao")).toEqual({ status: "negociacao", aguardandoOutroLado: false });
    expect(updates()[0].params).toEqual(expect.arrayContaining(["negociacao", "c-1", "apresentacao"]));
  });

  it("quem descartou não registra mais etapa", async () => {
    conexaoNoBanco("apresentacao", [DA_DONA(5), DA_OUTRA_DONA()]);
    await expect(avancarConexao(DONA, "c-1", "negociacao")).rejects.toBeInstanceOf(EtapaForaDeOrdem);
    await expect(avancarConexao(DONA, "c-1", "descartada")).rejects.toBeInstanceOf(EtapaForaDeOrdem);
    expect(updates()).toHaveLength(0);
  });

  it("quando o último lado descarta, a conexão vira 'descartada'", async () => {
    conexaoNoBanco("negociacao", [DA_DONA(), DA_OUTRA_DONA(4)]);
    await avancarConexao(DONA, "c-1", "descartada");
    const [, cabecalho] = updates();
    expect(cabecalho.sql).toMatch(/^update `conexoes_registradas`/);
    expect(cabecalho.params).toEqual(expect.arrayContaining(["descartada", "c-1"]));
  });

  it("descartar depois de confirmar o fechamento apaga a confirmação do próprio lado", async () => {
    conexaoNoBanco("negociacao", [DA_DONA(null, 5), DA_OUTRA_DONA()]);
    expect(await avancarConexao(DONA, "c-1", "descartada")).toEqual({ status: "descartada", aguardandoOutroLado: false });
    const [descarte, ...outros] = updates();
    expect(outros).toHaveLength(0);
    expect(descarte.sql).toMatch(/^update `conexoes_participantes`/);
    expect(descarte.params).toEqual(expect.arrayContaining(["c-1", DONA.openId, DONA.id]));
    expect(valorNoSet(descarte, "descartada_em")).toEqual(expect.any(Number));
    expect(valorNoSet(descarte, "fechamento_confirmado_em")).toBeNull();
  });

  it("item 6 da revisão da #135 — A confirma, A descarta, B confirma: a conexão NÃO fecha e a comissão NÃO vai a 'a_apurar'", async () => {
    const OUTRA_DONA = { id: 2, openId: "dona-2" };
    // 1. A confirma o fechamento: fica só no lado dela.
    conexaoNoBanco("negociacao", [DA_DONA(), DA_OUTRA_DONA()]);
    expect(await avancarConexao(DONA, "c-1", "fechada")).toEqual({ status: "negociacao", aguardandoOutroLado: true });

    // 2. A descarta (o que o descarte grava está no teste acima).
    estado.consultas = [];
    conexaoNoBanco("negociacao", [DA_DONA(null, 5), DA_OUTRA_DONA()]);
    expect(await avancarConexao(DONA, "c-1", "descartada")).toEqual({ status: "descartada", aguardandoOutroLado: false });

    // 3. B confirma. O lado descartado de A não conta como confirmado — nem quando a confirmação
    //    antiga ficou gravada nele (linha anterior a esta regra): B fica aguardando, como na primeira confirmação.
    for (const ladoDeA of [DA_DONA(8, null), DA_DONA(8, 5)]) {
      estado.consultas = [];
      conexaoNoBanco("negociacao", [ladoDeA, DA_OUTRA_DONA()]);
      expect(await avancarConexao(OUTRA_DONA, "c-1", "fechada")).toEqual({ status: "negociacao", aguardandoOutroLado: true });
      const [confirmacao, ...outros] = updates();
      expect(outros).toHaveLength(0);
      expect(confirmacao.sql).toMatch(/^update `conexoes_participantes`/);
      expect(confirmacao.params).toEqual(expect.arrayContaining(["c-1", OUTRA_DONA.openId, OUTRA_DONA.id]));
      const params = estado.consultas.flatMap(c => c.params);
      expect(params).not.toContain("fechada");
      expect(params).not.toContain("a_apurar");
    }
  });

  it("falha ao marcar as originadoras desfaz o fechamento inteiro (rollback): a ação pode ser repetida", async () => {
    conexaoNoBanco("negociacao", [DA_DONA(), DA_DONA()], sql => (/^update `conexoes_participantes` set `status_comissao_originador`/.test(sql)
      ? new Error("Connection lost: The server closed the connection.")
      : undefined));
    await expect(avancarConexao(DONA, "c-1", "fechada")).rejects.toMatchObject({ cause: { message: expect.stringContaining("Connection lost") } });
    expect(sqls()).toContain("rollback");
    expect(sqls()).not.toContain("commit");
  });

  it("o painel conta intermediações, negócios e comissionamentos a partir das etapas", () => {
    const base = { motivo: "", itens: [], pontuacao: 100, apresentacaoEm: null, negociacaoEm: null, fechamentoEm: null, descartadaEm: null, fechamentoConfirmadoPorMim: false, criadaEm: 1, lados: [] };
    const contagem = contarConexoes([
      { ...base, id: "1", origem: "PRIVATE_NETWORK_MATCH", status: "identificada", statusComissao: "sem_negocio" },
      { ...base, id: "2", origem: "PRIVATE_NETWORK_MATCH", status: "negociacao", apresentacaoEm: 2, negociacaoEm: 3, statusComissao: "sem_negocio" },
      { ...base, id: "3", origem: "NETWORK_NETWORK_MATCH", status: "fechada", apresentacaoEm: 2, negociacaoEm: 3, fechamentoEm: 4, statusComissao: "a_apurar" },
      { ...base, id: "4", origem: "NETWORK_PLATFORM_MATCH", status: "descartada", descartadaEm: 5, statusComissao: "sem_negocio" },
    ]);
    expect(contagem).toEqual({ internas: 2, internasIdentificadas: 1, comRedeGlobal: 2, oportunidades: 3, intermediacoes: 2, negociosEmAndamento: 1, negociosConcluidos: 1, comissionamentos: 1 });
  });
});

describe("registro — a apuração da plataforma", () => {
  it("antes do fechamento: recusa, sem escrever", async () => {
    estado.responder = sql => (/from `conexoes_registradas`/.test(sql) ? [["negociacao"]] : undefined);
    await expect(definirStatusDeComissao({ conexaoId: "c-1", status: "devida" })).rejects.toBeInstanceOf(ComissaoAntesDoFechamento);
    expect(estado.consultas.some(c => /^update/.test(c.sql))).toBe(false);
  });

  it("depois do fechamento: grava só o status (da plataforma, ou da originadora indicada)", async () => {
    estado.responder = sql => (/from `conexoes_registradas`/.test(sql) ? [["fechada"]] : undefined);
    await definirStatusDeComissao({ conexaoId: "c-1", status: "devida" });
    await definirStatusDeComissao({ conexaoId: "c-1", status: "nao_devida", participanteId: 2 });
    const [plataforma, originadora] = estado.consultas.filter(c => /^update/.test(c.sql));
    expect(plataforma.sql).toMatch(/^update `conexoes_registradas` set `status_comissao` = \?, `updated_at` = \?/);
    expect(originadora.sql).toContain("`conexoes_participantes`.`originador` = ?");
    expect(originadora.params).toEqual(expect.arrayContaining(["nao_devida", 2, "c-1", true]));
  });

  it("nenhuma coluna de percentual, valor ou preço no registro", () => {
    const colunas = [
      ...Object.values(schema.conexoesRegistradas).map(coluna => (coluna as { name?: string }).name),
      ...Object.values(schema.conexoesParticipantes).map(coluna => (coluna as { name?: string }).name),
    ].filter(Boolean).join(" ");
    expect(colunas).not.toMatch(/percent|valor|preco|price|amount|fee/i);
  });
});
