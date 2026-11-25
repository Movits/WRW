import { describe, expect, it } from "vitest";
import { MARCADOR_DE_CONTATO_OCULTO, ocultarContatosEmTexto } from "../shared/contato-em-texto";

/**
 * A mensagem do pedido pela entidade (pedidos-pela-entidade.ts): o contato sai
 * INTEIRO, trocado por um marcador. A máscara do registro deixava as pontas:
 * "(61) 98888-7777" virava "(6***********77" (conferência de tela, 25/11).
 */
describe("ocultarContatosEmTexto", () => {
  it("troca o telefone inteiro pelo marcador, sem parêntese aberto nem dígito à mostra", () => {
    const r = ocultarContatosEmTexto("Ligue (61) 98888-7777 depois das 14h");
    expect(r).toBe(`Ligue ${MARCADOR_DE_CONTATO_OCULTO} depois das 14h`);
    expect(r).not.toMatch(/\(6|77/);
  });

  it("troca e-mail e telefone da mesma mensagem, e deixa preço e ano", () => {
    const r = ocultarContatosEmTexto("Lote de 2025-2026 a R$ 1500. Escreva a ana@exemplo.com ou +55 11 99999-8888");
    expect(r).toBe(`Lote de 2025-2026 a R$ 1500. Escreva a ${MARCADOR_DE_CONTATO_OCULTO} ou ${MARCADOR_DE_CONTATO_OCULTO}`);
  });

  it("texto sem contato não muda", () => {
    expect(ocultarContatosEmTexto("Quero comprar café")).toBe("Quero comprar café");
  });
});
