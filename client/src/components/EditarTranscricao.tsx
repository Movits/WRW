import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, PencilLine, RefreshCw, Replace, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { mensagemDoRefazer, pedidoParaEnviar } from "@/components/ModeloDoResumo";
import { BOTAO_PRINCIPAL, BOTAO_SECUNDARIO, CAMPO, ROTULO } from "@/components/FormularioDoTrecho";
import {
  contarNoTexto, LOCALIZAR_MAX, RECUSAS_DA_EDICAO, SUBSTITUIR_POR_MAX, TEXTO_CORRIDO_MAX,
  type CodigoDaRecusaDaEdicao, type OperacaoDaEdicao,
} from "@shared/editar-transcricao";
import { ESTILO_DO_RESUMO_PADRAO, MODELO_DE_RESUMO_PADRAO, estiloDoResumo } from "@shared/modelos-de-resumo";

/**
 * Editar a transcrição (H18; HN-23 e HN-27 do app de referência da cliente),
 * na tela da dona: a barra (editar, localizar e substituir, voltar tudo ao
 * original), o editor do texto corrido (a transcrição sem falas) e o aviso de
 * que o resumo é de antes da edição, com "Refazer o resumo". O formulário de um
 * trecho (o texto e a voz) mora em FormularioDoTrecho.tsx. Quem grava é o servidor
 * (server/editar-transcricao.ts), com a revisão que a tela leu; a recusa sai
 * como código, dito aqui no idioma da tela. O link aberto é só de leitura.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** O que o detalhe da dona (meetings.get) traz da edição. */
export type EdicaoNaTela = {
  revisao: number;
  editada: boolean;
  editadaEm: number | null;
  originais: ReadonlyArray<{ indice: number; texto: string; falante: string }>;
};

/** A transcrição que nunca foi editada (e a resposta antiga, sem o campo). */
export const EDICAO_VAZIA: EdicaoNaTela = { revisao: 0, editada: false, editadaEm: null, originais: [] };

/**
 * O aviso de cada recusa do servidor. O Record é pelo tipo compartilhado:
 * código novo lá não compila aqui sem o aviso dele, e cada valor chama t() com
 * a chave literal (server/i18n-chaves-usadas.test.ts confere que existem).
 */
const AVISO_POR_RECUSA: Record<CodigoDaRecusaDaEdicao, (t: TranslateFn) => string> = {
  [RECUSAS_DA_EDICAO.foraDoEstado]: t => t("meetings.editTranscript.errorState"),
  [RECUSAS_DA_EDICAO.documento]: t => t("meetings.editTranscript.errorDocument"),
  [RECUSAS_DA_EDICAO.mudou]: t => t("meetings.editTranscript.errorChanged"),
  [RECUSAS_DA_EDICAO.trecho]: t => t("meetings.editTranscript.errorSegment"),
  [RECUSAS_DA_EDICAO.vazio]: t => t("meetings.editTranscript.errorEmpty"),
  [RECUSAS_DA_EDICAO.demais]: t => t("meetings.editTranscript.errorTooMany"),
};

export function avisoDaRecusaDaEdicao(erro: unknown, t: TranslateFn): string {
  const { message, data } = (erro ?? {}) as { message?: unknown; data?: { code?: unknown } };
  if (data?.code === "NOT_FOUND") return t("meetings.meetingNotFound");
  if (typeof message === "string" && Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA, message)) {
    return AVISO_POR_RECUSA[message as CodigoDaRecusaDaEdicao](t);
  }
  if (typeof message === "string" && data?.code) {
    const traduzida = traduzirMensagemDoServidor(message, t);
    if (traduzida !== message) return traduzida;
  }
  return t("meetings.editTranscript.error");
}

export type EdicaoFeitaNaTela = { mudou: boolean; substituicoes: number };

