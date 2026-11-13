import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { criarTeto, MAXIMO_DE_CHAVES_POR_TETO } from "./assistente-de-texto";

/**
 * O teto em memória (criarTeto) protege login, cadastro e "esqueci a senha",
 * com chaves que quem abusa escolhe (endereços, e-mails). Antes, passando de
 * 5000 chaves o Map inteiro era zerado: bastava girar chaves para apagar o
 * contador de todo mundo. Agora sai só a chave usada há mais tempo.
 */
const codigo = (acao: () => void) => {
  try {
    acao();
    return "ok";
  } catch (erro) {
    return erro instanceof TRPCError ? erro.code : String(erro);
  }
};

describe("criarTeto", () => {
  it("barra a partir do máximo na janela, por chave", () => {
    const teto = criarTeto(3, 60_000, "chega");
    for (let i = 0; i < 3; i++) expect(codigo(() => teto.reservar("a"))).toBe("ok");
    expect(codigo(() => teto.reservar("a"))).toBe("TOO_MANY_REQUESTS");
    expect(codigo(() => teto.reservar("b"))).toBe("ok");
  });

  it(`girar mais de ${MAXIMO_DE_CHAVES_POR_TETO} chaves não zera o contador de quem acabou de usar`, () => {
    const teto = criarTeto(1, 60_000, "chega");
    // Chaves antigas, de quem abusa, cada uma já no máximo.
    for (let i = 0; i < MAXIMO_DE_CHAVES_POR_TETO; i++) teto.reservar(`giro-${i}`);
    // A vítima esgota o próprio teto, depois de todas elas.
    teto.reservar("vitima|conta@exemplo.test");
    // Mais 100 chaves novas: com o clear() antigo, a vítima voltaria a zero.
    for (let i = 0; i < 100; i++) teto.reservar(`giro-novo-${i}`);

    expect(codigo(() => teto.reservar("vitima|conta@exemplo.test"))).toBe("TOO_MANY_REQUESTS");
    // Quem saiu foi a chave mais antiga (ainda no máximo, ela seria barrada).
    expect(codigo(() => teto.reservar("giro-0"))).toBe("ok");
    expect(codigo(() => teto.reservar("giro-4999"))).toBe("TOO_MANY_REQUESTS");
  });

  it("reservar de novo move a chave para o fim: a usada há mais tempo é a que sai", () => {
    const teto = criarTeto(2, 60_000, "chega");
    teto.reservar("antiga-mas-ativa");
    for (let i = 0; i < MAXIMO_DE_CHAVES_POR_TETO - 1; i++) teto.reservar(`k-${i}`);
    // Usada de novo agora: vai para o fim da fila de saída.
    teto.reservar("antiga-mas-ativa");
    teto.reservar("uma-a-mais");

    expect(codigo(() => teto.reservar("antiga-mas-ativa"))).toBe("TOO_MANY_REQUESTS");
    // k-0 era a mais antiga e saiu: reservar duas vezes cabe de novo.
    teto.reservar("k-0");
    expect(codigo(() => teto.reservar("k-0"))).toBe("ok");
  });

  // O pedido que falha antes de usar a vaga (banco fora do ar no "esqueci a
  // senha") a devolve: sem isso, três quedas seguidas gastavam o teto de 3.
  it("liberar devolve a vaga da reserva, uma vez só", () => {
    const teto = criarTeto(2, 60_000, "chega");
    const liberar = teto.reservar("a");
    teto.reservar("a");
    expect(codigo(() => teto.reservar("a"))).toBe("TOO_MANY_REQUESTS");

    liberar();
    expect(codigo(() => teto.reservar("a"))).toBe("ok");
    // Chamar de novo não abre vaga a mais.
    liberar();
    expect(codigo(() => teto.reservar("a"))).toBe("TOO_MANY_REQUESTS");
  });

  it("liberar uma chave não mexe nas outras, e liberar depois que a chave saiu do Map não quebra", () => {
    const teto = criarTeto(1, 60_000, "chega");
    const liberarA = teto.reservar("a");
    teto.reservar("b");
    liberarA();
    expect(codigo(() => teto.reservar("b"))).toBe("TOO_MANY_REQUESTS");
    expect(codigo(() => teto.reservar("a"))).toBe("ok");

    const liberarVelha = teto.reservar("velha");
    for (let i = 0; i < MAXIMO_DE_CHAVES_POR_TETO; i++) teto.reservar(`giro-${i}`);
    expect(() => liberarVelha()).not.toThrow();
  });
});
