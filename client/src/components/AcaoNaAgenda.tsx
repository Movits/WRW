import { AlertTriangle, CalendarCheck, CalendarPlus, Download, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import {
  destinoDaAcaoNaAgenda,
  DURACAO_DO_EVENTO_DA_ACAO_MIN,
  inicioDoEventoDaAcao,
  textosDaAcaoNaAgenda,
  uidDoIcsDaAcao,
  type RotulosDaAcaoNaAgenda,
} from "@shared/acoes-na-agenda";
import { fusoDoAparelho } from "@shared/agenda";
import { montarIcs, nomeDoArquivoIcs, revisaoDoIcs } from "@shared/agenda-ics";
import { linkDaGoogleAgenda } from "@shared/agenda-links";
import type { EstadoNaGoogle, MotivoSemGoogle, ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { rotaDaProximaAcao } from "@shared/lembretes";

/**
 * A próxima ação na agenda da dona (H5c do plano do gravador), na lista das
 * ações (components/ProximasAcoes.tsx) e no perfil do contato:
 *
 * - com a Google Agenda conectada no Perfil, a ação aberta com prazo vai para
 *   lá sozinha (server/acoes-na-google.ts), e a linha mostra o estado dela lá:
 *   "Na sua Google Agenda", "Ainda não está" com "Tentar de novo", ou "Pôr na
 *   Google Agenda" na que tinha prazo antes de conectar;
 * - sem ela, o link que abre a Google Agenda com o evento preenchido;
 * - sempre, o .ics para a agenda do celular, feito aqui, no navegador.
 *
 * O evento é às 9h do dia do prazo, no relógio do aparelho (a hora do lembrete
 * no sino), dura 30 minutos e avisa na hora. O texto é o da lista: os nomes que
 * a dona deu às vozes, e "Falante n" para a voz sem nome (shared/acoes-na-agenda.ts).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** A ação como a linha da agenda precisa: a da lista. */
export type AcaoParaAAgenda = {
  id: string;
  texto: string;
  detalhe: string | null;
  responsavel: string | null;
  prazo: string | null;
  feita: boolean;
  google: EstadoNaGoogle | null;
  vozes: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

/** Os rótulos do evento no idioma da tela: os mesmos da lista. */
export function rotulosDaTela(t: TranslateFn): RotulosDaAcaoNaAgenda {
  return { voz: t("meetings.speakerLabel", { n: "{n}" }), responsavel: t("proximasAcoes.owner", { nome: "{nome}" }) };
}

/** O que toda mutação que pode levar a ação à Google manda (H5c): o fuso do aparelho e os rótulos da tela. */
export function pedidoDaTela(t: TranslateFn): { fuso: string; rotulos: RotulosDaAcaoNaAgenda } {
  return { fuso: fusoDoAparelho(), rotulos: rotulosDaTela(t) };
}

// Cada ramo chama t() com a chave literal, para o teste de chaves usadas conferir que todas existem.
/** Por que a Google não recebeu o evento (ou não o tirou), no idioma da tela: as frases da agenda servem. */
export function motivoDaAgendaNaTela(t: TranslateFn, motivo: MotivoSemGoogle): string {
  switch (motivo) {
    case "nao-conectada": return t("agenda.google.reason.notConnected");
    case "revogada": return t("agenda.google.reason.revoked");
    case "google": return t("agenda.google.reason.google");
  }
}

/** O endereço da ação na WRW, que vai na descrição do evento. */
function enderecoDaAcao(acaoId: string): string | null {
  const origem = typeof window !== "undefined" ? window.location?.origin : undefined;
  return origem && origem !== "null" ? `${origem}${rotaDaProximaAcao(acaoId)}` : null;
}

function textosNaTela(acao: AcaoParaAAgenda, t: TranslateFn) {
  return textosDaAcaoNaAgenda(acao, rotulosDaTela(t), enderecoDaAcao(acao.id));
}

/**
 * O .ics da ação, feito aqui: nada vai ao servidor. O mesmo UID a cada
 * download e a revisão que cresce a cada mudança: o calendário que já tem o
 * evento fica com a versão nova. Sem prazo válido, nenhum.
 */
export function icsDaAcao(acao: AcaoParaAAgenda, t: TranslateFn, fuso: string = fusoDoAparelho(), agora: number = Date.now()) {
  const inicio = acao.prazo ? inicioDoEventoDaAcao(acao.prazo, fuso) : null;
  if (inicio === null) return null;
  const { titulo, descricao } = textosNaTela(acao, t);
  const conteudo = montarIcs({
    uid: uidDoIcsDaAcao(acao.id),
    titulo,
    inicioMs: inicio,
    duracaoMinutos: DURACAO_DO_EVENTO_DA_ACAO_MIN,
    descricao,
    lembreteMinutos: 0,
    revisao: revisaoDoIcs(acao.createdAt, acao.updatedAt),
    modificadoEmMs: acao.updatedAt,
  }, agora);
  return { conteudo, nome: nomeDoArquivoIcs(titulo) };
}

/** O link que abre a Google Agenda com o evento da ação preenchido, sem conta ligada. Sem prazo válido, nenhum. */
export function linkDaAcaoNaGoogle(acao: AcaoParaAAgenda, t: TranslateFn, fuso: string = fusoDoAparelho()): string | null {
  const inicio = acao.prazo ? inicioDoEventoDaAcao(acao.prazo, fuso) : null;
  if (inicio === null) return null;
  const { titulo, descricao } = textosNaTela(acao, t);
  return linkDaGoogleAgenda({ titulo, inicioMs: inicio, duracaoMinutos: DURACAO_DO_EVENTO_DA_ACAO_MIN, fuso, detalhes: descricao });
}

/** Baixa o .ics. O link temporário sai depois do download. */
function baixar(conteudo: string, nome: string) {
  const endereco = URL.createObjectURL(new Blob([conteudo], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = endereco;
  link.download = nome;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(endereco), 10_000);
}

/** O erro do "Tentar de novo" de tirar o evento: a ação que continua aberta e com prazo tem frase própria. */
export function mensagemDoErroDeTirarDaAgenda(t: TranslateFn, erro: unknown): string {
  if ((erro as { data?: { code?: string } } | null)?.data?.code === "CONFLICT") return t("proximasAcoes.agenda.errors.stillOpen");
  return mensagemDeErroParaTela(erro, t);
}

/**
 * Os avisos do que houve na Google depois de anotar, editar, marcar ou apagar
 * uma ação: o que a dona salvou está salvo, e a falha da Google vem num aviso à
 * parte, com o porquê. Quando o evento ficou na Google (a ação saiu dela, e a
 * Google não confirmou), o aviso traz "Tentar de novo"; quando só reconectar
 * resolve, ele diz para apagar o evento por lá. A conexão que a Google recusou,
 * ou que saiu em outra aba, faz o estado dela ser relido.
 */
export function useAvisosDaAgenda() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const releConexao = (resultado: ResultadoNaGoogle | undefined) => {
    if (resultado?.naGoogle === "falhou" && (resultado.motivo === "revogada" || resultado.motivo === "nao-conectada")) {
      void utils.googleAgenda.estado.invalidate();
    }
  };
  const tirar = trpc.proximasAcoes.tirarDaGoogle.useMutation({
    onSuccess: (resultado, variaveis) => {
      if (resultado.naGoogle === "falhou") avisarQueFicou(variaveis.id, resultado.motivo);
      else toast.success(t("proximasAcoes.agenda.toast.removed"));
      releConexao(resultado);
    },
    onError: erro => toast.error(mensagemDoErroDeTirarDaAgenda(t, erro)),
  });
  function avisarQueFicou(acaoId: string, motivo: MotivoSemGoogle) {
    const texto = `${t("proximasAcoes.agenda.toast.notRemoved")} ${motivo === "google" ? motivoDaAgendaNaTela(t, motivo) : t("agenda.google.toast.removeThere")}`;
    if (motivo === "google") toast.warning(texto, { duration: 15_000, action: { label: t("agenda.google.retry"), onClick: () => tirar.mutate({ id: acaoId }) } });
    else toast.warning(texto, { duration: 15_000 });
  }
  return {
    /** Depois de mandar a ação para a Google: anotar, editar com prazo, reabrir. */
    depoisDeMandar(resultado: ResultadoNaGoogle | undefined) {
      if (resultado?.naGoogle === "falhou") toast.warning(`${t("proximasAcoes.agenda.toast.notSent")} ${motivoDaAgendaNaTela(t, resultado.motivo)}`, { duration: 10_000 });
      releConexao(resultado);
    },
    /** Depois de tirar a ação da Google: feita, sem prazo ou apagada. */
    depoisDeTirar(acaoId: string, resultado: ResultadoNaGoogle | undefined) {
      if (resultado?.naGoogle === "falhou") avisarQueFicou(acaoId, resultado.motivo);
      releConexao(resultado);
    },
  };
}

const BOTAO = "inline-flex items-center gap-1 text-xs font-semibold text-amber-200 hover:text-amber-100 disabled:opacity-50";

/**
 * A linha da agenda de uma ação aberta com prazo. Com o dia do prazo encerrado
 * (a ação atrasada), só o estado na Google aparece: o link e o .ics criariam um
 * evento no passado, e a Google não recebe a que ainda não está lá.
 */
export function AcaoNaAgenda({ acao, googleLigada, googleDesligada, aoTerminar, aoFalhar }: {
  acao: AcaoParaAAgenda;
  /** A Google Agenda conectada: a linha mostra o estado da ação lá. */
  googleLigada: boolean;
  /** A resposta foi "não conectada" (ou a função não existe para a conta): o link de criar evento aparece. */
  googleDesligada: boolean;
  /** Relê as telas da ação depois de mandar (a lista, o perfil do contato). */
  aoTerminar: () => unknown;
  aoFalhar: (erro: unknown) => void;
}) {
  const { t } = useTranslation();
  const avisos = useAvisosDaAgenda();
  const mandar = trpc.proximasAcoes.mandarParaGoogle.useMutation({
    onSuccess: resultado => {
      if (resultado.naGoogle === "ok") toast.success(t("proximasAcoes.agenda.toast.sent"));
      else if (resultado.naGoogle === null) toast.info(t("proximasAcoes.agenda.toast.pastNotSent"));
      avisos.depoisDeMandar(resultado);
    },
    onError: aoFalhar,
    onSettled: aoTerminar,
  });
  const futura = destinoDaAcaoNaAgenda(acao, fusoDoAparelho(), Date.now()) === "gravar";
  const link = googleDesligada && futura ? linkDaAcaoNaGoogle(acao, t) : null;
  const mandarAgora = () => mandar.mutate({ id: acao.id, ...pedidoDaTela(t) });
  const baixarIcs = () => {
    const ics = icsDaAcao(acao, t);
    if (ics) baixar(ics.conteudo, ics.nome);
  };

  let naGoogle = null;
  if (googleLigada && acao.google === "ok") {
    naGoogle = <span className="inline-flex items-center gap-1 text-xs text-emerald-200/90">
      <CalendarCheck size={12} aria-hidden="true"/> {t("agenda.google.onCalendar")}
    </span>;
  } else if (googleLigada && (acao.google === "pendente" || acao.google === "falhou")) {
    naGoogle = <span className="inline-flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-xs text-amber-200/90"><AlertTriangle size={12} aria-hidden="true"/> {t("agenda.google.notOnCalendar")}</span>
      <button type="button" onClick={mandarAgora} disabled={mandar.isPending} className={BOTAO}>
        {mandar.isPending ? <Loader2 size={12} className="animate-spin" aria-hidden="true"/> : <RefreshCw size={12} aria-hidden="true"/>}
        {mandar.isPending ? t("agenda.google.sending") : t("agenda.google.retry")}
      </button>
    </span>;
  } else if (googleLigada && futura) {
    naGoogle = <button type="button" onClick={mandarAgora} disabled={mandar.isPending} className={BOTAO}>
      {mandar.isPending ? <Loader2 size={12} className="animate-spin" aria-hidden="true"/> : <CalendarPlus size={12} aria-hidden="true"/>}
      {mandar.isPending ? t("agenda.google.sending") : t("agenda.google.send")}
    </button>;
  }
  if (!naGoogle && !link && !futura) return null;

  return <div role="group" aria-label={t("proximasAcoes.agenda.group")} className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
    {naGoogle}
    {link && <a href={link} target="_blank" rel="noopener noreferrer" className={BOTAO}>
      <CalendarPlus size={12} aria-hidden="true"/> {t("agenda.card.googleCalendar")}
    </a>}
    {futura && <button type="button" onClick={baixarIcs} className={BOTAO}>
      <Download size={12} aria-hidden="true"/> {t("proximasAcoes.agenda.downloadIcs")}
    </button>}
  </div>;
}
