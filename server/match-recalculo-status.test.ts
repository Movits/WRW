import { and, eq, gte, inArray, or } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Reverificação de 04/09 (MAJOR): a sugestão dispensada era reaproveitada para
 * uma razão nova. O índice único (dona, par) força uma linha por par; na
 * atualização, `values` reescrevia razão, texto e nota, mas nunca o status —
 * um par dispensado por "Vinho" cuja razão sumiu e para o qual nasceu "Café"
 * ficava "dispensado" com o texto do café: a dona nunca via a oportunidade nova.
 * E o e-mail de "nova oportunidade" saía para par dispensado que subia de nota.
 *
 * Decisão do Nicolas (04/09): par dispensado (ou aceito) que ganha razão
 * TOTALMENTE nova volta a pendente; com qualquer razão em comum, a decisão da
 * usuária permanece. O par só VISTO segue a mesma regra (revisão adversarial
 * de 05/09): o que ela viu foi a razão antiga.
 */

// Banco falso por identidade de tabela (padrão de match-escritas-nao-latinas),
// mas que GRAVA DE VOLTA: o dublê antigo só registrava o `update` e nunca
// aplicava o patch na linha, então nenhum dos testes enxergava dois recálculos
// em sequência — e era exatamente aí que o defeito sobrevivia (um par reaberto
// continuava "dispensado" na leitura seguinte, e a corrida entre dois
// recálculos era invisível). Agora o dublê:
//
//  • devolve CÓPIA das linhas no `select`, como um banco devolve um retrato:
//    duas rodadas simultâneas partem do mesmo estado e só se atropelam na
//    escrita;
//  • traduz o WHERE do drizzle no SQL real (MySqlDialect), aplica a condição
//    na linha e responde `affectedRows` — é o que faz o UPDATE condicional da
//    reabertura significar alguma coisa;
//  • guarda o SQL e os parâmetros de cada escrita, para o teste afirmar sobre
//    o WHERE INTEIRO, não sobre um fragmento;
//  • respeita o índice único (dona, par) no insert, que é o que faz duas
//    rodadas simultâneas colidirem de verdade.
type Atualizacao = { tabela: unknown; valores: Record<string, unknown>; colunas: string[]; sql: string; params: unknown[]; afetadas: number };
const estado = vi.hoisted(() => ({
  linhas: new Map<unknown, Array<Record<string, unknown>>>(),
  inseridos: [] as Array<Record<string, unknown>>,
  atualizacoes: [] as Array<{ tabela: unknown; valores: Record<string, unknown>; colunas: string[]; sql: string; params: unknown[]; afetadas: number }>,
  apagados: 0,
  // Ganchos de corrida: o primeiro roda uma vez, quando o recálculo acaba de
  // LER as sugestões (é a janela entre a leitura e a escrita); o segundo, toda
  // vez que um insert grava linha nova.
  entreALeituraEAEscrita: null as null | (() => void),
  aposInserir: null as null | (() => void),
  // Falha do banco que NÃO é chave duplicada, para provar que ela continua subindo.
  falhaNoInsert: null as null | Error,
}));

const { MySqlDialect } = await import("drizzle-orm/mysql-core");
const dialeto = new MySqlDialect();

/** Nome da coluna no banco → nome da propriedade na linha (id → id, owner_id → ownerId). */
function propriedadePorColuna(tabela: unknown) {
  const mapa = new Map<string, string>();
  for (const [prop, coluna] of Object.entries(tabela as Record<string, unknown>)) {
    const nome = (coluna as { name?: unknown } | null)?.name;
    if (typeof nome === "string") mapa.set(nome, prop);
  }
  return mapa;
}

/**
 * Uma comparação inteira, e nada além dela: coluna, operador e o(s) parâmetro(s),
 * com os parênteses que o `and` do drizzle deixa nas pontas. Ancorada de
 * propósito — "casa o começo do pedaço" aceitaria `a = ? or b = ?` e aplicaria
 * só a primeira metade, que é justamente o dublê cego que este arquivo evita.
 */
