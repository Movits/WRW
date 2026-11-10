import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Cartão "Não existe caminho para excluir os dados de uma usuária": o caminho
 * agora existe (server/exclusao-de-conta.ts + server/routers/conta.ts) e este
 * teste é o que impede que ele apodreça.
 *
 * Duas direções, as mesmas do teste da limpeza do exame:
 *
 * A) SCHEMA → PLANO. Toda coluna de usuária do `drizzle/schema.ts` tem de estar
 *    no plano, na lista de atores secundários preservados (com motivo escrito)
 *    ou na lista das que saem pelo id do pai. Tabela nova com `userId` deixa
 *    este teste vermelho até alguém decidir o que acontece com ela na exclusão
 *    — que é exatamente o buraco que o cartão descreve, só que em 2027.
 *
 * B) COMPORTAMENTO. `excluirConta` roda de verdade contra um banco falso que
 *    NÃO engole o WHERE: se um passo perder o `eq(ownerId, ...)`, o teste
 *    acusa, porque um DELETE sem a chave da conta apagaria a plataforma
 *    inteira. Também se prova a ordem (arquivo antes de linha, `users` por
 *    último) e que falha no bucket não aborta a exclusão.
 */

import {
  PLANO_DE_EXCLUSAO,
  ATORES_SECUNDARIOS_PRESERVADOS,
  COBERTAS_PELO_PAI,
  ACOES_DE_AUDITORIA_PRESERVADAS,
  nomeDoPasso,
  excluirConta,
  lerChavesDaConta,
  chavesDeArquivosDaConta,
  tirarDosGruposAlheios,
  MOTIVO_DA_PARTE_QUE_FICOU,
} from "./exclusao-de-conta";
import { COLUNAS_DE_USUARIA } from "../scripts/exame/limpeza.mjs";
import {
  contextMedia, dealRoomDocuments, dealRooms, loginAttempts, meetingAudioSlices, meetingRecordings,
  opportunities, opportunityMatches, privateContacts, sivcDocuments, sivcVerifications,
  strategicGroups, users,
} from "../drizzle/schema";

const AQUI: string = (import.meta as { dirname?: string }).dirname ?? path.dirname(fileURLToPath(import.meta.url));
const FONTE_SCHEMA = readFileSync(path.resolve(AQUI, "..", "drizzle", "schema.ts"), "utf8");

// Mesmos padrões do teste do exame: o "\n\}" fecha o objeto de colunas antes do
// bloco de índices, senão nome de índice entraria como coluna.
const RE_TABELA = /mysqlTable\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\n\}/g;
const RE_COLUNA = /^[ \t]+[A-Za-z_$][\w$]*:\s*(?:[A-Za-z_$][\w$]*)(?:<[^>]*>)?\(\s*"([^"]+)"/gm;

function paresDeUsuariaNoSchema(): { tabela: string; coluna: string }[] {
  const pares: { tabela: string; coluna: string }[] = [];
  for (const tabela of FONTE_SCHEMA.matchAll(RE_TABELA)) {
    if (tabela[1] === "users") continue; // a própria conta tem passo próprio
    for (const coluna of tabela[2].matchAll(RE_COLUNA)) {
      if (COLUNAS_DE_USUARIA.test(coluna[1])) pares.push({ tabela: tabela[1], coluna: coluna[1] });
    }
  }
  return pares;
}

const PARES = paresDeUsuariaNoSchema();
const noPlano = (tabela: string, coluna: string) =>
  PLANO_DE_EXCLUSAO.some(passo => nomeDoPasso(passo) === `${tabela}.${coluna}`);

