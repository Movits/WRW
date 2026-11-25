import type { ReactNode } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { CircleAlert, Handshake, Sparkles, UserCheck, UserPlus, type LucideIcon } from "lucide-react";

/**
 * O resumo das conexões no Início, em frases (pedido do Nicolas, 25/11): no
 * lugar dos quatro cartões de número ("Conexões sugeridas", "Compatibilidade
 * Média", "acima de 80%" e "Conexões efetivadas"), uma lista curta que se
 * entende de bater o olho, cada linha com o toque que leva aonde agir.
 *
 * - Só aparece o que existe: zero não vira linha. A falta de conexão feita vira
 *   o próximo passo ("Aceite uma sugestão…"), e o pedido que espera resposta
 *   vem primeiro.
 * - Os números são os mesmos de antes, das mesmas consultas do Dashboard.
 *   Consulta que falhou não vira "nenhuma": diz que não carregou (o erro com
 *   "tentar de novo" está na aba logo abaixo).
 * - U3: a Bronze vê QUANTAS pessoas combinam e o convite a completar o perfil;
 *   a afinidade e o "combinam muito" são da lista, que é da Prata em diante.
 */
export type PropsDoResumo = {
  /** A lista de sugestões é desta conta (Prata em diante). */
  listaLiberada: boolean;
  /** Quantas sugestões (Bronze: quantas possíveis); undefined enquanto carrega. */
  sugestoes: number | undefined;
  sugestoesFalharam: boolean;
  /** A afinidade média da lista, em %. Só com a lista liberada. */
  afinidadeMedia?: number;
  /** Quantas da lista têm afinidade de 80% ou mais. Só com a lista liberada. */
  combinamMuito?: number;
  /** As conexões aceitas; undefined enquanto carrega ou se a consulta falhou. */
  conexoesFeitas: number | undefined;
  /** Os pedidos de conexão que esperam a resposta desta conta. */
  pedidosParaResponder: number;
  aoVerSugestoes: () => void;
  aoVerConexoes: () => void;
};

type Linha = { chave: string; Icone: LucideIcon; frase: string; detalhe?: string; acao?: ReactNode };

export function ResumoDasConexoes(props: PropsDoResumo) {
  const { t } = useTranslation();
  const linhas: Linha[] = [];

  /** O botão de uma linha; o nome acessível leva a frase, porque há mais de um "Ver". */
  const botao = (rotulo: string, frase: string, aoTocar: () => void, leve = false) => (
    <button type="button" onClick={aoTocar} aria-label={`${rotulo}: ${frase}`}
      className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${leve
        ? "border border-[#c98f70]/40 text-[#c98f70] hover:bg-[#c98f70]/10"
        : "bg-[#c98f70] text-[#1a120c] hover:bg-[#efcba8]"}`}>
      {rotulo}
    </button>
  );

  if (props.pedidosParaResponder > 0) {
    const frase = t("dashboard.resumo.pedidos", { count: props.pedidosParaResponder });
    linhas.push({ chave: "pedidos", Icone: UserPlus, frase, acao: botao(t("dashboard.resumo.responder"), frase, props.aoVerConexoes) });
  }

  if (props.sugestoesFalharam) {
    const frase = t("dashboard.resumo.falhou");
    linhas.push({ chave: "sugestoes", Icone: CircleAlert, frase, acao: botao(t("dashboard.resumo.ver"), frase, props.aoVerSugestoes, true) });
  } else if (props.sugestoes !== undefined && !props.listaLiberada) {
    // U3: a Bronze sabe quantas, e o que falta para ver quem são.
    const frase = props.sugestoes > 0 ? t("dashboard.resumo.combinam", { count: props.sugestoes }) : t("dashboard.resumo.completarPerfil");
    const completar = (
      <Link href="/profile" aria-label={`${t("dashboard.resumo.completar")}: ${frase}`}
        className="shrink-0 rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#1a120c] transition-colors hover:bg-[#efcba8]">
        {t("dashboard.resumo.completar")}
      </Link>
    );
    linhas.push({
      chave: "sugestoes", Icone: props.sugestoes > 0 ? Sparkles : UserCheck, frase,
      detalhe: props.sugestoes > 0 ? t("dashboard.resumo.completarParaVer") : undefined, acao: completar,
    });
  } else if (props.sugestoes !== undefined) {
    if (props.sugestoes > 0) {
      const frase = t("dashboard.resumo.combinam", { count: props.sugestoes });
      const detalhe = props.combinamMuito && props.combinamMuito > 0
        ? t("dashboard.resumo.combinamMuito", { count: props.combinamMuito })
        : props.afinidadeMedia !== undefined ? t("dashboard.resumo.afinidade", { valor: props.afinidadeMedia }) : undefined;
      linhas.push({ chave: "sugestoes", Icone: Sparkles, frase, detalhe, acao: botao(t("dashboard.resumo.ver"), frase, props.aoVerSugestoes) });
    } else {
      linhas.push({ chave: "sugestoes", Icone: Sparkles, frase: t("dashboard.resumo.combinam", { count: 0 }), detalhe: t("dashboard.resumo.nenhumaDesc") });
    }
  }

  if (props.conexoesFeitas !== undefined && props.conexoesFeitas > 0) {
    const frase = t("dashboard.resumo.conexoes", { count: props.conexoesFeitas });
    linhas.push({ chave: "conexoes", Icone: Handshake, frase, acao: botao(t("dashboard.resumo.abrir"), frase, props.aoVerConexoes, true) });
  } else if (props.conexoesFeitas === 0 && props.listaLiberada && (props.sugestoes ?? 0) > 0) {
    linhas.push({ chave: "conexoes", Icone: Handshake, frase: t("dashboard.resumo.primeiraConexao") });
  }

  // Carregando as sugestões, sem nada a mostrar ainda: o lugar do bloco fica guardado.
  if (linhas.length === 0) {
    if (props.sugestoes !== undefined || props.sugestoesFalharam) return null;
    return <div aria-hidden="true" className="mb-8 h-[66px] rounded-2xl border border-white/8 bg-[#1b1714] animate-pulse" />;
  }

  return (
    <section aria-label={t("dashboard.resumo.rotulo")} className="mb-8 overflow-hidden rounded-2xl border border-white/8 bg-[#1b1714]">
      <ul className="divide-y divide-white/[0.06]">
        {linhas.map(({ chave, Icone, frase, detalhe, acao }) => (
          <li key={chave} className="flex items-center gap-3 px-4 py-3">
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#c98f70]/30 bg-[#c98f70]/15">
              <Icone className="h-[18px] w-[18px] text-[#c98f70]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium leading-snug text-white">{frase}</span>
              {detalhe && <span className="mt-0.5 block text-xs leading-snug text-white/55">{detalhe}</span>}
            </span>
            {acao}
          </li>
        ))}
      </ul>
    </section>
  );
}
