import { describe, expect, it } from "vitest";
import { idiomaDoPush, mensagemDoAviso, TEXTOS_DO_PUSH, tokenValido } from "./push-no-celular";

/**
 * As partes do push no celular que não precisam de banco: o formato do token,
 * o idioma do aparelho e o texto de cada aviso. O texto nunca leva o título da
 * reunião nem o texto da ação: o push passa pelos servidores do Expo, do Google
 * e da Apple.
 */
describe("push no celular — o texto", () => {
  it("aceita só o token no formato do Expo", () => {
    expect(tokenValido("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(tokenValido("ExpoPushToken[AbC_123-xyzAbC_123-xyz]")).toBe(true);
    expect(tokenValido("ExponentPushToken[]")).toBe(false);
    expect(tokenValido("um texto qualquer")).toBe(false);
    expect(tokenValido("ExponentPushToken[abc def ghi jkl]")).toBe(false);
  });

  it("acha o idioma da tela do app entre os 10, e cai no pt-BR fora deles", () => {
    expect(idiomaDoPush("pt-BR")).toBe("pt-BR");
    expect(idiomaDoPush("pt")).toBe("pt-BR");
    expect(idiomaDoPush("en-US")).toBe("en");
    expect(idiomaDoPush("AR")).toBe("ar");
    expect(idiomaDoPush("zh-CN")).toBe("zh");
    expect(idiomaDoPush("it")).toBe("pt-BR");
    expect(idiomaDoPush(null)).toBe("pt-BR");
  });

  it("reunião pronta: o título pelo resumo, no idioma do aparelho, sem o título da reunião", () => {
    const pronta = mensagemDoAviso({ type: "reuniao_pronta", actionUrl: "/meetings/abc", parametros: { titulo: "Reunião sigilosa com o banco", resumo: "pronto" } }, "en");
    expect(pronta).toEqual({ title: TEXTOS_DO_PUSH.en.reuniaoPronta, body: TEXTOS_DO_PUSH.en.corpo, url: "/meetings/abc" });
    expect(JSON.stringify(pronta)).not.toContain("sigilosa");
    const semResumo = mensagemDoAviso({ type: "reuniao_pronta", actionUrl: "/meetings/abc", parametros: { titulo: "x", resumo: "falhou" } }, "pt-BR");
    expect(semResumo?.title).toBe(TEXTOS_DO_PUSH["pt-BR"].reuniaoProntaSemResumo);
  });

  it("lembrete da ação: texto genérico, sem o texto da ação", () => {
    const acao = mensagemDoAviso({ type: "lembrete", actionUrl: "/proximas-acoes?acao=1", parametros: { origem: "acao", texto: "Mandar a proposta ao cliente secreto", prazo: "2026-11-27" } }, "pt-BR");
    expect(acao?.title).toBe(TEXTOS_DO_PUSH["pt-BR"].lembreteDaAcao);
    expect(JSON.stringify(acao)).not.toContain("secreto");
  });

  it("lembrete da reunião da agenda: a hora no fuso em que foi marcada, sem o título", () => {
    // 27/11/2026 17:30 UTC = 14:30 em São Paulo.
    const inicioEm = Date.UTC(2026, 10, 27, 17, 30);
    const agenda = mensagemDoAviso({ type: "lembrete", actionUrl: "/gravar?agendada=9", parametros: { origem: "agenda", titulo: "Almoço confidencial", inicioEm, fuso: "America/Sao_Paulo" } }, "pt-BR");
    expect(agenda?.title).toBe("Lembrete: reunião às 14:30");
    expect(JSON.stringify(agenda)).not.toContain("confidencial");
    expect(agenda?.url).toBe("/gravar?agendada=9");
  });

  it("parâmetros fora da forma: o aviso não vai por push", () => {
    expect(mensagemDoAviso({ type: "reuniao_pronta", actionUrl: null, parametros: null }, "pt-BR")).toBeNull();
    expect(mensagemDoAviso({ type: "lembrete", actionUrl: null, parametros: { origem: "outra" } }, "pt-BR")).toBeNull();
  });

  it("os 10 idiomas têm os cinco textos, e a hora entra no lembrete da reunião", () => {
    for (const textos of Object.values(TEXTOS_DO_PUSH)) {
      for (const valor of Object.values(textos)) expect(valor.trim().length).toBeGreaterThan(0);
      expect(textos.lembreteDaReuniao).toContain("{{hora}}");
    }
  });
});
