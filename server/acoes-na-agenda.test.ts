import { describe, expect, it } from "vitest";
import {
  destinoDaAcaoNaAgenda,
  estadoDaAcaoAoEscrever,
  inicioDoEventoDaAcao,
  ROTULOS_SEM_TRADUCAO,
  rotulosDaAgendaValidos,
  textosDaAcaoNaAgenda,
  TITULO_DO_EVENTO_DA_ACAO_MAX,
  uidDoIcsDaAcao,
} from "@shared/acoes-na-agenda";

/**
 * A regra da próxima ação na agenda (H5c, shared/acoes-na-agenda.ts), que a
 * tela (o .ics e o link de criar evento) e o servidor (o evento na Google
 * Agenda conectada) dividem: quando a ação vai, a que horas e com que texto.
 */

const ROTULOS = { voz: "Falante {n}", responsavel: "Responsável: {nome}" };
const SP = "America/Sao_Paulo";

describe("o destino da ação na agenda", () => {
  it("só a aberta com prazo vai: feita, sem prazo ou com prazo inválido sai", () => {
    const agora = Date.UTC(2026, 10, 16, 12);
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: false }, SP, agora)).toBe("gravar");
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: true }, SP, agora)).toBe("tirar");
    expect(destinoDaAcaoNaAgenda({ prazo: null, feita: false }, SP, agora)).toBe("tirar");
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-02-30", feita: false }, SP, agora)).toBe("tirar");
  });

  it("o dia do prazo vale até a meia-noite no fuso: depois dela, só muda o que já está lá", () => {
    // 23h do dia 20 em São Paulo (2h do dia 21 em UTC): o dia do prazo ainda não acabou lá.
    const quaseMeiaNoite = Date.UTC(2026, 10, 21, 2);
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: false }, SP, quaseMeiaNoite)).toBe("gravar");
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: false }, "UTC", quaseMeiaNoite)).toBe("atualizar");
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: false }, SP, Date.UTC(2026, 10, 21, 3))).toBe("atualizar");
    // Depois das 9h, mas no mesmo dia: ainda vai (o evento fica no dia, e o aviso já passou).
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: false }, SP, Date.UTC(2026, 10, 20, 18))).toBe("gravar");
  });

  it("fuso que o Intl não conhece cai no UTC, sem quebrar", () => {
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: false }, "Lugar/Nenhum", Date.UTC(2026, 10, 20, 23))).toBe("gravar");
    expect(destinoDaAcaoNaAgenda({ prazo: "2026-11-20", feita: false }, "Lugar/Nenhum", Date.UTC(2026, 10, 21, 0))).toBe("atualizar");
    expect(inicioDoEventoDaAcao("2026-11-20", "Lugar/Nenhum")).toBe(Date.UTC(2026, 10, 20, 9));
  });
});

describe("a hora do evento", () => {
  it("às 9h do dia do prazo, no relógio do fuso, como o lembrete no sino (H15)", () => {
    expect(inicioDoEventoDaAcao("2026-11-20", SP)).toBe(Date.UTC(2026, 10, 20, 12));
    expect(inicioDoEventoDaAcao("2026-11-20", "Asia/Tokyo")).toBe(Date.UTC(2026, 10, 20, 0));
    expect(inicioDoEventoDaAcao("2026-07-01", "Europe/Lisbon")).toBe(Date.UTC(2026, 6, 1, 8));
    expect(inicioDoEventoDaAcao("ontem", SP)).toBeNull();
  });
});

describe("o estado na Google que a escrita grava", () => {
  it("sai da agenda: nulo, de qualquer estado", () => {
    for (const antes of [null, "pendente", "ok", "falhou"] as const) {
      expect(estadoDaAcaoAoEscrever("tirar", antes, true)).toBeNull();
      expect(estadoDaAcaoAoEscrever("tirar", antes, false)).toBeNull();
    }
  });

  it("vai para lá: 'pendente' com a Google Agenda; sem ela, 'falhou' se estava, nulo se nunca foi", () => {
    expect(estadoDaAcaoAoEscrever("gravar", null, true)).toBe("pendente");
    expect(estadoDaAcaoAoEscrever("gravar", "ok", true)).toBe("pendente");
    expect(estadoDaAcaoAoEscrever("gravar", "ok", false)).toBe("falhou");
    expect(estadoDaAcaoAoEscrever("gravar", null, false)).toBeNull();
  });

  it("dia do prazo encerrado: a que nunca foi continua nula; a que está lá muda como acima", () => {
    expect(estadoDaAcaoAoEscrever("atualizar", null, true)).toBeNull();
    expect(estadoDaAcaoAoEscrever("atualizar", "ok", true)).toBe("pendente");
    expect(estadoDaAcaoAoEscrever("atualizar", "falhou", false)).toBe("falhou");
  });
});