const COMPARACAO = /^\(?`[^`]+`\.`([^`]+)` (>=|=|in) (\?|\(\?(?:, \?)*\))\)?$/;

/**
 * Lê o WHERE como o banco leria: o SQL de verdade, com os parâmetros na ordem.
 * Cobre as três formas que o match-service monta (`=`, `>=`, `in (...)`) e
 * recusa qualquer outra em vez de aceitar em silêncio — um dublê que ignora a
 * condição que não entende volta a ser cego.
 */
function condicaoDe(tabela: unknown, condicao: unknown) {
  const { sql, params } = dialeto.sqlToQuery(condicao as never);
  const mapa = propriedadePorColuna(tabela);
  const colunas: string[] = [];
  const testes: Array<(linha: Record<string, unknown>) => boolean> = [];
  let lidos = 0;
  for (const pedaco of sql.split(" and ")) {
    const achado = pedaco.match(COMPARACAO);
    if (!achado) throw new Error("condição que o dublê não sabe aplicar: " + pedaco);
    const [, coluna, operador] = achado;
    const valores = params.slice(lidos, lidos + (pedaco.match(/\?/g) ?? []).length);
    lidos += valores.length;
    colunas.push(coluna);
    const prop = mapa.get(coluna);
    testes.push(linha => {
      const valor = prop ? linha[prop] : undefined;
      if (operador === "=") return valor === valores[0];
      if (operador === ">=") return Number(valor) >= Number(valores[0]);
      return valores.includes(valor);
    });
  }
  return { sql, params, colunas, casa: (linha: Record<string, unknown>) => testes.every(teste => teste(linha)) };
}

/**
 * A chave do índice único `ai_match_owner_pair_unique_idx` (drizzle/0000_fundacao.sql):
 * uma linha por dona e por par. É ela que recusa o segundo insert quando duas
 * rodadas simultâneas descobrem o mesmo par novo ao mesmo tempo.
 */
const chaveDoPar = (linha: Record<string, unknown>) =>
  `${linha.ownerId}:${linha.pairLowContactId}:${linha.pairHighContactId}`;

// A leitura dos itens leva ORDER BY id (o corte do modo em massa sai igual entre rodadas): o dublê aceita.
const comOrderBy = vi.hoisted(() => <T>(leitura: () => Promise<T>) => () => {
  const promessa = leitura();
  return Object.assign(promessa, { orderBy: () => promessa });
});

vi.mock("./db", () => ({
  exigirDb: async () => ({
    // Cópia: quem leu antes da escrita alheia continua com o retrato antigo.
    select: () => ({ from: (tabela: unknown) => ({ where: comOrderBy(async () => {
      const retrato = (estado.linhas.get(tabela) ?? []).map(linha => ({ ...linha }));
      if (tabela === aiMatchSuggestions && estado.entreALeituraEAEscrita) {
        const acontecer = estado.entreALeituraEAEscrita;
        estado.entreALeituraEAEscrita = null; // uma vez só: é uma janela, não um laço
        acontecer();
      }
      return retrato;
    }) }) }),
    // Insert com o índice único de verdade: o segundo par igual levanta
    // ER_DUP_ENTRY embrulhado num DrizzleQueryError, como o par
    // drizzle + MariaDB levanta (conferido contra MariaDB 12.3).
    insert: (tabela: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        estado.inseridos.push(v);
        if (estado.falhaNoInsert) throw estado.falhaNoInsert;
        const linhas = estado.linhas.get(tabela) ?? [];
        if (tabela === aiMatchSuggestions && linhas.some(linha => chaveDoPar(linha) === chaveDoPar(v))) {
          const doDriver = Object.assign(new Error("Duplicate entry for key 'ai_match_owner_pair_unique_idx'"), { code: "ER_DUP_ENTRY", errno: 1062 });
          throw Object.assign(new Error("Failed query"), { cause: doDriver });
        }
        linhas.push({ ...v });
        estado.linhas.set(tabela, linhas);
        estado.aposInserir?.();
        return [{ affectedRows: 1 }];
      },
    }),
    update: (tabela: unknown) => ({
      set: (valores: Record<string, unknown>) => ({
        where: async (condicao: unknown) => {
          const { sql, params, colunas, casa } = condicaoDe(tabela, condicao);
          const alvos = (estado.linhas.get(tabela) ?? []).filter(casa);
          for (const linha of alvos) Object.assign(linha, valores);
          estado.atualizacoes.push({ tabela, valores, colunas, sql, params, afetadas: alvos.length });
          // Como o mysql2: o cabeçalho vem na primeira posição, e o
          // `affectedRows` conta a linha ENCONTRADA pelo WHERE (o driver liga
          // CLIENT_FOUND_ROWS por padrão), não a que mudou de valor.
          return [{ affectedRows: alvos.length }];
        },
      }),
    }),
    delete: (tabela: unknown) => ({
      where: async (condicao: unknown) => {
        const { casa } = condicaoDe(tabela, condicao);
        const restantes = (estado.linhas.get(tabela) ?? []).filter(linha => !casa(linha));
        estado.apagados += (estado.linhas.get(tabela) ?? []).length - restantes.length;
        estado.linhas.set(tabela, restantes);
      },
    }),
  }),
}));
const email = vi.hoisted(() => ({ sendEmail: vi.fn(async () => true) }));
vi.mock("./_core/email", () => email);
// O registro das conexões internas no fim do recálculo tem teste próprio (registro-de-conexoes-nos-motores.test.ts).
vi.mock("./network-registro", () => ({ registrarConexoesInternasDepoisDoRecalculo: async () => undefined }));

