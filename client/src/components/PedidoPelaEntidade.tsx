import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ehErroDaEntidade } from "@shared/entidades";
import { MENSAGEM_DO_PEDIDO_MAX, type CanalDoPedido, type EstadoDoPedido } from "@shared/pedidos-pela-entidade";

/**
 * O pedido de contato pela entidade (N2), no cartão de uma conexão cujo outro
 * lado é associado de uma entidade. Quem pede vê ANTES que o nome dela vai à
 * entidade e marca a ciência (o servidor exige). O nome da empresa e o canal
 * só aparecem no "aceito", quando ela toca em "Ver o contato" (cada leitura
 * fica na auditoria).
 *
 * Os textos vão a terceiros (a entidade lê o pedido): marcados para a Cris
 * revisar (docs/arquitetura/entidades.md, seção 10).
 */

export type PedidoNaTela = {
  id: string; estado: EstadoDoPedido; criadoEm: number; expiraEm: number; decididoEm: number | null; canal: CanalDoPedido | null;
};

export function PedidoPelaEntidade({ conexaoId, pedido, podePedir }: { conexaoId: string; pedido: PedidoNaTela | null; podePedir: boolean }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const [aberto, setAberto] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [ciente, setCiente] = useState(false);
  const traduz = (erro: unknown) => {
    const codigo = (erro as { message?: unknown })?.message;
    return ehErroDaEntidade(codigo) ? t(`entidade.erros.${codigo}`) : mensagemDeErroParaTela(erro, t);
  };
  const pedir = trpc.networkInteligente.pedirContatoPelaEntidade.useMutation({
    onSuccess: () => {
      setAberto(false); setMensagem(""); setCiente(false);
      toast.success(t("pedidoPelaEntidade.enviado"));
      void utils.networkInteligente.conexoes.invalidate();
      void utils.networkInteligente.contato.invalidate();
    },
    onError: erro => toast.error(traduz(erro)),
  });
  const revelar = trpc.networkInteligente.contatoPeloPedido.useMutation({ onError: erro => toast.error(traduz(erro)) });
  const data = (em: number) => new Date(em).toLocaleDateString(i18n.language, { dateStyle: "short" });

  return (
    <div className="mt-3 rounded-lg border border-[#c98f70]/25 bg-[#c98f70]/[0.06] p-3 text-xs">
      {pedido && (
        <p className="text-[#efcba8]">
          {t(`pedidoPelaEntidade.estado.${pedido.estado}`)}
          {(pedido.estado === "na_entidade" || pedido.estado === "encaminhado") && (
            <span className="text-white/50">{" · "}{t("pedidoPelaEntidade.prazo", { data: data(pedido.expiraEm) })}</span>
          )}
        </p>
      )}
      {pedido?.estado === "aceito" && (
        revelar.data ? (
          <div className="mt-2 space-y-0.5 text-sm text-white/85" data-testid="contato-pelo-pedido">
            <p className="font-semibold break-words">{revelar.data.empresa}</p>
            {revelar.data.telefone && <p className="break-all">{t("pedidoPelaEntidade.telefone", { valor: revelar.data.telefone })}</p>}
            {revelar.data.email && <p className="break-all">{t("pedidoPelaEntidade.email", { valor: revelar.data.email })}</p>}
          </div>
        ) : (
          <button type="button" disabled={revelar.isPending} onClick={() => revelar.mutate({ pedidoId: pedido.id })}
            className="mt-2 rounded-lg bg-[#c98f70] px-3 py-1.5 text-xs font-bold text-[#151312] hover:bg-[#efcba8] disabled:opacity-50">
            {t("pedidoPelaEntidade.verContato")}
          </button>
        )
      )}
      {podePedir && (
        <button type="button" onClick={() => setAberto(true)}
          className="mt-2 rounded-lg border border-[#c98f70]/50 px-3 py-1.5 text-xs font-bold text-[#efcba8] hover:bg-[#c98f70]/15">
          {t(pedido ? "pedidoPelaEntidade.pedirDeNovo" : "pedidoPelaEntidade.pedir")}
        </button>
      )}

      <Dialog open={aberto} onOpenChange={valor => { if (!valor && !pedir.isPending) setAberto(false); }}>
        <DialogContent className="bg-[#211e1b] border-white/15 text-white">
          <DialogHeader>
            <DialogTitle className="text-white">{t("pedidoPelaEntidade.titulo")}</DialogTitle>
            <DialogDescription className="text-sm text-white/65">{t("pedidoPelaEntidade.aviso")}</DialogDescription>
          </DialogHeader>
          <label className="block text-sm text-white/75">
            {t("pedidoPelaEntidade.mensagemRotulo")}
            <textarea value={mensagem} maxLength={MENSAGEM_DO_PEDIDO_MAX} rows={3} onChange={e => setMensagem(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-white" />
            <span className="mt-1 block text-xs text-white/45">{t("pedidoPelaEntidade.mensagemDica")}</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-white/80">
            <input type="checkbox" checked={ciente} onChange={e => setCiente(e.target.checked)} className="mt-1" />
            <span>{t("pedidoPelaEntidade.ciente")}</span>
          </label>
          <DialogFooter>
            <button type="button" disabled={pedir.isPending} onClick={() => setAberto(false)}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm text-white/60 hover:bg-white/8 disabled:opacity-50">
              {t("pedidoPelaEntidade.cancelar")}
            </button>
            <button type="button" disabled={!ciente || pedir.isPending}
              onClick={() => pedir.mutate({ conexaoId, mensagem: mensagem.trim() || undefined, cienteDoNome: true })}
              className="rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#151312] hover:bg-[#efcba8] disabled:opacity-50">
              {t("pedidoPelaEntidade.enviar")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
