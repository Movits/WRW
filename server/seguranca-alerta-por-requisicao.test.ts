/**
 * Os quatro defeitos do alerta de segurança, achados em 12/09/2026 na auditoria
 * da faxina do banco de produção.
 *
 * O sintoma: 851 eventos de segurança não resolvidos, gerados por 26 contas de
 * TESTE em treze dias — 678 deles do tipo "multiple_sessions", todos dizendo o
 * mesmo "10 sessões simultâneas detectadas".
 *
 * As quatro causas, cada uma com um teste aqui:
 *
 * A) A contagem de sessões incluía sessão VENCIDA. O filtro pedia `isActive`
 *    e atividade nas últimas 24 h, e não pedia validade. Como
 *    `cleanupExpiredSessions` só roda quando alguém abre o painel, havia 80
 *    sessões vencidas ainda marcadas como ativas no Aiven.
 * B) O número relatado era SEMPRE 10, porque vinha do `.length` de uma consulta
 *    com `.limit(10)` — e por isso o ramo "crítico a partir de 20" era
 *    inalcançável por construção.
 * C) Não havia dedupe: a mesma condição virava linha nova a cada requisição.
 * D) O bloqueio automático era reavaliado em TODA requisição autenticada, num
 *    SELECT que entre dois eventos críticos só podia devolver o mesmo de antes.
 *
 * ---
 *
 * Revisão do Nicolas em 14/09/2026, com a PR #102 já em produção, achou mais
 * três — todas no mesmo caminho, todas testadas aqui:
 *
 * E) A dedupe de C não era ATÔMICA: um SELECT e um INSERT, com uma ida e volta
 *    ao banco entre eles. Requisições simultâneas da mesma conta liam "não
 *    existe" antes de qualquer uma gravar, e a mesma condição virava várias
 *    linhas — linha crítica repetida empurra a conta para o bloqueio automático.
 * F) `multiple_sessions` alimentava a contagem do bloqueio automático. Ele nasce
 *    CRÍTICO a partir de 20 sessões simultâneas, e 20 sessões é a Rede aberta
 *    com muitas fotos: uma conta Prata ou Ouro se autobloqueava sozinha.
 * G) O UPDATE que desativa a conta não tinha condição de estado. Ele "dava
 *    certo" sempre, então cada novo evento crítico dentro da janela regravava o
 *    mesmo `account_locked`, com aviso no sino e linha de auditoria, numa conta
 *    que já estava bloqueada.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTableName } from "drizzle-orm";

type Linha = Record<string, unknown>;

const estado = {
  sessoes: [] as Linha[],
  totalDeSessoes: 0,
  jaExisteEventoIgual: false,
  inseridos: [] as { tabela: string; valores: Linha }[],
  atualizacoes: [] as { tabela: string; valores: Linha; condicao: unknown }[],
  consultas: [] as string[],
  condicaoDasSessoes: null as unknown,
  condicaoDosCriticos: null as unknown,
  /** Linhas devolvidas para a contagem de eventos críticos do bloqueio automático. */
  eventosCriticosNaJanela: [] as Linha[],
  /** Quantas linhas o UPDATE de `users` alcança: 0 = a conta já estava bloqueada. */
  linhasNoUpdateDeUsuarias: 1,
  usuaria: { isActive: true, role: "silver" } as Linha,
};

/** Nomes de coluna citados numa condição do Drizzle, em qualquer profundidade. */
function colunasCitadas(no: unknown, achadas = new Set<string>()): Set<string> {
  if (!no || typeof no !== "object") return achadas;
  const obj = no as Record<string, unknown>;
  if (typeof obj.name === "string" && obj.table) achadas.add(obj.name);
  const pedacos = (obj.queryChunks ?? obj.chunks) as unknown[] | undefined;
  if (Array.isArray(pedacos)) for (const p of pedacos) colunasCitadas(p, achadas);
  return achadas;
}

