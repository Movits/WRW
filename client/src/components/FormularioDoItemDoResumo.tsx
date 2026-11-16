import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { pedidoDaTela } from "@/components/AcaoNaAgenda";
import type { ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import {
  CAMPO_DO_ITEM_DO_RESUMO_MAX,
  SECOES_DO_RESUMO,
  TEXTO_DO_ITEM_DO_RESUMO_MAX,
  secaoTemAssunto,
  secaoTemResponsavel,
  type SecaoDoItem,
} from "@shared/item-do-resumo";
import { responsavelDeVolta, textoDeVolta, textoExibido, type ExibirVoz } from "@shared/vozes-na-edicao";

/**
 * O formulário do item do resumo guardado (H4f do pacote do gravador): a dona
 * edita o texto, o assunto (das tarefas), o responsável e o prazo de um item,
 * ou acrescenta um item à mão numa seção. O que ela salva vale como
 * confirmado (server/resumo-guardado.ts). Só a tela da dona o usa: o link
 * aberto é só de leitura.
 *
 * Ela edita o texto como a tela o mostra, com o nome da voz no lugar do
 * rótulo ({F2}); ao salvar, o rótulo volta onde estava
 * (shared/vozes-na-edicao.ts). No responsável, a lista sugere as vozes da
 * reunião. As mutações moram aqui, e não no ResumoGuardado: o formulário só
 * monta quando a dona o abre, e a falha deixa o que ela escreveu nos campos.
 *
 * A próxima ação do item (H5a) leva o texto editado, e o evento dela na Google
 * Agenda também (H5c): a edição manda o fuso do aparelho e os rótulos da tela,
 * como a caixa de feito do resumo, e o resultado da Google volta a quem chama
 * (`aoSalvarEdicao`). Ignorar a ação ou tarefa confirmada apaga a próxima ação:
 * antes, o formulário pede a confirmação (`ignorarApagaAcao`).
 */

export type ItemEditavel = {
  id: string;
  section: SecaoDoItem;
  subject: string | null;
  text: string;
  assignee: string | null;
  due: string | null;
};

type Props = {
  meetingId: string;
  /** O item editado; sem ele, o formulário acrescenta um item novo. */
  item?: ItemEditavel;
  /** As vozes da reunião (F1, F2...), sugeridas no responsável. */
  vozes: readonly string[];
  /** O que a tela mostra no lugar de uma voz: o nome que a dona deu, ou "Falante n". */
  exibir: ExibirVoz;
  /** O título traduzido de cada seção, o mesmo dos cabeçalhos do resumo. */
  tituloDaSecao: (secao: SecaoDoItem) => string;
  /** Relê o resumo; a espera por ela segura o botão até o estado novo chegar. */
  reler: () => unknown;
  /** A recusa do servidor, dita no idioma da tela. */
  aoFalhar: (erro: unknown) => void;
  /** Fecha o formulário: depois de salvar (e reler) ou ao cancelar. */
  aoFechar: () => void;
  /** Só na edição: tira o item do resumo (vai para os ignorados, com Desfazer). */
  aoIgnorar?: () => void;
  /** O Ignorar apaga a próxima ação do item (a ação ou tarefa confirmada): pergunta antes. */
  ignorarApagaAcao?: boolean;
  /** Só na edição: o que a Google Agenda fez com o evento da próxima ação do item (H5c). */
  aoSalvarEdicao?: (resultado: (ResultadoNaGoogle & { acaoId: string | null }) | undefined) => void;
  /** Outra decisão do resumo no ar: o Ignorar espera por ela. */
  decidindo?: boolean;
  /**
   * O link aberto da reunião está ligado: quem tem o link vê o que ela salva
   * aqui, e o formulário avisa antes de ela escrever.
   */
  comLinkAberto?: boolean;
};

// 16 px no celular: com menos, o iPhone aproxima a página ao tocar no campo.
// O fundo vem à parte: a lista de seções precisa de fundo opaco.
const CAMPO = "mt-1 w-full rounded-lg border border-white/15 px-3 py-2 text-base text-white outline-none placeholder:text-white/35 focus:border-amber-300 sm:text-sm";
const CAMPO_DE_TEXTO = `${CAMPO} bg-white/5`;
const ROTULO = "block text-xs font-semibold text-white/60";

export function FormularioDoItemDoResumo({
  meetingId, item, vozes, exibir, tituloDaSecao, reler, aoFalhar, aoFechar, aoIgnorar, ignorarApagaAcao = false, aoSalvarEdicao, decidindo = false, comLinkAberto = false,
}: Props) {
  const { t } = useTranslation();
  const idDasVozes = useId();
  const idDoAvisoDoLink = useId();
  const [secao, setSecao] = useState<SecaoDoItem>(item?.section ?? "action");
  const [texto, setTexto] = useState(() => item ? textoExibido(item.text, exibir) : "");
  const [assunto, setAssunto] = useState(() => item?.subject ? textoExibido(item.subject, exibir) : "");
  const [responsavel, setResponsavel] = useState(() => item?.assignee ? textoExibido(item.assignee, exibir) : "");
  const [prazo, setPrazo] = useState(item?.due ?? "");
  const [perguntandoIgnorar, setPerguntandoIgnorar] = useState(false);

  // Salvou: relê e só então fecha, para o item não piscar com o texto velho.
  // A falha deixa o formulário aberto, com o que a dona escreveu.
  const aoTerminar = (_dados: unknown, erro: unknown) => Promise.resolve(reler()).then(() => { if (!erro) aoFechar(); });
  const editar = trpc.meetings.editarItemDoResumo.useMutation({ onSuccess: resultado => aoSalvarEdicao?.(resultado), onError: aoFalhar, onSettled: aoTerminar });
  const acrescentar = trpc.meetings.acrescentarItemDoResumo.useMutation({ onError: aoFalhar, onSettled: aoTerminar });
  const salvando = editar.isPending || acrescentar.isPending;
  const comAssunto = secaoTemAssunto(secao);
  const comResponsavel = secaoTemResponsavel(secao);
  // As vozes como a tela as mostra, sem repetir (duas vozes com o mesmo nome).
  const sugestoes = Array.from(new Set(vozes.map(falante => exibir(falante).trim()).filter(Boolean)));

  function salvar(evento: FormEvent) {
    evento.preventDefault();
    if (!texto.trim() || salvando) return;
    const campos = {
      texto: textoDeVolta(texto, item?.text, exibir),
      assunto: comAssunto ? textoDeVolta(assunto, item?.subject, exibir) || null : null,
      responsavel: comResponsavel ? responsavelDeVolta(responsavel, item?.assignee, vozes, exibir) : null,
      prazo: comResponsavel ? prazo.trim() || null : null,
    };
    if (item) editar.mutate({ itemId: item.id, ...campos, ...pedidoDaTela(t) });
    else acrescentar.mutate({ meetingId, secao, ...campos });
  }

  // Esc cancela, como no nome da voz (TranscricaoPorFalante). Com o link
  // ligado, o aviso descreve o formulário, e o leitor de tela o lê ao entrar.
  return <form onSubmit={salvar} aria-label={item ? t("meetings.summary.edit") : t("meetings.summary.addItem")}
    aria-describedby={comLinkAberto ? idDoAvisoDoLink : undefined}
    onKeyDown={evento => { if (evento.key === "Escape" && !salvando) aoFechar(); }}
    className="space-y-3 rounded-xl border border-amber-300/30 bg-black/20 p-3">
    {comLinkAberto && <p id={idDoAvisoDoLink} className="text-xs text-amber-100/75">{t("meetings.summary.linkHint")}</p>}
    {!item && <label className={ROTULO}>{t("meetings.summary.sectionLabel")}
      <select value={secao} onChange={evento => setSecao(evento.target.value as SecaoDoItem)} className={`${CAMPO} bg-[#211e1b]`}>
        {SECOES_DO_RESUMO.map(opcao => <option key={opcao} value={opcao} className="bg-white text-[#322C26]">{tituloDaSecao(opcao)}</option>)}
      </select>
    </label>}
    {comAssunto && <label className={ROTULO}>{t("meetings.summary.subjectLabel")}
      <input value={assunto} onChange={evento => setAssunto(evento.target.value)} maxLength={CAMPO_DO_ITEM_DO_RESUMO_MAX} dir="auto" className={CAMPO_DE_TEXTO}/>
    </label>}
    <label className={ROTULO}>{t("meetings.summary.textLabel")}
      <textarea autoFocus required value={texto} onChange={evento => setTexto(evento.target.value)} maxLength={TEXTO_DO_ITEM_DO_RESUMO_MAX}
        rows={secao === "focus" || secao === "task" ? 4 : 2} dir="auto" className={`${CAMPO_DE_TEXTO} resize-y leading-6`}/>
    </label>
    {comResponsavel && <div className="grid gap-3 sm:grid-cols-2">
      <label className={ROTULO}>{t("meetings.summary.assigneeLabel")}
        <input value={responsavel} onChange={evento => setResponsavel(evento.target.value)} maxLength={CAMPO_DO_ITEM_DO_RESUMO_MAX}
          list={sugestoes.length ? idDasVozes : undefined} autoComplete="off" dir="auto" className={CAMPO_DE_TEXTO}/>
      </label>
      <label className={ROTULO}>{t("meetings.summary.dueLabel")}
        <input value={prazo} onChange={evento => setPrazo(evento.target.value)} maxLength={CAMPO_DO_ITEM_DO_RESUMO_MAX}
          placeholder={t("meetings.summary.duePlaceholder")} autoComplete="off" dir="auto" className={CAMPO_DE_TEXTO}/>
      </label>
      {sugestoes.length > 0 && <datalist id={idDasVozes}>{sugestoes.map(nome => <option key={nome} value={nome}/>)}</datalist>}
    </div>}
    {/* Ignorar a ação ou tarefa confirmada apaga a próxima ação dela (H5a), com o
        prazo, o contato e o evento: a pergunta toma o lugar dos botões, e o
        Cancelar dela volta ao formulário. */}
    {aoIgnorar && perguntandoIgnorar ? <div role="group" aria-label={t("meetings.summary.ignore")} className="rounded-lg border border-amber-300/30 bg-amber-300/[0.06] p-3 text-xs text-amber-100">
      <p>{t("proximasAcoes.ignoreConfirmQuestion")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={salvando || decidindo} onClick={() => { setPerguntandoIgnorar(false); aoIgnorar(); }}
          className="rounded-lg bg-amber-400 px-3 py-1.5 font-bold text-[#1a120c] disabled:opacity-50">{t("proximasAcoes.ignoreConfirmYes")}</button>
        <button type="button" onClick={() => setPerguntandoIgnorar(false)}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70">{t("proximasAcoes.cancel")}</button>
      </div>
    </div> : <div className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={salvando || !texto.trim()}
        className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-50">
        {salvando ? <Loader2 size={14} className="animate-spin"/> : <Check size={14}/>} {t("meetings.summary.save")}
      </button>
      <button type="button" onClick={aoFechar} disabled={salvando}
        className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/65 disabled:opacity-50">
        {t("meetings.summary.cancel")}
      </button>
      {aoIgnorar && <button type="button" onClick={() => (ignorarApagaAcao ? setPerguntandoIgnorar(true) : aoIgnorar())} disabled={salvando || decidindo}
        className="ms-auto inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-white/55 hover:text-white disabled:opacity-50">
        <X size={14}/> {t("meetings.summary.ignore")}
      </button>}
    </div>}
  </form>;
}
