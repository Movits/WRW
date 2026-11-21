/**
 * O tamanho do lote do tRPC: várias chamadas num pedido só
 * (/api/trpc/a,b,c?batch=1). O limite da API conta o lote como um pedido, e o
 * tRPC roda as chamadas dele em paralelo: sem teto, um procedimento caro (o
 * scrypt da senha do link, a leitura de uma transcrição inteira) virava
 * amplificador, com centenas de chamadas num pedido. O servidor recusa o lote
 * maior que CHAMADAS_POR_LOTE_MAX (server/_core/index.ts), e o navegador corta
 * os dele em CHAMADAS_POR_LOTE_NO_NAVEGADOR (client/src/main.tsx).
 *
 * O do servidor fica mais alto de propósito: a aba aberta antes do deploy não
 * corta o lote e junta num só tudo o que a tela pede de uma vez (o Dashboard
 * pede uns 14, mais os do cabeçalho).
 */
export const CHAMADAS_POR_LOTE_MAX = 50;
export const CHAMADAS_POR_LOTE_NO_NAVEGADOR = 20;
