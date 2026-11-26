import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, MessagesSquare, Search, Send, Tag, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { AvisoDeConferir, idiomaDaTela, mensagemDoErroDaIA, TempoDoTrecho } from "@/components/ReuniaoComIA";
import { VisualDaResposta } from "@/components/VisualDaResposta";
import { rotaDaReuniao } from "@shared/rotas";
import { fusoDoAparelho } from "@shared/agenda";
import { chaveDaEtiqueta, etiquetasDaDona } from "@shared/detalhes-da-reuniao";
import {
  ETIQUETAS_POR_PERGUNTA_MAX, horasDeFala, LIMITE_DA_LEITURA_DA_IA, PERGUNTAS_ENTRE_REUNIOES_EM_24H, RECUSAS_ENTRE_REUNIOES, REUNIOES_POR_PERGUNTA_MAX,
  vozesEntreReunioesNoTexto, type AvaliacaoDaResposta, type CodigoDaRecusaEntreReunioes,
} from "@shared/perguntar-a-varias-reunioes";

/**
 * O Pergunte a várias reuniões (H6c; HN-44 no app de referência da cliente):
 * a dona escolhe as reuniões por etiqueta (uma ou várias: entram as reuniões
 * com qualquer uma delas, T52) ou uma a uma e pergunta. A IA lê as
 * transcrições delas no servidor (server/perguntar-a-varias-reunioes.ts), até
 * cerca de 7 h de fala; acima disso, lê primeiro as mais ligadas à pergunta e
 * diz quais ficaram de fora. A resposta traz o número de fontes, os trechos de
 * cada reunião (o "▶" abre a reunião naquele ponto), a tabela ou o gráfico
 * quando a pergunta pede (H6d) e a avaliação "ajudou / não ajudou". Nada da
 * pergunta nem da resposta fica guardado: só a avaliação, sem o texto.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type Modo = "etiqueta" | "uma";
type Sugestao = { id: string; rotulo: (t: TranslateFn) => string; pergunta: (t: TranslateFn) => string };

/** As sugestões prontas entre reuniões, como as da pergunta a uma reunião (H6b): cada uma é uma pergunta comum. */
export const SUGESTOES_ENTRE_REUNIOES: readonly Sugestao[] = [
  { id: "decisoes", rotulo: t => t("meetings.multiAsk.suggestions.decisionsLabel"), pergunta: t => t("meetings.multiAsk.suggestions.decisionsQuestion") },
  { id: "pendencias", rotulo: t => t("meetings.multiAsk.suggestions.openItemsLabel"), pergunta: t => t("meetings.multiAsk.suggestions.openItemsQuestion") },
  { id: "mudancas", rotulo: t => t("meetings.multiAsk.suggestions.changesLabel"), pergunta: t => t("meetings.multiAsk.suggestions.changesQuestion") },
  { id: "tabela", rotulo: t => t("meetings.multiAsk.suggestions.tableLabel"), pergunta: t => t("meetings.multiAsk.suggestions.tableQuestion") },
];

/**
 * O aviso de cada recusa do servidor. O Record é pelo tipo compartilhado:
 * código novo lá não compila aqui sem o aviso dele, e cada valor chama t() com
 * a chave literal (server/i18n-chaves-usadas.test.ts confere que existem).
 */
const AVISO_POR_RECUSA: Record<CodigoDaRecusaEntreReunioes, (t: TranslateFn) => string> = {
  [RECUSAS_ENTRE_REUNIOES.naoEncontrada]: t => t("meetings.multiAsk.errorNotFound"),
  [RECUSAS_ENTRE_REUNIOES.semReuniao]: t => t("meetings.multiAsk.errorNoMeeting"),
  [RECUSAS_ENTRE_REUNIOES.semTranscricao]: t => t("meetings.multiAsk.errorNoTranscript"),
  [RECUSAS_ENTRE_REUNIOES.longasDemais]: t => t("meetings.multiAsk.errorTooLong"),
  [RECUSAS_ENTRE_REUNIOES.tetoDiario]: t => t("meetings.multiAsk.errorDaily", { max: PERGUNTAS_ENTRE_REUNIOES_EM_24H }),
  [RECUSAS_ENTRE_REUNIOES.perguntaNaoEncontrada]: t => t("meetings.multiAsk.rateError"),
};

