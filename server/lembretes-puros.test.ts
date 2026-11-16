import { describe, expect, it } from "vitest";
import {
  deslocamentoDoFuso,
  horarioDoLembreteDaAcao,
  horarioDoLembreteDaAgenda,
  instanteNoFuso,
  lerParametrosDaReuniaoPronta,
  lerParametrosDoLembrete,
  rotaDaProximaAcao,
} from "@shared/lembretes";

/**
 * As regras puras dos lembretes no sino (H15, shared/lembretes.ts): a hora do
 * aviso em cada fuso, inclusive nos dias de troca do horário de verão, a
 * validade, o link e a leitura dos parâmetros que o sino recebe. O que o banco
 * faz com elas está em server/lembretes.test.ts.
 */

const utc = (ano: number, mes: number, dia: number, hora = 0, minuto = 0) => Date.UTC(ano, mes - 1, dia, hora, minuto);

describe("a hora local de um dia, em ms UTC", () => {
  it.each([
    ["America/Sao_Paulo", "2026-11-20", utc(2026, 11, 20, 12)],
    // Nova York no inverno (−5) e no verão (−4).
    ["America/New_York", "2026-12-01", utc(2026, 12, 1, 14)],
    ["America/New_York", "2026-07-01", utc(2026, 7, 1, 13)],
    // Meia hora de deslocamento.
    ["Asia/Kolkata", "2026-11-20", utc(2026, 11, 20, 3, 30)],
    ["Asia/Tokyo", "2026-11-20", utc(2026, 11, 20, 0)],
    // +14: as 9h locais caem no dia anterior em UTC.
    ["Pacific/Kiritimati", "2026-11-20", utc(2026, 11, 19, 19)],
    ["UTC", "2026-11-20", utc(2026, 11, 20, 9)],
  ])("%s, %s às 9h", (fuso, dia, esperado) => {
    expect(instanteNoFuso(dia, 9, fuso)).toBe(esperado);
  });

  it("nos dias da troca do horário de verão, as 9h já estão do lado novo", () => {
    // Nova York: o verão começa em 08/03/2026 às 2h e acaba em 01/11/2026 às 2h.
    expect(instanteNoFuso("2026-03-08", 9, "America/New_York")).toBe(utc(2026, 3, 8, 13));
    expect(instanteNoFuso("2026-11-01", 9, "America/New_York")).toBe(utc(2026, 11, 1, 14));
  });

  it("24h é a meia-noite que fecha o dia", () => {
    expect(instanteNoFuso("2026-11-20", 24, "America/Sao_Paulo")).toBe(utc(2026, 11, 21, 3));
    expect(instanteNoFuso("2026-12-31", 24, "Asia/Tokyo")).toBe(utc(2026, 12, 31, 15));
  });

  it("dia que não existe, ou fuso que o Intl não conhece: null", () => {
    expect(instanteNoFuso("2026-02-30", 9, "America/Sao_Paulo")).toBeNull();
    expect(instanteNoFuso("20/11/2026", 9, "America/Sao_Paulo")).toBeNull();
    expect(instanteNoFuso("2026-11-20", 9, "Marte/Olympus")).toBeNull();
  });

  it("o deslocamento do fuso num instante", () => {
    expect(deslocamentoDoFuso(utc(2026, 11, 20, 12), "America/Sao_Paulo")).toBe(-3 * 3_600_000);
    expect(deslocamentoDoFuso(utc(2026, 7, 1, 12), "America/New_York")).toBe(-4 * 3_600_000);
    expect(deslocamentoDoFuso(utc(2026, 11, 20, 12, 0) + 999, "Asia/Kolkata")).toBe(5.5 * 3_600_000);
  });
});

