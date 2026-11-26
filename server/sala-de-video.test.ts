import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  MINUTOS_PESSOA_POR_MES, PESSOAS_POR_SALA_MAX, RECUSAS_DA_SALA, SALA_DURA_MS, TETO_DA_SALA_EM_MINUTOS, papelAbreSala,
} from "@shared/sala-de-video";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As regras da sala de vídeo (V1) que não precisam de banco: a conta do
 * orçamento, quem ocupa lugar, o nome do visitante, o aceite do aviso, o papel
 * que abre sala e as recusas que acontecem ANTES do banco (sem as variáveis,
 * Bronze, link fora do formato). O caminho inteiro, com banco, está em
 * server/sala-de-video.integracao.test.ts.
 */

const {
  aceiteValido, abrirSala, entrarComoVisitante, entrarNaSala, estadoDaSala, mesDoOrcamento, minutosPessoaDoMes, nomeDoVisitante, ocupaLugar,
  orcamentoComportaOutraSala, segundosCobrados, verLinkDeVisitante,
} = await import("./sala-de-video");

const PROVA = { userId: 7, ipAddress: "203.0.113.1", userAgent: "vitest" };
const REUNIAO = "0b6f2c1e-1111-4222-8333-944445555666";
const SEGREDO_VALIDO = "A".repeat(32);
const AVISO = { aceito: true, versao: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO };

async function recusa(promessa: Promise<unknown>): Promise<TRPCError> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof TRPCError) return erro;
    throw erro;
  }
  throw new Error("era para recusar");
}

const ambienteAntes = { ...process.env };
beforeEach(() => {
  delete process.env.DAILY_API_KEY;
  delete process.env.DAILY_DOMINIO;
  delete process.env.DAILY_WEBHOOK_SEGREDO;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const nome of ["DAILY_API_KEY", "DAILY_DOMINIO", "DAILY_WEBHOOK_SEGREDO"]) {
    if (ambienteAntes[nome] === undefined) delete process.env[nome];
    else process.env[nome] = ambienteAntes[nome];
  }
  vi.restoreAllMocks();
});
const ligarSala = () => { process.env.DAILY_API_KEY = "chave-de-teste"; process.env.DAILY_DOMINIO = "marquesa"; };

describe("os tetos da decisão de 24/11", () => {
  it("8 pessoas, 2 horas, 960 minutos-pessoa por sala, 22.500 no mês (10 mil grátis + US$ 50 a US$ 0,004)", () => {
    expect(PESSOAS_POR_SALA_MAX).toBe(8);
    expect(SALA_DURA_MS).toBe(2 * 60 * 60 * 1000);
    expect(TETO_DA_SALA_EM_MINUTOS).toBe(960);
    expect(MINUTOS_PESSOA_POR_MES).toBe(10_000 + 50 / 0.004);
  });

  it("abre sala quem é Prata ou acima, e só", () => {
    for (const papel of ["silver", "gold", "president", "admin"]) expect(papelAbreSala(papel)).toBe(true);
    for (const papel of ["bronze", "", null, undefined, "member"]) expect(papelAbreSala(papel)).toBe(false);
  });
});