const { recalculatePrivateMatches, slugifyMatchTag } = await import("./match-service");
const { aiMatchSuggestions, contactAssets, contactNeeds, privateContacts } = await import("../drizzle/schema");

const ANA = 1; const BIA = 2;
const t = 1000;
const razao = (label: string) => ({ slug: slugifyMatchTag(label), label });
const termo = (id: number, contactId: number, tagLabel: string, category: string | null = null) =>
  ({ id, ownerId: "dona", contactId, tagSlug: slugifyMatchTag(tagLabel), tagLabel, category, description: null, createdAt: t, updatedAt: t });

/** A linha do par Ana:Bia como ficou depois da decisão da dona. */
function linhaDoPar(status: "pending" | "viewed" | "accepted" | "dismissed", matchScore: number, assets: string[], needs: string[]) {
  return {
    id: "sugestao-1", ownerId: "dona", contactAId: ANA, contactBId: BIA, pairLowContactId: ANA, pairHighContactId: BIA,
    matchScore, matchType: matchScore === 60 ? "category" : "exact",
    matchedAssets: assets.map(razao), matchedNeeds: needs.map(razao), reasonText: "razão antiga",
    status, notifiedAt: null,
    viewedAt: status === "viewed" ? t : null,
    acceptedAt: status === "accepted" ? t : null,
    dismissedAt: status === "dismissed" ? t : null,
    createdAt: t, updatedAt: t,
  };
}

const atualizacoesDeSugestao = (): Atualizacao[] => estado.atualizacoes.filter(a => a.tabela === aiMatchSuggestions);
const patchDoPar = () => atualizacoesDeSugestao().find(a => "matchScore" in a.valores)?.valores;

/**
 * A linha do par Ana:Bia lida de volta do "banco" — o que ATERRISSOU, não o que
 * foi enviado. Procura pelo par (e não pelo id) porque a linha pode ter nascido
 * de um insert, com id sorteado.
 */
const linhaGravada = () => estado.linhas.get(aiMatchSuggestions)!.find(l => l.pairLowContactId === ANA && l.pairHighContactId === BIA)!;

beforeEach(() => {
  estado.linhas.clear();
  estado.inseridos = [];
  estado.atualizacoes = [];
  estado.apagados = 0;
  estado.entreALeituraEAEscrita = null;
  estado.aposInserir = null;
  estado.falhaNoInsert = null;
  email.sendEmail.mockClear();
  estado.linhas.set(privateContacts, [{ id: ANA, fullName: "Ana" }, { id: BIA, fullName: "Bia" }]);
});