// ═══════════════ A) schema → plano: nada de usuária fica sem decisão ═══════════
describe("A) toda coluna de usuária do schema tem destino declarado na exclusão", () => {
  it("o parse do schema encontra os pares esperados", () => {
    // Igualdade de propósito: subir é normal ao criar tabela, e o teste abaixo
    // exige que a coluna nova entre em uma das três listas.
    // 58: o distribuidor do Smart Match somou connections.moderatedBy.
    // 63: o Meu Network Inteligente somou network_sugestoes.owner_id,
    // conexoes_participantes.owner_id e .userId, consumo_de_minutos.owner_id e
    // assinaturas_de_minutos.userId.
    // 64: as partes do áudio da gravação longa somaram meeting_audio_slices.owner_id.
    expect(PARES).toHaveLength(64);
    expect(PARES).toContainEqual({ tabela: "meeting_audio_slices", coluna: "owner_id" });
    expect(PARES).toContainEqual({ tabela: "private_contacts", coluna: "ownerId" });
    expect(PARES).toContainEqual({ tabela: "gold_access_grants", coluna: "revokedBy" });
    expect(PARES).toContainEqual({ tabela: "deal_rooms", coluna: "interestedId" });
  });

  it.each(PARES)(
    "$tabela.$coluna está no plano, entre os atores preservados ou coberta pelo pai",
    ({ tabela, coluna }) => {
      const preservada = ATORES_SECUNDARIOS_PRESERVADOS.find(a => a.tabela === tabela && a.coluna === coluna);
      const pelosPai = COBERTAS_PELO_PAI.find(c => c.tabela === tabela && c.coluna === coluna);
      const destinos = [noPlano(tabela, coluna), Boolean(preservada), Boolean(pelosPai)].filter(Boolean);
      expect(destinos, `${tabela}.${coluna} não tem destino declarado na exclusão`).toHaveLength(1);
      if (preservada) expect(preservada.motivo.length).toBeGreaterThan(20);
      if (pelosPai) expect(noPlano(pelosPai.passo.split(" ")[0].split(".")[0], pelosPai.passo.split(" ")[0].split(".")[1])).toBe(true);
    },
  );

  it("a conta não sai pelo plano: `users` tem passo próprio, com as duas chaves", () => {
    expect(PLANO_DE_EXCLUSAO.some(passo => nomeDoPasso(passo).startsWith("users."))).toBe(false);
  });
});

// ═══════════════════════ A2) ordem: filha antes da mãe ════════════════════════
describe("A2) a ordem do plano não deixa órfão", () => {
  const indiceDe = (nome: string) => PLANO_DE_EXCLUSAO.findIndex(passo => nomeDoPasso(passo) === nome);

  it.each([
    ["deal_room_messages.dealRoomId", "deal_rooms.id"],
    ["deal_room_documents.dealRoomId", "deal_rooms.id"],
    ["nda_acceptances.dealRoomId", "deal_rooms.id"],
    ["sivc_checks.verificationId", "sivc_verifications.userId"],
    ["opportunity_matches.opportunityAId", "opportunities.publishedBy"],
    ["president_validations.opportunityId", "opportunities.publishedBy"],
    ["opportunity_documents.opportunityId", "opportunities.publishedBy"],
  ])("%s vem antes de %s", (filha, mae) => {
    expect(indiceDe(filha)).toBeGreaterThanOrEqual(0);
    expect(indiceDe(mae)).toBeGreaterThanOrEqual(0);
    expect(indiceDe(filha)).toBeLessThan(indiceDe(mae));
  });
});

// ═══════════════════════════ banco falso (executa) ════════════════════════════
// `condicao` é o WHERE inteiro, para os testes que o renderizam pelo dialeto.
type Delecao = { tabela: unknown; colunas: string[]; sql: string; condicao: unknown };
let delecoes: Delecao[] = [];
let atualizacoes: Array<{ tabela: unknown; valores: Record<string, unknown>; condicao?: unknown }> = [];
let linhasPorTabela: Map<unknown, unknown[]>;
let apagadosNoBucket: string[] = [];
let ordemDosEfeitos: string[] = [];
let bucketFalha: Set<string>;

/** Nomes de coluna citados numa condição do drizzle (mesma varredura de exclusao-e-nucleo). */
function colunasDe(condicao: unknown): string[] {
  const achadas: string[] = [];
  const visitados = new Set<unknown>();
  const visitar = (no: unknown) => {
    if (!no || typeof no !== "object" || visitados.has(no)) return;
    visitados.add(no);
    const alvo = no as Record<string, unknown>;
    if (typeof alvo.name === "string" && alvo.table) { achadas.push(alvo.name); return; }
    for (const valor of Object.values(alvo)) {
      if (Array.isArray(valor)) valor.forEach(visitar);
      else if (valor && typeof valor === "object") visitar(valor);
    }
  };
  visitar(condicao);
  return achadas;
}