/**
 * Valores parametrizados de um comando (ou condição) do Drizzle, na ordem em que
 * aparecem. Num literal `sql` o valor fica cru entre os pedaços de texto; num
 * operador (`eq`, `notInArray`) ele vem embrulhado num `Param`. O que é
 * instância de classe do Drizzle sem valor dentro — `StringChunk`, coluna,
 * tabela, `Name` — não é valor e fica de fora.
 */
function valoresDe(no: unknown, achados: unknown[] = []): unknown[] {
  const pedacos = (no as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(pedacos)) return achados;
  for (const p of pedacos) juntarValor(p, achados);
  return achados;
}

function juntarValor(pedaco: unknown, achados: unknown[]) {
  if (Array.isArray(pedaco)) {
    for (const item of pedaco) juntarValor(item, achados);
    return;
  }
  if (pedaco !== null && typeof pedaco === "object" && !(pedaco instanceof Date)) {
    const obj = pedaco as Record<string, unknown>;
    if (obj.queryChunks) return void valoresDe(pedaco, achados);
    if ("encoder" in obj && "value" in obj) return void achados.push(obj.value); // Param
    if (Object.getPrototypeOf(pedaco) === Object.prototype) return void achados.push(pedaco);
    return; // StringChunk, coluna, tabela ou identificador
  }
  achados.push(pedaco);
}

vi.mock("./db", () => ({
  exigirDb: async () => ({
    select: (campos?: Record<string, unknown>) => ({
      from: (tabela: unknown) => {
        const nome = getTableName(tabela as never);
        const ehContagem = !!campos && "n" in campos;
        return {
          where: (condicao: unknown) => {
            estado.consultas.push(`${nome}:${ehContagem ? "contagem" : "linhas"}`);
            if (nome === "sessions" && !ehContagem) estado.condicaoDasSessoes = condicao;
            if (nome === "security_events" && !ehContagem) estado.condicaoDosCriticos = condicao;
            const resolver = (r: (linhas: Linha[]) => unknown) => {
              if (ehContagem) return r([{ n: estado.totalDeSessoes }]);
              if (nome === "security_events") return r(estado.eventosCriticosNaJanela);
              return r([]);
            };
            return {
              orderBy: () => ({ limit: async (n: number) => estado.sessoes.slice(0, n) }),
              limit: async () => (nome === "users" ? [estado.usuaria] : []),
              then: resolver,
            };
          },
        };
      },
    }),
    insert: (tabela: unknown) => ({
      values: async (valores: Linha) => {
        estado.inseridos.push({ tabela: getTableName(tabela as never), valores });
      },
    }),
    update: (tabela: unknown) => ({
      set: (valores: Linha) => ({
        where: async (condicao: unknown) => {
          const nome = getTableName(tabela as never);
          estado.atualizacoes.push({ tabela: nome, valores, condicao });
          return [{ affectedRows: nome === "users" ? estado.linhasNoUpdateDeUsuarias : 1 }];
        },
      }),
    }),
    /**
     * O `insert ... select ... where not exists` da dedupe, e é de propósito que
     * este corpo não tenha nenhum `await`: decidir e gravar acontecem no MESMO
     * passo, que é justamente o que um comando único garante ao banco e o par
     * SELECT+INSERT não garantia.
     *
     * Os oito valores chegam na ordem em que o comando os escreve: userId,
     * eventType, severity, ipAddress e details da linha nova; userId, eventType
     * e o início da janela da subconsulta.
     */
    execute: async (comando: unknown) => {
      const valores = valoresDe(comando);
      if (valores.length !== 8) {
        throw new Error(`comando inesperado em execute: ${valores.length} valores, esperava 8`);
      }
      const [userId, eventType, severity, ipAddress, details] = valores;
      const jaTem =
        estado.jaExisteEventoIgual ||
        estado.inseridos.some(
          l => l.tabela === "security_events" && l.valores.userId === userId && l.valores.eventType === eventType,
        );
      if (jaTem) return [{ affectedRows: 0 }];
      estado.inseridos.push({
        tabela: "security_events",
        valores: {
          userId,
          eventType,
          severity,
          ipAddress,
          details: typeof details === "string" ? JSON.parse(details) : details,
          resolved: false,
        },
      });
      return [{ affectedRows: 1 }];
    },
  }),
}));

