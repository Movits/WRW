import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { CATEGORIA_DE_SERVICO, categoriaDoQuePreciso, MINIMO_DA_DESCRICAO, type ChaveOQuePreciso } from "@shared/o-que-preciso";
import { CATEGORIA_PADRAO_DO_PRECISO, CATEGORIAS_DO_PRECISO_DA_REUNIAO, type AlvoDoItem } from "@shared/reuniao-no-match";

/**
 * Um item que a reunião tirou de uma pessoa — o que ela TEM ou PRECISA, com o
 * trecho da conversa — para a dona decidir ali mesmo (N5): ✓ confirma, ✎
 * corrige o texto antes, ✕ ignora. Nada entra sem esse clique.
 *
 * O destino é o do item (`alvo`): o contato, como no perfil dele, ou o PERFIL
 * da própria dona ("Sou eu"). No perfil, o "preciso" vira demanda de "O que
 * preciso": ela escolhe a categoria ("Outra necessidade" por padrão; em
 * "Especialistas / Serviços", também o serviço), e a descrição pede 10
 * caracteres ou mais, como no Perfil. A recusa do servidor (BAD_REQUEST: o
 * item nomeia alguém da reunião, a lista cheia) aparece como ele a escreveu.
 */

export type ItemDaReuniaoNaTela = { id: string; campo: string; valor: string; trecho: string | null };

const OPCOES_DE_SERVICO = (() => {
  const definicao = categoriaDoQuePreciso(CATEGORIA_DE_SERVICO)?.campos.find(campo => campo.campo === "service");
  return definicao?.tipo === "opcoes" ? definicao.opcoes.map(opcao => opcao.chave) : [];
})();

export function LinhaDoItemDaReuniao({ item, alvo, aoDecidir, cabecalho }: {
  item: ItemDaReuniaoNaTela; alvo: AlvoDoItem; aoDecidir: () => void;
  /** O que vem antes do item, dentro dele (no Perfil, a reunião de onde veio). */
  cabecalho?: ReactNode;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [corrigindo, setCorrigindo] = useState(false);
  const [valor, setValor] = useState(item.valor);
  const [categoria, setCategoria] = useState<ChaveOQuePreciso>(CATEGORIA_PADRAO_DO_PRECISO);
  const [servico, setServico] = useState("");
  const confirmar = trpc.networkInteligente.confirmarPendencia.useMutation({
    onSuccess: resultado => {
      toast.success(t("networkInteligente.suggestions.confirmed"));
      // Bronze que qualificou o perfil saiu Prata no servidor: o selo lê auth.me.
      if (resultado?.promovidaAPrata) {
        toast.success(t("governanca.perfil.promovida"));
        void utils.auth.me.invalidate();
      }
      aoDecidir();
    },
    onError: erro => toast.error(erro.data?.code === "BAD_REQUEST" ? erro.message : t("networkInteligente.suggestions.error")),
  });
  const ignorar = trpc.networkInteligente.ignorarPendencia.useMutation({
    onSuccess: () => { toast.success(t("networkInteligente.suggestions.ignored")); aoDecidir(); },
    onError: () => toast.error(t("networkInteligente.suggestions.error")),
  });
  const ocupado = confirmar.isPending || ignorar.isPending;
  const demandaDoPerfil = alvo === "perfil" && item.campo === "preciso";
  const texto = valor.trim();
  const curta = demandaDoPerfil && texto.length < MINIMO_DA_DESCRICAO;
  const faltaServico = demandaDoPerfil && categoria === CATEGORIA_DE_SERVICO && !servico;
  const rotulo = item.campo === "tenho" ? t("networkPanel.fields.tenho") : t("networkPanel.fields.preciso");
  const tituloDaCategoria = (chave: string) => t(`oQuePreciso.categorias.${chave}.titulo`, { defaultValue: categoriaDoQuePreciso(chave)?.titulo ?? chave });
  const rotuloDoServico = (chave: string) => t(`oQuePreciso.opcoes.${CATEGORIA_DE_SERVICO}.${chave}`, { defaultValue: chave });

  return (
    <li className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      {cabecalho}
      <div className="flex flex-wrap items-start gap-2">
        <span className="pt-0.5 text-[11px] font-bold uppercase tracking-wider text-[#efcba8]">{rotulo}</span>
        {corrigindo ? (
          <label className="min-w-0 flex-1 basis-56">
            <span className="sr-only">{t("reuniaoNoMatch.valorDoItem")}</span>
            <input value={valor} onChange={evento => setValor(evento.target.value)} disabled={ocupado} maxLength={200} autoFocus
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white outline-none focus:border-[#c98f70]" />
          </label>
        ) : (
          <span dir="auto" className="min-w-0 flex-1 basis-56 text-sm text-white/90">{valor}</span>
        )}
      </div>
      {demandaDoPerfil && (
        <div className="mt-2 flex flex-wrap gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs text-white/55">
            {t("reuniaoNoMatch.categoria")}
            <select value={categoria} disabled={ocupado} onChange={evento => setCategoria(evento.target.value as ChaveOQuePreciso)}
              className="max-w-full rounded-lg border border-white/15 bg-[#211e1b] px-2 py-1.5 text-sm text-white">
              {CATEGORIAS_DO_PRECISO_DA_REUNIAO.map(chave => <option key={chave} value={chave} className="bg-white text-[#322C26]">{tituloDaCategoria(chave)}</option>)}
            </select>
          </label>
          {categoria === CATEGORIA_DE_SERVICO && (
            <label className="flex min-w-0 flex-col gap-1 text-xs text-white/55">
              {t("reuniaoNoMatch.servico")}
              <select value={servico} disabled={ocupado} onChange={evento => setServico(evento.target.value)}
                className="max-w-full rounded-lg border border-white/15 bg-[#211e1b] px-2 py-1.5 text-sm text-white">
                <option value="" className="bg-white text-[#322C26]">—</option>
                {OPCOES_DE_SERVICO.map(chave => <option key={chave} value={chave} className="bg-white text-[#322C26]">{rotuloDoServico(chave)}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {curta && <p className="mt-1.5 text-xs text-amber-300">{t("oQuePreciso.descricaoCurta", { minimo: MINIMO_DA_DESCRICAO })}</p>}
      {faltaServico && <p className="mt-1.5 text-xs text-amber-300">{t("oQuePreciso.servicoObrigatorio")}</p>}
      {item.trecho && <p dir="auto" className="mt-1.5 text-xs italic leading-relaxed text-white/45">{t("networkInteligente.suggestions.evidence", { trecho: item.trecho })}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={ocupado || !texto || curta || faltaServico}
          onClick={() => confirmar.mutate({
            id: item.id,
            ...(texto !== item.valor ? { valor: texto } : {}),
            ...(demandaDoPerfil ? { categoria, ...(categoria === CATEGORIA_DE_SERVICO ? { servico } : {}) } : {}),
          })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#151312] hover:bg-[#efcba8] disabled:opacity-50">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> {t("networkInteligente.suggestions.confirm")}
        </button>
        <button type="button" disabled={ocupado} aria-pressed={corrigindo} onClick={() => setCorrigindo(atual => !atual)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50">
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> {t("reuniaoNoMatch.corrigir")}
        </button>
        <button type="button" disabled={ocupado} onClick={() => ignorar.mutate({ id: item.id })}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/65 hover:bg-white/5 disabled:opacity-50">
          <X className="h-3.5 w-3.5" aria-hidden="true" /> {t("networkInteligente.suggestions.ignore")}
        </button>
      </div>
    </li>
  );
}