describe("os rótulos da tela", () => {
  it("valem com o lugar do valor e dentro do limite; o resto cai nos sem tradução", () => {
    expect(rotulosDaAgendaValidos(ROTULOS)).toBe(true);
    expect(rotulosDaAgendaValidos({ voz: "話者 {n}", responsavel: "担当：{nome}" })).toBe(true);
    expect(rotulosDaAgendaValidos({ voz: "Falante", responsavel: "Responsável: {nome}" })).toBe(false);
    expect(rotulosDaAgendaValidos({ voz: "Falante {n}", responsavel: "Responsável" })).toBe(false);
    expect(rotulosDaAgendaValidos({ voz: `${"x".repeat(80)}{n}`, responsavel: "{nome}" })).toBe(false);
    expect(rotulosDaAgendaValidos({ voz: 3, responsavel: "{nome}" })).toBe(false);
    expect(rotulosDaAgendaValidos(null)).toBe(false);
    expect(rotulosDaAgendaValidos(undefined)).toBe(false);
    expect(rotulosDaAgendaValidos(ROTULOS_SEM_TRADUCAO)).toBe(true);
  });
});

describe("o texto do evento", () => {
  const acao = { texto: "{F2} envia a proposta a {F3}", detalhe: "Com o desconto que {F2} prometeu", responsavel: "{F2}", vozes: { F2: "Carla" } };

  it("os rótulos de voz viram o nome dado; a voz sem nome sai com o rótulo da tela; o responsável e o endereço, cada um num parágrafo", () => {
    expect(textosDaAcaoNaAgenda(acao, ROTULOS, "https://wrwglobal.org/proximas-acoes?acao=a1")).toEqual({
      titulo: "Carla envia a proposta a Falante 3",
      descricao: "Com o desconto que Carla prometeu\n\nResponsável: Carla\n\nhttps://wrwglobal.org/proximas-acoes?acao=a1",
    });
  });

  it("sem detalhe, responsável nem endereço, a descrição fica vazia; sem tradução, a voz sai crua", () => {
    expect(textosDaAcaoNaAgenda({ texto: " Ligar para {F1} ", detalhe: null, responsavel: null, vozes: {} }, ROTULOS_SEM_TRADUCAO, null))
      .toEqual({ titulo: "Ligar para F1", descricao: "" });
    expect(textosDaAcaoNaAgenda({ ...acao, vozes: {} }, ROTULOS_SEM_TRADUCAO, null).descricao).toBe("Com o desconto que F2 prometeu\n\nF2");
  });

  it("o texto comprido é cortado no título, sem partir um emoji, e vai inteiro na descrição", () => {
    const comprido = `${"😀".repeat(TITULO_DO_EVENTO_DA_ACAO_MAX)} fim`;
    const { titulo, descricao } = textosDaAcaoNaAgenda({ texto: comprido, detalhe: null, responsavel: null, vozes: {} }, ROTULOS, null);
    expect(Array.from(titulo)).toHaveLength(TITULO_DO_EVENTO_DA_ACAO_MAX);
    expect(titulo.endsWith("…")).toBe(true);
    expect(titulo.startsWith("😀")).toBe(true);
    expect(descricao).toBe(comprido);
  });

  it("um nome com $& ou $1 sai como foi escrito", () => {
    const { titulo, descricao } = textosDaAcaoNaAgenda({ texto: "Pagar {F1}", detalhe: null, responsavel: "{F1}", vozes: { F1: "A$&B $1" } }, ROTULOS, null);
    expect(titulo).toBe("Pagar A$&B $1");
    expect(descricao).toBe("Responsável: A$&B $1");
  });
});

describe("o UID do .ics", () => {
  it("é estável pela ação e diferente do das reuniões da agenda", () => {
    expect(uidDoIcsDaAcao("8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("acao-8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b@wrwglobal.org");
  });
});