describe("a conta do orçamento", () => {
  const AGORA = Date.UTC(2026, 10, 26, 12, 0, 0);
  const sala = (extra: Partial<{ expiraEm: number; encerradaEm: number | null; segundosPessoa: number; medida: boolean }> = {}) => ({
    expiraEm: AGORA + 60_000, encerradaEm: null, segundosPessoa: 0, medida: true, ...extra,
  });

  it("a sala aberta reserva o teto dela, mesmo medida e com pouco uso", () => {
    expect(minutosPessoaDoMes([sala({ segundosPessoa: 120 })], AGORA)).toBe(960);
  });

  it("a fechada e medida conta o que o Daily avisou, arredondado para cima", () => {
    expect(minutosPessoaDoMes([sala({ encerradaEm: AGORA - 1, segundosPessoa: 61 })], AGORA)).toBe(2);
    // Vencida sem o aviso de fim também é fechada.
    expect(minutosPessoaDoMes([sala({ expiraEm: AGORA - 1, segundosPessoa: 600 })], AGORA)).toBe(10);
    expect(minutosPessoaDoMes([sala({ encerradaEm: AGORA - 1, segundosPessoa: 0 })], AGORA)).toBe(0);
  });

  it("a sala sem o segredo do webhook (não medida) conta pelo teto, aberta ou fechada", () => {
    expect(minutosPessoaDoMes([sala({ medida: false, encerradaEm: AGORA - 1, segundosPessoa: 60 })], AGORA)).toBe(960);
  });

  it("o mês comporta 23 salas no teto e recusa a 24ª (22.500 / 960 = 23,4)", () => {
    const vinteTres = Array.from({ length: 23 }, () => sala());
    const vinteDuas = vinteTres.slice(1);
    expect(orcamentoComportaOutraSala(minutosPessoaDoMes(vinteDuas, AGORA))).toBe(true);
    expect(orcamentoComportaOutraSala(minutosPessoaDoMes(vinteTres, AGORA))).toBe(false);
    expect(orcamentoComportaOutraSala(MINUTOS_PESSOA_POR_MES - 960)).toBe(true);
    expect(orcamentoComportaOutraSala(MINUTOS_PESSOA_POR_MES - 959)).toBe(false);
  });

  it("cada sessão é cobrada ao minuto, para cima; o mês é o de UTC", () => {
    expect(segundosCobrados(0)).toBe(0);
    expect(segundosCobrados(1)).toBe(60);
    expect(segundosCobrados(60)).toBe(60);
    expect(segundosCobrados(61)).toBe(120);
    expect(segundosCobrados(-5)).toBe(0);
    expect(mesDoOrcamento(Date.UTC(2026, 10, 30, 23, 59))).toBe("2026-11");
    expect(mesDoOrcamento(Date.UTC(2026, 11, 1, 0, 0))).toBe("2026-12");
  });
});

describe("quem ocupa um lugar na sala (o teto de 8)", () => {
  const AGORA = 1_000_000;
  it("quem está na sala (o Daily avisou a entrada e ainda não a saída) ocupa", () => {
    expect(ocupaLugar({ openSessionId: "s", tokenIssuedAt: 0, tokenExpiresAt: 0, leftAt: null }, AGORA)).toBe(true);
  });
  it("a ficha recém-emitida ocupa até vencer, se a pessoa não saiu depois dela", () => {
    expect(ocupaLugar({ openSessionId: null, tokenIssuedAt: AGORA - 10, tokenExpiresAt: AGORA + 10, leftAt: null }, AGORA)).toBe(true);
    expect(ocupaLugar({ openSessionId: null, tokenIssuedAt: AGORA - 10, tokenExpiresAt: AGORA - 1, leftAt: null }, AGORA)).toBe(false);
    // Entrou e saiu com a mesma ficha: o lugar volta.
    expect(ocupaLugar({ openSessionId: null, tokenIssuedAt: AGORA - 10, tokenExpiresAt: AGORA + 10, leftAt: AGORA - 5 }, AGORA)).toBe(false);
    // Saiu antes e pediu outra ficha: ocupa de novo.
    expect(ocupaLugar({ openSessionId: null, tokenIssuedAt: AGORA - 10, tokenExpiresAt: AGORA + 10, leftAt: AGORA - 50 }, AGORA)).toBe(true);
  });
});

describe("o nome do visitante", () => {
  it("sem espaços sobrando, até 60 caracteres", () => {
    expect(nomeDoVisitante("  Maria   da  Silva ")).toBe("Maria da Silva");
    expect(nomeDoVisitante("x".repeat(60))).toBe("x".repeat(60));
    expect(nomeDoVisitante("x".repeat(61))).toBeNull();
    expect(nomeDoVisitante("   ")).toBeNull();
  });
  it("sem caractere de controle nem invisível", () => {
    expect(nomeDoVisitante("Ana\u0000")).toBeNull();
    expect(nomeDoVisitante("Ana​")).toBeNull();
    expect(nomeDoVisitante("Ana‮oir")).toBeNull();
  });
  it("sem e-mail nem telefone (D3: os contatos não vão à tela das outras pessoas nem ao fornecedor)", () => {
    expect(nomeDoVisitante("Ana ana@exemplo.com")).toBeNull();
    expect(nomeDoVisitante("Ana (11) 99999-8888")).toBeNull();
    expect(nomeDoVisitante("Ana da Empresa 2026")).toBe("Ana da Empresa 2026");
  });
});

