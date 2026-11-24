import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import {
  ESCOLHA_DA_IA, ESTILO_DO_RESUMO_PADRAO, ESTILOS_DO_RESUMO, MODELOS_DE_RESUMO, ICONES_DOS_MODELOS, INSTRUCOES_DO_MODELO_MAX, MODELOS_PROPRIOS_MAX, NOME_DO_MODELO_MAX, RECUSAS_DOS_MODELOS,
  type EstiloDoResumo,
} from "@shared/modelos-de-resumo";
import { nomeDoEstilo, nomeDoModelo, useModelosDaDona, type ModeloProprioNaTela } from "@/components/ModeloDoResumo";

/**
 * Os modelos de resumo da própria dona (H4e do plano do gravador; HN-35 do
 * HiNoter): criar, editar e apagar um modelo (nome, ícone e as instruções que
 * dizem à IA que tipo de reunião é e o que destacar), e o padrão dos próximos
 * resumos (o modelo e o estilo). Só da dona: o link aberto não mostra nada
 * disto. O servidor confere tudo de novo (server/modelos-proprios.ts).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function mensagemDosModelos(t: TranslateFn, erro: unknown): string {
  const message = (erro as { message?: unknown } | null)?.message;
  if (message === RECUSAS_DOS_MODELOS.demais) return t("meetings.summary.myTemplates.errorTooMany", { n: MODELOS_PROPRIOS_MAX });
  if (message === RECUSAS_DOS_MODELOS.nomeRepetido) return t("meetings.summary.myTemplates.errorRepeated");
  if (message === RECUSAS_DOS_MODELOS.naoEncontrado) return t("meetings.summary.myTemplates.errorNotFound");
  return mensagemDeErroParaTela(erro, t);
}

type Rascunho = { id: string | null; nome: string; icone: string; instrucoes: string };
const NOVO: Rascunho = { id: null, nome: "", icone: ICONES_DOS_MODELOS[0], instrucoes: "" };

function FormularioDoModelo({ inicial, aoFechar }: { inicial: Rascunho; aoFechar: () => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const id = useId();
  const [rascunho, setRascunho] = useState(inicial);
  const reler = () => utils.meetings.modelosDeResumo.invalidate();
  // O resumo aberto mostra o nome e o ícone do modelo da dona: editado, relê.
  const relerComOResumo = () => Promise.all([reler(), utils.meetings.resumoGuardado.invalidate()]);
  const aoDarCerto = () => { toast.success(t("meetings.summary.myTemplates.saved")); aoFechar(); };
  const criar = trpc.meetings.criarModeloDeResumo.useMutation({ onSuccess: aoDarCerto, onSettled: reler });
  const editar = trpc.meetings.editarModeloDeResumo.useMutation({ onSuccess: aoDarCerto, onSettled: relerComOResumo });
  const salvando = criar.isPending || editar.isPending;
  const erro = criar.error ?? editar.error;
  const valido = rascunho.nome.trim().length > 0 && rascunho.instrucoes.trim().length > 0;
  const salvar = () => {
    const dados = { nome: rascunho.nome.trim(), icone: rascunho.icone as (typeof ICONES_DOS_MODELOS)[number], instrucoes: rascunho.instrucoes.trim() };
    if (rascunho.id) editar.mutate({ id: rascunho.id, ...dados });
    else criar.mutate(dados);
  };
  return <form className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-4" onSubmit={evento => { evento.preventDefault(); if (valido && !salvando) salvar(); }}>
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${id}-nome`} className="text-xs font-semibold text-white/60">{t("meetings.summary.myTemplates.name")}</label>
      <input id={`${id}-nome`} value={rascunho.nome} maxLength={NOME_DO_MODELO_MAX} disabled={salvando}
        onChange={evento => setRascunho({ ...rascunho, nome: evento.target.value })}
        className="w-full min-w-0 rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300"/>
    </div>
    <fieldset className="min-w-0">
      <legend className="text-xs font-semibold text-white/60">{t("meetings.summary.myTemplates.icon")}</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {ICONES_DOS_MODELOS.map(icone => <label key={icone} className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border text-lg ${rascunho.icone === icone ? "border-amber-300/70 bg-amber-300/15" : "border-white/15"}`}>
          <input type="radio" name={`${id}-icone`} value={icone} checked={rascunho.icone === icone} disabled={salvando}
            onChange={() => setRascunho({ ...rascunho, icone })} className="sr-only"/>
          <span aria-hidden="true">{icone}</span><span className="sr-only">{icone}</span>
        </label>)}
      </div>
    </fieldset>
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${id}-instrucoes`} className="text-xs font-semibold text-white/60">{t("meetings.summary.myTemplates.instructions")}</label>
      <textarea id={`${id}-instrucoes`} value={rascunho.instrucoes} maxLength={INSTRUCOES_DO_MODELO_MAX} rows={4} disabled={salvando}
        aria-describedby={`${id}-aviso`} placeholder={t("meetings.summary.myTemplates.instructionsPlaceholder")}
        onChange={evento => setRascunho({ ...rascunho, instrucoes: evento.target.value })}
        className="w-full min-w-0 resize-y rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300"/>
      {/* Texto para a Cris revisar: o que vai à Google e o que fica guardado. */}
      <p id={`${id}-aviso`} className="text-xs text-white/45">{t("meetings.summary.myTemplates.privacyNote")}</p>
    </div>
    {erro && <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDosModelos(t, erro)}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={!valido || salvando}
        className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
        {salvando && <Loader2 size={15} className="animate-spin"/>}{t("meetings.summary.myTemplates.save")}
      </button>
      <button type="button" onClick={aoFechar} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:text-white">{t("meetings.summary.myTemplates.cancel")}</button>
    </div>
  </form>;
}

