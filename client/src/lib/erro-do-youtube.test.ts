import { afterEach, describe, expect, it } from "vitest";
import i18n, { LANGUAGES } from "@/i18n";
import { CODIGOS_DE_ERRO_DO_YOUTUBE, VIDEOS_DO_YOUTUBE_POR_DIA } from "@shared/youtube";
import { fraseDoErroDoYoutube, fraseDoPedidoDoYoutube } from "./erro-do-youtube";

/**
 * Os erros do vídeo do YouTube (H13) na tela: o servidor manda o CÓDIGO
 * (processing_error, ou a mensagem do erro do tRPC), e a tela o traduz no
 * idioma de quem lê. Nenhum código sai cru, em nenhum dos 10 idiomas.
 */

const t = (chave: string, opcoes?: Record<string, unknown>) => i18n.t(chave, opcoes);

afterEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

describe("fraseDoErroDoYoutube", () => {
  it.each(LANGUAGES.map(idioma => idioma.code))("em %s, cada código vira uma frase traduzida, nunca o código nem a chave", async idioma => {
    await i18n.changeLanguage(idioma);
    const frases = CODIGOS_DE_ERRO_DO_YOUTUBE.map(codigo => fraseDoErroDoYoutube(codigo, t));
    for (const [i, frase] of frases.entries()) {
      expect(frase, CODIGOS_DE_ERRO_DO_YOUTUBE[i]).toBeTruthy();
      expect(frase).not.toContain("YOUTUBE_");
      expect(frase).not.toContain("meetings.youtube");
    }
    // Uma frase por código: dois motivos diferentes não viram a mesma frase.
    expect(new Set(frases).size).toBe(CODIGOS_DE_ERRO_DO_YOUTUBE.length);
  });

  it("o teto diz quantos vídeos por dia", () => {
    expect(fraseDoErroDoYoutube("YOUTUBE_TETO_DIARIO", t)).toContain(String(VIDEOS_DO_YOUTUBE_POR_DIA));
  });

  it("o que não é código do vídeo não é traduzido aqui", () => {
    expect(fraseDoErroDoYoutube("ERRO_INTERROMPIDO", t)).toBeNull();
    expect(fraseDoErroDoYoutube(null, t)).toBeNull();
    expect(fraseDoErroDoYoutube("Não foi possível transcrever o áudio.", t)).toBeNull();
  });
});

describe("fraseDoPedidoDoYoutube: a recusa do resumir e do Tentar de novo", () => {
  it("o código do vídeo na mensagem vale mais que o código tRPC", () => {
    expect(fraseDoPedidoDoYoutube({ message: "YOUTUBE_TETO_DIARIO", data: { code: "TOO_MANY_REQUESTS" } }, t))
      .toBe("Você já mandou 5 vídeos à IA nas últimas 24 horas, o limite de um dia. Tente de novo mais tarde.");
  });

  it.each([
    ["NOT_FOUND", "Reunião não encontrada. Ela pode ter sido excluída, ou o link é de outra conta."],
    ["CONFLICT", "Esta reunião não está com falha ou já está sendo processada."],
  ])("sem código do vídeo, %s vira a frase da tela, e não a frase do servidor em português", (codigo, frase) => {
    expect(fraseDoPedidoDoYoutube({ message: "frase do servidor", data: { code: codigo } }, t)).toBe(frase);
  });

  it("em inglês, a recusa sai em inglês", async () => {
    await i18n.changeLanguage("en");
    expect(fraseDoPedidoDoYoutube({ message: "YOUTUBE_LINK_INVALIDO", data: { code: "BAD_REQUEST" } }, t))
      .toBe("This link isn't to a YouTube video. Copy the video's address (youtube.com/watch?v=… or youtu.be/…).");
  });
});