const { detectSessionAnomaly, createSecurityEvent, lockUserAccount } = await import("./security");

const IP = "200.100.50.1";

function sessao(i: number): Linha {
  return {
    id: i,
    userId: 1,
    ipAddress: IP,
    deviceFingerprint: "impressao-" + i,
    lastActivityAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
    isActive: true,
  };
}

function eventosGravados() {
  return estado.inseridos.filter(l => l.tabela === "security_events").map(l => l.valores);
}

/** As linhas de risco alto "novo IP e novo dispositivo" que foram para audit_logs. */
function acessosSuspeitos() {
  return estado.inseridos.filter(l => l.tabela === "audit_logs" && l.valores.action === "SUSPICIOUS_ACCESS").map(l => l.valores);
}

beforeEach(() => {
  estado.sessoes = [];
  estado.totalDeSessoes = 0;
  estado.jaExisteEventoIgual = false;
  estado.inseridos = [];
  estado.atualizacoes = [];
  estado.consultas = [];
  estado.condicaoDasSessoes = null;
  estado.condicaoDosCriticos = null;
  estado.eventosCriticosNaJanela = [];
  estado.linhasNoUpdateDeUsuarias = 1;
  estado.usuaria = { isActive: true, role: "silver" };
});

const JANELA = 30 * 60 * 1000;
/** Uma janela cheia: um a menos que isso não bloqueia ninguém (o limite é 20). */
function janelaCheiaDeCriticos() {
  return Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
}
function contasDesativadas() {
  return estado.atualizacoes.filter(a => a.tabela === "users" && a.valores.isActive === false);
}

// ═══ A) sessão vencida não pode contar ═══════════════════════════════════════
describe("A) a busca de sessões simultâneas exige sessão NÃO VENCIDA", () => {
  it("a condição cita expiresAt, e não só isActive", async () => {
    estado.sessoes = [sessao(1)];
    await detectSessionAnomaly(1, IP, "navegador-de-teste");

    const colunas = colunasCitadas(estado.condicaoDasSessoes);
    expect(colunas.has("isActive"), "o filtro perdeu o isActive").toBe(true);
    expect(
      colunas.has("expiresAt"),
      "sem expiresAt no filtro, sessão vencida volta a contar como simultânea — foi o que encheu 678 alertas",
    ).toBe(true);
  });
});

// ═══ B) o número tem de ser o real, não o tamanho da amostra ═════════════════
describe("B) o número de sessões é contado, não é o tamanho da amostra", () => {
  it("com a amostra cheia, grava a contagem de verdade e chega a crítico", async () => {
    estado.sessoes = Array.from({ length: 10 }, (_, i) => sessao(i + 1));
    estado.totalDeSessoes = 37;

    await detectSessionAnomaly(1, IP, "navegador-de-teste");

    const eventos = eventosGravados();
    expect(eventos).toHaveLength(1);
    const detalhes = eventos[0].details as Record<string, unknown>;
    expect(detalhes.activeSessions, "gravou o tamanho da amostra em vez da contagem").toBe(37);
    expect(
      eventos[0].severity,
      "37 sessões tem de ser crítico; antes o ramo crítico era inalcançável porque o número era sempre 10",
    ).toBe("critical");
    expect(estado.consultas).toContain("sessions:contagem");
  });

  it("abaixo do limite não alerta, e não gasta a consulta de contagem", async () => {
    estado.sessoes = Array.from({ length: 3 }, (_, i) => sessao(i + 1));

    await detectSessionAnomaly(1, IP, "navegador-de-teste");

    expect(eventosGravados()).toHaveLength(0);
    expect(
      estado.consultas.filter(c => c === "sessions:contagem"),
      "a contagem só pode ser pedida quando a amostra enche: é uma consulta por requisição de cada usuária",
    ).toHaveLength(0);
  });
});

