/**
 * O pedido de contato pela entidade (N2, docs/arquitetura/entidades.md, seção 11).
 *
 * Quando o outro lado de uma conexão da rede global é o associado de uma
 * entidade, quem está do lado de cá não vê a empresa: vê "membro da entidade X"
 * (ou "de uma entidade parceira", se o convênio não autoriza o nome) e pode
 * PEDIR o contato pela entidade. A entidade recebe o pedido com o nome de quem
 * pede, fala com a empresa fora do app e registra o que houve. Só no "aceito"
 * quem pediu vê o nome da empresa e o canal que ela escolheu.
 *
 * Os estados e as passagens (cada passo leva o estado anterior no WHERE, como
 * no distribuidor do Smart Match):
 *
 *   na_entidade ──encaminhar──▶ encaminhado ──aceitar──▶ aceito
 *        │                           └───────recusar──▶ recusado
 *        └──────nao_encaminhar──▶ nao_encaminhado
 *   (na_entidade ou encaminhado, passado o prazo) ──▶ expirado
 *
 * Funções puras: a tela e o servidor usam as mesmas.
 */

export const ESTADOS_DO_PEDIDO = ["na_entidade", "encaminhado", "aceito", "recusado", "nao_encaminhado", "expirado"] as const;
export type EstadoDoPedido = (typeof ESTADOS_DO_PEDIDO)[number];

/** Os estados em que a entidade ainda tem o que fazer. */
export const ESTADOS_ABERTOS: readonly EstadoDoPedido[] = ["na_entidade", "encaminhado"];

export const ACOES_DA_ENTIDADE = ["encaminhar", "nao_encaminhar", "aceitar", "recusar"] as const;
export type AcaoDaEntidade = (typeof ACOES_DA_ENTIDADE)[number];

/** O canal que a empresa escolheu, entre os que a entidade já tem dela (o telefone e o e-mail cifrados da carga). */
export const CANAIS_DO_PEDIDO = ["telefone", "email", "ambos"] as const;
export type CanalDoPedido = (typeof CANAIS_DO_PEDIDO)[number];

const DIA = 86_400_000;
/** O prazo para a entidade responder, contado do pedido e renovado quando ela encaminha à empresa (vetável). */
export const PRAZO_DO_PEDIDO_MS = 30 * DIA;
/** Pedidos novos por conta em 24 horas: o pedido leva o nome de quem pede a outra conta, e a entidade é uma equipe pequena. */
export const PEDIDOS_POR_DIA_MAX = 10;
/** A mensagem opcional de quem pede; telefone e e-mail escritos nela são escondidos. */
export const MENSAGEM_DO_PEDIDO_MAX = 500;
/** Pedidos por página no painel da entidade. */
export const PEDIDOS_POR_PAGINA = 30;

/** O estado depois da ação, ou null quando a ação não vale a partir do estado atual. */
export function proximoEstado(atual: EstadoDoPedido, acao: AcaoDaEntidade): EstadoDoPedido | null {
  switch (acao) {
    case "encaminhar": return atual === "na_entidade" ? "encaminhado" : null;
    case "nao_encaminhar": return atual === "na_entidade" ? "nao_encaminhado" : null;
    case "aceitar": return atual === "encaminhado" ? "aceito" : null;
    case "recusar": return atual === "encaminhado" ? "recusado" : null;
  }
}

/** O estado de onde a ação parte (o que vai no WHERE do UPDATE). */
export function estadoDeOrigem(acao: AcaoDaEntidade): EstadoDoPedido {
  return acao === "aceitar" || acao === "recusar" ? "encaminhado" : "na_entidade";
}

/** O estado que vale agora: o pedido aberto com o prazo vencido é "expirado", ainda que a linha não tenha sido atualizada. */
export function estadoEfetivo(pedido: { estado: EstadoDoPedido; expiraEm: number }, agora = Date.now()): EstadoDoPedido {
  return ESTADOS_ABERTOS.includes(pedido.estado) && pedido.expiraEm <= agora ? "expirado" : pedido.estado;
}

/** Quem pediu e teve o pedido expirado pode pedir de novo; a recusa e o "não encaminhado" valem como resposta. */
export function podePedirDeNovo(estado: EstadoDoPedido): boolean {
  return estado === "expirado";
}

/** O que o canal escolhido revela do contato guardado. */
export function camposDoCanal(canal: CanalDoPedido): { telefone: boolean; email: boolean } {
  return { telefone: canal !== "email", email: canal !== "telefone" };
}