describe("recalculatePrivateMatches — par dispensado que ganha razão totalmente nova", () => {
  it("volta a pendente: a razão que a dona dispensou sumiu e nasceu outra sem nada em comum", async () => {
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("dismissed", 100, ["Vinho"], ["Vinho"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);

    const r = await recalculatePrivateMatches("dona");
    expect(r).toEqual({ created: 0, updated: 1, removed: 0, total: 1 });
    expect(estado.inseridos).toEqual([]);

    const patch = patchDoPar();
    expect(patch?.status).toBe("pending");
    expect(patch?.viewedAt).toBeNull();
    expect(patch?.notifiedAt).toBeNull();
    expect(patch?.reasonText).toBe("Ana possui Café, que Bia procura.");
    // a decisão anterior fica como histórico: o patch não toca em dismissedAt
    expect(patch).not.toHaveProperty("dismissedAt");
    expect(patch).not.toHaveProperty("acceptedAt");
    // e a atualização continua presa à dona
    expect(atualizacoesDeSugestao()[0].colunas).toContain("owner_id");
  });

  it("NÃO reabre quando alguma razão continua: a decisão da dona vale para o par", async () => {
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("dismissed", 100, ["Vinho"], ["Vinho"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Vinho"), termo(2, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(3, BIA, "Vinho"), termo(4, BIA, "Café")]);

    const r = await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(r.updated).toBe(1);
    const patch = patchDoPar();
    expect(patch).toBeDefined();
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("viewedAt");
    // razão nova somada à antiga não é "nova oportunidade" para quem dispensou o par
    expect(email.sendEmail).not.toHaveBeenCalled();
    // Este é o UPDATE mais usado do recálculo, e o WHERE dele vai INTEIRO:
    // sem `owner_id` a escrita alcançaria a linha de outra dona, e sem
    // `match_score` duas rodadas simultâneas anunciariam a mesma subida de nota.
    const comum = atualizacoesDeSugestao()[0];
    expect(comum.sql).toBe(
      "(`ai_match_suggestions`.`id` = ? and `ai_match_suggestions`.`owner_id` = ? and `ai_match_suggestions`.`match_score` = ?)"
    );
    expect(comum.params).toEqual(["sugestao-1", "dona", 100]);
    expect(comum.afetadas).toBe(1);
    expect(linhaGravada().status).toBe("dismissed");
  });

  it("a razão antiga gravada com slug vazio (linha anterior ao conserto da escrita) ainda conta como interseção", async () => {
    const antiga = linhaDoPar("dismissed", 100, ["Vinho"], ["Vinho"]);
    antiga.matchedAssets = [{ slug: "", label: "Vinho" }];
    antiga.matchedNeeds = [{ slug: "", label: "Vinho" }];
    estado.linhas.set(aiMatchSuggestions, [antiga]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Vinho")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Vinho")]);

    await recalculatePrivateMatches("dona");
    expect(patchDoPar()).not.toHaveProperty("status");
  });

  it("par aceito com razão totalmente nova também volta a pendente, e acceptedAt fica como histórico", async () => {
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("accepted", 100, ["Vinho"], ["Vinho"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);

    await recalculatePrivateMatches("dona");
    const patch = patchDoPar();
    expect(patch?.status).toBe("pending");
    expect(patch).not.toHaveProperty("acceptedAt");
    // A linha que ATERRISSOU, não só o patch enviado: fixar "dismissed" no
    // WHERE da reabertura deixaria o patch igualzinho e o par aceito parado.
    expect(linhaGravada().status).toBe("pending");
    expect(linhaGravada().acceptedAt).toBe(t);
  });

  it("par só VISTO com razão totalmente nova volta a pendente sem viewedAt, e conta como nova para o e-mail", async () => {
    // A dona viu a razão antiga; a nova ela não viu nem foi anunciada. Antes o
    // par ficava "visto" com o texto novo e, com a nota antiga já em 100, nem
    // entrava no e-mail (revisão adversarial de 05/09).
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("viewed", 100, ["Vinho"], ["Vinho"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);

    await recalculatePrivateMatches("dona", "dona@exemplo.com");
    const patch = patchDoPar();
    expect(patch?.status).toBe("pending");
    expect(patch?.viewedAt).toBeNull();
    expect(patch?.notifiedAt).toBeNull();
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0]).toMatchObject({ subject: expect.stringContaining("1 nova(s) oportunidade(s)") });
  });

  it("par visto que mantém alguma razão continua visto, e a mesma razão não vira e-mail", async () => {
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("viewed", 100, ["Vinho"], ["Vinho"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Vinho"), termo(2, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(3, BIA, "Vinho"), termo(4, BIA, "Café")]);

    await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(patchDoPar()).not.toHaveProperty("status");
    expect(patchDoPar()).not.toHaveProperty("viewedAt");
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
});

describe("recalculatePrivateMatches — o e-mail de 'nova oportunidade' só sai para o que a dona ainda vai decidir", () => {
  it("dispensada que sobe de 60 para 100 pela mesma razão não manda e-mail nem ganha carimbo", async () => {
    // Antes: previous.matchScore < 70 e o novo >= 70 contavam sem olhar o
    // status — a dona recebia "1 nova(s) oportunidade(s)" e na tela nada mudava.
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("dismissed", 60, ["Café especial"], ["Café"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café", "Agro")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café", "Agro")]);

    const r = await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(r.updated).toBe(1);
    expect(patchDoPar()?.matchScore).toBe(100);
    expect(patchDoPar()).not.toHaveProperty("status");
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(atualizacoesDeSugestao().some(a => "notifiedAt" in a.valores && !("matchScore" in a.valores))).toBe(false);
  });

  it("par reaberto com nota alta é oportunidade nova: entra no e-mail, e o carimbo filtra por status e por dona", async () => {
    // A segunda linha é outro par da mesma dona, DISPENSADO e com nota alta:
    // ele não foi anunciado neste e-mail e não pode receber o carimbo. Sem essa
    // linha, o filtro de status só era conferido pelo nome da coluna, e um
    // `in ("pending","viewed","dismissed")` passava batido.
    const outroDispensado = { ...linhaDoPar("dismissed", 100, ["Ouro"], ["Ouro"]), id: "sugestao-2", pairLowContactId: 3, pairHighContactId: 4 };
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("dismissed", 100, ["Vinho"], ["Vinho"]), outroDispensado]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);

    await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0]).toMatchObject({ to: "dona@exemplo.com", subject: expect.stringContaining("1 nova(s) oportunidade(s)") });
    const carimbo = atualizacoesDeSugestao().find(a => "notifiedAt" in a.valores && !("matchScore" in a.valores));
    expect(carimbo).toBeDefined();
    expect(carimbo?.valores.notifiedAt).toEqual(expect.any(Number));
    expect(carimbo?.colunas).toContain("status");
    expect(carimbo?.colunas).toContain("owner_id");
    expect(carimbo?.colunas).toContain("match_score");
    // e o que aterrissou: só o par reaberto foi carimbado
    expect(linhaGravada().notifiedAt).toEqual(expect.any(Number));
    expect(estado.linhas.get(aiMatchSuggestions)!.find(l => l.id === "sugestao-2")!.notifiedAt).toBeNull();
  });

  it("pendente que sobe de 60 para 100 continua contando, como sempre contou", async () => {
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("pending", 60, ["Café especial"], ["Café"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café", "Agro")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café", "Agro")]);

    await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(patchDoPar()).not.toHaveProperty("status");
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });
});