export function avisoDoErroEntreReunioes(t: TranslateFn, erro: unknown): string {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (typeof mensagem === "string" && Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA, mensagem)) {
    return AVISO_POR_RECUSA[mensagem as CodigoDaRecusaEntreReunioes](t);
  }
  // A IA fora do ar, o teto de pedidos à IA e o banco fora do ar: as frases da pergunta a uma reunião.
  return mensagemDoErroDaIA(t, erro, t("meetings.multiAsk.error"), false);
}

export function PergunteAVariasReunioes({ aoFechar, aoAbrir }: { aoFechar: () => void; aoAbrir: (destino: string) => void }) {
  const { t, i18n } = useTranslation();
  const idDoTitulo = useId();
  const reunioes = trpc.perguntasEntreReunioes.reunioes.useQuery(undefined, { refetchOnWindowFocus: false });
  const perguntar = trpc.perguntasEntreReunioes.perguntar.useMutation();
  const avaliar = trpc.perguntasEntreReunioes.avaliar.useMutation();
  const [modo, setModo] = useState<Modo>("etiqueta");
  // As etiquetas escolhidas (T52): a pergunta junta as reuniões com qualquer uma delas.
  const [etiquetasEscolhidas, setEtiquetasEscolhidas] = useState<string[]>([]);
  const [escolhidas, setEscolhidas] = useState<string[]>([]);
  const [filtro, setFiltro] = useState("");
  const [pergunta, setPergunta] = useState("");
  const [perguntaFeita, setPerguntaFeita] = useState("");
  const [avaliacao, setAvaliacao] = useState<AvaliacaoDaResposta | null>(null);

  // O Esc fecha, como o "Fechar".
  useEffect(() => {
    const aoTeclar = (evento: KeyboardEvent) => { if (evento.key === "Escape") aoFechar(); };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [aoFechar]);

  const lista = reunioes.data ?? [];
  const etiquetas = useMemo(() => etiquetasDaDona(lista, i18n.language), [lista, i18n.language]);
  const daEtiqueta = useMemo(() => {
    if (!etiquetasEscolhidas.length) return [];
    const chaves = new Set(etiquetasEscolhidas.map(chaveDaEtiqueta));
    return lista.filter(reuniao => reuniao.etiquetas.some(da => chaves.has(chaveDaEtiqueta(da))));
  }, [lista, etiquetasEscolhidas]);
  const visiveis = useMemo(() => {
    const procurado = filtro.trim().toLocaleLowerCase(i18n.language);
    return procurado ? lista.filter(reuniao => reuniao.titulo.toLocaleLowerCase(i18n.language).includes(procurado)) : lista;
  }, [lista, filtro, i18n.language]);
  const selecionadas = modo === "etiqueta" ? daEtiqueta.slice(0, REUNIOES_POR_PERGUNTA_MAX) : lista.filter(reuniao => escolhidas.includes(reuniao.id));
  const caracteres = selecionadas.reduce((total, reuniao) => total + reuniao.caracteres, 0);
  const escolheuOBastante = modo === "etiqueta" ? selecionadas.length >= 1 : selecionadas.length >= 2;
  const podePerguntar = escolheuOBastante && pergunta.trim().length >= 2 && !perguntar.isPending;
  const resposta = perguntar.isPending ? undefined : perguntar.data;

  // As vozes de cada reunião lida trocam pelo nome que a dona deu NAQUELA reunião.
  const nomesPorNumero = useMemo(() => new Map((resposta?.reunioes ?? []).map(fonte => [fonte.numero, fonte.nomes])), [resposta]);
  const comVozes = (texto: string) => vozesEntreReunioesNoTexto(texto, numero => nomesPorNumero.get(numero),
    (voz, reuniao) => t("meetings.multiAsk.speakerInMeeting", { falante: t("meetings.speakerLabel", { n: voz }), n: reuniao }));
  const tituloDaReuniao = (numero: number) => resposta?.reunioes.find(fonte => fonte.numero === numero)?.titulo ?? "";

  function perguntarTexto(texto: string) {
    if (!escolheuOBastante || perguntar.isPending) return;
    setPerguntaFeita(texto);
    setAvaliacao(null);
    avaliar.reset();
    const idioma = idiomaDaTela(i18n);
    // O fuso do aparelho: a IA lê a data de cada reunião no dia que a tela mostra.
    const fuso = fusoDoAparelho();
    if (modo === "etiqueta" && etiquetasEscolhidas.length) perguntar.mutate({ etiquetas: etiquetasEscolhidas, idioma, pergunta: texto, fuso });
    else perguntar.mutate({ meetingIds: selecionadas.map(reuniao => reuniao.id), idioma, pergunta: texto, fuso });
  }
  function enviar(evento: FormEvent) {
    evento.preventDefault();
    if (podePerguntar) perguntarTexto(pergunta.trim());
  }
  function alternarEtiqueta(nome: string) {
    setEtiquetasEscolhidas(atuais => atuais.includes(nome) ? atuais.filter(atual => atual !== nome) : atuais.length >= ETIQUETAS_POR_PERGUNTA_MAX ? atuais : [...atuais, nome]);
  }
  function alternar(id: string) {
    setEscolhidas(atuais => atuais.includes(id) ? atuais.filter(atual => atual !== id) : atuais.length >= REUNIOES_POR_PERGUNTA_MAX ? atuais : [...atuais, id]);
  }
  function avaliarResposta(nota: AvaliacaoDaResposta) {
    if (!resposta) return;
    avaliar.mutate({ perguntaId: resposta.perguntaId, nota }, { onSuccess: () => setAvaliacao(nota) });
  }

  const data = (criadaEm: number) => new Date(criadaEm).toLocaleDateString(i18n.language);
  const escolha = (
    <div className="space-y-3">
      <div role="group" aria-label={t("meetings.multiAsk.chooseLabel")} className="inline-flex rounded-xl border border-white/15 p-1">
        {(["etiqueta", "uma"] as const).map(opcao => (
          <button key={opcao} type="button" aria-pressed={modo === opcao} onClick={() => setModo(opcao)}
            className={`rounded-lg px-3 py-1.5 text-sm ${modo === opcao ? "bg-amber-300/15 text-amber-100" : "text-white/60 hover:text-white"}`}>
            {opcao === "etiqueta" ? t("meetings.multiAsk.byTag") : t("meetings.multiAsk.oneByOne")}
          </button>
        ))}
      </div>
      {modo === "etiqueta" ? (
        etiquetas.length ? (
          <div className="space-y-2">
            <p className="text-xs text-white/55">{t("meetings.multiAsk.tagsHint")}</p>
            <ul aria-label={t("meetings.multiAsk.tagsLabel")} className="flex flex-wrap gap-2">
              {etiquetas.map(nome => {
                const marcada = etiquetasEscolhidas.includes(nome);
                return <li key={nome}>
                  <button type="button" aria-pressed={marcada} onClick={() => alternarEtiqueta(nome)}
                    disabled={!marcada && etiquetasEscolhidas.length >= ETIQUETAS_POR_PERGUNTA_MAX}
                    className={`inline-flex max-w-full items-center gap-1 break-words rounded-full border px-3 py-1 text-xs disabled:opacity-50 ${marcada ? "border-amber-300/60 bg-amber-300/15 text-amber-100" : "border-white/15 text-white/70 hover:bg-white/5"}`}>
                    <Tag size={11} aria-hidden="true" /><span dir="auto">{nome}</span>
                  </button>
                </li>;
              })}
            </ul>
            {etiquetasEscolhidas.length > 0 && <p className="text-xs text-white/55">{t("meetings.multiAsk.meetingsWithTag", { n: daEtiqueta.length })}</p>}
            {daEtiqueta.length > REUNIOES_POR_PERGUNTA_MAX && <p className="text-xs text-white/55">{t("meetings.multiAsk.tagOverMax", { max: REUNIOES_POR_PERGUNTA_MAX })}</p>}
          </div>
        ) : <p className="text-sm text-white/55">{t("meetings.multiAsk.noTags")}</p>
      ) : (
        <div className="space-y-2">
          <label className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-3 focus-within:border-amber-300/50">
            <Search size={15} aria-hidden="true" className="shrink-0 text-white/40" />
            <span className="sr-only">{t("meetings.multiAsk.filterLabel")}</span>
            <input type="search" value={filtro} onChange={evento => setFiltro(evento.target.value)} placeholder={t("meetings.multiAsk.filterLabel")}
              className="w-full min-w-0 bg-transparent py-2 text-sm text-white outline-none placeholder:text-white/35" />
          </label>
          <ul aria-label={t("meetings.multiAsk.oneByOne")} className="max-h-56 space-y-1 overflow-y-auto pe-1">
            {visiveis.map(reuniao => {
              const marcada = escolhidas.includes(reuniao.id);
              return (
                <li key={reuniao.id}>
                  <label className={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 ${marcada ? "bg-amber-300/[0.07]" : ""}`}>
                    <input type="checkbox" checked={marcada} onChange={() => alternar(reuniao.id)}
                      disabled={!marcada && escolhidas.length >= REUNIOES_POR_PERGUNTA_MAX} className="mt-0.5 h-4 w-4 shrink-0 accent-amber-300" />
                    <span className="min-w-0">
                      <span dir="auto" className="block break-words text-sm text-white/85">{reuniao.titulo}</span>
                      <span className="text-xs text-white/45">{data(reuniao.criadaEm)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-white/55">{t("meetings.multiAsk.selected", { n: escolhidas.length, max: REUNIOES_POR_PERGUNTA_MAX })}</p>
        </div>
      )}
      {/* A linha da estimativa ocupa o seu lugar mesmo vazia: ao marcar a primeira
          reunião, o texto aparece sem empurrar o campo da pergunta (um toque logo
          depois de marcar cairia fora do campo, e o que se digitou se perderia). */}
      <p data-estimativa="" aria-live="polite" className="min-h-4 text-xs leading-4 text-white/55">
        {selecionadas.length > 0 && t("meetings.multiAsk.estimate", { horas: horasDeFala(caracteres).toLocaleString(i18n.language) })}
        {selecionadas.length > 0 && caracteres > LIMITE_DA_LEITURA_DA_IA && <span className="mt-1 block text-amber-200/90">{t("meetings.multiAsk.overLimit")}</span>}
      </p>
    </div>
  );

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={idDoTitulo} className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-white/15 bg-[#211e1b] p-5 shadow-2xl sm:rounded-2xl sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 id={idDoTitulo} className="flex items-center gap-2 font-bold text-white"><MessagesSquare size={18} className="text-amber-300" aria-hidden="true" />{t("meetings.multiAsk.title")}</h3>
          <button type="button" onClick={aoFechar} aria-label={t("meetings.multiAsk.close")} className="rounded-md p-1 text-white/60 hover:bg-white/5 hover:text-white"><X size={18} aria-hidden="true" /></button>
        </div>
        <p className="mt-2 text-sm text-white/60">{t("meetings.multiAsk.intro")}</p>

        <div className="mt-4">
          {reunioes.isError
            ? <ErroDeConsulta erro={reunioes.error} aoTentarDeNovo={() => void reunioes.refetch()} />
            : !reunioes.data
              ? <p role="status" className="text-sm text-white/55"><Loader2 size={14} className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.multiAsk.loading")}</p>
              : !lista.length
                ? <p className="text-sm text-white/55">{t("meetings.multiAsk.noMeetings")}</p>
                : escolha}
        </div>

        {lista.length > 0 && <>
          <div role="group" aria-label={t("meetings.ai.suggestions.label")} className="mt-4 flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="text-xs text-white/40">{t("meetings.ai.suggestions.label")}</span>
            {SUGESTOES_ENTRE_REUNIOES.map(sugestao => (
              <button key={sugestao.id} type="button" disabled={!escolheuOBastante || perguntar.isPending} onClick={() => perguntarTexto(sugestao.pergunta(t))}
                className="rounded-full border border-amber-300/30 px-3 py-1 text-xs text-amber-100 hover:bg-amber-300/10 disabled:opacity-50">{sugestao.rotulo(t)}</button>
            ))}
          </div>
          <form onSubmit={enviar} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input aria-label={t("meetings.multiAsk.askLabel")} value={pergunta} onChange={evento => setPergunta(evento.target.value)} maxLength={500}
              placeholder={t("meetings.multiAsk.askPlaceholder")}
              className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none focus:border-amber-300" />
            <button type="submit" disabled={!podePerguntar}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
              {perguntar.isPending ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />} {t("meetings.ai.askButton")}
            </button>
          </form>
          {!escolheuOBastante && <p className="mt-2 text-xs text-white/45">{t("meetings.multiAsk.chooseFirst")}</p>}
          {/* O passo da tabela e do gráfico (T52): o pedido vai na própria pergunta. */}
          <p className="mt-2 text-xs text-white/45">{t("meetings.multiAsk.visualHint")}</p>
        </>}

        {perguntar.isPending && <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.multiAsk.asking")}</p>}
        {perguntar.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{avisoDoErroEntreReunioes(t, perguntar.error)}</p>}

        {resposta && (
          <section aria-label={t("meetings.multiAsk.answerLabel")} className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/10 p-4">
            {perguntaFeita && <p dir="auto" className="text-xs text-white/45">{perguntaFeita}</p>}
            {resposta.respondida ? <>
              <p dir="auto" className="text-sm leading-6 text-white/85">{comVozes(resposta.resposta)}</p>
              {resposta.visual && <VisualDaResposta visual={resposta.visual} comVozes={comVozes} />}
              <p className="text-xs font-semibold text-amber-200/90">{t("meetings.multiAsk.sourcesCount", { citadas: resposta.reunioes.filter(fonte => fonte.citada).length, lidas: resposta.reunioes.length })}</p>
              <ul className="space-y-2 border-s-2 border-amber-300/40 ps-3">
                {resposta.citacoes.map((citacao, i) => (
                  <li key={i} className="space-y-0.5">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-white/45">
                      <span dir="auto">[{citacao.reuniao}] {tituloDaReuniao(citacao.reuniao)}</span>
                      {citacao.inicioSegundos !== null && <TempoDoTrecho segundos={citacao.inicioSegundos} aoIrPara={segundo => aoAbrir(rotaDaReuniao(citacao.meetingId, { t: segundo }))} />}
                    </p>
                    <q dir="auto" className="text-xs italic text-white/55">{citacao.trecho}</q>
                  </li>
                ))}
              </ul>
              <AvisoDeConferir>{t("meetings.multiAsk.reviewNotice")}</AvisoDeConferir>
            </> : <p className="text-sm text-white/60">{t("meetings.multiAsk.notAnswered")}</p>}

            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">{t("meetings.multiAsk.sourcesTitle")}</p>
              <ol className="space-y-1">
                {resposta.reunioes.map(fonte => (
                  <li key={fonte.meetingId}>
                    <button type="button" onClick={() => aoAbrir(rotaDaReuniao(fonte.meetingId))} aria-label={t("meetings.multiAsk.openMeeting", { titulo: fonte.titulo })}
                      className="flex w-full flex-wrap items-baseline gap-x-2 rounded-md px-1.5 py-1 text-start text-xs hover:bg-white/5">
                      <span className="font-semibold text-white/50">[{fonte.numero}]</span>
                      <span dir="auto" className="min-w-0 break-words text-white/80">{fonte.titulo}</span>
                      <span className="text-white/40">{data(fonte.criadaEm)}</span>
                      {fonte.citada && <span className="rounded-full bg-amber-300/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200">{t("meetings.multiAsk.citedBadge")}</span>}
                    </button>
                  </li>
                ))}
              </ol>
              {resposta.ordem === "relevancia" && <p className="text-xs text-white/50">{t("meetings.multiAsk.orderRelevance")}</p>}
              {resposta.ordem === "recentes" && <p className="text-xs text-white/50">{t("meetings.multiAsk.orderRecent")}</p>}
              {resposta.alemDoMaximo > 0 && <p className="text-xs text-white/50">{t("meetings.multiAsk.tagOverMaxAnswer", { n: resposta.alemDoMaximo, max: REUNIOES_POR_PERGUNTA_MAX })}</p>}
            </div>

            {resposta.deFora.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">{t("meetings.multiAsk.leftOutTitle")}</p>
                <ul className="space-y-0.5 text-xs text-white/55">
                  {resposta.deFora.map(fora => (
                    <li key={fora.meetingId}>
                      <span dir="auto">{fora.titulo}</span>{" · "}
                      {fora.motivo === "limite" ? t("meetings.multiAsk.leftOutLimit") : fora.motivo === "longa_demais" ? t("meetings.multiAsk.leftOutTooLong") : t("meetings.multiAsk.leftOutNotReady")}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div role="group" aria-label={t("meetings.multiAsk.rateLabel")} className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
              <span className="text-xs text-white/55">{t("meetings.multiAsk.rateLabel")}</span>
              <button type="button" aria-pressed={avaliacao === "boa"} disabled={avaliar.isPending} onClick={() => avaliarResposta("boa")}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${avaliacao === "boa" ? "border-emerald-300/50 bg-emerald-300/10 text-emerald-100" : "border-white/15 text-white/70 hover:bg-white/5"} disabled:opacity-50`}>
                <ThumbsUp size={13} aria-hidden="true" />{t("meetings.multiAsk.rateGood")}
              </button>
              <button type="button" aria-pressed={avaliacao === "ruim"} disabled={avaliar.isPending} onClick={() => avaliarResposta("ruim")}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${avaliacao === "ruim" ? "border-red-300/50 bg-red-300/10 text-red-100" : "border-white/15 text-white/70 hover:bg-white/5"} disabled:opacity-50`}>
                <ThumbsDown size={13} aria-hidden="true" />{t("meetings.multiAsk.rateBad")}
              </button>
              {avaliacao && <span role="status" className="text-xs text-white/55">{t("meetings.multiAsk.rated")}</span>}
              {avaliar.isError && <span role="alert" className="text-xs text-red-200">{t("meetings.multiAsk.rateError")}</span>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