/**
 * As mudanças da dona, uma de cada vez: cada pedido leva a revisão que o
 * anterior devolveu (o texto e a voz do mesmo trecho são dois pedidos), e dois
 * cliques não mandam a mesma revisão. Depois de cada um, com acerto ou recusa,
 * o detalhe, o resumo (que passa a ser de outra versão) e a lista são relidos:
 * a recusa por revisão velha (outra aba editou) traz a versão nova. A recusa
 * vira aviso no idioma da tela, e a promessa devolve null.
 */
export function useEdicaoDaTranscricao(meetingId: string, transcricao: { id: string; edicao?: EdicaoNaTela } | null | undefined) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const transcricaoId = transcricao?.id;
  const revisaoLida = transcricao?.edicao?.revisao ?? 0;
  const revisao = useRef(revisaoLida);
  useEffect(() => { revisao.current = revisaoLida; }, [transcricaoId, revisaoLida]);
  const fila = useRef<Promise<unknown>>(Promise.resolve());
  const [salvando, setSalvando] = useState(0);

  function editar(operacao: OperacaoDaEdicao): Promise<EdicaoFeitaNaTela | null> {
    if (!transcricaoId) return Promise.resolve(null);
    const vez = fila.current.then(async () => {
      setSalvando(n => n + 1);
      try {
        const feita = await utils.client.meetings.editarTranscricao.mutate({ meetingId, transcricaoId, revisao: revisao.current, operacao });
        revisao.current = feita.revisao;
        return feita;
      } catch (erro) {
        toast.error(avisoDaRecusaDaEdicao(erro, t));
        return null;
      } finally {
        // A releitura que falha aparece na própria consulta (o detalhe mostra o
        // erro com "tentar de novo"): o invalidate não rejeita por ela.
        try {
          await Promise.all([
            utils.meetings.get.invalidate({ meetingId }),
            utils.meetings.resumoGuardado.invalidate({ meetingId }),
            utils.meetings.list.invalidate(),
          ]);
        } finally {
          setSalvando(n => n - 1);
        }
      }
    });
    // A fila segue depois de um pedido que falhou; quem pediu recebe a falha (vez).
    fila.current = vez.catch(() => undefined);
    return vez;
  }

  return { editar, salvando: salvando > 0 };
}

// Os estilos dos campos e botões moram em FormularioDoTrecho.tsx, com o formulário do trecho.