/** Os literais de uma condição (para provar o filtro das ações preservadas). */
function textoDe(condicao: unknown): string {
  const partes: string[] = [];
  const visitados = new Set<unknown>();
  const visitar = (no: unknown) => {
    if (no === null || no === undefined) return;
    if (typeof no === "string" || typeof no === "number") { partes.push(String(no)); return; }
    if (typeof no !== "object" || visitados.has(no)) return;
    visitados.add(no);
    for (const valor of Object.values(no as Record<string, unknown>)) visitar(valor);
  };
  visitar(condicao);
  return partes.join(" ");
}

function selecionar(tabela: unknown) {
  const linhas = linhasPorTabela.get(tabela) ?? [];
  const resultado = Promise.resolve(linhas);
  return {
    where: () => resultado,
    then: resultado.then.bind(resultado),
  };
}

const fakeDb = {
  select: () => ({ from: (tabela: unknown) => selecionar(tabela) }),
  delete: (tabela: unknown) => ({
    where: async (condicao: unknown) => {
      delecoes.push({ tabela, colunas: colunasDe(condicao), sql: textoDe(condicao), condicao });
      ordemDosEfeitos.push("delete");
      return [{ affectedRows: (linhasPorTabela.get(tabela) ?? []).length || 1 }];
    },
  }),
  // O mysql2 devolve [ResultSetHeader, campos] também no UPDATE.
  update: (tabela: unknown) => ({
    set: (valores: Record<string, unknown>) => ({
      where: async (condicao?: unknown) => {
        atualizacoes.push({ tabela, valores, condicao });
        ordemDosEfeitos.push("update");
        return [{ affectedRows: 1 }];
      },
    }),
  }),
} as never;

/** O WHERE renderizado pelo dialeto do MySQL, sem banco: texto e parâmetros. */
const dialeto = new MySqlDialect();
const renderizar = (condicao: unknown) => {
  const { sql: texto, params } = dialeto.sqlToQuery(condicao as SQL);
  return { sql: texto, params };
};

const apagarArquivo = async (chave: string) => {
  ordemDosEfeitos.push("bucket");
  if (bucketFalha.has(chave)) throw new Error("bucket recusou");
  apagadosNoBucket.push(chave);
};

const CONTA = { id: 7, openId: "open-7", email: "Dona@Exemplo.com " };

beforeEach(() => {
  delecoes = [];
  atualizacoes = [];
  apagadosNoBucket = [];
  ordemDosEfeitos = [];
  bucketFalha = new Set();
  linhasPorTabela = new Map<unknown, unknown[]>([
    [opportunities, [{ id: 101 }, { id: 102 }]],
    [dealRooms, [{ id: 55 }]],
    [sivcVerifications, [{ id: 9 }]],
    [privateContacts, [{ foto: "/manus-storage/contacts/open-7/foto.jpg", cartao: null }]],
    [contextMedia, [{ caminho: "contexts/open-7/ctx/imagem.png", miniatura: "contexts/open-7/ctx/mini.png" }]],
    [meetingRecordings, [{ chave: "meetings/open-7/reuniao-1/recording.webm" }]],
    // A segunda parte vem com o prefixo do proxy: a chave conferida é a mesma
    // sem ele, e é por ela que o bucket é chamado.
    [meetingAudioSlices, [
      { id: "parte-1", chave: "meetings/open-7/reuniao-2/partes/0_aaaa.mp4" },
      { id: "parte-2", chave: "/manus-storage/meetings/open-7/reuniao-2/partes/1_bbbb.mp4" },
    ]],
    [sivcDocuments, [{ chave: "sivc/7/9/1234-rg.png" }]],
    [dealRoomDocuments, [{ chave: "deal-rooms/55/1234-planilha.xlsx", sala: 55 }]],
    [strategicGroups, [
      { id: 1, membros: [7, 8] },
      { id: 2, membros: [8, 9] },
    ]],
  ]);
});

