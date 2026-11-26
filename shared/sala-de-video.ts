/**
 * A sala de vídeo da reunião (V1 do estudo docs/arquitetura/sala-de-video.md;
 * decisão do Roberto de 24/11/2026: o Daily em São Paulo, até 8 pessoas e 2
 * horas por sala, abre quem é Prata ou acima, US$ 50 por mês, visitante só com
 * o nome). A parte que o servidor e a tela dividem: os tetos, o formato do link
 * de visitante e os códigos das recusas, que a tela traduz (V2).
 */

/** Até 8 pessoas por sala, contando a dona e os visitantes. */
export const PESSOAS_POR_SALA_MAX = 8;

/** A sala dura 2 horas desde que foi aberta; quem está dentro sai no fim. */
export const SALA_DURA_MS = 2 * 60 * 60 * 1000;

/**
 * O teto de uma sala em minutos-pessoa: 8 pessoas por 120 minutos. É o que a
 * sala aberta reserva no orçamento do mês até fechar.
 */
export const TETO_DA_SALA_EM_MINUTOS = PESSOAS_POR_SALA_MAX * (SALA_DURA_MS / 60_000);

/**
 * O teto do mês em minutos-pessoa: os 10 mil grátis do Daily mais os 12.500 que
 * os US$ 50 pagam a US$ 0,004 cada (preço com vídeo visto em 24/11/2026; ver
 * "O orçamento de US$ 50 por mês" no estudo). Muda por PR quando o orçamento
 * mudar.
 */
export const MINUTOS_PESSOA_POR_MES = 22_500;

/** Ao passar desta fração do teto do mês, a administração recebe um aviso no sino (uma vez por mês). */
export const FRACAO_DO_AVISO_DO_ORCAMENTO = 0.8;

/**
 * A ficha de entrada (o token do Daily) vale 10 minutos para entrar. Quem já
 * entrou não sai quando ela vence: sai no fim da sala. Para voltar depois, a
 * tela pede outra.
 */
export const FICHA_DA_SALA_VALE_MS = 10 * 60_000;

/** O nome do visitante, como o nome de uma voz (shared/const.ts, NOME_DO_FALANTE_MAX). */
export const NOME_DO_VISITANTE_MAX = 60;

/**
 * O segredo do link de visitante: 24 bytes aleatórios (192 bits) em base64url,
 * 32 caracteres, como o convite da R1b. Só o hash (sha256) fica no banco.
 */
export const FORMATO_DO_LINK_DE_VISITANTE = /^[A-Za-z0-9_-]{32}$/;

/** Os papéis que abrem sala (Prata ou acima, decisão de 24/11), conferidos no servidor. */
export const PAPEIS_QUE_ABREM_SALA = ["silver", "gold", "president", "admin"] as const;

export function papelAbreSala(papel: string | null | undefined): boolean {
  return (PAPEIS_QUE_ABREM_SALA as readonly string[]).includes(papel ?? "");
}

/** Quem está na sala, como a dona a vê. */
export type PapelNaSala = "owner" | "participant" | "guest";

/** As recusas da sala, como CÓDIGO (a tela traduz, na V2, em client/src/lib/mensagem-de-erro.ts). */
export const RECUSAS_DA_SALA = {
  /** Sem DAILY_API_KEY e DAILY_DOMINIO (ou com valor inválido), a função não existe. */
  indisponivel: "SALA_INDISPONIVEL",
  /** Só Prata ou acima abre sala. */
  soPrataOuAcima: "SALA_SO_PRATA_OU_ACIMA",
  /** A reunião não existe, não é da dona, foi excluída ou está na lixeira. */
  reuniaoNaoEncontrada: "SALA_REUNIAO_NAO_ENCONTRADA",
  /** A sala não existe ou a conta não entra nela (a mesma frase para os dois). */
  salaNaoEncontrada: "SALA_NAO_ENCONTRADA",
  /** A sala já fechou (a dona encerrou ou passaram as 2 horas). */
  salaEncerrada: "SALA_ENCERRADA",
  /** A sala já tem 8 pessoas. */
  salaCheia: "SALA_CHEIA",
  /** O orçamento do mês não comporta outra sala; ela é recusada (decisão vetável, ver o estudo). */
  orcamentoEsgotado: "SALA_ORCAMENTO_ESGOTADO",
  /** Entrar pede o aceite do aviso de gravação, numa versão que existe. */
  avisoPedido: "SALA_AVISO_PEDIDO",
  /** O link de visitante não existe, foi desligado ou a sala fechou (a mesma frase para os três). */
  linkInvalido: "SALA_LINK_INVALIDO",
  /** O nome do visitante está vazio, longo demais ou traz e-mail ou telefone. */
  nomeInvalido: "SALA_NOME_INVALIDO",
  /** Teto de pedidos (abrir, entrar, o link de visitante). */
  muitosPedidos: "SALA_MUITOS_PEDIDOS",
  /** O Daily não respondeu ou recusou; tentar de novo. */
  fornecedorFalhou: "SALA_FORNECEDOR_FALHOU",
} as const;
