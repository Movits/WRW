import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import type { OpcaoDeLocal } from "@/lib/cascata-de-local";

// Combobox com busca, um por nível da cascata país → estado → cidade
// (PaisEstadoCidade). Segue o padrão de combobox da WAI-ARIA: o <input> tem
// role="combobox", a lista é um listbox, a opção destacada vai em
// aria-activedescendant, e as setas, o Enter e o Esc funcionam sem mouse.
//
// Dois modos:
//  - escolha (padrão): o texto digitado é só a busca. Ao abrir, o campo fica
//    vazio e mostra o valor escolhido como placeholder; ao sair sem escolher,
//    volta a mostrar o valor. É o país e o estado: só vale o que está na lista.
//  - livre: o texto digitado É o valor (onTexto a cada tecla). É a cidade:
//    quem mora em distrito ou vila fora da lista digita o nome e segue.
//
// O campo é o <Input> do shadcn, e não um <input> cru, por causa do IME: quem
// digita 東京 confirma a composição com Enter, e o Input engole esse Enter
// (client/src/hooks/useComposition.ts). Num <input> cru, esse Enter escolheria
// uma sugestão no meio da digitação.
//
// No celular: o campo tem a altura de toque do formulário, a lista rola dentro
// dela mesma (max-h) e cada opção é um alvo inteiro de linha. A escolha é no
// clique; o mousedown só impede que o campo perca o foco antes do clique.

export interface CampoComBuscaProps {
  rotulo: string;
  /** O que o campo mostra fechado: o rótulo do valor escolhido, ou a cidade. */
  valorExibido: string;
  /** Opções para o que foi digitado ("" = campo vazio). */
  filtrar: (consulta: string) => OpcaoDeLocal[];
  onEscolher: (opcao: OpcaoDeLocal) => void;
  /** Só no modo livre: o texto digitado, a cada tecla. */
  onTexto?: (texto: string) => void;
  livre?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Linha de ajuda embaixo do campo (por que está desligado, carregando...). */
  dica?: string;
  /** Mostrado com a lista aberta e nada encontrado. */
  textoSemResultado: string;
  /** Ligado ao fim do campo (crédito da fonte dos dados). */
  rodape?: React.ReactNode;
  classeDoCampo?: string;
  classeDoRotulo?: string;
}

/** Teto de linhas desenhadas: 250 países cabem, uma lista maior não ajuda a escolher. */
const LIMITE_DE_LINHAS = 300;

export default function CampoComBusca({
  rotulo,
  valorExibido,
  filtrar,
  onEscolher,
  onTexto,
  livre = false,
  placeholder,
  disabled = false,
  dica,
  textoSemResultado,
  rodape,
  // Padrão: o visual do cadastro (Onboarding). O "h-auto" desfaz a altura fixa
  // do Input do shadcn, para o py-3 valer.
  classeDoCampo = "h-auto w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder-white/25 focus-visible:ring-0 focus:border-[#c98f70]/60 transition-all duration-200 text-sm disabled:opacity-50",
  classeDoRotulo = "block text-sm font-medium text-white/70 mb-2",
}: CampoComBuscaProps) {
  const id = useId();
  const idDoCampo = `${id}-campo`;
  const idDaLista = `${id}-lista`;
  const idDaDica = `${id}-dica`;
  const [aberto, setAberto] = useState(false);
  const [consulta, setConsulta] = useState("");
  const [destacado, setDestacado] = useState(-1);
  const lista = useRef<HTMLUListElement | null>(null);

  const texto = livre ? valorExibido : aberto ? consulta : valorExibido;
  const opcoes = useMemo(
    () => (aberto ? filtrar(texto).slice(0, LIMITE_DE_LINHAS) : []),
    [aberto, filtrar, texto]
  );

  // A opção destacada pelas setas fica à vista dentro da lista que rola.
  useEffect(() => {
    if (destacado < 0 || !lista.current) return;
    const linha = lista.current.children[destacado] as HTMLElement | undefined;
    linha?.scrollIntoView?.({ block: "nearest" });
  }, [destacado]);

  const abrir = () => {
    if (disabled) return;
    if (!livre && !aberto) setConsulta("");
    setAberto(true);
  };

  const fechar = () => {
    setAberto(false);
    setDestacado(-1);
    setConsulta("");
  };

  const escolher = (opcao: OpcaoDeLocal) => {
    onEscolher(opcao);
    fechar();
  };

  const aoTeclar = (evento: React.KeyboardEvent<HTMLInputElement>) => {
    if (evento.key === "Escape") {
      if (aberto) evento.preventDefault();
      fechar();
      return;
    }
    if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
      evento.preventDefault();
      if (!aberto) {
        abrir();
        return;
      }
      if (!opcoes.length) return;
      setDestacado(anterior =>
        evento.key === "ArrowDown"
          ? (anterior + 1) % opcoes.length
          : anterior <= 0
            ? opcoes.length - 1
            : anterior - 1
      );
      return;
    }
    if (
      evento.key === "Enter" &&
      aberto &&
      destacado >= 0 &&
      opcoes[destacado]
    ) {
      evento.preventDefault();
      escolher(opcoes[destacado]);
    }
  };

  const mostrandoLista = aberto && opcoes.length > 0;
  const nadaEncontrado = aberto && !opcoes.length && texto.trim().length > 0;
  const linhaDeAjuda = nadaEncontrado ? textoSemResultado : dica;

  return (
    <div>
      <label htmlFor={idDoCampo} className={classeDoRotulo}>
        {rotulo}
      </label>
      <div className="relative">
        <Input
          id={idDoCampo}
          type="text"
          value={texto}
          disabled={disabled}
          onChange={evento => {
            const novo = evento.target.value;
            if (livre) onTexto?.(novo);
            else setConsulta(novo);
            setAberto(true);
            setDestacado(-1);
          }}
          onFocus={abrir}
          onClick={abrir}
          onBlur={fechar}
          onKeyDown={aoTeclar}
          placeholder={!livre && valorExibido ? valorExibido : placeholder}
          className={classeDoCampo}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          role="combobox"
          aria-expanded={mostrandoLista}
          aria-controls={idDaLista}
          aria-autocomplete="list"
          aria-activedescendant={
            mostrandoLista && destacado >= 0
              ? `${idDaLista}-${destacado}`
              : undefined
          }
          aria-describedby={linhaDeAjuda ? idDaDica : undefined}
        />
        {mostrandoLista && (
          <ul
            ref={lista}
            id={idDaLista}
            role="listbox"
            aria-label={rotulo}
            className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-[#1b1714] py-1 shadow-xl"
          >
            {opcoes.map((opcao, indice) => (
              <li
                key={`${opcao.valor}-${indice}`}
                id={`${idDaLista}-${indice}`}
                role="option"
                aria-selected={indice === destacado}
                onMouseDown={evento => evento.preventDefault()}
                onClick={() => escolher(opcao)}
                onMouseEnter={() => setDestacado(indice)}
                className={`cursor-pointer px-4 py-2.5 text-left text-sm text-white hover:bg-white/10 ${
                  indice === destacado ? "bg-white/10" : ""
                }`}
              >
                {opcao.rotulo}
              </li>
            ))}
          </ul>
        )}
      </div>
      {linhaDeAjuda && (
        <p
          id={idDaDica}
          className="text-xs text-white/40 mt-1"
          aria-live="polite"
        >
          {linhaDeAjuda}
        </p>
      )}
      {rodape}
    </div>
  );
}