// ══════════════════════ B) comportamento, executado ═══════════════════════════
describe("B) excluirConta apaga o que é da conta, na ordem, e nada além", () => {
  it("lê as chaves do pai antes de apagar (oportunidades, salas, verificações)", async () => {
    const chaves = await lerChavesDaConta(fakeDb, CONTA);
    expect(chaves).toMatchObject({
      id: 7, openId: "open-7", email: "dona@exemplo.com",
      oportunidades: [101, 102], salas: [55], verificacoes: [9],
    });
  });

  it("todo DELETE cita a chave da conta ou o id de um pai dela", async () => {
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(delecoes.length).toBeGreaterThan(40);
    for (const delecao of delecoes) {
      expect(delecao.colunas.length, `DELETE sem WHERE em ${String(delecao.sql).slice(0, 40)}`).toBeGreaterThan(0);
    }
  });

  it("`users` é o último DELETE e exige id E openId", async () => {
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    const ultima = delecoes[delecoes.length - 1];
    expect(ultima.tabela).toBe(users);
    expect(ultima.colunas).toContain("id");
    expect(ultima.colunas).toContain("openId");
  });

  it("os arquivos saem antes da primeira linha do banco", async () => {
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(ordemDosEfeitos.indexOf("bucket")).toBeGreaterThanOrEqual(0);
    expect(ordemDosEfeitos.indexOf("bucket")).toBeLessThan(ordemDosEfeitos.indexOf("delete"));
  });

  it("falha no bucket não aborta a exclusão: volta no relatório e as linhas saem", async () => {
    bucketFalha.add("sivc/7/9/1234-rg.png");
    const relatorio = await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(relatorio.arquivosComFalha).toEqual(["sivc/7/9/1234-rg.png"]);
    expect(relatorio.arquivosApagados).toBeGreaterThan(0);
    expect(delecoes[delecoes.length - 1].tabela).toBe(users);
  });

  it("o passo de audit_logs preserva as duas ações da decisão de 02/09", async () => {
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    const auditoria = delecoes.find(d => d.colunas.includes("action"));
    expect(auditoria, "nenhum DELETE em audit_logs com filtro por ação").toBeDefined();
    for (const acao of ACOES_DE_AUDITORIA_PRESERVADAS) {
      expect(auditoria!.sql).toContain(acao);
    }
  });

  it("conta sem e-mail não apaga login_attempts (o identifier é o e-mail)", async () => {
    await excluirConta(fakeDb, { ...CONTA, email: null }, { apagarArquivo });
    expect(delecoes.some(d => d.tabela === loginAttempts)).toBe(false);
    const comEmail = (delecoes = [], await excluirConta(fakeDb, CONTA, { apagarArquivo }), delecoes);
    expect(comEmail.some(d => d.tabela === loginAttempts)).toBe(true);
  });

  it("sem oportunidade publicada, os passos das oportunidades são pulados", async () => {
    linhasPorTabela.set(opportunities, []);
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(delecoes.some(d => d.tabela === opportunityMatches)).toBe(false);
  });

  it("a notificação da SALA também sai, e não só a da oportunidade", async () => {
    // Achado da revisão de 12/09: a notificação de mensagem nova guarda os 100
    // primeiros caracteres do texto escrito na sala. Se ela ficasse, o conteúdo
    // continuaria legível para a contraparte depois da conta apagada.
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    const daUrl = delecoes.find(d => d.colunas.includes("actionUrl"));
    expect(daUrl, "nenhum DELETE por actionUrl").toBeDefined();
    expect(daUrl!.sql).toContain("/deal-room/55");
    expect(daUrl!.sql).toContain("/opportunities/101");
  });

  it("o relatório soma as linhas e nomeia os passos", async () => {
    const relatorio = await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(relatorio.linhasApagadas).toBeGreaterThan(0);
    expect(relatorio.passos.map(p => p.nome)).toContain("users.id + users.openId");
    expect(relatorio.passos.every(p => p.linhas > 0)).toBe(true);
  });
});

