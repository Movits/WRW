import { expect } from "vitest";

/**
 * O título de uma janela de confirmação leva o tamanho dele (de text-xs a
 * text-xl), como o "Descartar esta gravação?". Sem classe de tamanho, o h3
 * herda o global de client/src/index.css (30 px no celular, 36 px no
 * computador), e "Mandar esta reunião para a lixeira?" quebrava em três linhas
 * na janela estreita (a conferência de tela do Pacote 5b parte 1). O jsdom não
 * calcula o CSS: o que se confere é a classe no título que dá nome à janela.
 */
export function esperarTituloPequeno(janela: HTMLElement) {
  const id = janela.getAttribute("aria-labelledby");
  const titulo = id ? janela.ownerDocument.getElementById(id) : null;
  expect(titulo, "a janela tem o título que lhe dá nome").not.toBeNull();
  expect(titulo!.className).toMatch(/(^|\s)text-(xs|sm|base|lg|xl)(\s|$)/);
}
