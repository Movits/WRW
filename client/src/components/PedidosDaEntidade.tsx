import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { ehErroDaEntidade } from "@shared/entidades";
import { CANAIS_DO_PEDIDO, type AcaoDaEntidade, type CanalDoPedido } from "@shared/pedidos-pela-entidade";

/**
 * Os pedidos de contato que chegam à entidade (N2). Cada um traz quem pede
 * (o nome e a empresa dela, que ela sabia que viriam), a mensagem, o associado
 * e o que se encontrou. A entidade fala com a empresa fora do app e registra:
 * "levei à empresa", e depois "aceitou" (com o canal que a empresa escolheu,
 * entre os que a entidade mandou na planilha) ou "recusou"; ou "não
 * encaminhar". O servidor confere a ordem e o prazo.
 *
 * Textos marcados para a Cris revisar (docs/arquitetura/entidades.md, seção 10).
 */
export function PedidosDaEntidade({ habilitado }: { habilitado: boolean }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const [soAbertos, setSoAbertos] = useState(true);
  const [pagina, setPagina] = useState(0);
  const [aceitando, setAceitando] = useState<string | null>(null);
  const [canal, setCanal] = useState<CanalDoPedido>("telefone");
  const lista = trpc.entidades.pedidos.useQuery({ abertos: soAbertos, pagina }, { placeholderData: anterior => anterior });
  const traduz = (erro: unknown) => {
    const codigo = (erro as { message?: unknown })?.message;
    return ehErroDaEntidade(codigo) ? t(`entidade.erros.${codigo}`) : mensagemDeErroParaTela(erro, t);
  };
  const decidir = trpc.entidades.decidirPedido.useMutation({
    onSuccess: () => { setAceitando(null); toast.success(t("entidade.pedidos.salvo")); void utils.entidades.pedidos.invalidate(); },
    onError: erro => { toast.error(traduz(erro)); void utils.entidades.pedidos.invalidate(); },
  });
  const agir = (pedidoId: string, acao: AcaoDaEntidade, comCanal?: CanalDoPedido) => decidir.mutate({ pedidoId, acao, canal: comCanal });
  const data = (em: number) => new Date(em).toLocaleDateString(i18n.language, { dateStyle: "short" });
  const total = lista.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / (lista.data?.porPagina ?? 30)));
  const botao = "rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50";

  return (
    <section aria-labelledby="titulo-pedidos" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="titulo-pedidos" className="text-lg font-semibold">{t("entidade.pedidos.titulo")}</h2>
        <span className="text-sm text-white/50">{t("entidade.pedidos.abertos", { n: lista.data?.abertos ?? 0 })}</span>
      </div>
      <p className="text-sm text-white/60">{t("entidade.pedidos.explicacao")}</p>
      <div role="group" className="flex flex-wrap gap-2 text-xs">
        {[true, false].map(valor => (
          <button key={String(valor)} type="button" aria-pressed={soAbertos === valor} onClick={() => { setSoAbertos(valor); setPagina(0); }}
            className={`rounded-full border px-3 py-1 ${soAbertos === valor ? "border-[#c98f70] bg-[#c98f70]/15 text-[#efcba8]" : "border-white/15 text-white/60"}`}>
            {t(valor ? "entidade.pedidos.soAbertos" : "entidade.pedidos.todos")}
          </button>
        ))}
      </div>

      {lista.error ? <ErroDeConsulta erro={lista.error} aoTentarDeNovo={() => void lista.refetch()} /> : null}
      {lista.data && lista.data.pedidos.length === 0 && <p className="text-sm text-white/50">{t("entidade.pedidos.vazio")}</p>}

      <ul className="space-y-3">
        {lista.data?.pedidos.map(pedido => {
          const aberto = pedido.estado === "na_entidade" || pedido.estado === "encaminhado";
          return (
            <li key={pedido.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold break-words">
                  {pedido.solicitante.ehEntidade
                    ? t("entidade.pedidos.deEntidade", { nome: pedido.solicitante.nome ?? "—" })
                    : pedido.solicitante.empresa
                      ? t("entidade.pedidos.deComEmpresa", { nome: pedido.solicitante.nome ?? "—", empresa: pedido.solicitante.empresa })
                      : t("entidade.pedidos.de", { nome: pedido.solicitante.nome ?? "—" })}
                </span>
                <span className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs text-white/70">{t(`entidade.pedidos.estados.${pedido.estado}`)}</span>
              </div>
              <p className="text-white/70 break-words">
                {t("entidade.pedidos.associado", { codigo: pedido.associado.codigo ?? "—", nome: pedido.associado.nome ?? "—" })}
              </p>
              {pedido.itens.map((item, i) => (
                <p key={i} className="text-white/60 break-words">{t("networkInteligente.connections.itemLine", { tem: item.tem, precisa: item.precisa })}</p>
              ))}
              {pedido.mensagem && <p className="text-white/75 break-words">{t("entidade.pedidos.mensagem", { texto: pedido.mensagem })}</p>}
              <p className="text-xs text-white/45">
                {t("entidade.pedidos.recebido", { data: data(pedido.criadoEm) })}
                {aberto && <>{" · "}{t("entidade.pedidos.prazo", { data: data(pedido.expiraEm) })}</>}
                {pedido.canal && <>{" · "}{t(`entidade.pedidos.canais.${pedido.canal}`)}</>}
              </p>
              {habilitado && pedido.estado === "na_entidade" && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" disabled={decidir.isPending} onClick={() => agir(pedido.id, "encaminhar")}
                    className={`${botao} bg-[#c98f70] text-[#151312] hover:bg-[#efcba8]`}>{t("entidade.pedidos.encaminhar")}</button>
                  <button type="button" disabled={decidir.isPending} onClick={() => agir(pedido.id, "nao_encaminhar")}
                    className={`${botao} border border-white/15 text-white/60 hover:bg-white/5`}>{t("entidade.pedidos.naoEncaminhar")}</button>
                </div>
              )}
              {habilitado && pedido.estado === "encaminhado" && (
                aceitando === pedido.id ? (
                  <fieldset className="space-y-2 pt-1">
                    <legend className="text-xs text-white/70">{t("entidade.pedidos.canal")}</legend>
                    <div className="flex flex-wrap gap-3 text-xs">
                      {CANAIS_DO_PEDIDO.map(opcao => (
                        <label key={opcao} className="flex items-center gap-1.5">
                          <input type="radio" name={`canal-${pedido.id}`} checked={canal === opcao} onChange={() => setCanal(opcao)} />
                          {t(`entidade.pedidos.canais.${opcao}`)}
                        </label>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={decidir.isPending} onClick={() => agir(pedido.id, "aceitar", canal)}
                        className={`${botao} bg-[#c98f70] text-[#151312] hover:bg-[#efcba8]`}>{t("entidade.pedidos.confirmarAceite")}</button>
                      <button type="button" disabled={decidir.isPending} onClick={() => setAceitando(null)}
                        className={`${botao} border border-white/15 text-white/60 hover:bg-white/5`}>{t("entidade.pedidos.voltar")}</button>
                    </div>
                  </fieldset>
                ) : (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button type="button" disabled={decidir.isPending} onClick={() => { setCanal("telefone"); setAceitando(pedido.id); }}
                      className={`${botao} bg-[#c98f70] text-[#151312] hover:bg-[#efcba8]`}>{t("entidade.pedidos.aceitar")}</button>
                    <button type="button" disabled={decidir.isPending} onClick={() => agir(pedido.id, "recusar")}
                      className={`${botao} border border-white/15 text-white/60 hover:bg-white/5`}>{t("entidade.pedidos.recusar")}</button>
                  </div>
                )
              )}
            </li>
          );
        })}
      </ul>

      {paginas > 1 && (
        <nav aria-label={t("entidade.membros.paginas")} className="flex items-center justify-between gap-2 text-sm">
          <button type="button" disabled={pagina === 0} onClick={() => setPagina(p => p - 1)} className="rounded-lg border border-white/15 px-3 py-1.5 disabled:opacity-40">
            {t("entidade.membros.anterior")}
          </button>
          <span className="text-white/50">{t("entidade.membros.pagina", { atual: pagina + 1, total: paginas })}</span>
          <button type="button" disabled={pagina + 1 >= paginas} onClick={() => setPagina(p => p + 1)} className="rounded-lg border border-white/15 px-3 py-1.5 disabled:opacity-40">
            {t("entidade.membros.proxima")}
          </button>
        </nav>
      )}
    </section>
  );
}