/**
 * Reverificação de 05/09 (MAJOR 20): os buracos que sobraram no conserto acima.
 * Todos dependem do dublê GRAVAR de volta — o antigo registrava o `update` e
 * não aplicava nada, então nenhum destes casos era observável.
 */
describe("recalculatePrivateMatches — sem razão antiga registrada, a decisão da dona é que vale", () => {
  /** A linha do par sem nenhuma razão guardada (JSON nulo ou lista vazia). */
  const semRazaoGuardada = (guardado: unknown) => {
    const linha = linhaDoPar("dismissed", 100, ["Vinho"], ["Vinho"]);
    linha.matchedAssets = guardado as never;
    linha.matchedNeeds = guardado as never;
    return linha;
  };

  it.each([
    ["nulo", null],
    ["lista vazia", []],
    // O `jsonCompat` do schema devolve o que estiver gravado na coluna: no
    // MariaDB ela é longtext, e um JSON que não é lista chega assim mesmo.
    // Espalhar isso num array (`[...{}]`) explode o recálculo inteiro.
    ["um objeto, não uma lista", {}],
  ])("matched_assets/matched_needs %s e a MESMA razão de sempre: o par continua dispensado, sem e-mail", async (_nome, guardado) => {
    // Antes, `previous.matchedAssets ?? []` deixava a interseção vazia por
    // falta de dado: "razão totalmente nova" era SEMPRE verdadeiro, o par
    // dispensado voltava a pendente e ainda saía "1 nova(s) oportunidade(s)".
    estado.linhas.set(aiMatchSuggestions, [semRazaoGuardada(guardado)]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Vinho")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Vinho")]);

    await recalculatePrivateMatches("dona", "dona@exemplo.com");

    expect(patchDoPar()).not.toHaveProperty("status");
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(estado.linhas.get(aiMatchSuggestions)![0].status).toBe("dismissed");
  });

  it("nem com razão diferente: sem slug antigo não há prova de que a razão mudou", async () => {
    estado.linhas.set(aiMatchSuggestions, [semRazaoGuardada(null)]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);

    await recalculatePrivateMatches("dona", "dona@exemplo.com");

    expect(patchDoPar()).not.toHaveProperty("status");
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(estado.linhas.get(aiMatchSuggestions)![0].status).toBe("dismissed");
    // A razão nova é gravada mesmo assim: o texto na tela não pode mentir.
    expect(patchDoPar()?.reasonText).toBe("Ana possui Café, que Bia procura.");
  });

  it("com razão antiga registrada, a reabertura combinada com o Nicolas continua valendo", async () => {
    // Contraprova do caso acima: o que muda é só a existência do registro.
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("dismissed", 100, ["Vinho"], ["Vinho"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);

    await recalculatePrivateMatches("dona", "dona@exemplo.com");

    expect(patchDoPar()?.status).toBe("pending");
    expect(estado.linhas.get(aiMatchSuggestions)![0].status).toBe("pending");
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("recalculatePrivateMatches — dois recálculos ao mesmo tempo reabrem o par UMA vez só", () => {
  const parDispensadoComRazaoNova = () => {
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("dismissed", 100, ["Vinho"], ["Vinho"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);
  };

  it("duas abas (ou 'Reanalisar' clicado duas vezes): um e-mail, uma reabertura", async () => {
    parDispensadoComRazaoNova();

    // As duas rodadas leem a MESMA linha dispensada antes de qualquer escrita
    // — é a corrida real: sem o status no WHERE, as duas reabriam e saíam
    // dois e-mails "1 nova(s) oportunidade(s)" para o mesmo par.
    await Promise.all([
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
    ]);

    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0]).toMatchObject({ subject: expect.stringContaining("1 nova(s) oportunidade(s)") });
    // Só uma das duas escritas mudou a linha; a outra não pôde reabrir nada.
    const reaberturas = atualizacoesDeSugestao().filter(a => a.valores.status === "pending");
    expect(reaberturas).toHaveLength(2);
    expect(reaberturas.map(a => a.afetadas).sort()).toEqual([0, 1]);
    expect(estado.linhas.get(aiMatchSuggestions)![0].status).toBe("pending");
  });

  it("quem perde a corrida não escreve nada, e o texto certo é o que a vencedora gravou", async () => {
    parDispensadoComRazaoNova();

    await Promise.all([
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
    ]);

    // A gravação de consolo repete a guarda de status, então ela também casa
    // zero linhas — e não precisa casar nenhuma: a vencedora calculou a MESMA
    // razão e já a gravou.
    const perdedor = atualizacoesDeSugestao().find(a => "matchScore" in a.valores && !("status" in a.valores));
    expect(perdedor).toBeDefined();
    expect(perdedor?.sql).toBe(
      "(`ai_match_suggestions`.`id` = ? and `ai_match_suggestions`.`owner_id` = ? and `ai_match_suggestions`.`status` = ?)"
    );
    expect(perdedor?.params).toEqual(["sugestao-1", "dona", "dismissed"]);
    expect(perdedor?.afetadas).toBe(0);
    expect(linhaGravada().reasonText).toBe("Ana possui Café, que Bia procura.");
    expect(linhaGravada().status).toBe("pending");
  });

  it("a dona ACEITA o par entre a leitura e a escrita: nada aterrissa, e o par não fica preso", async () => {
    // Revisão adversarial de 05/09: a reabertura casava zero linhas (certo),
    // mas a gravação de consolo escrevia mesmo assim — a linha ficava
    // "accepted" com o texto e as razões do Café, que a dona nunca viu. Pior:
    // no recálculo seguinte o Café já era a razão "antiga", a interseção
    // deixava de ser vazia e a reabertura NUNCA mais acontecia.
    parDispensadoComRazaoNova();
    estado.entreALeituraEAEscrita = () => { linhaGravada().status = "accepted"; linhaGravada().acceptedAt = 2000; };

    await recalculatePrivateMatches("dona", "dona@exemplo.com");

    expect(linhaGravada().status).toBe("accepted");
    expect(linhaGravada().reasonText).toBe("razão antiga");
    expect(linhaGravada().matchedAssets).toEqual([{ slug: "vinho", label: "Vinho" }]);
    expect(atualizacoesDeSugestao().every(a => a.afetadas === 0)).toBe(true);
    expect(email.sendEmail).not.toHaveBeenCalled();

    // E o par continua alcançável: a rodada seguinte lê o retrato de verdade
    // (aceito, razão "Vinho") e reabre por causa do Café.
    await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(linhaGravada().status).toBe("pending");
    expect(linhaGravada().reasonText).toBe("Ana possui Café, que Bia procura.");
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("o UPDATE de reabertura prende a linha à dona E ao status que foi lido — o WHERE inteiro", async () => {
    parDispensadoComRazaoNova();

    await recalculatePrivateMatches("dona", "dona@exemplo.com");

    const reabertura = atualizacoesDeSugestao().find(a => a.valores.status === "pending")!;
    expect(reabertura.sql).toBe(
      "(`ai_match_suggestions`.`id` = ? and `ai_match_suggestions`.`owner_id` = ? and `ai_match_suggestions`.`status` = ?)"
    );
    expect(reabertura.params).toEqual(["sugestao-1", "dona", "dismissed"]);
    expect(reabertura.afetadas).toBe(1);
  });

  it("recálculo repetido em SEQUÊNCIA não reabre de novo nem manda outro e-mail", async () => {
    parDispensadoComRazaoNova();

    await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    estado.atualizacoes = [];
    email.sendEmail.mockClear();

    // O par já está pendente e a razão é a mesma: a segunda rodada não tem o
    // que anunciar. Com o dublê antigo (que não gravava) isto era invisível.
    await recalculatePrivateMatches("dona", "dona@exemplo.com");
    expect(patchDoPar()).not.toHaveProperty("status");
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("a mesma subida de nota em duas abas é UM e-mail: quem escreve a nota é quem anuncia", async () => {
    // Par pendente de 60 que vira 100 pela mesma razão. As duas rodadas leem 60
    // e as duas achavam que tinham cruzado o limiar: a dona recebia dois
    // e-mails "1 nova(s) oportunidade(s)" pelo mesmo par.
    estado.linhas.set(aiMatchSuggestions, [linhaDoPar("pending", 60, ["Café especial"], ["Café"])]);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café", "Agro")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café", "Agro")]);

    await Promise.all([
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
    ]);

    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    const escritas = atualizacoesDeSugestao().filter(a => "matchScore" in a.valores);
    expect(escritas).toHaveLength(2);
    expect(escritas.map(a => a.afetadas).sort()).toEqual([0, 1]);
    expect(linhaGravada().matchScore).toBe(100);
    expect(linhaGravada().status).toBe("pending");
  });
});

describe("recalculatePrivateMatches — par NOVO descoberto por duas rodadas ao mesmo tempo", () => {
  const parNovo = () => {
    estado.linhas.set(aiMatchSuggestions, []);
    estado.linhas.set(contactAssets, [termo(1, ANA, "Café")]);
    estado.linhas.set(contactNeeds, [termo(2, BIA, "Café")]);
  };

  it("o segundo insert não derruba a rodada: uma linha, um e-mail, nenhum erro", async () => {
    // Salvar contato (`routers/network.ts`), o chat de enriquecimento e
    // "Reanalisar" noutra aba disparam o recálculo; as duas rodadas leem "não
    // existe" e as duas inserem. O índice único recusa a segunda, e como
    // `matches.addAsset` RETORNA o recálculo, o ER_DUP_ENTRY virava falha da
    // mutação na tela — com a tag já gravada e os pares seguintes sem calcular.
    parNovo();

    const [uma, outra] = await Promise.all([
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
    ]);

    expect(estado.inseridos).toHaveLength(2); // as duas tentaram inserir
    expect(estado.linhas.get(aiMatchSuggestions)).toHaveLength(1); // e existe uma linha só
    expect([uma.created, outra.created].sort()).toEqual([0, 1]);
    expect([uma.updated, outra.updated].sort()).toEqual([0, 1]);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(linhaGravada().reasonText).toBe("Ana possui Café, que Bia procura.");
  });

  it("o insert perdedor não rebaixa nem desmarca o par que a dona já decidiu", async () => {
    parNovo();
    // A dona dispensa o par na tela entre um insert e o outro. O insert que
    // perde a corrida só pode atualizar a razão: status, dismissed_at e
    // notified_at são decisão dela, e ficam fora do `set`.
    estado.aposInserir = () => {
      estado.aposInserir = null;
      Object.assign(linhaGravada(), { status: "dismissed", dismissedAt: 555, notifiedAt: 777 });
    };

    await Promise.all([
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
      recalculatePrivateMatches("dona", "dona@exemplo.com"),
    ]);

    expect(estado.linhas.get(aiMatchSuggestions)).toHaveLength(1);
    expect(linhaGravada().status).toBe("dismissed");
    expect(linhaGravada().dismissedAt).toBe(555);
    expect(linhaGravada().notifiedAt).toBe(777);
    expect(linhaGravada().reasonText).toBe("Ana possui Café, que Bia procura.");
  });

  it("falha de banco que NÃO é chave duplicada continua subindo: aquilo não é corrida", async () => {
    // Engolir tudo esconderia banco fora do ar atrás de um recálculo "bem
    // sucedido" — e o tratamento de `BancoIndisponivel` do tRPC nunca rodaria.
    parNovo();
    estado.falhaNoInsert = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });

    await expect(recalculatePrivateMatches("dona", "dona@exemplo.com")).rejects.toThrow("Failed query");
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
});

describe("o dublê de banco deste arquivo", () => {
  it("recusa a condição que não sabe aplicar, em vez de casar o que der", () => {
    // Um `or` casaria o começo do pedaço e o dublê aplicaria só a primeira
    // metade — voltaria a ser cego, e todo teste de WHERE aqui viraria enfeite.
    expect(() => condicaoDe(aiMatchSuggestions, or(
      eq(aiMatchSuggestions.status, "pending"),
      eq(aiMatchSuggestions.status, "viewed"),
    ))).toThrow(/não sabe aplicar/);
  });

  it("aplica as três formas que o match-service monta: =, >= e in (...)", () => {
    const { colunas, casa } = condicaoDe(aiMatchSuggestions, and(
      eq(aiMatchSuggestions.ownerId, "dona"),
      gte(aiMatchSuggestions.matchScore, 70),
      inArray(aiMatchSuggestions.status, ["pending", "viewed"]),
    ));
    expect(colunas).toEqual(["owner_id", "match_score", "status"]);
    expect(casa(linhaDoPar("pending", 100, [], []))).toBe(true);
    expect(casa(linhaDoPar("dismissed", 100, [], []))).toBe(false);
    expect(casa(linhaDoPar("pending", 60, [], []))).toBe(false);
    expect(casa({ ...linhaDoPar("pending", 100, [], []), ownerId: "outra" })).toBe(false);
  });
});