// ═══ C) alerta repetido não vira linha nova ══════════════════════════════════
describe("C) o mesmo alerta não se repete dentro da janela", () => {
  it("com alerta igual recente, nada é gravado", async () => {
    estado.sessoes = Array.from({ length: 10 }, (_, i) => sessao(i + 1));
    estado.totalDeSessoes = 12;
    estado.jaExisteEventoIgual = true;

    await detectSessionAnomaly(1, IP, "navegador-de-teste");

    expect(
      eventosGravados(),
      "sem dedupe, 26 contas de teste geraram 851 eventos em treze dias",
    ).toHaveLength(0);
  });

  it("sem alerta igual recente, grava", async () => {
    estado.sessoes = Array.from({ length: 10 }, (_, i) => sessao(i + 1));
    estado.totalDeSessoes = 12;
    estado.jaExisteEventoIgual = false;

    await detectSessionAnomaly(1, IP, "navegador-de-teste");

    expect(eventosGravados()).toHaveLength(1);
  });

  it("evento crítico de força bruta NÃO é dedupado: cada tentativa continua registrada", async () => {
    estado.jaExisteEventoIgual = true;
    await createSecurityEvent(1, "brute_force_attempt", "critical", IP, { tentativas: 9 });
    expect(eventosGravados()).toHaveLength(1);
  });
});

// ═══ D) o bloqueio automático é avaliado quando nasce um crítico ═════════════
describe("D) o bloqueio automático sai do caminho de toda requisição", () => {
  it("evento crítico dispara a checagem do limite", async () => {
    await createSecurityEvent(1, "brute_force_attempt", "critical", IP, {});
    expect(estado.consultas).toContain("security_events:linhas");
  });

  it("evento de aviso não dispara a checagem", async () => {
    estado.consultas = [];
    await createSecurityEvent(1, "suspicious_ip", "warning", IP, {});
    expect(
      estado.consultas.filter(c => c === "security_events:linhas"),
      "aviso não muda a contagem de críticos, então não pode custar uma consulta",
    ).toHaveLength(0);
  });

  it("o próprio bloqueio não se realimenta", async () => {
    estado.consultas = [];
    await createSecurityEvent(1, "account_locked", "critical", IP, {});
    expect(
      estado.consultas.filter(c => c === "security_events:linhas"),
      "account_locked é gravado pela própria função de bloqueio: relançar a checagem seria recursão",
    ).toHaveLength(0);
  });

  it("o caminho de autenticação não importa mais a checagem", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(new URL("./_core/sdk.ts", import.meta.url), "utf8");
    expect(
      fonte.includes("checkAutoLockThreshold"),
      "voltou a ser chamada em getUserFromRequest: é um SELECT por requisição autenticada",
    ).toBe(false);
  });
});

// ═══ E) a dedupe é atômica ═══════════════════════════════════════════════════
describe("E) alertas simultâneos iguais não viram linhas repetidas", () => {
  it("cinco pedidos ao mesmo tempo gravam UMA linha", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        createSecurityEvent(1, "multiple_sessions", "warning", IP, { activeSessions: 12 }, { naoRepetirPorMs: JANELA }),
      ),
    );

    expect(
      eventosGravados(),
      "checar e gravar em dois comandos deixa a janela aberta: as cinco requisições leem 'não existe' antes de qualquer uma gravar",
    ).toHaveLength(1);
  });

  it("a janela recém-fechada por outra requisição barra a linha nova", async () => {
    estado.jaExisteEventoIgual = true;
    await createSecurityEvent(1, "suspicious_ip", "warning", IP, {}, { naoRepetirPorMs: JANELA });
    expect(eventosGravados()).toHaveLength(0);
  });
});

