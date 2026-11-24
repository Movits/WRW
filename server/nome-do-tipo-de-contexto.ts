/**
 * A marca virou WRW em 15/09/2026 e MarquesaMatch em 23/11/2026, mas o catálogo de
 * tipos de contexto foi semeado no banco com "Evento do MMM" (migração 0003,
 * slug `evento-mmm`) e esse nome chega à tela cru: filtro da página Contextos,
 * selo do tipo no cartão, no detalhe e no perfil do contato.
 *
 * Migração não edita dado à mão (CLAUDE.md), e o slug é chave: fica. A troca é
 * na leitura, e só do nome exato da semente — se alguém renomeou o tipo no
 * banco, o nome escolhido prevalece.
 */
const NOME_SEMEADO_PELA_MARCA: Readonly<Record<string, { semeado: string; atual: string }>> = {
  "evento-mmm": { semeado: "Evento do MMM", atual: "Evento da MarquesaMatch" },
};

export function nomeDoTipoDeContexto<T extends string | null | undefined>(slug: string | null | undefined, nome: T): T | string {
  const troca = slug ? NOME_SEMEADO_PELA_MARCA[slug] : undefined;
  return troca && nome === troca.semeado ? troca.atual : nome;
}