function PadraoDosResumos({ proprios, padrao, estilo }: { proprios: readonly ModeloProprioNaTela[]; padrao: string; estilo: EstiloDoResumo }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const id = useId();
  const [valor, setValor] = useState({ padrao, estilo });
  useEffect(() => setValor({ padrao, estilo }), [padrao, estilo]);
  const definir = trpc.meetings.definirPreferenciasDoResumo.useMutation({
    onSuccess: () => toast.success(t("meetings.summary.myTemplates.saved")),
    onSettled: () => utils.meetings.modelosDeResumo.invalidate(),
  });
  const mudou = valor.padrao !== padrao || valor.estilo !== estilo;
  return <div className="space-y-3 border-t border-white/10 pt-4">
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${id}-padrao`} className="text-xs font-semibold text-white/60">{t("meetings.summary.myTemplates.defaultLabel")}</label>
      <select id={`${id}-padrao`} value={valor.padrao} disabled={definir.isPending} onChange={evento => setValor({ ...valor, padrao: evento.target.value })}
        className="w-full min-w-0 rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300 sm:w-72">
        {MODELOS_DE_RESUMO.map(modelo => <option key={modelo} value={modelo}>{nomeDoModelo(t, modelo)}</option>)}
        {proprios.map(modelo => <option key={modelo.id} value={`proprio:${modelo.id}`}>{modelo.icone} {modelo.nome}</option>)}
        <option value={ESCOLHA_DA_IA}>{t("meetings.summary.templateAi")}</option>
      </select>
    </div>
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${id}-estilo`} className="text-xs font-semibold text-white/60">{t("meetings.summary.myTemplates.defaultStyle")}</label>
      <select id={`${id}-estilo`} value={valor.estilo} disabled={definir.isPending} onChange={evento => setValor({ ...valor, estilo: evento.target.value as EstiloDoResumo })}
        className="w-full min-w-0 rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300 sm:w-72">
        {ESTILOS_DO_RESUMO.map(opcao => <option key={opcao} value={opcao}>{nomeDoEstilo(t, opcao)}</option>)}
      </select>
    </div>
    {definir.isError && <p role="alert" className="text-sm text-red-200">{mensagemDosModelos(t, definir.error)}</p>}
    <button type="button" disabled={!mudou || definir.isPending} onClick={() => definir.mutate(valor)}
      className="inline-flex items-center gap-2 rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-300/10 disabled:opacity-50">
      {definir.isPending && <Loader2 size={14} className="animate-spin"/>}{t("meetings.summary.myTemplates.savePrefs")}
    </button>
  </div>;
}

