import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen, Briefcase, CalendarDays, Check, Flag, Folder, FolderMinus, FolderPlus, Globe, Heart, House, Lightbulb, Loader2, Mic, Star, Users,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import {
  COR_DA_PASTA_PADRAO, CORES_DA_PASTA, ICONE_DA_PASTA_PADRAO, ICONES_DA_PASTA, NOME_DA_PASTA_MAX, normalizarNomeDaPasta, PASTAS_POR_DONA_MAX,
  RECUSAS_DAS_PASTAS, REUNIOES_POR_ACAO_MAX, type CodigoDaRecusaDaPasta, type CorDaPasta, type IconeDaPasta,
} from "@shared/pastas-de-reunioes";

/**
 * As pastas das reuniões na tela (H7d; HN-67 no app de referência da cliente):
 * o desenho do ícone e da cor de cada pasta, o editor (criar, renomear, trocar
 * ícone e cor, apagar) e a escolha da pasta para mover as reuniões
 * selecionadas. O servidor confere tudo de novo (server/pastas-de-reunioes.ts);
 * as recusas chegam como código e saem no idioma da tela.
 */

export type PastaNaTela = { id: string; nome: string; icone: IconeDaPasta; cor: CorDaPasta; reunioes: number };

const DESENHO_DO_ICONE: Record<IconeDaPasta, LucideIcon> = {
  pasta: Folder, estrela: Star, maleta: Briefcase, pessoas: Users, coracao: Heart, livro: BookOpen,
  lampada: Lightbulb, globo: Globe, microfone: Mic, calendario: CalendarDays, bandeira: Flag, casa: House,
};

/** As classes de cada cor, inteiras (o Tailwind só gera a classe escrita por extenso), legíveis no fundo escuro. */
export const CLASSES_DA_COR: Record<CorDaPasta, { texto: string; fundo: string; borda: string; amostra: string }> = {
  ambar: { texto: "text-amber-300", fundo: "bg-amber-300/10", borda: "border-amber-300/30", amostra: "bg-amber-300" },
  vermelho: { texto: "text-red-300", fundo: "bg-red-300/10", borda: "border-red-300/30", amostra: "bg-red-400" },
  laranja: { texto: "text-orange-300", fundo: "bg-orange-300/10", borda: "border-orange-300/30", amostra: "bg-orange-400" },
  verde: { texto: "text-emerald-300", fundo: "bg-emerald-300/10", borda: "border-emerald-300/30", amostra: "bg-emerald-400" },
  azul: { texto: "text-sky-300", fundo: "bg-sky-300/10", borda: "border-sky-300/30", amostra: "bg-sky-400" },
  roxo: { texto: "text-violet-300", fundo: "bg-violet-300/10", borda: "border-violet-300/30", amostra: "bg-violet-400" },
  rosa: { texto: "text-pink-300", fundo: "bg-pink-300/10", borda: "border-pink-300/30", amostra: "bg-pink-400" },
  cinza: { texto: "text-zinc-300", fundo: "bg-zinc-300/10", borda: "border-zinc-300/30", amostra: "bg-zinc-400" },
};

/** O nome do ícone e da cor, para quem ouve a tela. O Record é pelo tipo: chave nova lá não compila aqui sem o texto. */
const NOME_DO_ICONE: Record<IconeDaPasta, (t: (chave: string) => string) => string> = {
  pasta: t => t("meetings.folders.icons.pasta"), estrela: t => t("meetings.folders.icons.estrela"), maleta: t => t("meetings.folders.icons.maleta"),
  pessoas: t => t("meetings.folders.icons.pessoas"), coracao: t => t("meetings.folders.icons.coracao"), livro: t => t("meetings.folders.icons.livro"),
  lampada: t => t("meetings.folders.icons.lampada"), globo: t => t("meetings.folders.icons.globo"), microfone: t => t("meetings.folders.icons.microfone"),
  calendario: t => t("meetings.folders.icons.calendario"), bandeira: t => t("meetings.folders.icons.bandeira"), casa: t => t("meetings.folders.icons.casa"),
};
const NOME_DA_COR: Record<CorDaPasta, (t: (chave: string) => string) => string> = {
  ambar: t => t("meetings.folders.colors.ambar"), vermelho: t => t("meetings.folders.colors.vermelho"), laranja: t => t("meetings.folders.colors.laranja"),
  verde: t => t("meetings.folders.colors.verde"), azul: t => t("meetings.folders.colors.azul"), roxo: t => t("meetings.folders.colors.roxo"),
  rosa: t => t("meetings.folders.colors.rosa"), cinza: t => t("meetings.folders.colors.cinza"),
};

