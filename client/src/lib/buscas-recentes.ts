import { BUSCAS_RECENTES_MAX, comBuscaRecente, TERMO_DA_BUSCA_MAX } from "@shared/busca-de-reunioes";

/**
 * As buscas recentes entre as reuniões (H7b), neste aparelho: é conveniência
 * de quem busca, e não dado que precise valer em outro aparelho. A chave leva a
 * conta (o openId de quem está logada), para outra pessoa no mesmo navegador
 * não ver as buscas da anterior, e a tela tem o "Limpar". O navegador pode
 * recusar o armazenamento (aba anônima, dados bloqueados): toda leitura e
 * escrita é protegida, e sem ele a busca funciona igual, só sem as recentes.
 *
 * O prefixo `mmm.` segue o das outras chaves do navegador das usuárias (nome
 * gravado, que não se renomeia: ver o CLAUDE.md da raiz).
 */
const PREFIXO = "mmm.buscasDeReunioes.";

function chave(conta: string) {
  return `${PREFIXO}${conta}`;
}

export function lerBuscasRecentes(conta: string | null | undefined): string[] {
  if (!conta) return [];
  try {
    const bruto = window.localStorage.getItem(chave(conta));
    const lista: unknown = bruto ? JSON.parse(bruto) : [];
    return Array.isArray(lista)
      ? lista.filter((termo): termo is string => typeof termo === "string" && !!termo.trim()).map(termo => termo.slice(0, TERMO_DA_BUSCA_MAX)).slice(0, BUSCAS_RECENTES_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Guarda o termo na frente das recentes e devolve a lista como ficou (a da tela, mesmo se o navegador recusar guardar). */
export function guardarBuscaRecente(conta: string | null | undefined, termo: string): string[] {
  const nova = comBuscaRecente(lerBuscasRecentes(conta), termo);
  if (!conta) return nova;
  try {
    window.localStorage.setItem(chave(conta), JSON.stringify(nova));
  } catch {
    // Sem armazenamento: a lista vale só nesta tela.
  }
  return nova;
}

export function limparBuscasRecentes(conta: string | null | undefined): void {
  if (!conta) return;
  try {
    window.localStorage.removeItem(chave(conta));
  } catch {
    // Sem armazenamento, não há o que limpar.
  }
}

/**
 * Apaga as buscas recentes de todas as contas deste navegador. Sair da conta é
 * o momento, pela mesma razão do rascunho do cadastro (useAuth): em computador
 * compartilhado, o que uma conta buscou não fica à espera de quem entrar depois.
 */
export function apagarBuscasRecentesDoAparelho(): void {
  try {
    const area = window.localStorage;
    const chaves: string[] = [];
    for (let i = 0; i < area.length; i++) {
      const atual = area.key(i);
      if (atual?.startsWith(PREFIXO)) chaves.push(atual);
    }
    for (const atual of chaves) area.removeItem(atual);
  } catch {
    // Sem o armazenamento, ou bloqueado: não há o que apagar.
  }
}
