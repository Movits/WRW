import { describe, expect, it } from "vitest";
import { ehDaWrw, lerMensagem, mensagemDaWrw } from "../mobile/ponte";

/**
 * A ponte entre o site e o app das lojas (mobile/ponte.ts) só aceita mensagem
 * vinda de uma página da WRW, e no formato de cada tipo (ressalva da validação
 * da #248). O arquivo não importa nada do React Native, então o teste roda no
 * CI da raiz, sem as dependências do app.
 */
const WRW = "https://wrwglobal.org/dashboard";
const rota = JSON.stringify({ tipo: "rota", caminho: "/meetings" });

describe("ponte do app — a origem", () => {
  it("aceita só https em wrwglobal.org e www.wrwglobal.org", () => {
    expect(ehDaWrw("https://wrwglobal.org/")).toBe(true);
    expect(ehDaWrw("https://www.wrwglobal.org/gravar?agendada=1")).toBe(true);
    expect(ehDaWrw("http://wrwglobal.org/")).toBe(false);
    expect(ehDaWrw("https://wrwglobal.org.golpe.com/")).toBe(false);
    expect(ehDaWrw("https://golpe.com/?wrwglobal.org")).toBe(false);
    expect(ehDaWrw("about:blank")).toBe(false);
    expect(ehDaWrw("")).toBe(false);
    expect(ehDaWrw(undefined)).toBe(false);
  });

  it("mensagem de outra origem não faz nada, mesmo bem formada", () => {
    expect(mensagemDaWrw("https://golpe.com/", rota)).toBeNull();
    expect(mensagemDaWrw("https://wrwglobal.org.golpe.com/", JSON.stringify({ tipo: "microfone", id: 1 }))).toBeNull();
    expect(mensagemDaWrw("about:blank", JSON.stringify({ tipo: "gravando", ativo: true }))).toBeNull();
    expect(mensagemDaWrw(undefined, rota)).toBeNull();
  });

  it("a mesma mensagem vinda da WRW passa", () => {
    expect(mensagemDaWrw(WRW, rota)).toEqual({ tipo: "rota", caminho: "/meetings" });
  });
});

describe("ponte do app — o formato de cada tipo", () => {
  it("aceita cada tipo no formato certo", () => {
    expect(lerMensagem(JSON.stringify({ tipo: "log", nivel: "error", texto: "falhou" }))).toEqual({ tipo: "log", nivel: "error", texto: "falhou" });
    expect(lerMensagem(JSON.stringify({ tipo: "microfone", id: 3 }))).toEqual({ tipo: "microfone", id: 3 });
    expect(lerMensagem(JSON.stringify({ tipo: "gravando", ativo: false }))).toEqual({ tipo: "gravando", ativo: false });
    expect(lerMensagem(JSON.stringify({ tipo: "idioma", lang: "ar", dir: "rtl" }))).toEqual({ tipo: "idioma", lang: "ar", dir: "rtl" });
  });

  it("recusa o que está fora do formato", () => {
    expect(lerMensagem("não é JSON")).toBeNull();
    expect(lerMensagem("null")).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "outra-coisa" }))).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "microfone", id: "1" }))).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "microfone", id: -1 }))).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "gravando", ativo: "sim" }))).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "rota", caminho: "https://golpe.com" }))).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "rota", caminho: `/${"x".repeat(3000)}` }))).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "idioma", lang: "pt-BR", dir: "diagonal" }))).toBeNull();
    expect(lerMensagem(JSON.stringify({ tipo: "log", nivel: 1, texto: "x" }))).toBeNull();
  });

  it("o texto do log é cortado em 4000 caracteres", () => {
    const longo = lerMensagem(JSON.stringify({ tipo: "log", nivel: "warn", texto: "y".repeat(10_000) }));
    expect(longo?.tipo === "log" && longo.texto.length).toBe(4000);
  });
});
