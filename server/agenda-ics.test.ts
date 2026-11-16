import { describe, expect, it } from "vitest";
import { dataIcsUtc, dobrarLinhaIcs, escaparTextoIcs, montarIcs, nomeDoArquivoIcs, revisaoDoIcs } from "@shared/agenda-ics";

/**
 * O .ics da agenda (H16a), feito no navegador (shared/agenda-ics.ts). O que os
 * calendários do celular cobram: CRLF em toda linha, o texto escapado, a linha
 * longa dobrada em 75 octetos sem partir caractere, e as datas em UTC.
 */

const INICIO = Date.UTC(2026, 10, 20, 17, 0); // 20/11/2026 14:00 em Brasília
const AGORA = Date.UTC(2026, 10, 16, 12, 34, 56);
const evento = { uid: "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b@wrwglobal.org", titulo: "Reunião com a Bia", inicioMs: INICIO, duracaoMinutos: 90 };

/** Desfaz a dobra (CRLF + espaço) e devolve as linhas lógicas. */
function linhasLogicas(ics: string) {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

describe("escaparTextoIcs", () => {
  it("escapa barra invertida, ponto e vírgula, vírgula e quebra de linha (RFC 5545, 3.3.11)", () => {
    expect(escaparTextoIcs("a\\b; c, d\ne")).toBe("a\\\\b\\; c\\, d\\ne");
  });

  it("CRLF e CR viram uma quebra só; controle sai, o TAB fica", () => {
    expect(escaparTextoIcs("um\r\ndois\rtrês")).toBe("um\\ndois\\ntrês");
    expect(escaparTextoIcs("a\u0000b\u0007c\td\u007f")).toBe("abc\td");
  });

  it("um título que tenta abrir outra propriedade fica dentro do texto", () => {
    const ics = montarIcs({ ...evento, titulo: "Oi\r\nATTENDEE:mailto:x@y.com" }, AGORA);
    expect(linhasLogicas(ics)).not.toContain("ATTENDEE:mailto:x@y.com");
    expect(linhasLogicas(ics)).toContain("SUMMARY:Oi\\nATTENDEE:mailto:x@y.com");
  });
});

describe("dobrarLinhaIcs", () => {
  const octetos = (texto: string) => new TextEncoder().encode(texto).length;

  it("linha de até 75 octetos não muda", () => {
    const linha = "X".repeat(75);
    expect(dobrarLinhaIcs(linha)).toBe(linha);
  });

  it("linha longa: cada pedaço com até 75 octetos, a continuação começa com espaço e desdobrar devolve o original", () => {
    const linha = `SUMMARY:${"Reunião de alinhamento ".repeat(10)}`;
    const dobrada = dobrarLinhaIcs(linha);
    const pedacos = dobrada.split("\r\n");
    expect(pedacos.length).toBeGreaterThan(1);
    for (const [i, pedaco] of pedacos.entries()) {
      expect(octetos(pedaco)).toBeLessThanOrEqual(75);
      if (i > 0) expect(pedaco.startsWith(" ")).toBe(true);
    }
    expect(dobrada.replace(/\r\n /g, "")).toBe(linha);
  });

  it("conta octetos do UTF-8 e não parte caractere: acentos, chinês e emoji", () => {
    for (const texto of ["ção".repeat(40), "会议".repeat(40), "🎙️📅".repeat(30), `${"a".repeat(74)}😀b`]) {
      const linha = `DESCRIPTION:${texto}`;
      const dobrada = dobrarLinhaIcs(linha);
      for (const pedaco of dobrada.split("\r\n")) {
        expect(octetos(pedaco)).toBeLessThanOrEqual(75);
        // Nenhuma metade de par substituto: o pedaço é texto válido.
        expect(pedaco).toBe(pedaco.toWellFormed?.() ?? pedaco);
        expect(/[\uD800-\uDBFF]$/.test(pedaco)).toBe(false);
      }
      expect(dobrada.replace(/\r\n /g, "")).toBe(linha);
    }
  });
});

describe("montarIcs", () => {
  it("o evento inteiro: CRLF em toda linha (inclusive a última), datas em UTC e as propriedades na ordem", () => {
    const ics = montarIcs(evento, AGORA);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(linhasLogicas(ics).slice(0, -1)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//WRW//Agenda de reunioes//PT",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b@wrwglobal.org",
      "DTSTAMP:20261116T123456Z",
      "SEQUENCE:0",
      "DTSTART:20261120T170000Z",
      "DTEND:20261120T183000Z",
      "SUMMARY:Reunião com a Bia",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
  });

  it("local de rua vai em LOCATION; o link da chamada vai também em URL, sem o escape do texto", () => {
    const rua = linhasLogicas(montarIcs({ ...evento, local: "Av. Paulista, 1000; sala 3" }, AGORA));
    expect(rua).toContain("LOCATION:Av. Paulista\\, 1000\\; sala 3");
    expect(rua.some(linha => linha.startsWith("URL:"))).toBe(false);
    const chamada = linhasLogicas(montarIcs({ ...evento, local: "https://meet.google.com/abc-defg-hij?authuser=0,1" }, AGORA));
    expect(chamada).toContain("LOCATION:https://meet.google.com/abc-defg-hij?authuser=0\\,1");
    expect(chamada).toContain("URL:https://meet.google.com/abc-defg-hij?authuser=0,1");
  });

  it("descrição escapada quando há", () => {
    expect(linhasLogicas(montarIcs({ ...evento, descricao: "Pauta: a, b\nc" }, AGORA))).toContain("DESCRIPTION:Pauta: a\\, b\\nc");
  });

  it.each([
    [0, "TRIGGER:PT0S"],
    [15, "TRIGGER:-PT15M"],
    [60, "TRIGGER:-PT1H"],
    [120, "TRIGGER:-PT2H"],
    [1440, "TRIGGER:-P1D"],
  ])("lembrete de %i min vira o VALARM com %s", (minutos, gatilho) => {
    const linhas = linhasLogicas(montarIcs({ ...evento, lembreteMinutos: minutos }, AGORA));
    const inicio = linhas.indexOf("BEGIN:VALARM");
    expect(linhas.slice(inicio, inicio + 5)).toEqual(["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reunião com a Bia", gatilho, "END:VALARM"]);
    // O alarme fica dentro do evento.
    expect(inicio).toBeLessThan(linhas.indexOf("END:VEVENT"));
  });

  it("sem lembrete, sem VALARM", () => {
    expect(montarIcs({ ...evento, lembreteMinutos: null }, AGORA)).not.toContain("VALARM");
  });

  it("início ou duração inválidos não viram arquivo", () => {
    expect(() => montarIcs({ ...evento, inicioMs: Number.NaN }, AGORA)).toThrow(RangeError);
    expect(() => montarIcs({ ...evento, duracaoMinutos: 0 }, AGORA)).toThrow(RangeError);
  });

  // A dona marca às 10:00, põe no calendário do celular, muda para 15:00 e baixa
  // de novo: com o mesmo UID e o mesmo SEQUENCE, o calendário que escolhe a
  // versão pelo SEQUENCE (RFC 5546, 2.1.5) podia ficar com a das 10:00.
  it("a reunião mudada sai com o mesmo UID, o SEQUENCE maior e o LAST-MODIFIED da mudança", () => {
    const criada = Date.UTC(2026, 10, 10, 9, 0);
    const mudada = criada + 26 * 60 * 60_000 + 30_000;
    const antes = linhasLogicas(montarIcs({ ...evento, revisao: revisaoDoIcs(criada, criada), modificadoEmMs: criada }, AGORA));
    const depois = linhasLogicas(montarIcs({ ...evento, inicioMs: INICIO + 5 * 60 * 60_000, revisao: revisaoDoIcs(criada, mudada), modificadoEmMs: mudada }, AGORA));
    const valor = (linhas: string[], nome: string) => linhas.find(linha => linha.startsWith(`${nome}:`))?.slice(nome.length + 1);
    expect(valor(depois, "UID")).toBe(valor(antes, "UID"));
    expect(valor(antes, "SEQUENCE")).toBe("0");
    expect(valor(depois, "SEQUENCE")).toBe(String(26 * 60 * 60 + 30));
    expect(Number(valor(depois, "SEQUENCE"))).toBeGreaterThan(Number(valor(antes, "SEQUENCE")));
    expect(valor(depois, "LAST-MODIFIED")).toBe("20261111T110030Z");
    expect(valor(depois, "DTSTART")).toBe("20261120T220000Z");
    // As duas propriedades ficam dentro do evento.
    expect(depois.indexOf("SEQUENCE:93630")).toBeLessThan(depois.indexOf("END:VEVENT"));
    expect(depois.indexOf("LAST-MODIFIED:20261111T110030Z")).toBeGreaterThan(depois.indexOf("BEGIN:VEVENT"));
  });

  it("revisão que não é inteiro positivo vira 0; sem a última mudança, sem LAST-MODIFIED", () => {
    for (const revisao of [-3, 1.5, Number.NaN]) {
      expect(linhasLogicas(montarIcs({ ...evento, revisao }, AGORA))).toContain("SEQUENCE:0");
    }
    expect(montarIcs(evento, AGORA)).not.toContain("LAST-MODIFIED");
  });
});

describe("revisaoDoIcs", () => {
  it("os segundos entre criar e a última mudança: cresce a cada mudança", () => {
    const criada = Date.UTC(2026, 10, 10, 9, 0);
    expect(revisaoDoIcs(criada, criada)).toBe(0);
    expect(revisaoDoIcs(criada, criada + 999)).toBe(0);
    expect(revisaoDoIcs(criada, criada + 61_000)).toBe(61);
    expect(revisaoDoIcs(criada, criada + 2 * 61_000)).toBeGreaterThan(revisaoDoIcs(criada, criada + 61_000));
  });

  it("relógio para trás ou valor que não é número não dá revisão negativa", () => {
    expect(revisaoDoIcs(5_000, 1_000)).toBe(0);
    expect(revisaoDoIcs(Number.NaN, 1_000)).toBe(0);
  });
});

describe("dataIcsUtc e nomeDoArquivoIcs", () => {
  it("a data sai em UTC, sem os milissegundos", () => {
    expect(dataIcsUtc(Date.UTC(2027, 0, 2, 3, 4, 5, 678))).toBe("20270102T030405Z");
  });

  it("o nome do arquivo guarda letras de qualquer escrita e troca o resto", () => {
    expect(nomeDoArquivoIcs("Reunião: Glenda / Rosber?")).toBe("Reunião-Glenda-Rosber.ics");
    expect(nomeDoArquivoIcs("会议 2026")).toBe("会议-2026.ics");
    // As marcas combinantes ficam: sem elas, o hindi perde as vogais.
    expect(nomeDoArquivoIcs("बैठक योजना")).toBe("बैठक-योजना.ics");
    expect(nomeDoArquivoIcs("اجتماع الفريق")).toBe("اجتماع-الفريق.ics");
    expect(nomeDoArquivoIcs("🎙️ ***")).toBe("reuniao.ics");
    expect(nomeDoArquivoIcs("a".repeat(100))).toBe(`${"a".repeat(60)}.ics`);
  });
});
