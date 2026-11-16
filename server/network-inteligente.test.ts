import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Meu Network Inteligente — o resumo do painel, no drizzle real sobre um
 * cliente mysql2 falso que captura cada comando (molde de
 * match-em-analise.test.ts). O cliente responde pela tabela do FROM.
 *
 * O que se trava:
 * 1. Toda consulta leva o openId da dona no WHERE: nada atravessa donas.
 * 2. Sem o termo do Smart Match, ai_match_suggestions nem é lida e o painel
 *    recebe só { termoAceito: false } — nenhum número.
 * 3. Os números são os do banco: reuniões por status (a em exclusão fica de
 *    fora), duração das reuniões guardadas, contatos incompletos pela régua de
 *    shared/ e a amostra limitada, na ordem do banco.
 * 4. A leitura dos contatos traz só as colunas da régua: nunca notas, foto,
 *    cartão, redes, empresa ou cidade.
 * 5. O limite por reunião é o mesmo número que o servidor aplica ao gravar.
 */

const estado = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  /** Linhas (arrays, na ordem das colunas) por tabela do FROM. */
  respostas: {} as Record<string, unknown[][]>,
}));

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      estado.consultas.push({ sql: config.sql, params });
      const tabela = /from `([a-z_]+)`/i.exec(config.sql)?.[1] ?? "";
      return [estado.respostas[tabela] ?? [], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const hasValidConsent = vi.hoisted(() => vi.fn(async (_userId: number, _tipo: string) => false));
vi.mock("./routers/consent", () => ({ hasValidConsent }));

const { AMOSTRA_DE_INCOMPLETOS } = await import("./network-inteligente");
const { networkInteligenteRouter } = await import("./routers/networkInteligente");
const { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } = await import("@shared/const");

const DONA = "dona-9";
const ctx = {
  user: { id: 9, openId: DONA, email: "dona@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never;
const resumo = () => networkInteligenteRouter.createCaller(ctx).resumo();

// O preenchimento do ID anônimo (item 13 da spec de 14/09) roda antes do
// resumo e tem teste próprio abaixo e em network-codigo-anonimo.test.ts; as
// contagens daqui são as do resumo.
const ehPreenchimentoDoCodigo = (sql: string) => /`codigo_anonimo` is null/.test(sql);
const selects = () => estado.consultas.filter(c => /^\s*select/i.test(c.sql) && !ehPreenchimentoDoCodigo(c.sql));
const daTabela = (tabela: string) => selects().filter(c => new RegExp(`from \`${tabela}\``, "i").test(c.sql));

function bancoComDados() {
  estado.respostas = {
    // status, total — COUNT pode chegar como texto
    meetings: [["ready", 3], ["processing", 1], ["draft", "1"], ["failed", 2]],
    meeting_transcripts: [["1530"]],
    // id, fullName, phone, whatsapp, email — na ordem do banco (updatedAt desc)
    private_contacts: [
      [11, "Ana Completa", "+55 11 90000-0001", null, "ana@exemplo.com"],
      [12, "Bia Sem Telefone", null, null, "bia@exemplo.com"],
      [13, "Carla Só WhatsApp", null, "+55 21 90000-0003", "carla@exemplo.com"],
      [14, "Duda Sem Tenho", null, null, null],
      [15, "Eva Telefone Em Branco", "   ", null, "eva@exemplo.com"],
      [16, "Fabi Só Nome", null, null, null],
      [17, "Gil Só Nome", null, null, null],
      [18, "Hana Só Nome", null, null, null],
      [19, "Ivo Só Nome", null, null, null],
    ],
    contact_assets: [[11], [12], [13], [15]],
    contact_needs: [[11], [13], [14], [15]],
    ai_match_suggestions: [["pending", 2], ["viewed", 1], ["accepted", 1], ["dismissed", 5]],
  };
}

beforeEach(() => {
  estado.consultas = [];
  estado.respostas = {};
  hasValidConsent.mockReset();
  hasValidConsent.mockResolvedValue(false);
});

describe("networkInteligente.resumo — o termo do Smart Match decide se as sugestões entram", () => {
  it("sem o termo: ai_match_suggestions nem é lida e não há número de matches", async () => {
    bancoComDados();
    const r = await resumo();
    expect(hasValidConsent).toHaveBeenCalledWith(9, "termo_smart_match");
    expect(r.matchesInternos).toEqual({ termoAceito: false });
    expect(daTabela("ai_match_suggestions")).toEqual([]);
    // o resto do painel é dado da agenda e não depende do termo
    expect(r.contatos.total).toBe(9);
  });

  it("com o termo: conta as sugestões da dona; dispensada não entra no total", async () => {
    bancoComDados();
    hasValidConsent.mockResolvedValue(true);
    const r = await resumo();
    expect(r.matchesInternos).toEqual({ termoAceito: true, novos: 2, total: 4 });
    const [consulta] = daTabela("ai_match_suggestions");
    expect(consulta.sql).toContain("`ai_match_suggestions`.`owner_id` = ?");
    expect(consulta.sql).toMatch(/group by `ai_match_suggestions`.`status`/i);
    expect(consulta.params).toEqual([DONA]);
  });
});

describe("networkInteligente.resumo — tudo é da própria dona", () => {
  it("cada consulta filtra pelo openId da dona, e só por ele", async () => {
    bancoComDados();
    hasValidConsent.mockResolvedValue(true);
    await resumo();
    expect(selects()).toHaveLength(6);
    for (const consulta of selects()) {
      expect(consulta.params).toContain(DONA);
      expect(consulta.params.filter(p => typeof p === "string" && p !== DONA && p !== "deleted")).toEqual([]);
    }
    const [reunioes] = daTabela("meetings");
    expect(reunioes.sql).toContain("`meetings`.`owner_id` = ?");
    expect(reunioes.sql).toContain("`meetings`.`status` <> ?");
    expect(reunioes.params).toEqual([DONA, "deleted"]);

    const [duracao] = daTabela("meeting_transcripts");
    expect(duracao.sql).toMatch(/inner join `meetings` on `meetings`.`id` = `meeting_transcripts`.`meeting_id`/i);
    expect(duracao.sql).toContain("`meeting_transcripts`.`owner_id` = ?");
    expect(duracao.params).toEqual([DONA, DONA, "deleted"]);

    const [contatos] = daTabela("private_contacts");
    expect(contatos.sql).toContain("`private_contacts`.`ownerId` = ?");
    expect(contatos.params).toEqual([DONA]);

    for (const tabela of ["contact_assets", "contact_needs"]) {
      const [consulta] = daTabela(tabela);
      expect(consulta.sql).toMatch(/^select distinct/i);
      expect(consulta.sql).toContain(`\`${tabela}\`.\`owner_id\` = ?`);
      expect(consulta.params).toEqual([DONA]);
    }
  });

  it("a leitura dos contatos traz só as colunas da régua de completude", async () => {
    bancoComDados();
    await resumo();
    const [contatos] = daTabela("private_contacts");
    const colunas = contatos.sql.slice(0, contatos.sql.search(/ from /i));
    for (const proibida of ["notes", "photoUrl", "cardImageUrl", "cardOcrText", "linkedinUrl", "instagram", "company", "jobTitle", "city", "country", "profileTags", "nivel_visibilidade"]) {
      expect(colunas).not.toContain(`\`${proibida}\``);
    }
    for (const permitida of ["id", "fullName", "phone", "whatsapp", "email"]) {
      expect(colunas).toContain(`\`${permitida}\``);
    }
  });
});

describe("networkInteligente.resumo — o ID anônimo dos contatos antigos", () => {
  it("antes do resumo, preenche o ID anônimo só dos contatos desta dona que ainda não têm", async () => {
    bancoComDados();
    await resumo();
    const preenchimento = estado.consultas.filter(c => ehPreenchimentoDoCodigo(c.sql));
    expect(preenchimento.length).toBeGreaterThan(0);
    for (const consulta of preenchimento) {
      expect(consulta.sql).toContain("`private_contacts`.`ownerId` = ?");
      expect(consulta.params).toContain(DONA);
    }
  });
});

describe("networkInteligente.resumo — os números são os do banco", () => {
  it("reuniões por status, duração guardada e o limite que o servidor aplica (o da gravação em partes desde a G13b)", async () => {
    bancoComDados();
    const r = await resumo();
    expect(r.reunioes).toEqual({ total: 7, transcritas: 3, emAndamento: 2, comFalha: 2 });
    expect(r.minutos).toEqual({ segundosEmReunioesGuardadas: 1530, limitePorReuniaoSegundos: GRAVACAO_EM_PARTES_SEGUNDOS_MAX });
    expect(r.minutos.limitePorReuniaoSegundos).toBe(12 * 60 * 60);
  });

  it("incompletos pela régua de shared/, com a amostra limitada e na ordem do banco", async () => {
    bancoComDados();
    const r = await resumo();
    expect(r.contatos.total).toBe(9);
    // Ana e Carla (WhatsApp vale telefone) estão completas; as outras 7 não.
    expect(r.contatos.incompletos).toBe(7);
    // nenhum contato de teste marcou SIM para a rede global
    expect(r.contatos.disponibilizados).toBe(0);
    expect(AMOSTRA_DE_INCOMPLETOS).toBe(5);
    expect(r.contatos.amostraIncompletos).toEqual([
      { id: 12, fullName: "Bia Sem Telefone", faltando: ["telefone", "preciso"] },
      { id: 14, fullName: "Duda Sem Tenho", faltando: ["telefone", "email", "tenho"] },
      { id: 15, fullName: "Eva Telefone Em Branco", faltando: ["telefone"] },
      { id: 16, fullName: "Fabi Só Nome", faltando: ["telefone", "email", "tenho", "preciso"] },
      { id: 17, fullName: "Gil Só Nome", faltando: ["telefone", "email", "tenho", "preciso"] },
    ]);
  });

  it("contatos disponibilizados: conta os que têm SIM para a rede global, na mesma leitura dos contatos", async () => {
    estado.respostas = {
      // id, fullName, phone, whatsapp, email, disponivel_rede_global
      private_contacts: [[1, "Ana", null, null, null, 1], [2, "Bia", null, null, null, 0], [3, "Cris", null, null, null, true]],
    };
    const r = await resumo();
    expect(r.contatos.disponibilizados).toBe(2);
    expect(daTabela("private_contacts")).toHaveLength(1);
  });

  it("banco vazio: tudo zero, sem erro, e com o termo os matches também zeram", async () => {
    hasValidConsent.mockResolvedValue(true);
    const r = await resumo();
    expect(r).toEqual({
      reunioes: { total: 0, transcritas: 0, emAndamento: 0, comFalha: 0 },
      minutos: { segundosEmReunioesGuardadas: 0, limitePorReuniaoSegundos: 12 * 60 * 60 },
      contatos: { total: 0, incompletos: 0, disponibilizados: 0, amostraIncompletos: [] },
      matchesInternos: { termoAceito: true, novos: 0, total: 0 },
    });
  });
});