// ═════════════ B2) arquivo só sai quando a chave prova a posse ════════════════
describe("B2) chave de bucket sem prova de posse não é apagada", () => {
  it("colhe as chaves da própria dona", async () => {
    const chaves = await lerChavesDaConta(fakeDb, CONTA);
    const arquivos = await chavesDeArquivosDaConta(fakeDb, chaves);
    expect(arquivos).toEqual([
      "contacts/open-7/foto.jpg",
      "contexts/open-7/ctx/imagem.png",
      "contexts/open-7/ctx/mini.png",
      "meetings/open-7/reuniao-1/recording.webm",
      "meetings/open-7/reuniao-2/partes/0_aaaa.mp4",
      "meetings/open-7/reuniao-2/partes/1_bbbb.mp4",
      "sivc/7/9/1234-rg.png",
      "deal-rooms/55/1234-planilha.xlsx",
    ]);
  });

  it("chave de outra dona, de outro id ou de outra sala é ignorada", async () => {
    linhasPorTabela.set(privateContacts, [{ foto: "contacts/open-OUTRA/foto.jpg", cartao: "/etc/passwd" }]);
    linhasPorTabela.set(contextMedia, [{ caminho: "contexts/open-OUTRA/x.png", miniatura: null }]);
    linhasPorTabela.set(meetingRecordings, [{ chave: "meetings/open-OUTRA/r/recording.webm" }]);
    linhasPorTabela.set(meetingAudioSlices, [
      { id: "parte-x", chave: "meetings/open-OUTRA/r/partes/0_x.mp4" },
      { id: "parte-y", chave: "contexts/open-7/nao-e-reuniao.mp4" },
    ]);
    linhasPorTabela.set(sivcDocuments, [{ chave: "sivc/999/9/rg.png" }]);
    linhasPorTabela.set(dealRoomDocuments, [{ chave: "deal-rooms/999/doc.pdf", sala: 55 }]);
    const chaves = await lerChavesDaConta(fakeDb, CONTA);
    expect(await chavesDeArquivosDaConta(fakeDb, chaves)).toEqual([]);
  });

  it("a mesma chave repetida em duas linhas é apagada uma vez", async () => {
    linhasPorTabela.set(privateContacts, [
      { foto: "contacts/open-7/foto.jpg", cartao: null },
      { foto: "contacts/open-7/foto.jpg", cartao: null },
    ]);
    const chaves = await lerChavesDaConta(fakeDb, CONTA);
    const arquivos = await chavesDeArquivosDaConta(fakeDb, chaves);
    expect(arquivos.filter(c => c === "contacts/open-7/foto.jpg")).toHaveLength(1);
  });
});

// ════════════ B3) grupo estratégico de outra pessoa: sai da lista ═════════════
describe("B3) a conta sai da lista de membros dos grupos alheios", () => {
  it("tira o id dela e não mexe em grupo que não a tem", async () => {
    const alterados = await tirarDosGruposAlheios(fakeDb, 7);
    expect(alterados).toBe(1);
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0].tabela).toBe(strategicGroups);
    expect(atualizacoes[0].valores).toEqual({ memberIds: [8] });
  });

  it("lista com o id em texto (JSON do Manus) também sai", async () => {
    linhasPorTabela.set(strategicGroups, [{ id: 3, membros: ["7", "8"] }]);
    await tirarDosGruposAlheios(fakeDb, 7);
    expect(atualizacoes[0].valores).toEqual({ memberIds: ["8"] });
  });

  it("memberIds nulo não vira array vazio", async () => {
    linhasPorTabela.set(strategicGroups, [{ id: 4, membros: null }]);
    expect(await tirarDosGruposAlheios(fakeDb, 7)).toBe(0);
    expect(atualizacoes).toHaveLength(0);
  });
});