describe("a hora de cada lembrete", () => {
  it("a próxima ação: às 9h do dia do prazo, até a meia-noite que fecha o dia, no fuso dado", () => {
    expect(horarioDoLembreteDaAcao("2026-11-20", "America/Sao_Paulo")).toEqual({ dispararEm: utc(2026, 11, 20, 12), expiraEm: utc(2026, 11, 21, 3) });
    expect(horarioDoLembreteDaAcao("2026-11-20", "Asia/Tokyo")).toEqual({ dispararEm: utc(2026, 11, 20, 0), expiraEm: utc(2026, 11, 20, 15) });
  });

  it("a próxima ação sem prazo, com prazo inválido ou fuso desconhecido: nenhum", () => {
    expect(horarioDoLembreteDaAcao(null, "America/Sao_Paulo")).toBeNull();
    expect(horarioDoLembreteDaAcao("", "America/Sao_Paulo")).toBeNull();
    expect(horarioDoLembreteDaAcao("2026-13-01", "America/Sao_Paulo")).toBeNull();
    expect(horarioDoLembreteDaAcao("2026-11-20", "Marte/Olympus")).toBeNull();
  });

  it("a reunião da agenda: os minutos antes do início, até o fim; na hora (0) e um dia antes (1440)", () => {
    const inicioEm = utc(2026, 11, 20, 17);
    expect(horarioDoLembreteDaAgenda({ inicioEm, duracaoMinutos: 90, lembreteMinutos: 15 })).toEqual({ dispararEm: inicioEm - 15 * 60_000, expiraEm: inicioEm + 90 * 60_000 });
    expect(horarioDoLembreteDaAgenda({ inicioEm, duracaoMinutos: 30, lembreteMinutos: 0 })?.dispararEm).toBe(inicioEm);
    expect(horarioDoLembreteDaAgenda({ inicioEm, duracaoMinutos: 30, lembreteMinutos: 1440 })?.dispararEm).toBe(utc(2026, 11, 19, 17));
  });

  it("a reunião da agenda sem lembrete (nulo): nenhum", () => {
    expect(horarioDoLembreteDaAgenda({ inicioEm: 1, duracaoMinutos: 30, lembreteMinutos: null })).toBeNull();
    expect(horarioDoLembreteDaAgenda({ inicioEm: 1, duracaoMinutos: 30, lembreteMinutos: undefined })).toBeNull();
  });
});

describe("o link e os parâmetros que o sino recebe", () => {
  it("o link da ação abre a página das próximas ações nela", () => {
    expect(rotaDaProximaAcao("8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("/proximas-acoes?acao=8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(rotaDaProximaAcao("a b&c")).toBe("/proximas-acoes?acao=a%20b%26c");
  });

  it("o lembrete da ação e o da agenda passam com a forma certa, também como texto (MariaDB)", () => {
    expect(lerParametrosDoLembrete({ origem: "acao", texto: "{F2} manda a proposta", prazo: "2026-11-20" }))
      .toEqual({ origem: "acao", texto: "{F2} manda a proposta", prazo: "2026-11-20" });
    expect(lerParametrosDoLembrete(JSON.stringify({ origem: "agenda", titulo: "Com a Bia", inicioEm: 1_763_650_800_000, fuso: "America/Sao_Paulo", extra: 1 })))
      .toEqual({ origem: "agenda", titulo: "Com a Bia", inicioEm: 1_763_650_800_000, fuso: "America/Sao_Paulo" });
  });

  it.each([
    null, undefined, "", "{quebrado", [], 42,
    { origem: "acao", texto: "x" },
    { origem: "acao", texto: "x", prazo: "2026-02-30" },
    { origem: "acao", texto: 3, prazo: "2026-11-20" },
    { origem: "agenda", titulo: "x", inicioEm: Number.NaN, fuso: "UTC" },
    { origem: "agenda", titulo: "x", inicioEm: "1", fuso: "UTC" },
    { origem: "outra", titulo: "x", inicioEm: 1, fuso: "UTC" },
  ])("fora da forma, o lembrete é null: %j", bruto => {
    expect(lerParametrosDoLembrete(bruto)).toBeNull();
  });

  it("o aviso de reunião pronta: o título e como o resumo terminou", () => {
    expect(lerParametrosDaReuniaoPronta({ titulo: "Comitê", resumo: "pronto" })).toEqual({ titulo: "Comitê", resumo: "pronto" });
    expect(lerParametrosDaReuniaoPronta('{"titulo":"Comitê","resumo":"falhou"}')).toEqual({ titulo: "Comitê", resumo: "falhou" });
    expect(lerParametrosDaReuniaoPronta({ titulo: "Comitê", resumo: "talvez" })).toBeNull();
    expect(lerParametrosDaReuniaoPronta({ resumo: "pronto" })).toBeNull();
    expect(lerParametrosDaReuniaoPronta(null)).toBeNull();
  });
});