describe("o aceite do aviso de gravação", () => {
  it("marcado e numa versão que existe", () => {
    expect(aceiteValido(AVISO)).toBe(true);
    expect(aceiteValido({ aceito: true, versao: "2026-11-14" })).toBe(true);
    expect(aceiteValido({ aceito: false, versao: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO })).toBe(false);
    expect(aceiteValido({ aceito: true, versao: "1999-01-01" })).toBe(false);
    expect(aceiteValido(null)).toBe(false);
  });
});

describe("sem DAILY_API_KEY e DAILY_DOMINIO, a função some", () => {
  it("o estado diz que não existe, sem tocar o banco", async () => {
    expect(await estadoDaSala({ id: 7, openId: "dona", role: "gold" }, REUNIAO)).toEqual({ disponivel: false });
  });
  it("abrir, entrar e o link de visitante recusam com SALA_INDISPONIVEL", async () => {
    for (const promessa of [
      abrirSala({ id: 7, openId: "dona", role: "gold" }, REUNIAO, PROVA),
      entrarNaSala({ id: 7, openId: "dona" }, REUNIAO, AVISO),
      verLinkDeVisitante(SEGREDO_VALIDO, "rede-1"),
      entrarComoVisitante(SEGREDO_VALIDO, "Ana", AVISO, "rede-1"),
    ]) {
      expect(await recusa(promessa)).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_SALA.indisponivel });
    }
  });
});

describe("as recusas antes do banco, com a sala configurada", () => {
  it("Bronze não abre sala (FORBIDDEN), sem tocar o banco", async () => {
    ligarSala();
    expect(await recusa(abrirSala({ id: 7, openId: "dona-bronze", role: "bronze" }, REUNIAO, PROVA)))
      .toMatchObject({ code: "FORBIDDEN", message: RECUSAS_DA_SALA.soPrataOuAcima });
  });

  it("o visitante: link fora do formato, nome inválido e aviso sem aceite, cada um com o seu código", async () => {
    ligarSala();
    expect(await recusa(entrarComoVisitante("curto", "Ana", AVISO, "rede-2"))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DA_SALA.linkInvalido });
    expect(await recusa(entrarComoVisitante(SEGREDO_VALIDO, "ana@exemplo.com", AVISO, "rede-2"))).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DA_SALA.nomeInvalido });
    expect(await recusa(entrarComoVisitante(SEGREDO_VALIDO, "Ana", { aceito: false, versao: "2026-11-24" }, "rede-2")))
      .toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DA_SALA.avisoPedido });
    expect(await recusa(entrarComoVisitante(SEGREDO_VALIDO, "Ana", null, "rede-2"))).toMatchObject({ message: RECUSAS_DA_SALA.avisoPedido });
  });

  it("as tentativas do link de visitante têm teto por rede, também com o link errado", async () => {
    ligarSala();
    for (let vez = 0; vez < 30; vez += 1) {
      expect(await recusa(entrarComoVisitante("errado", "Ana", AVISO, "rede-teto"))).toMatchObject({ message: RECUSAS_DA_SALA.linkInvalido });
    }
    expect(await recusa(entrarComoVisitante("errado", "Ana", AVISO, "rede-teto"))).toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DA_SALA.muitosPedidos });
    // Outra rede não é afetada.
    expect(await recusa(entrarComoVisitante("errado", "Ana", AVISO, "rede-outra"))).toMatchObject({ message: RECUSAS_DA_SALA.linkInvalido });
  });

  it("com as variáveis e sem banco, o estado lança (banco fora do ar é erro, nunca 'sem sala')", async () => {
    ligarSala();
    await expect(estadoDaSala({ id: 7, openId: "dona", role: "gold" }, REUNIAO)).rejects.toThrow();
  });
});