// ═══ B4) falha do bucket: a conta sai, mas ninguém finge que deu tudo certo ═══
// Achado do Nicolas, 14/09: o comentário prometia que uma falha no bucket
// "deixa a conta de pé e a dona tenta outra vez", e o código fazia o contrário —
// apagava o banco assim mesmo e a tela dizia "sua conta e seus dados foram
// excluídos". A decisão é continuar apagando (a dona PEDIU a exclusão; parar no
// meio deixaria o dado pessoal no banco), mas relatar com honestidade: as chaves
// que ficaram no bucket são o ÚNICO ponteiro que sobra para os objetos órfãos,
// porque as linhas que as citavam já saíram.
describe("B4) o bucket que recusa não é engolido", () => {
  it("o log nomeia cada chave que ficou e diz que a conta foi apagada assim mesmo", async () => {
    bucketFalha.add("contacts/open-7/foto.jpg");
    bucketFalha.add("sivc/7/9/1234-rg.png");
    const linhasDeLog: string[] = [];
    const espiao = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      linhasDeLog.push(args.map(String).join(" "));
    });
    let relatorio;
    try {
      relatorio = await excluirConta(fakeDb, CONTA, { apagarArquivo });
    } finally {
      espiao.mockRestore();
    }

    // O relatório continua nomeando as chaves, e a conta sai assim mesmo.
    expect(relatorio.arquivosComFalha).toEqual(["contacts/open-7/foto.jpg", "sivc/7/9/1234-rg.png"]);
    expect(delecoes[delecoes.length - 1].tabela).toBe(users);

    const resumo = linhasDeLog.find(l => l.includes("ficaram no bucket"));
    expect(resumo, "nenhuma linha de log resume o que sobrou no bucket").toBeDefined();
    for (const chave of relatorio.arquivosComFalha) expect(resumo!).toContain(chave);
    expect(resumo!).toContain("userId 7");
    expect(resumo!).toMatch(/conta foi apagada assim mesmo/i);
  });

  it("sem falha nenhuma, não há linha de log inventando problema", async () => {
    const linhasDeLog: string[] = [];
    const espiao = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      linhasDeLog.push(args.map(String).join(" "));
    });
    try {
      await excluirConta(fakeDb, CONTA, { apagarArquivo });
    } finally {
      espiao.mockRestore();
    }
    expect(linhasDeLog.filter(l => l.includes("ficaram no bucket"))).toEqual([]);
  });
});

// ═══ B5) o aviso chega até a tela, em vez de morrer no relatório ══════════════
// Leitura de fonte (o mesmo método do teste da carga de participantes): o que se
// prova aqui é o CONTRATO entre as três camadas, que nenhum teste de unidade
// sozinho cobre — relatório → router → tela.
describe("B5) a tela não diz 'excluídos' quando um arquivo ficou para trás", () => {
  const ler = (...partes: string[]) => readFileSync(path.resolve(AQUI, "..", ...partes), "utf8");
  const FONTE_ROUTER = ler("server", "routers", "conta.ts");
  const FONTE_TELA = ler("client", "src", "components", "ExcluirMinhaConta.tsx");

  it("o router devolve a contagem de arquivos com falha para a tela", () => {
    const retorno = FONTE_ROUTER.slice(FONTE_ROUTER.lastIndexOf("return {"));
    expect(retorno).toContain("arquivosComFalha");
  });

  it("a tela olha arquivosComFalha antes de escolher a mensagem", () => {
    expect(
      FONTE_TELA.includes("arquivosComFalha"),
      "a tela diz sucesso sem olhar o que ficou no bucket",
    ).toBe(true);
  });

  it("existe um texto próprio para o caso de arquivo pendente, e ele não é o de sucesso", () => {
    expect(FONTE_TELA).toContain("conta.excluir.sucessoComPendencias");
    // O toast de sucesso puro continua existindo, mas agora é um ramo.
    expect(FONTE_TELA).toContain("conta.excluir.sucesso\"");
  });
});