// ═══ F) múltiplas sessões não bloqueiam a conta ══════════════════════════════
describe("F) multiple_sessions sai da contagem do bloqueio automático", () => {
  it("alerta de sessões simultâneas não desativa a conta, e continua registrado", async () => {
    estado.eventosCriticosNaJanela = janelaCheiaDeCriticos();

    await createSecurityEvent(1, "multiple_sessions", "critical", IP, { activeSessions: 21 }, { naoRepetirPorMs: JANELA });

    expect(
      contasDesativadas(),
      "20 sessões simultâneas é a Rede aberta com muitas fotos, não invasão: a conta Prata se autobloqueava sozinha",
    ).toHaveLength(0);
    expect(
      eventosGravados().filter(e => e.eventType === "multiple_sessions"),
      "tirar do bloqueio não é parar de registrar: o evento continua no painel",
    ).toHaveLength(1);
  });

  it("a contagem exclui multiple_sessions no próprio WHERE", async () => {
    await createSecurityEvent(1, "brute_force_attempt", "critical", IP, {});

    expect(
      valoresDe(estado.condicaoDosCriticos),
      "senão as linhas de multiple_sessions somam com a tentativa de força bruta e fecham a conta",
    ).toContain("multiple_sessions");
  });

  it("ameaça de verdade continua bloqueando", async () => {
    estado.eventosCriticosNaJanela = janelaCheiaDeCriticos();
    await createSecurityEvent(1, "brute_force_attempt", "critical", IP, {});
    expect(contasDesativadas(), "força bruta acima do limite tem de bloquear").toHaveLength(1);
  });
});

// ═══ G) só desativa quem está ativa ═════════════════════════════════════════
describe("G) o UPDATE que bloqueia leva a condição no WHERE", () => {
  it("o bloqueio automático só alcança conta ativa", async () => {
    estado.eventosCriticosNaJanela = janelaCheiaDeCriticos();

    await createSecurityEvent(1, "brute_force_attempt", "critical", IP, {});

    const bloqueio = contasDesativadas()[0];
    expect(bloqueio, "a conta tinha de ter sido bloqueada").toBeTruthy();
    expect(
      colunasCitadas(bloqueio.condicao).has("isActive"),
      "UPDATE sem condição de estado 'dá certo' sempre: o account_locked se repete a cada crítico novo",
    ).toBe(true);
  });

  it("zero linhas alcançadas é 'já estava bloqueada': não repete evento nem auditoria", async () => {
    estado.eventosCriticosNaJanela = janelaCheiaDeCriticos();
    estado.linhasNoUpdateDeUsuarias = 0; // outra requisição bloqueou primeiro

    await createSecurityEvent(1, "brute_force_attempt", "critical", IP, {});

    expect(
      eventosGravados().filter(e => e.eventType === "account_locked"),
      "conta já bloqueada não ganha account_locked novo (nem aviso no sino)",
    ).toHaveLength(0);
    expect(
      estado.inseridos.filter(l => l.tabela === "audit_logs" && l.valores.action === "AUTO_LOCK_ACCOUNT"),
      "nem linha de auditoria de bloqueio automático",
    ).toHaveLength(0);
  });

  it("o bloqueio manual diz se a conta mudou de estado", async () => {
    estado.linhasNoUpdateDeUsuarias = 0;

    const bloqueou = await lockUserAccount(7, 1, "teste");

    expect(bloqueou, "lockUserAccount precisa distinguir bloquear de já estar bloqueada").toBe(false);
    expect(
      eventosGravados().filter(e => e.eventType === "account_locked"),
      "o painel administrativo regravava account_locked a cada clique",
    ).toHaveLength(0);
  });
});

// ═══ H) o IP da sessão acompanha a usuária (PR #179) ═════════════════════════
/**
 * Revisão da PR #179: o IP da sessão era gravado só no login. Com a sessão de
 * 90 dias desde o último uso, quem trocava do wi-fi para o 4G passava a gravar
 * um SUSPICIOUS_ACCESS de risco alto em TODA requisição, por meses. Agora,
 * alertado o IP novo, a sessão desta requisição passa a guardá-lo: o alerta
 * sai uma vez por troca de rede.
 */