export function IconeDaPastaNaTela({ icone, cor, tamanho = 16, className = "" }: { icone: IconeDaPasta; cor: CorDaPasta; tamanho?: number; className?: string }) {
  const Desenho = DESENHO_DO_ICONE[icone] ?? Folder;
  return <Desenho size={tamanho} aria-hidden="true" className={`shrink-0 ${CLASSES_DA_COR[cor]?.texto ?? CLASSES_DA_COR.ambar.texto} ${className}`} />;
}

/** O aviso de cada recusa das pastas (o código do servidor), no idioma da tela. */
const AVISO_POR_RECUSA: Record<CodigoDaRecusaDaPasta, (t: (chave: string, opcoes?: Record<string, unknown>) => string) => string> = {
  [RECUSAS_DAS_PASTAS.naoEncontrada]: t => t("meetings.folders.errorNotFound"),
  [RECUSAS_DAS_PASTAS.demais]: t => t("meetings.folders.errorTooMany", { max: PASTAS_POR_DONA_MAX }),
  [RECUSAS_DAS_PASTAS.nomeInvalido]: t => t("meetings.folders.errorNameInvalid"),
  [RECUSAS_DAS_PASTAS.nomeRepetido]: t => t("meetings.folders.errorNameRepeated"),
};

export function avisoDaRecusaDaPasta(erro: unknown, t: (chave: string, opcoes?: Record<string, unknown>) => string, padrao: string): string {
  const { message, data } = (erro ?? {}) as { message?: unknown; data?: { code?: unknown } };
  if (typeof message === "string" && Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA, message)) {
    return AVISO_POR_RECUSA[message as CodigoDaRecusaDaPasta](t);
  }
  if (data?.code === "NOT_FOUND") return t("meetings.meetingNotFound");
  if (typeof message === "string" && data?.code) {
    const traduzida = traduzirMensagemDoServidor(message, t);
    if (traduzida !== message) return traduzida;
  }
  return padrao;
}

