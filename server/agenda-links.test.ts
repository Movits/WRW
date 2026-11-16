import { describe, expect, it } from "vitest";
import { ehLinkDaChamada, fusoCanonico } from "@shared/agenda";
import {
  ENDERECO_DA_GOOGLE_AGENDA,
  linkDaGoogleAgenda,
  linkDoEmailDoConvite,
  linkDoWhatsAppDoConvite,
  mensagemDoConvite,
  quandoDaReuniao,
} from "@shared/agenda-links";

/**
 * Os links e a mensagem do convite da agenda (H16a, shared/agenda-links.ts):
 * tudo abre no app da própria dona. O que não pode escapar: os e-mails dos
 * convidados no link que vai para os outros convidados, e a hora sem o fuso.
 */

const INICIO = Date.UTC(2026, 10, 20, 17, 0); // sexta, 20/11/2026, 14:00 em São Paulo
const evento = { titulo: "Reunião com a Bia", inicioMs: INICIO, duracaoMinutos: 90, fuso: "America/Sao_Paulo", local: "https://meet.google.com/abc-defg-hij" };
const rotulos = { cabecalho: "Convite para a reunião “Reunião com a Bia”", quando: "Quando", onde: "Onde", adicionarNaGoogle: "Adicionar à Google Agenda" };

function parametrosDe(link: string) {
  const url = new URL(link);
  return { base: `${url.origin}${url.pathname}`, parametros: url.searchParams };
}

describe("linkDaGoogleAgenda", () => {
  it("abre o evento preenchido: título, início e fim em UTC, local e fuso", () => {
    const { base, parametros } = parametrosDe(linkDaGoogleAgenda(evento));
    expect(base).toBe(ENDERECO_DA_GOOGLE_AGENDA);
    expect(parametros.get("action")).toBe("TEMPLATE");
    expect(parametros.get("text")).toBe("Reunião com a Bia");
    expect(parametros.get("dates")).toBe("20261120T170000Z/20261120T183000Z");
    expect(parametros.get("location")).toBe("https://meet.google.com/abc-defg-hij");
    expect(parametros.get("ctz")).toBe("America/Sao_Paulo");
    expect(parametros.has("add")).toBe(false);
  });

  it("os convidados entram só quando passados (o botão da dona), limpos e separados por vírgula", () => {
    const { parametros } = parametrosDe(linkDaGoogleAgenda({ ...evento, convidados: [" ana@exemplo.com ", "", "bia@exemplo.com"] }));
    expect(parametros.get("add")).toBe("ana@exemplo.com,bia@exemplo.com");
  });

  it("sem local e sem fuso, os parâmetros não vão vazios", () => {
    const { parametros } = parametrosDe(linkDaGoogleAgenda({ titulo: "X", inicioMs: INICIO, duracaoMinutos: 30, local: "   " }));
    expect(parametros.has("location")).toBe(false);
    expect(parametros.has("ctz")).toBe(false);
    expect(parametros.has("details")).toBe(false);
  });

  it("a descrição vai em details quando passada (a próxima ação, H5c), com as quebras de linha; vazia, não vai", () => {
    const { parametros } = parametrosDe(linkDaGoogleAgenda({ ...evento, detalhes: " Com o desconto\n\nResponsável: Bia " }));
    expect(parametros.get("details")).toBe("Com o desconto\n\nResponsável: Bia");
    expect(parametrosDe(linkDaGoogleAgenda({ ...evento, detalhes: "  " })).parametros.has("details")).toBe(false);
    // O convite (mensagemDoConvite) não passa descrição: o link dele fica como era.
    expect(parametrosDe(linkDaGoogleAgenda(evento)).parametros.has("details")).toBe(false);
  });
});

describe("quandoDaReuniao", () => {
  it("diz a hora no fuso em que a reunião foi marcada, com o nome do fuso, no idioma de quem lê", () => {
    const formato = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone: "America/Sao_Paulo",
    });
    const esperado = formato.formatRange(new Date(INICIO), new Date(INICIO + 90 * 60_000));
    expect(quandoDaReuniao(evento, "pt-BR")).toBe(esperado);
    expect(quandoDaReuniao(evento, "pt-BR")).toContain("14:00");
    expect(quandoDaReuniao(evento, "pt-BR")).toContain("15:30");
    // Em Tóquio, a mesma reunião é outra hora: o fuso decide, não o aparelho.
    expect(quandoDaReuniao({ ...evento, fuso: "Asia/Tokyo" }, "pt-BR")).toContain("02:00");
  });

  it("fuso que o Intl não conhece não derruba a tela: cai na hora local", () => {
    expect(() => quandoDaReuniao({ ...evento, fuso: "Marte/Base_Alfa" }, "pt-BR")).not.toThrow();
    expect(quandoDaReuniao({ ...evento, fuso: "Marte/Base_Alfa" }, "pt-BR")).toMatch(/\d{2}:\d{2}/);
  });
});

