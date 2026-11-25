import { describe, expect, it } from "vitest";
import {
  ACOES_DA_ENTIDADE, ESTADOS_DO_PEDIDO, camposDoCanal, estadoDeOrigem, estadoEfetivo, podePedirDeNovo, proximoEstado,
} from "../shared/pedidos-pela-entidade";

/** As regras puras do pedido de contato pela entidade (N2, shared/pedidos-pela-entidade.ts). */
describe("pedido pela entidade — passagens", () => {
  it("cada ação parte de um estado só, e o estado de origem é o do WHERE", () => {
    expect(proximoEstado("na_entidade", "encaminhar")).toBe("encaminhado");
    expect(proximoEstado("na_entidade", "nao_encaminhar")).toBe("nao_encaminhado");
    expect(proximoEstado("encaminhado", "aceitar")).toBe("aceito");
    expect(proximoEstado("encaminhado", "recusar")).toBe("recusado");
    for (const estado of ESTADOS_DO_PEDIDO) {
      for (const acao of ACOES_DA_ENTIDADE) {
        const destino = proximoEstado(estado, acao);
        expect(destino === null).toBe(estado !== estadoDeOrigem(acao));
      }
    }
  });

  it("nada sai de um estado final nem do expirado", () => {
    for (const estado of ["aceito", "recusado", "nao_encaminhado", "expirado"] as const) {
      for (const acao of ACOES_DA_ENTIDADE) expect(proximoEstado(estado, acao)).toBeNull();
    }
  });

  it("o aberto com o prazo vencido vale como expirado; o decidido não muda", () => {
    expect(estadoEfetivo({ estado: "na_entidade", expiraEm: 1000 }, 1000)).toBe("expirado");
    expect(estadoEfetivo({ estado: "encaminhado", expiraEm: 1000 }, 999)).toBe("encaminhado");
    expect(estadoEfetivo({ estado: "aceito", expiraEm: 1 }, 1000)).toBe("aceito");
  });

  it("só o expirado se pede de novo: a recusa e o não encaminhado são resposta", () => {
    expect(ESTADOS_DO_PEDIDO.filter(podePedirDeNovo)).toEqual(["expirado"]);
  });

  it("o canal revela só o campo escolhido", () => {
    expect(camposDoCanal("telefone")).toEqual({ telefone: true, email: false });
    expect(camposDoCanal("email")).toEqual({ telefone: false, email: true });
    expect(camposDoCanal("ambos")).toEqual({ telefone: true, email: true });
  });
});
