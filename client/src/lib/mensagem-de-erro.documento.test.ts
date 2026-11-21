import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { CODIGOS_DA_FALHA_DO_DOCUMENTO, DOCUMENTO_BYTES_MAX, DOCUMENTOS_POR_HORA } from "@shared/documento-da-reuniao";
import { CODIGO_ERRO_INTERROMPIDO, MENSAGEM_AUDIO_GUARDADO_AUSENTE } from "@shared/const";
import { causaDaFalhaDoDocumento, mensagemDaRecusaDoDocumento } from "./mensagem-de-erro";

/**
 * Os erros da reunião de documento (H12 e H12b) saem do servidor como CÓDIGO,
 * nunca como frase pronta em português: a rota responde `{ codigo }` e a
 * leitura em segundo plano grava o código em processing_error. A tela traduz
 * no idioma de quem lê. Aqui, com o i18n de verdade: cada código tem a frase
 * dele em pt-BR e em árabe, com os tetos certos, e o que não é código do
 * documento não vira frase do documento.
 */
const t = (chave: string, opcoes?: Record<string, unknown>) => i18n.t(chave, opcoes);

// Todos os códigos que a rota responde (server/_core/rota-do-documento.ts) e o REDE da tela.
const CODIGOS_DO_ENVIO = [
  "SEM_REUNIAO", "FORA_DO_ESTADO", "CONTEUDO_DIFERENTE", "GRANDE_DEMAIS", "VAZIO", "FORMATO",
  "SEM_SESSAO", "CADASTRO_INCOMPLETO", "MUITOS_PEDIDOS", "TENTE_DE_NOVO", "BANCO_INDISPONIVEL", "ERRO", "REDE",
];

afterEach(async () => { await i18n.changeLanguage("pt-BR"); });

describe("mensagemDaRecusaDoDocumento: o código do envio vira a frase no idioma da tela", () => {
  it("cada código tem frase traduzida (nunca a chave nem o código cru)", () => {
    for (const codigo of CODIGOS_DO_ENVIO) {
      const frase = mensagemDaRecusaDoDocumento(codigo, t);
      expect(frase, codigo).not.toMatch(/meetings\.|errors\./);
      expect(frase, codigo).not.toContain(codigo);
      expect(frase.length, codigo).toBeGreaterThan(10);
    }
  });

  it("os tetos aparecem na frase: 15 MB e 10 por hora", () => {
    expect(mensagemDaRecusaDoDocumento("GRANDE_DEMAIS", t)).toBe(`O PDF passa de ${DOCUMENTO_BYTES_MAX / 1_000_000} MB. Envie um arquivo menor ou divida o documento em partes.`);
    expect(mensagemDaRecusaDoDocumento("MUITOS_PEDIDOS", t)).toBe(`Você já enviou ${DOCUMENTOS_POR_HORA} documentos na última hora. Espere um pouco para enviar outro.`);
    expect(mensagemDaRecusaDoDocumento("FORMATO", t)).toBe("Este arquivo não é um PDF.");
  });

  it("código desconhecido, vazio ou de outro objeto: a frase geral, nunca o que veio", () => {
    for (const codigo of [undefined, "", "toString", "__proto__", "Mensagem crua do servidor"]) {
      expect(mensagemDaRecusaDoDocumento(codigo, t)).toBe("Não foi possível enviar o documento agora. Tente de novo.");
    }
  });

  it("em árabe, a frase sai em árabe", async () => {
    await i18n.changeLanguage("ar");
    expect(mensagemDaRecusaDoDocumento("FORMATO", t)).toBe("هذا الملف ليس ملف PDF.");
    expect(mensagemDaRecusaDoDocumento("GRANDE_DEMAIS", t)).toContain("15");
    for (const codigo of CODIGOS_DO_ENVIO) expect(mensagemDaRecusaDoDocumento(codigo, t), codigo).toMatch(/[؀-ۿ]/);
  });
});

describe("causaDaFalhaDoDocumento: o código gravado pela leitura em segundo plano", () => {
  it("cada código da falha tem a frase dele, diferente das outras", () => {
    const frases = CODIGOS_DA_FALHA_DO_DOCUMENTO.map(codigo => causaDaFalhaDoDocumento(codigo, t));
    for (const [i, frase] of frases.entries()) {
      expect(frase, CODIGOS_DA_FALHA_DO_DOCUMENTO[i]).toBeTruthy();
      expect(frase, CODIGOS_DA_FALHA_DO_DOCUMENTO[i]).not.toMatch(/meetings\.|DOCUMENTO_/);
    }
    expect(new Set(frases).size).toBe(frases.length);
    expect(causaDaFalhaDoDocumento("DOCUMENTO_LONGO_DEMAIS", t)).toBe("O documento é longo demais para uma leitura só. Divida o arquivo em partes menores e envie cada uma.");
  });

  it("o que não é código do documento fica com as outras causas da tela (null)", () => {
    for (const valor of [null, undefined, "", CODIGO_ERRO_INTERROMPIDO, MENSAGEM_AUDIO_GUARDADO_AUSENTE, "Erro ao consultar o banco de dados"]) {
      expect(causaDaFalhaDoDocumento(valor, t)).toBeNull();
    }
  });

  it("em árabe", async () => {
    await i18n.changeLanguage("ar");
    expect(causaDaFalhaDoDocumento("DOCUMENTO_SEM_TEXTO", t)).toMatch(/^لم يجد الذكاء الاصطناعي/);
  });
});