/** O painel inteiro: a lista dos modelos da dona, o formulário e o padrão. */
export function MeusModelosDeResumo() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const modelos = useModelosDaDona();
  const [editando, setEditando] = useState<Rascunho | null>(null);
  const apagar = trpc.meetings.apagarModeloDeResumo.useMutation({
    onError: erro => toast.error(mensagemDosModelos(t, erro)),
    // O servidor troca para o Geral o resumo que usava o modelo apagado: o resumo aberto relê.
    onSettled: () => Promise.all([utils.meetings.modelosDeResumo.invalidate(), utils.meetings.resumoGuardado.invalidate()]),
  });
  if (modelos.isError) return <p role="alert" className="text-sm text-red-200">{mensagemDeErroParaTela(modelos.error, t)}</p>;
  if (!modelos.data) return <p role="status" className="text-sm text-white/55"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.summary.loading")}</p>;
  const { proprios, padrao, estilo } = modelos.data;
  const cheio = proprios.length >= MODELOS_PROPRIOS_MAX;
  return <section aria-labelledby="meus-modelos-de-resumo" className="space-y-4">
    <h3 id="meus-modelos-de-resumo" className="text-sm font-semibold text-amber-100">{t("meetings.summary.myTemplates.title")}</h3>
    {!proprios.length && !editando && <p className="text-sm text-white/55">{t("meetings.summary.myTemplates.empty")}</p>}
    {proprios.length > 0 && <ul className="space-y-2">
      {proprios.map(modelo => <li key={modelo.id} className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-white/90"><span aria-hidden="true">{modelo.icone} </span>{modelo.nome}</p>
          <p className="line-clamp-2 break-words text-xs text-white/50">{modelo.instrucoes}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" aria-label={t("meetings.summary.myTemplates.edit", { nome: modelo.nome })} onClick={() => setEditando({ ...modelo })}
            className="rounded-lg p-2 text-white/60 hover:bg-white/5 hover:text-white"><Pencil size={15}/></button>
          <button type="button" aria-label={t("meetings.summary.myTemplates.delete", { nome: modelo.nome })} disabled={apagar.isPending}
            onClick={() => { if (window.confirm(t("meetings.summary.myTemplates.deleteConfirm", { nome: modelo.nome }))) apagar.mutate({ id: modelo.id }); }}
            className="rounded-lg p-2 text-white/60 hover:bg-white/5 hover:text-red-200 disabled:opacity-50"><Trash2 size={15}/></button>
        </div>
      </li>)}
    </ul>}
    {editando
      ? <FormularioDoModelo key={editando.id ?? "novo"} inicial={editando} aoFechar={() => setEditando(null)}/>
      : <div>
        <button type="button" disabled={cheio} onClick={() => setEditando(NOVO)}
          className="inline-flex items-center gap-2 rounded-lg border border-dashed border-amber-300/40 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-300/10 disabled:opacity-50">
          <Plus size={15}/> {t("meetings.summary.myTemplates.new")}
        </button>
        <p className="mt-1 text-xs text-white/40">{t("meetings.summary.myTemplates.limit", { n: MODELOS_PROPRIOS_MAX })}</p>
      </div>}
    <PadraoDosResumos proprios={proprios} padrao={padrao} estilo={estilo ?? ESTILO_DO_RESUMO_PADRAO}/>
  </section>;
}