/** A data da edição no idioma da tela. */
function dataDaEdicao(ms: number, idioma: string): string {
  try {
    return new Intl.DateTimeFormat(idioma, { dateStyle: "short", timeStyle: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/**
 * A barra da edição, acima da transcrição. Fechada: "Editar a transcrição" e,
 * se a dona já a editou, quando. Aberta: os avisos (editar muda só o texto, e
 * o link aberto passa a mostrar a versão editada), localizar e substituir em
 * todos os trechos, com a contagem antes de trocar, e "Voltar tudo ao
 * original", que pede confirmação.
 *
 * Na tradução (`naTraducao`), a edição não abre ali: a dona edita o que foi
 * falado, no idioma original. A barra fica fechada, com o botão e a frase que
 * diz isso; o botão volta ao original e abre a edição (quem chama, em
 * aoMudarEditando). Sem ela, o botão sumia na tradução, que é a vista padrão da
 * reunião em outro idioma, sem nenhuma dica.
 */
export function BarraDaEdicao({ edicao, textos, editando, aoMudarEditando, comLinkAberto, editar, salvando, naTraducao = false }: {
  edicao: EdicaoNaTela;
  /** Os textos em que a substituição procura: os dos trechos, ou o texto corrido. */
  textos: readonly string[];
  editando: boolean;
  aoMudarEditando: (editando: boolean) => void;
  comLinkAberto: boolean;
  editar: (operacao: OperacaoDaEdicao) => Promise<EdicaoFeitaNaTela | null>;
  salvando: boolean;
  /** A transcrição na tela é a tradução: o botão abre a edição no original. */
  naTraducao?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const prefixo = useId();
  const [localizar, setLocalizar] = useState("");
  const [substituirPor, setSubstituirPor] = useState("");
  const [diferenciar, setDiferenciar] = useState(false);
  const [confirmandoVolta, setConfirmandoVolta] = useState(false);
  const procura = localizar.trim() ? localizar : "";
  const ocorrencias = useMemo(() => (procura ? textos.reduce((soma, texto) => soma + contarNoTexto(texto, procura, diferenciar), 0) : 0), [textos, procura, diferenciar]);

  async function substituir(evento: FormEvent) {
    evento.preventDefault();
    if (!procura || !ocorrencias || salvando) return;
    const feita = await editar({ tipo: "substituir", localizar: procura, substituirPor, diferenciarMaiusculas: diferenciar });
    if (!feita) return;
    if (feita.mudou) {
      toast.success(t("meetings.editTranscript.replaced", { n: feita.substituicoes }));
      setLocalizar("");
      setSubstituirPor("");
    } else {
      toast(t("meetings.editTranscript.nothingFound"));
    }
  }

  async function voltarTudo() {
    setConfirmandoVolta(false);
    const feita = await editar({ tipo: "restaurarTudo" });
    if (feita?.mudou) toast.success(t("meetings.editTranscript.restoredAll"));
  }

  if (!editando || naTraducao) {
    return <div className="mb-4 flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => aoMudarEditando(true)} aria-describedby={naTraducao ? `${prefixo}-no-original` : undefined} className={BOTAO_SECUNDARIO}>
        <PencilLine size={14} aria-hidden/> {t("meetings.editTranscript.start")}
      </button>
      {naTraducao && <span id={`${prefixo}-no-original`} className="text-xs text-white/50">{t("meetings.editTranscript.editsInOriginal")}</span>}
      {edicao.editada && edicao.editadaEm !== null && <span className="text-xs text-white/50">{t("meetings.editTranscript.editedOn", { data: dataDaEdicao(edicao.editadaEm, i18n.language) })}</span>}
    </div>;
  }

  return <section aria-labelledby={`${prefixo}-titulo`} className="mb-5 space-y-4 rounded-xl border border-amber-300/30 bg-black/20 p-4">
    <div className="flex flex-wrap items-center gap-3">
      <h3 id={`${prefixo}-titulo`} className="text-sm font-semibold text-amber-100">{t("meetings.editTranscript.title")}</h3>
      {salvando && <Loader2 size={14} className="animate-spin text-amber-200" aria-label={t("meetings.editTranscript.saving")}/>}
      <button type="button" onClick={() => aoMudarEditando(false)} className={`ms-auto ${BOTAO_PRINCIPAL}`}>
        <Check size={14} aria-hidden/> {t("meetings.editTranscript.done")}
      </button>
    </div>
    <ul className="list-disc space-y-1 ps-5 text-xs text-amber-100/75">
      <li>{t("meetings.editTranscript.audioNotice")}</li>
      <li>{t("meetings.editTranscript.summaryNotice")}</li>
      {comLinkAberto && <li>{t("meetings.editTranscript.linkNotice")}</li>}
    </ul>

    <form onSubmit={substituir} aria-label={t("meetings.editTranscript.replaceTitle")} className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-white/45">{t("meetings.editTranscript.replaceTitle")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={ROTULO}>{t("meetings.editTranscript.findLabel")}
          <input value={localizar} onChange={evento => setLocalizar(evento.target.value)} maxLength={LOCALIZAR_MAX} dir="auto" autoComplete="off"
            aria-describedby={`${prefixo}-ocorrencias`} className={CAMPO}/>
        </label>
        <label className={ROTULO}>{t("meetings.editTranscript.replaceLabel")}
          <input value={substituirPor} onChange={evento => setSubstituirPor(evento.target.value)} maxLength={SUBSTITUIR_POR_MAX} dir="auto" autoComplete="off" className={CAMPO}/>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs text-white/70">
          <input type="checkbox" checked={diferenciar} onChange={evento => setDiferenciar(evento.target.checked)} className="h-4 w-4 accent-amber-400"/>
          {t("meetings.editTranscript.matchCase")}
        </label>
        <span id={`${prefixo}-ocorrencias`} role="status" className="text-xs text-white/55">
          {procura ? t("meetings.editTranscript.occurrences", { n: ocorrencias }) : ""}
        </span>
        <button type="submit" disabled={!procura || !ocorrencias || salvando} className={`ms-auto ${BOTAO_PRINCIPAL}`}>
          <Replace size={14} aria-hidden/> {t("meetings.editTranscript.replaceAll")}
        </button>
      </div>
    </form>

    {edicao.editada && (confirmandoVolta
      ? <div role="group" aria-label={t("meetings.editTranscript.restoreAll")} className="rounded-lg border border-amber-300/30 bg-amber-300/[0.06] p-3 text-xs text-amber-100">
          <p>{t("meetings.editTranscript.restoreAllQuestion")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={salvando} onClick={() => void voltarTudo()} className={BOTAO_PRINCIPAL}>{t("meetings.editTranscript.restoreAllYes")}</button>
            <button type="button" onClick={() => setConfirmandoVolta(false)} className={BOTAO_SECUNDARIO}>{t("meetings.editTranscript.cancel")}</button>
          </div>
        </div>
      : <button type="button" disabled={salvando} onClick={() => setConfirmandoVolta(true)} className={BOTAO_SECUNDARIO}>
          <RotateCcw size={14} aria-hidden/> {t("meetings.editTranscript.restoreAll")}
        </button>)}
  </section>;
}


/**
 * A transcrição sem falas (o envio único de antes das partes), editada como um
 * texto só. Salvar manda o texto inteiro; o campo volta ao texto salvo quando o
 * detalhe é relido.
 */
export function EditorDoTextoCorrido({ texto, editar, salvando }: {
  texto: string;
  editar: (operacao: OperacaoDaEdicao) => Promise<EdicaoFeitaNaTela | null>;
  salvando: boolean;
}) {
  const { t } = useTranslation();
  const [rascunho, setRascunho] = useState(texto);
  // O texto do servidor que o rascunho acompanhou por último. Quando o texto
  // muda (a edição salva aqui, outra aba, a recusa por conflito, que relê a
  // reunião), o rascunho acompanha só se a dona não tinha mexido nele: o que
  // ela escreveu fica (numa transcrição de até 400 mil caracteres), com o
  // aviso da recusa, e o "Cancelar" volta ao texto salvo.
  const textoAcompanhado = useRef(texto);
  useEffect(() => {
    const anterior = textoAcompanhado.current;
    textoAcompanhado.current = texto;
    setRascunho(atual => (atual.trim() === anterior.trim() ? texto : atual));
  }, [texto]);
  const mudou = rascunho.trim() !== texto.trim();

  async function salvar(evento: FormEvent) {
    evento.preventDefault();
    if (!rascunho.trim() || !mudou || salvando) return;
    const feita = await editar({ tipo: "textoCorrido", texto: rascunho });
    if (feita?.mudou) toast.success(t("meetings.editTranscript.saved"));
  }

  return <form onSubmit={salvar} className="space-y-3">
    <label className={ROTULO}>{t("meetings.editTranscript.plainTextLabel")}
      <textarea value={rascunho} onChange={evento => setRascunho(evento.target.value)} maxLength={TEXTO_CORRIDO_MAX} rows={14} dir="auto"
        className={`${CAMPO} resize-y leading-7`}/>
    </label>
    <div className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={salvando || !mudou || !rascunho.trim()} className={BOTAO_PRINCIPAL}>
        {salvando ? <Loader2 size={14} className="animate-spin" aria-hidden/> : <Check size={14} aria-hidden/>} {t("meetings.editTranscript.save")}
      </button>
      <button type="button" disabled={salvando || !mudou} onClick={() => setRascunho(texto)} className={BOTAO_SECUNDARIO}>{t("meetings.editTranscript.cancel")}</button>
    </div>
  </form>;
}

/**
 * O pedido do resumo de agora, como o servidor o devolve (resumoGuardado): o
 * modelo escolhido (o pronto, um da dona ou o que a IA escolheu), o estilo e as
 * instruções.
 */
export type PedidoDoResumoDeAgora = { escolha?: string | null; modelo?: string | null; estilo?: string | null; instrucoes?: string | null };

/**
 * O refazer depois da edição pede o MESMO resumo de agora, só que lido da
 * transcrição editada: o modelo da escolha (o da dona, ou o que a IA escolheu,
 * e não só o código do pronto, que levaria o resumo de um modelo próprio para
 * o Geral), o estilo e as instruções.
 */
export function pedidoDoRefazerDepoisDaEdicao(resumo: PedidoDoResumoDeAgora | null | undefined) {
  return pedidoParaEnviar({
    modelo: resumo?.escolha ?? resumo?.modelo ?? MODELO_DE_RESUMO_PADRAO,
    estilo: estiloDoResumo(resumo?.estilo ?? undefined) ?? ESTILO_DO_RESUMO_PADRAO,
    instrucoes: resumo?.instrucoes ?? "",
  });
}

/**
 * A dona editou a transcrição depois que o resumo foi escrito: o resumo, o
 * mapa mental e o que o link aberto mostra deles saíram da versão anterior.
 * "Refazer o resumo" manda a fila escrever de novo, no mesmo pedido, a partir
 * da versão editada; os itens que ela confirmou ficam, e o mapa é refeito.
 * Gasta uma vaga do teto de pedidos à IA, como o "Refazer como…".
 *
 * T51 (24/11): o toque não mostrava nada. O pedido aceito tira este aviso (o
 * resumo volta à fila), e a versão nova só aparece na aba Resumo quando a IA
 * termina; na aba da transcrição, onde a dona acabou de editar, nada dizia
 * que o resumo estava sendo refeito. Agora o pedido aceito avisa na hora (e a
 * aba da transcrição mostra AvisoDoResumoSendoRefeito enquanto a fila trabalha), e a
 * recusa fica escrita no próprio aviso, além do aviso flutuante.
 */
export function AvisoDeResumoDeOutraVersao({ meetingId, resumo }: { meetingId: string; resumo: PedidoDoResumoDeAgora | null | undefined }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const refazer = trpc.meetings.refazerResumo.useMutation({
    onSuccess: () => toast.success(t("meetings.editTranscript.redoStarted")),
    onError: erro => toast.error(mensagemDoRefazer(t, erro)),
    onSettled: () => Promise.all([utils.meetings.resumoGuardado.invalidate({ meetingId }), utils.meetings.mapaMental.invalidate({ meetingId })]),
  });
  return <div role="status" className="mb-4 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <p className="min-w-0 flex-1">{t("meetings.editTranscript.staleSummary")}</p>
      <button type="button" disabled={refazer.isPending} onClick={() => refazer.mutate({ meetingId, ...pedidoDoRefazerDepoisDaEdicao(resumo) })}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
        {refazer.isPending ? <Loader2 size={15} className="animate-spin" aria-hidden/> : <RefreshCw size={15} aria-hidden/>} {t("meetings.editTranscript.redoSummary")}
      </button>
    </div>
    {refazer.isError && <p role="alert" className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoRefazer(t, refazer.error)}</p>}
  </div>;
}

/**
 * O resumo sendo refeito (na fila, com a versão anterior guardada), dito na aba
 * da transcrição: é lá que a dona toca "Refazer o resumo" depois de editar, e a
 * versão nova só aparece na aba Resumo quando a IA termina (T51, 24/11).
 */
export function AvisoDoResumoSendoRefeito() {
  const { t } = useTranslation();
  return <p role="status" className="mb-4 rounded-xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
    <Loader2 size={15} className="mr-2 inline animate-spin" aria-hidden/>{t("meetings.editTranscript.redoingSummary")}
  </p>;
}
