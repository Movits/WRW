import { aoMudarAOcupacao, desocupadaPeloFimDaSessao, sessaoOcupada } from "@/lib/sessao-ocupada";

/**
 * Depois de um deploy, uma aba aberta antes dele ainda pede os chunks antigos
 * (nomes com hash) e o servidor responde 404 de propósito (fallthrough:false
 * em server/_core/vite.ts); o Vite avisa pelo evento vite:preloadError antes
 * de a tela cair no ErrorBoundary. Recarregar uma vez traz o index.html novo
 * (que sai com no-cache). A marca no sessionStorage evita laço se a causa for
 * outra.
 *
 * Com a sessão ocupada (lib/sessao-ocupada.ts: gravando, enviando ou com áudio
 * por enviar), recarregar perderia o áudio, que só existe na memória da aba. Aí
 * a aba NÃO recarrega: avisa que há versão nova e recarrega sozinha quando a
 * sessão desocupar. O erro do Vite também não é cancelado, para quem pediu o
 * pedaço receber a falha de verdade, e não um módulo vazio.
 *
 * O limite: o pedaço que falhou continua sem código. Se era a tela pedida (a
 * dona saiu do gravador por um link do menu), o ErrorBoundary do App troca o
 * app inteiro, o Toaster junto, pela tela de erro, e a tela de antes desmonta:
 * a gravação e o áudio por enviar se perdem como já se perdiam nessa ida sem
 * deploy, e o aviso não aparece. O que este adiamento salva é o envio já no ar
 * (que não depende da tela) e qualquer falha fora do caminho da tela aberta.
 *
 * O fim da sessão (Sair ou excluir a conta, que chamam liberarTodas) desocupa
 * sem recarregar: o app já está saindo para o login ou para a landing.
 */

export const MARCA_DO_RECARREGAMENTO = "mmm:recarregado-por-chunk-antigo";

export type DependenciasDaVersaoNova = {
  recarregar: () => void;
  enderecoAtual: () => string;
  /** Mostra o aviso de versão nova (fica na tela até ser dispensado). */
  avisar: () => void;
  dispensarAviso: () => void;
  armazenamento: () => Pick<Storage, "getItem" | "setItem">;
};

let esperandoDesocupar = false;

/** Só para os testes: esquece a espera de um teste anterior. */
export function _reiniciarParaTestes() {
  esperandoDesocupar = false;
}

/** Grava a marca e diz se esta aba ainda pode recarregar neste endereço. */
function podeRecarregar(deps: DependenciasDaVersaoNova): boolean {
  const endereco = deps.enderecoAtual();
  try {
    const armazenamento = deps.armazenamento();
    if (armazenamento.getItem(MARCA_DO_RECARREGAMENTO) === endereco) return false;
    armazenamento.setItem(MARCA_DO_RECARREGAMENTO, endereco);
  } catch {
    // sessionStorage bloqueado: recarrega assim mesmo, uma vez por aba nova.
  }
  return true;
}

export function tratarChunkAntigo(evento: Event, deps: DependenciasDaVersaoNova) {
  if (sessaoOcupada()) {
    if (esperandoDesocupar) return;
    esperandoDesocupar = true;
    deps.avisar();
    // O ouvinte do beforeunload (sessao-ocupada.ts) foi assinado no carregamento
    // daquele módulo, antes deste: ao desocupar, ele sai antes do recarregar, e
    // o navegador não pergunta. O teste confere.
    const pararDeOuvir = aoMudarAOcupacao(() => {
      if (sessaoOcupada()) return;
      pararDeOuvir();
      esperandoDesocupar = false;
      deps.dispensarAviso();
      if (desocupadaPeloFimDaSessao()) return;
      if (podeRecarregar(deps)) deps.recarregar();
    });
    return;
  }
  if (!podeRecarregar(deps)) return;
  evento.preventDefault();
  deps.recarregar();
}