// ═══ B6) parte do áudio de reunião: a linha só sai se o objeto saiu ══════════
// Correção da revisão do desenho do gravador (G3): apagar a linha da parte cujo
// objeto o bucket recusou deixaria a voz de quem participou no bucket sem
// ponteiro nenhum, e a conta já não existe para pedir de novo. A linha fica, mas
// só como ponteiro: sem a transcrição, fora da fila e já vencida.
describe("B6) a parte de áudio cujo objeto ficou no bucket fica, só como ponteiro", () => {
  const PARTE_1 = "meetings/open-7/reuniao-2/partes/0_aaaa.mp4";
  const PARTE_2 = "meetings/open-7/reuniao-2/partes/1_bbbb.mp4";
  const delecaoDasPartes = () => delecoes.filter(d => d.tabela === meetingAudioSlices);
  const atualizacoesDasPartes = () => atualizacoes.filter(a => a.tabela === meetingAudioSlices);

  it("o bucket recusou a parte 1: o DELETE das partes deixa só ela de fora", async () => {
    bucketFalha.add(PARTE_1);
    const relatorio = await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(relatorio.arquivosComFalha).toEqual([PARTE_1]);
    expect(apagadosNoBucket).toContain(PARTE_2);
    expect(delecaoDasPartes()).toHaveLength(1);
    expect(renderizar(delecaoDasPartes()[0].condicao)).toEqual({
      sql: "(`meeting_audio_slices`.`owner_id` = ? and `meeting_audio_slices`.`id` not in (?))",
      params: ["open-7", "parte-1"],
    });
  });

  it("a parte que fica perde a transcrição, sai da fila e vence na hora", async () => {
    bucketFalha.add(PARTE_1);
    const antes = Date.now();
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(atualizacoesDasPartes()).toHaveLength(1);
    const [ponteiro] = atualizacoesDasPartes();
    expect(ponteiro.valores).toMatchObject({
      status: "failed", lastError: MOTIVO_DA_PARTE_QUE_FICOU,
      result: null, lockedUntil: null, lockToken: null,
    });
    expect(ponteiro.valores.expiresAt).toBeGreaterThanOrEqual(antes);
    expect(ponteiro.valores.expiresAt).toBeLessThanOrEqual(Date.now());
    // Só a linha DELA, e só a que ficou.
    expect(renderizar(ponteiro.condicao)).toEqual({
      sql: "(`meeting_audio_slices`.`owner_id` = ? and `meeting_audio_slices`.`id` in (?))",
      params: ["open-7", "parte-1"],
    });
  });

  it("a linha gravada com o prefixo do proxy também é reconhecida (casa pelo id, não pela chave)", async () => {
    bucketFalha.add(PARTE_2);
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(renderizar(delecaoDasPartes()[0].condicao).params).toEqual(["open-7", "parte-2"]);
    expect(renderizar(atualizacoesDasPartes()[0].condicao).params).toEqual(["open-7", "parte-2"]);
  });

  it("o ponteiro é gravado depois do bucket e antes do primeiro DELETE", async () => {
    bucketFalha.add(PARTE_1);
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    const ponteiro = ordemDosEfeitos.indexOf("update");
    expect(ponteiro).toBeGreaterThan(ordemDosEfeitos.lastIndexOf("bucket"));
    expect(ponteiro).toBeLessThan(ordemDosEfeitos.indexOf("delete"));
  });

  it("o relatório nomeia o passo do ponteiro", async () => {
    bucketFalha.add(PARTE_1);
    const relatorio = await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(relatorio.passos.map(p => p.nome)).toContain("meeting_audio_slices (ponteiro, UPDATE)");
  });

  it("sem falha de áudio, todas as partes saem e nenhuma vira ponteiro", async () => {
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(apagadosNoBucket).toEqual(expect.arrayContaining([PARTE_1, PARTE_2]));
    expect(atualizacoesDasPartes()).toEqual([]);
    expect(renderizar(delecaoDasPartes()[0].condicao)).toEqual({
      sql: "`meeting_audio_slices`.`owner_id` = ?",
      params: ["open-7"],
    });
  });

  it("falha em outro arquivo, inclusive na gravação inteira da reunião, não segura parte nenhuma", async () => {
    bucketFalha.add("sivc/7/9/1234-rg.png");
    bucketFalha.add("meetings/open-7/reuniao-1/recording.webm");
    await excluirConta(fakeDb, CONTA, { apagarArquivo });
    expect(atualizacoesDasPartes()).toEqual([]);
    expect(renderizar(delecaoDasPartes()[0].condicao).params).toEqual(["open-7"]);
  });
});