describe("H) depois do alerta de IP novo, a sessão passa a conhecer o IP", () => {
  const OUTRO_IP = "198.51.100.77";
  const TOKEN = "t".repeat(64);
  const atualizacoesDeSessao = () => estado.atualizacoes.filter(a => a.tabela === "sessions");

  it("IP novo, com sessionToken: alerta e grava o IP na sessão desta requisição", async () => {
    estado.sessoes = [sessao(1)];
    await detectSessionAnomaly(1, OUTRO_IP, "navegador-de-teste", TOKEN);

    expect(eventosGravados().map(e => e.eventType)).toContain("suspicious_ip");
    const [atualizacao, ...resto] = atualizacoesDeSessao();
    expect(resto).toEqual([]);
    expect(atualizacao.valores).toEqual({ ipAddress: OUTRO_IP });
    expect(colunasCitadas(atualizacao.condicao)).toEqual(new Set(["sessionToken"]));
    expect(valoresDe(atualizacao.condicao)).toEqual([TOKEN]);
  });

  it("IP já conhecido: nenhum alerta e nenhuma escrita na sessão", async () => {
    estado.sessoes = [sessao(1)];
    await detectSessionAnomaly(1, IP, "navegador-de-teste", TOKEN);

    expect(eventosGravados()).toEqual([]);
    expect(atualizacoesDeSessao()).toEqual([]);
  });

  it("IP novo barrado pela dedupe (já houve suspicious_ip na janela): a sessão NÃO passa a conhecê-lo", async () => {
    // Segunda revisão da #179: a dedupe de 30 min não olha o IP. Se o IP fosse
    // gravado mesmo sem evento, um terceiro IP dentro da janela (o de quem
    // copiou o token) viraria "conhecido" sem nunca ter alertado.
    estado.sessoes = [sessao(1)];
    estado.jaExisteEventoIgual = true;
    await detectSessionAnomaly(1, OUTRO_IP, "navegador-de-teste", TOKEN);

    expect(eventosGravados()).toEqual([]);
    expect(atualizacoesDeSessao()).toEqual([]);
  });

  it("IP novo com alerta: uma linha SUSPICIOUS_ACCESS de risco alto em audit_logs", async () => {
    estado.sessoes = [sessao(1)];
    await detectSessionAnomaly(1, OUTRO_IP, "navegador-de-teste", TOKEN);

    expect(acessosSuspeitos()).toEqual([expect.objectContaining({ userId: 1, riskLevel: "high", ipAddress: OUTRO_IP })]);
  });

  it("IP novo barrado pela dedupe: nenhuma linha SUSPICIOUS_ACCESS, nem por requisição", async () => {
    // Pendência da validação da #179: com a sessão de 90 dias, durante a janela
    // da dedupe cada requisição de um IP ainda não aprendido gravava uma linha
    // de risco alto em audit_logs (cada foto pedida ao storageProxy, inclusive).
    estado.sessoes = [sessao(1)];
    estado.jaExisteEventoIgual = true;
    for (let i = 0; i < 5; i++) await detectSessionAnomaly(1, OUTRO_IP, "navegador-de-teste", TOKEN);

    expect(acessosSuspeitos()).toEqual([]);
  });

  it("várias requisições do mesmo IP novo: só a primeira, a que alertou, grava SUSPICIOUS_ACCESS", async () => {
    estado.sessoes = [sessao(1)];
    await detectSessionAnomaly(1, OUTRO_IP, "navegador-de-teste", TOKEN);
    // O suspicious_ip da primeira já está na janela: as seguintes caem na dedupe.
    estado.jaExisteEventoIgual = true;
    for (let i = 0; i < 4; i++) await detectSessionAnomaly(1, OUTRO_IP, "navegador-de-teste", TOKEN);

    expect(acessosSuspeitos()).toHaveLength(1);
  });

  it("sem sessionToken (o parâmetro segue opcional, embora o sdk já recuse token sem ele): alerta como antes, sem tocar em sessão nenhuma", async () => {
    estado.sessoes = [sessao(1)];
    await detectSessionAnomaly(1, OUTRO_IP, "navegador-de-teste", null);

    expect(eventosGravados().map(e => e.eventType)).toContain("suspicious_ip");
    expect(atualizacoesDeSessao()).toEqual([]);
  });
});
