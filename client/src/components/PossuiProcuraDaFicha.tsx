import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { RECUSAS_DO_ITEM_DA_FICHA, ROTULO_DO_ITEM_DA_FICHA_MAX, type TipoDoItemDaFicha } from "@shared/possui-procura-da-ficha";

/**
 * O que o contato possui e o que ele procura, na ficha (T45, 24/11): a dona
 * vê, acrescenta, corrige e remove cada item. Antes a ficha só removia, e
 * acrescentar ou corrigir era só pelo chat. O que ela escreve aqui é a palavra
 * dela e entra como ela escreveu (o servidor não passa pela IA,
 * server/possui-procura-da-ficha.ts); a nota da seção diz isso. As recusas
 * chegam como código e saem traduzidas.
 */

type Item = { id: number; label: string; category: string | null };
type TraduzirFn = (chave: string, opcoes?: Record<string, unknown>) => string;

export function mensagemDoItemDaFicha(t: TraduzirFn, erro: unknown) {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (mensagem === RECUSAS_DO_ITEM_DA_FICHA.repetido) return t("network.erroItemRepetido");
  if (mensagem === RECUSAS_DO_ITEM_DA_FICHA.semTexto) return t("network.erroItemSemTexto");
  return t("network.erroSalvarItem");
}

export function PossuiProcuraDaFicha({ contactId, possui, procura, removerPossui, removerProcura, removendo }: {
  contactId: number;
  possui: Item[];
  procura: Item[];
  removerPossui: (id: number) => void;
  removerProcura: (id: number) => void;
  removendo: boolean;
}) {
  const { t } = useTranslation();
  const grupos = [
    { tipo: "possui" as const, rotulo: t("network.rotuloPossui"), itens: possui, cor: "border-emerald-400/30 text-emerald-200/80", remover: removerPossui, novo: t("network.novoItemPossui"), exemplo: t("network.exemploPossui") },
    { tipo: "procura" as const, rotulo: t("network.rotuloProcura"), itens: procura, cor: "border-sky-300/30 text-sky-200/80", remover: removerProcura, novo: t("network.novoItemProcura"), exemplo: t("network.exemploProcura") },
  ];
  return <div className="space-y-4">
    {possui.length === 0 && procura.length === 0 && <p className="text-xs text-white/35">{t("network.semPossuiProcura")}</p>}
    {grupos.map(grupo => <GrupoDaFicha key={grupo.tipo} contactId={contactId} {...grupo} removendo={removendo}/>)}
    <p className="text-[11px] text-white/35">{t("network.notaItemDaFicha")}</p>
  </div>;
}

function GrupoDaFicha({ contactId, tipo, rotulo, itens, cor, remover, removendo, novo, exemplo }: {
  contactId: number; tipo: TipoDoItemDaFicha; rotulo: string; itens: Item[]; cor: string;
  remover: (id: number) => void; removendo: boolean; novo: string; exemplo: string;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [texto, setTexto] = useState("");
  const [editando, setEditando] = useState<{ id: number; texto: string } | null>(null);
  const depois = () => {
    void utils.network.assetsNeeds.invalidate({ contactId });
  };
  const acrescentar = trpc.network.addItem.useMutation({
    onSuccess: () => { setTexto(""); toast.success(t("network.toastItemAcrescentado")); },
    onError: erro => toast.error(mensagemDoItemDaFicha(t, erro)),
    onSettled: depois,
  });
  const corrigir = trpc.network.editItem.useMutation({
    onSuccess: () => { setEditando(null); toast.success(t("network.toastItemCorrigido")); },
    onError: erro => toast.error(mensagemDoItemDaFicha(t, erro)),
    onSettled: depois,
  });
  const ocupado = removendo || acrescentar.isPending || corrigir.isPending;
  const aoAcrescentar = (evento: FormEvent) => {
    evento.preventDefault();
    if (!texto.trim()) return;
    acrescentar.mutate({ contactId, tipo, rotulo: texto.trim() });
  };
  const aoCorrigir = (evento: FormEvent) => {
    evento.preventDefault();
    if (!editando || !editando.texto.trim()) return;
    corrigir.mutate({ id: editando.id, tipo, rotulo: editando.texto.trim() });
  };
  return <div>
    <p className="text-xs text-white/50 mb-1.5">{rotulo}</p>
    {itens.length > 0 && <ul className="flex flex-wrap gap-2">
      {itens.map(item => editando?.id === item.id ? (
        <li key={item.id} className="w-full">
          <form onSubmit={aoCorrigir} className="flex flex-wrap items-center gap-2">
            <input aria-label={t("network.textoDoItem")} value={editando.texto} maxLength={ROTULO_DO_ITEM_DA_FICHA_MAX} dir="auto" autoFocus
              onChange={evento => setEditando({ id: item.id, texto: evento.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/20 px-3 py-1.5 text-xs text-white"/>
            <button type="submit" disabled={ocupado || !editando.texto.trim()} className="inline-flex items-center gap-1 rounded-lg bg-amber-500/80 px-2.5 py-1.5 text-xs font-semibold text-[#1a120c] disabled:opacity-50">
              <Check size={12} aria-hidden/> {t("network.salvarItem")}
            </button>
            <button type="button" onClick={() => setEditando(null)} className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-white/60">{t("network.cancelarItem")}</button>
          </form>
        </li>
      ) : (
        <li key={item.id} className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${cor}`}>
          <span dir="auto" className="min-w-0 break-words">{item.label}</span>{item.category ? <span className="text-white/35"> · {item.category}</span> : null}
          <button type="button" aria-label={t("network.editarItemAria", { label: item.label })} title={t("network.editarItemAria", { label: item.label })}
            disabled={ocupado} onClick={() => setEditando({ id: item.id, texto: item.label })}
            className="shrink-0 rounded-full p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
            <Pencil size={11} aria-hidden/>
          </button>
          <button type="button" aria-label={t("intelligentMatches.removerAriaLabel", { label: item.label })} title={t("intelligentMatches.removerTooltip")}
            disabled={ocupado} onClick={() => remover(item.id)}
            className="shrink-0 rounded-full p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">
            <X size={12} aria-hidden/>
          </button>
        </li>
      ))}
    </ul>}
    <form onSubmit={aoAcrescentar} className="mt-2 flex items-center gap-2">
      <input aria-label={novo} placeholder={exemplo} value={texto} maxLength={ROTULO_DO_ITEM_DA_FICHA_MAX} dir="auto"
        onChange={evento => setTexto(evento.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/20 px-3 py-1.5 text-xs text-white placeholder:text-white/30"/>
      <button type="submit" disabled={ocupado || !texto.trim()} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/10 disabled:opacity-40">
        <Plus size={12} aria-hidden/> {t("network.acrescentarItem")}
      </button>
    </form>
  </div>;
}