// ═════════ C) o SQL que sai de cada passo (sem conectar em banco nenhum) ══════
// Esta máquina não tem MySQL local nem Docker, e o `.env` de trabalho aponta
// para a PRODUÇÃO: não há como rodar a exclusão de ponta a ponta aqui sem
// apagar conta de gente. O que dá para provar sem conexão é o SQL: o drizzle
// monta o comando com os nomes reais do schema, e `toSQL()` devolve texto e
// parâmetros sem tocar na rede (o pool do mysql2 só conecta na primeira query).
describe("C) cada passo gera um DELETE parametrizado com a coluna certa", () => {
  // Host inexistente de propósito: se algum dia este teste tentar conectar, ele
  // falha na hora em vez de falar com um banco de verdade.
  const db = drizzle("mysql://ninguem:ninguem@127.0.0.1:1/banco-que-nao-existe");
  const chaves = {
    id: 7, openId: "open-7", email: "dona@exemplo.com",
    oportunidades: [101, 102], salas: [55], verificacoes: [9],
  };
  const valores: Record<string, (string | number)[]> = {
    id: [chaves.id], openId: [chaves.openId], email: [chaves.email],
    oportunidades: chaves.oportunidades, salas: chaves.salas, verificacoes: chaves.verificacoes,
  };

  it.each(PLANO_DE_EXCLUSAO.map(passo => [nomeDoPasso(passo), passo] as const))(
    "%s",
    (nome, passo) => {
      const lista = valores[passo.origem];
      const condicoes = [lista.length === 1 ? eq(passo.coluna, lista[0]) : inArray(passo.coluna, lista)];
      const extra = passo.filtro?.(chaves as never);
      if (extra) condicoes.push(extra);
      const { sql: texto, params } = db.delete(passo.tabela).where(and(...condicoes)).toSQL();
      const [tabela, coluna] = nome.split(".");
      expect(texto).toMatch(/^delete from `/);
      expect(texto).toContain("`" + tabela + "`");
      expect(texto).toContain("`" + coluna + "`");
      // Parametrizado: nenhum valor da conta entra no texto do comando.
      expect(texto).not.toContain("open-7");
      expect(texto).not.toContain("dona@exemplo.com");
      expect(params.length).toBeGreaterThanOrEqual(lista.length);
    },
  );

  it("o passo de audit_logs preserva as duas ações, com placeholder para cada uma", () => {
    const passo = PLANO_DE_EXCLUSAO.find(p => nomeDoPasso(p) === "audit_logs.userId")!;
    const { sql: texto, params } = db.delete(passo.tabela)
      .where(and(eq(passo.coluna, 7), passo.filtro!(chaves as never)!)).toSQL();
    expect(texto).toMatch(/`action` NOT IN \(\?, \?\)/i);
    expect(params).toEqual([7, ...ACOES_DE_AUDITORIA_PRESERVADAS]);
  });

  it("o passo das partes de áudio só filtra com o contexto do bucket, e com parâmetro para cada parte que fica", () => {
    const passo = PLANO_DE_EXCLUSAO.find(p => nomeDoPasso(p) === "meeting_audio_slices.owner_id")!;
    expect(passo.filtro!(chaves as never)).toBeUndefined();
    expect(passo.filtro!(chaves as never, { fatiasQueFicam: [] })).toBeUndefined();
    const { sql: texto, params } = db.delete(passo.tabela)
      .where(and(eq(passo.coluna, "open-7"), passo.filtro!(chaves as never, { fatiasQueFicam: ["parte-1", "parte-2"] })!)).toSQL();
    expect(texto).toContain("`meeting_audio_slices`.`id` not in (?, ?)");
    expect(params).toEqual(["open-7", "parte-1", "parte-2"]);
  });

  it("a conta sai com as duas chaves no mesmo WHERE", () => {
    const { sql: texto, params } = db.delete(users)
      .where(and(eq(users.id, 7), eq(users.openId, "open-7"))).toSQL();
    expect(texto).toContain("`id` = ?");
    expect(texto).toContain("`openId` = ?");
    expect(params).toEqual([7, "open-7"]);
  });
});