describe("mensagemDoConvite", () => {
  it("título, quando, onde e o link para a pessoa pôr na própria agenda, uma linha cada", () => {
    const linhas = mensagemDoConvite(evento, rotulos, "pt-BR").split("\n");
    expect(linhas[0]).toBe("Convite para a reunião “Reunião com a Bia”");
    expect(linhas[1]).toBe(`Quando: ${quandoDaReuniao(evento, "pt-BR")}`);
    expect(linhas[2]).toBe("Onde: https://meet.google.com/abc-defg-hij");
    expect(linhas[3].startsWith(`Adicionar à Google Agenda: ${ENDERECO_DA_GOOGLE_AGENDA}?`)).toBe(true);
    expect(linhas).toHaveLength(4);
  });

  it("sem local, sem a linha do onde", () => {
    const linhas = mensagemDoConvite({ ...evento, local: null }, rotulos, "pt-BR").split("\n");
    expect(linhas).toHaveLength(3);
    expect(linhas.some(linha => linha.startsWith("Onde:"))).toBe(false);
  });

  it("o link que vai aos convidados nunca leva os e-mails dos outros, nem que o objeto traga os participantes", () => {
    const comParticipantes = { ...evento, convidados: ["ana@exemplo.com"], participantes: [{ nome: "Ana", email: "ana@exemplo.com" }] };
    const mensagem = mensagemDoConvite(comParticipantes, rotulos, "pt-BR");
    expect(mensagem).not.toContain("ana");
    expect(mensagem).not.toContain("add=");
  });
});

describe("links do WhatsApp e do e-mail", () => {
  it("WhatsApp: a mensagem inteira vai codificada, e o app escolhe o contato", () => {
    const mensagem = "Convite: a & b\nQuando: amanhã";
    const link = linkDoWhatsAppDoConvite(mensagem);
    expect(link.startsWith("https://wa.me/?text=")).toBe(true);
    expect(new URL(link).searchParams.get("text")).toBe(mensagem);
  });

  it("e-mail: os convidados em cópia oculta, com a arroba legível e separados por vírgula", () => {
    const link = linkDoEmailDoConvite(["ana@exemplo.com", " bia+wrw@exemplo.com ", ""], "Convite: X & Y", "Linha 1\nLinha 2");
    expect(link.startsWith("mailto:?bcc=ana@exemplo.com,bia%2Bwrw@exemplo.com&")).toBe(true);
    const consulta = new URLSearchParams(link.slice("mailto:?".length).replace(/\+/g, "%2B"));
    expect(consulta.get("subject")).toBe("Convite: X & Y");
    expect(consulta.get("body")).toBe("Linha 1\nLinha 2");
    expect(link).not.toContain("to=");
  });

  it("e-mail sem convidado com e-mail: a dona escolhe a quem mandar", () => {
    expect(linkDoEmailDoConvite([], "A", "B")).toBe("mailto:?subject=A&body=B");
  });
});

describe("fuso e link da chamada (shared/agenda.ts)", () => {
  it("o fuso volta no nome canônico; o desconhecido, o vazio e o longo demais, nulo", () => {
    expect(fusoCanonico("america/sao_paulo")).toBe("America/Sao_Paulo");
    expect(fusoCanonico("UTC")).toBe("UTC");
    expect(fusoCanonico("Marte/Base_Alfa")).toBeNull();
    expect(fusoCanonico("")).toBeNull();
    expect(fusoCanonico(`America/${"x".repeat(80)}`)).toBeNull();
  });

  it("só o endereço web inteiro é link da chamada", () => {
    expect(ehLinkDaChamada("https://zoom.us/j/123?pwd=abc")).toBe(true);
    expect(ehLinkDaChamada("  http://meet.google.com/x  ")).toBe(true);
    expect(ehLinkDaChamada("Zoom: https://zoom.us/j/123")).toBe(false);
    expect(ehLinkDaChamada("Av. Paulista, 1000")).toBe(false);
    expect(ehLinkDaChamada("javascript:alert(1)")).toBe(false);
    expect(ehLinkDaChamada(null)).toBe(false);
  });
});