/** A janela de baixo no celular e centrada no computador, como a da junção. */
function Janela({ titulo, idDoTitulo, children }: { titulo: string; idDoTitulo: string; children: React.ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={idDoTitulo} className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-white/15 bg-[#211e1b] p-5 shadow-2xl sm:rounded-2xl sm:p-6">
        <h3 id={idDoTitulo} className="font-bold text-white">{titulo}</h3>
        {children}
      </div>
    </div>
  );
}

/**
 * O editor da pasta: criar (sem `pasta`) ou mudar o nome, o ícone e a cor; ao
 * editar, também apagar (as reuniões dela ficam sem pasta). `aoCriar` recebe o
 * id da pasta nova (a escolha da pasta usa para mover as reuniões para ela).
 */
export function EditorDePasta({ pasta, aoFechar, aoCriar, aoApagar }: {
  pasta?: PastaNaTela;
  aoFechar: () => void;
  aoCriar?: (pastaId: string) => void;
  aoApagar?: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [nome, setNome] = useState(pasta?.nome ?? "");
  const [icone, setIcone] = useState<IconeDaPasta>(pasta?.icone ?? ICONE_DA_PASTA_PADRAO);
  const [cor, setCor] = useState<CorDaPasta>(pasta?.cor ?? COR_DA_PASTA_PADRAO);
  const [confirmandoApagar, setConfirmandoApagar] = useState(false);
  const atualizar = () => Promise.all([utils.meetings.pastas.invalidate(), utils.meetings.list.invalidate()]);
  const criar = trpc.meetings.criarPasta.useMutation({
    onSuccess: async ({ id }) => { await atualizar(); toast.success(t("meetings.folders.created")); aoCriar?.(id); aoFechar(); },
    onError: erro => toast.error(avisoDaRecusaDaPasta(erro, t, t("meetings.folders.error"))),
  });
  const editar = trpc.meetings.editarPasta.useMutation({
    onSuccess: async () => { await atualizar(); toast.success(t("meetings.folders.saved")); aoFechar(); },
    onError: erro => toast.error(avisoDaRecusaDaPasta(erro, t, t("meetings.folders.error"))),
  });
  const apagar = trpc.meetings.apagarPasta.useMutation({
    onSuccess: async () => { await atualizar(); toast.success(t("meetings.folders.deleted")); aoApagar?.(); aoFechar(); },
    onError: erro => toast.error(avisoDaRecusaDaPasta(erro, t, t("meetings.folders.error"))),
  });
  const ocupado = criar.isPending || editar.isPending || apagar.isPending;
  const nomeValido = normalizarNomeDaPasta(nome) !== null;
  const salvar = () => {
    if (!nomeValido) return;
    if (pasta) editar.mutate({ pastaId: pasta.id, nome, icone, cor });
    else criar.mutate({ nome, icone, cor });
  };

  if (pasta && confirmandoApagar) {
    return (
      <Janela titulo={t("meetings.folders.deleteConfirmTitle", { nome: pasta.nome })} idDoTitulo="apagar-pasta-titulo">
        <p className="mt-2 text-sm text-white/60">{t("meetings.folders.deleteConfirmText")}</p>
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={() => setConfirmandoApagar(false)} disabled={ocupado} className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50">{t("meetings.folders.cancel")}</button>
          <button type="button" onClick={() => apagar.mutate({ pastaId: pasta.id })} disabled={ocupado}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-white hover:bg-red-400 disabled:opacity-50">
            {apagar.isPending && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{t("meetings.folders.deleteConfirm")}
          </button>
        </div>
      </Janela>
    );
  }

  return (
    <Janela titulo={pasta ? t("meetings.folders.editTitle") : t("meetings.folders.newTitle")} idDoTitulo="editor-de-pasta-titulo">
      <form className="mt-4 space-y-5" onSubmit={evento => { evento.preventDefault(); salvar(); }}>
        <label className="block text-sm text-white/70">
          {t("meetings.folders.nameLabel")}
          <input value={nome} onChange={evento => setNome(evento.target.value)} maxLength={NOME_DA_PASTA_MAX * 2} autoFocus dir="auto"
            placeholder={t("meetings.folders.namePlaceholder")}
            className="mt-1 w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2.5 text-white outline-none placeholder:text-white/30 focus:border-amber-300/50" />
        </label>
        <fieldset>
          <legend className="text-sm text-white/70">{t("meetings.folders.iconLabel")}</legend>
          <div className="mt-2 grid grid-cols-6 gap-2">
            {ICONES_DA_PASTA.map(opcao => (
              <button key={opcao} type="button" aria-pressed={icone === opcao} aria-label={NOME_DO_ICONE[opcao](t)} onClick={() => setIcone(opcao)}
                className={`flex aspect-square items-center justify-center rounded-xl border ${icone === opcao ? `${CLASSES_DA_COR[cor].borda} ${CLASSES_DA_COR[cor].fundo}` : "border-white/10 hover:bg-white/5"}`}>
                <IconeDaPastaNaTela icone={opcao} cor={icone === opcao ? cor : "cinza"} tamanho={18} />
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm text-white/70">{t("meetings.folders.colorLabel")}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {CORES_DA_PASTA.map(opcao => (
              <button key={opcao} type="button" aria-pressed={cor === opcao} aria-label={NOME_DA_COR[opcao](t)} onClick={() => setCor(opcao)}
                className={`flex h-9 w-9 items-center justify-center rounded-full border-2 ${cor === opcao ? "border-white" : "border-transparent"}`}>
                <span className={`flex h-6 w-6 items-center justify-center rounded-full ${CLASSES_DA_COR[opcao].amostra}`}>
                  {cor === opcao && <Check size={14} aria-hidden="true" className="text-[#1a120c]" />}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-3 pt-1 sm:flex-row">
          {pasta && (
            <button type="button" onClick={() => setConfirmandoApagar(true)} disabled={ocupado}
              className="rounded-xl border border-red-400/25 px-4 py-2.5 text-sm text-red-200 hover:bg-red-400/10 disabled:opacity-50 sm:me-auto">{t("meetings.folders.delete")}</button>
          )}
          <button type="button" onClick={aoFechar} disabled={ocupado} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50">{t("meetings.folders.cancel")}</button>
          <button type="submit" disabled={ocupado || !nomeValido}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-5 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
            {(criar.isPending || editar.isPending) && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
            {pasta ? t("meetings.folders.save") : t("meetings.folders.create")}
          </button>
        </div>
      </form>
    </Janela>
  );
}

/** As reuniões em lotes do tamanho que o servidor aceita por pedido. */
export function emLotes<T>(itens: readonly T[], tamanho = REUNIOES_POR_ACAO_MAX): T[][] {
  const lotes: T[][] = [];
  for (let inicio = 0; inicio < itens.length; inicio += tamanho) lotes.push(itens.slice(inicio, inicio + tamanho));
  return lotes;
}

/**
 * A escolha da pasta para as reuniões selecionadas: uma das pastas da dona,
 * "Sem pasta" (tira da pasta) ou uma pasta nova, criada ali mesmo. O servidor
 * move todas ou nenhuma de cada lote.
 */
export function EscolherPasta({ reunioes, pastas, erro = null, aoTentarDeNovo, aoFechar, aoMover }: {
  reunioes: string[];
  /** As pastas da dona; null enquanto a consulta não deu certo (carregando ou com erro). */
  pastas: PastaNaTela[] | null;
  /** O erro da consulta das pastas (o banco fora do ar), que a janela mostra com o "tentar de novo". */
  erro?: unknown;
  aoTentarDeNovo?: () => void;
  aoFechar: () => void;
  aoMover: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [criando, setCriando] = useState(false);
  const [movendo, setMovendo] = useState(false);
  const mover = async (pastaId: string | null) => {
    setMovendo(true);
    try {
      for (const lote of emLotes(reunioes)) await utils.client.meetings.moverParaPasta.mutate({ meetingIds: lote, pastaId });
      toast.success(pastaId ? t("meetings.folders.moved") : t("meetings.folders.movedOut"));
      aoMover();
    } catch (erro) {
      toast.error(avisoDaRecusaDaPasta(erro, t, t("meetings.folders.moveError")));
    } finally {
      setMovendo(false);
      await Promise.all([utils.meetings.list.invalidate(), utils.meetings.pastas.invalidate()]);
    }
  };
  if (criando) return <EditorDePasta aoFechar={() => setCriando(false)} aoCriar={pastaId => void mover(pastaId)} />;
  // Sem a lista das pastas (carregando, ou o banco fora do ar), a janela não
  // oferece nada: só "Sem pasta" e "Nova pasta" pareceria que a dona não tem
  // pastas, e um toque em "Sem pasta" tiraria as reuniões das delas.
  if (!pastas) {
    return (
      <Janela titulo={t("meetings.folders.moveTitle")} idDoTitulo="escolher-pasta-titulo">
        <div className="mt-4">
          {erro ? <ErroDeConsulta erro={erro} aoTentarDeNovo={aoTentarDeNovo} />
            : <p role="status" className="text-sm text-white/50"><Loader2 size={14} className="me-2 inline animate-spin" aria-hidden="true" />{t("meetings.loadingList")}</p>}
        </div>
        <div className="mt-6 flex items-center gap-3">
          <button type="button" onClick={aoFechar} className="ms-auto rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/60 hover:bg-white/5">{t("meetings.folders.cancel")}</button>
        </div>
      </Janela>
    );
  }
  return (
    <Janela titulo={t("meetings.folders.moveTitle")} idDoTitulo="escolher-pasta-titulo">
      <p className="mt-1 text-xs text-white/50">{t("meetings.select.selected", { n: reunioes.length })}</p>
      <ul className="mt-4 space-y-2">
        {pastas.map(pasta => (
          <li key={pasta.id}>
            <button type="button" disabled={movendo} onClick={() => void mover(pasta.id)}
              className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-start hover:bg-white/[0.07] disabled:opacity-50">
              <IconeDaPastaNaTela icone={pasta.icone} cor={pasta.cor} tamanho={18} />
              <span dir="auto" className="min-w-0 flex-1 break-words text-sm font-semibold text-white">{pasta.nome}</span>
              <span className="shrink-0 text-xs text-white/45">{t("meetings.folders.meetingsCount", { n: pasta.reunioes })}</span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" disabled={movendo} onClick={() => void mover(null)}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 p-3 text-start text-white/70 hover:bg-white/[0.05] disabled:opacity-50">
            <FolderMinus size={18} aria-hidden="true" className="shrink-0 text-white/50" />
            <span className="text-sm">{t("meetings.folders.noFolder")}</span>
          </button>
        </li>
        <li>
          <button type="button" disabled={movendo || pastas.length >= PASTAS_POR_DONA_MAX} onClick={() => setCriando(true)}
            className="flex w-full items-center gap-3 rounded-xl border border-dashed border-white/20 p-3 text-start text-amber-200 hover:bg-white/[0.05] disabled:opacity-50">
            <FolderPlus size={18} aria-hidden="true" className="shrink-0" />
            <span className="text-sm">{t("meetings.folders.new")}</span>
          </button>
        </li>
      </ul>
      <div className="mt-6 flex items-center gap-3">
        {movendo && <Loader2 size={16} className="animate-spin text-white/60" aria-label={t("meetings.folders.moving")} />}
        <button type="button" onClick={aoFechar} disabled={movendo} className="ms-auto rounded-xl border border-white/15 px-4 py-2.5 text-sm text-white/60 hover:bg-white/5 disabled:opacity-50">{t("meetings.folders.cancel")}</button>
      </div>
    </Janela>
  );
}
