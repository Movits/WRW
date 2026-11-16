import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ArrowRight, BadgeCheck, Briefcase, CircleAlert, Clock3, Globe2, Handshake, Loader2, Mic, Percent, Search, Share2, Sparkles, Target,
  Users, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { AppHeader } from "@/components/AppHeader";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { rotuloDoCampo } from "@/components/CompletudeDoContato";
import { ConexaoRegistrada } from "@/components/ConexoesRegistradas";
import { ROTA_DAS_REUNIOES, ROTA_GRAVAR } from "@shared/rotas";

/**
 * Meu Network Inteligente — o painel da rede particular (pedido do Nicolas,
 * 13/09/2026, e spec da Glenda de 14/09, item 19). Cada número vem de uma
 * consulta real:
 *
 * - networkInteligente.resumo: reuniões, contatos, informações faltando,
 *   contatos disponibilizados e conexões internas (com o termo do Smart Match);
 * - networkInteligente.minutos: minutos usados no mês, limite por reunião,
 *   limite mensal (se um plano o definir) e se a ampliação existe — hoje não,
 *   porque depende de integração de pagamento, e a tela diz isso sem botão,
 *   link nem preço;
 * - networkInteligente.conexoes: o registro das conexões (internas e com a
 *   rede global), intermediações, negócios e comissionamentos — só com o
 *   termo; sem ele, traço e convite, nunca número.
 *
 * A busca inteligente é a Memória Inteligente (memory.search), que só olha a
 * rede da dona.
 */

// 20 s de reunião não são "0 min".
function emMinutos(segundos: number) {
  return segundos > 0 ? Math.max(1, Math.round(segundos / 60)) : 0;
}

const CARTAO = "rounded-2xl border border-white/[0.08] bg-[#211e1b]/90";

function Indicador({ rotulo, valor, detalhe, href, icone: Icone }: {
  rotulo: string; valor: ReactNode; detalhe: string; href?: string; icone: LucideIcon;
}) {
  const corpo = (
    <div className={`${CARTAO} h-full p-5 transition-colors duration-200 ${href ? "hover:border-[#c98f70]/35" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">{rotulo}</p>
        <Icone className="h-4 w-4 shrink-0 text-[#c98f70]" aria-hidden="true" />
      </div>
      <p className="mt-3 text-3xl font-black tabular-nums text-white">{valor}</p>
      <p className="mt-1 text-xs text-white/45">{detalhe}</p>
    </div>
  );
  return href ? <Link href={href} className="block h-full">{corpo}</Link> : corpo;
}

function Atalho({ href, icone: Icone, titulo, descricao, children }: {
  href: string; icone: LucideIcon; titulo: string; descricao: string; children?: ReactNode;
}) {
  return (
    <Link href={href} className={`${CARTAO} group flex h-full flex-col p-5 transition-colors duration-200 hover:border-[#c98f70]/35`}>
      <span className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#c98f70]/25 bg-[#c98f70]/10">
          <Icone className="h-5 w-5 text-[#c98f70]" aria-hidden="true" />
        </span>
        <span className="font-bold text-white">{titulo}</span>
      </span>
      <span className="mt-3 block text-sm leading-relaxed text-white/55">{descricao}</span>
      {children}
    </Link>
  );
}

function BuscaNoNetwork() {
  const { t } = useTranslation();
  const [pergunta, setPergunta] = useState("");
  const busca = trpc.memory.search.useMutation({
    onError: erro => toast.error(erro.data?.code === "TOO_MANY_REQUESTS" ? erro.message : t("networkInteligente.search.error")),
  });
  const contatos = (busca.data?.hits ?? []).filter(hit => hit.sourceType === "contact");
  // O servidor devolve o que ficou por indexar junto com a resposta: sem os
  // avisos, "nenhum contato" sobre um índice pela metade soava definitivo
  // (a Memória mostra os mesmos dois avisos).
  const naFila = busca.data?.pending ?? 0;
  const foraDaBusca = busca.data?.truncated ?? 0;
  return (
    <section aria-labelledby="nwi-busca" className={`${CARTAO} mt-8 p-5 md:p-6`}>
      <h2 id="nwi-busca" className="flex items-center gap-2 text-lg font-bold"><Search className="h-4 w-4 text-[#c98f70]" aria-hidden="true" />{t("networkInteligente.search.title")}</h2>
      <p className="mt-1 text-sm text-white/50">{t("networkInteligente.search.onlyYourNetwork")}</p>
      <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={evento => { evento.preventDefault(); if (pergunta.trim().length >= 2) busca.mutate({ query: pergunta.trim() }); }}>
        <label className="flex-1">
          <span className="sr-only">{t("networkInteligente.search.title")}</span>
          <input value={pergunta} onChange={evento => setPergunta(evento.target.value)} maxLength={1000}
            placeholder={t("networkInteligente.search.placeholder")}
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#c98f70]" />
        </label>
        <button type="submit" disabled={busca.isPending || pergunta.trim().length < 2}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-5 py-3 text-sm font-bold text-[#151312] hover:bg-[#efcba8] disabled:opacity-50">
          {busca.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
          {busca.isPending ? t("networkInteligente.search.searching") : t("networkInteligente.search.button")}
        </button>
      </form>
      {busca.data && (
        <div className="mt-4 space-y-3">
          {naFila > 0 && (
            <p role="note" className="rounded-xl border border-sky-300/30 bg-sky-300/10 px-4 py-3 text-sm text-sky-100/85">
              {t("networkInteligente.search.pending", { quantidade: naFila })}
            </p>
          )}
          {foraDaBusca > 0 && (
            <p role="note" className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100/85">
              {t("networkInteligente.search.truncated", { quantidade: foraDaBusca })}
            </p>
          )}
          <p className="whitespace-pre-wrap rounded-xl border border-[#c98f70]/20 bg-[#c98f70]/[0.05] p-4 text-sm leading-relaxed text-white/85">{busca.data.answer}</p>
          {contatos.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {contatos.map(hit => (
                <li key={hit.id}>
                  <Link href={`/meu-network-inteligente/contatos/${hit.sourceId}`}
                    className="inline-flex items-center gap-1 rounded-full border border-white/15 px-3 py-1 text-sm text-white/75 hover:border-[#c98f70]/40 hover:text-white">
                    {hit.title} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-white/45">{t("networkInteligente.search.noContacts")}</p>
          )}
        </div>
      )}
    </section>
  );
}

export default function MeuNetworkInteligente() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const resumo = trpc.networkInteligente.resumo.useQuery();
  const minutos = trpc.networkInteligente.minutos.useQuery();
  const conexoes = trpc.networkInteligente.conexoes.useQuery();
  const procurar = trpc.networkInteligente.procurarNaRedeGlobal.useMutation({
    onSuccess: r => {
      if (!r.contatosDisponiveis) toast.info(t("networkInteligente.global.noneAvailable"));
      else if (r.conexoes.length) toast.success(t("networkInteligente.global.found", { quantidade: r.conexoes.length }));
      else toast.info(t("networkInteligente.global.noneFound"));
      void utils.networkInteligente.conexoes.invalidate();
    },
    onError: () => toast.error(t("networkInteligente.global.error")),
  });
  const dados = resumo.data;
  const limite = emMinutos(minutos.data?.limitePorReuniaoSegundos ?? dados?.minutos.limitePorReuniaoSegundos ?? 0);
  const registro = conexoes.data;
  const contagem = registro?.termoAceito ? registro.contagem : null;
  // Com o termo e o registro lido, o número; sem o termo, o traço; em erro ou carregando, o traço também — nunca um zero inventado.
  const numeroDoRegistro = (valor: number | undefined) => (contagem && valor !== undefined ? valor : "—");
  const detalheDoRegistro = (detalhe: string) => (registro && !registro.termoAceito ? t("networkPanel.internalMatchesNoConsent") : detalhe);
  const oportunidadeInterna = registro?.termoAceito && registro.lista.some(c => c.origem === "PRIVATE_NETWORK_MATCH" && c.status === "identificada");

  return (
    <>
      <AppHeader title={t("networkPanel.title")} backTo="/dashboard" />
      <main className="min-h-screen bg-transparent px-4 py-8 text-white md:px-8">
        <div className="mx-auto max-w-5xl">
          <header className="mb-8">
            <p className="text-xs font-bold tracking-[.18em] text-[#c98f70]">{t("networkPanel.eyebrow")}</p>
            <h1 className="mt-2 text-3xl font-bold text-balance md:text-4xl">{t("networkPanel.title")}</h1>
            <p className="mt-3 max-w-2xl leading-relaxed text-white/60">{t("networkPanel.subtitle")}</p>
          </header>

          {resumo.isError ? (
            <ErroDeConsulta erro={resumo.error} aoTentarDeNovo={() => void resumo.refetch()} />
          ) : !dados ? (
            <div role="status" className="flex items-center justify-center gap-3 py-20 text-sm text-white/50">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#c98f70]/30 border-t-[#c98f70]" aria-hidden="true" />
              {t("networkPanel.loading")}
            </div>
          ) : (
            <>
              <section aria-label={t("networkPanel.title")} className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
                <Indicador rotulo={t("networkPanel.meetings")} valor={dados.reunioes.total} icone={Mic} href={ROTA_DAS_REUNIOES}
                  detalhe={t("networkPanel.meetingsDetail", { transcritas: dados.reunioes.transcritas })} />
                <Indicador rotulo={t("networkPanel.contacts")} valor={dados.contatos.total} icone={Users} href="/network"
                  detalhe={t("networkPanel.contactsDetail")} />
                <Indicador rotulo={t("networkPanel.incomplete")} valor={dados.contatos.incompletos} icone={CircleAlert}
                  detalhe={t("networkPanel.incompleteDetail")} />
                {dados.matchesInternos.termoAceito ? (
                  <Indicador rotulo={t("networkPanel.internalMatches")} valor={dados.matchesInternos.total} icone={Sparkles} href="/intelligent-matches"
                    detalhe={t("networkPanel.internalMatchesDetail", { novos: dados.matchesInternos.novos })} />
                ) : (
                  // Sem o termo não há número: o traço diz que ele não é mostrado,
                  // e o cartão leva à tela onde o termo é aceito.
                  <Indicador rotulo={t("networkPanel.internalMatches")} valor="—" icone={Sparkles} href="/intelligent-matches"
                    detalhe={t("networkPanel.internalMatchesNoConsent")} />
                )}
              </section>

              <section aria-label={t("networkInteligente.panel.registryLabel")} className="mt-3 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
                <Indicador rotulo={t("networkInteligente.panel.availableContacts")} valor={dados.contatos.disponibilizados} icone={Share2}
                  detalhe={t("networkInteligente.panel.availableContactsDetail")} />
                <Indicador rotulo={t("networkInteligente.panel.globalConnections")} valor={numeroDoRegistro(contagem?.comRedeGlobal)} icone={Globe2}
                  detalhe={detalheDoRegistro(t("networkInteligente.panel.globalConnectionsDetail"))} />
                <Indicador rotulo={t("networkInteligente.panel.opportunities")} valor={numeroDoRegistro(contagem?.oportunidades)} icone={Target}
                  detalhe={detalheDoRegistro(t("networkInteligente.panel.opportunitiesDetail"))} />
                <Indicador rotulo={t("networkInteligente.panel.intermediations")} valor={numeroDoRegistro(contagem?.intermediacoes)} icone={Handshake}
                  detalhe={detalheDoRegistro(t("networkInteligente.panel.intermediationsDetail"))} />
                <Indicador rotulo={t("networkInteligente.panel.dealsInProgress")} valor={numeroDoRegistro(contagem?.negociosEmAndamento)} icone={Briefcase}
                  detalhe={detalheDoRegistro(t("networkInteligente.panel.dealsInProgressDetail"))} />
                <Indicador rotulo={t("networkInteligente.panel.dealsClosed")} valor={numeroDoRegistro(contagem?.negociosConcluidos)} icone={BadgeCheck}
                  detalhe={detalheDoRegistro(t("networkInteligente.panel.dealsClosedDetail"))} />
                <Indicador rotulo={t("networkInteligente.panel.commissions")} valor={numeroDoRegistro(contagem?.comissionamentos)} icone={Percent}
                  detalhe={detalheDoRegistro(t("networkInteligente.panel.commissionsDetail"))} />
                <Indicador rotulo={t("networkInteligente.panel.internalRegistered")} valor={numeroDoRegistro(contagem?.internas)} icone={Sparkles}
                  detalhe={detalheDoRegistro(t("networkInteligente.panel.internalRegisteredDetail"))} />
              </section>

              <section aria-labelledby="nwi-minutos" className={`${CARTAO} mt-4 p-5 md:p-6`}>
                <h2 id="nwi-minutos" className="flex items-center gap-2 text-lg font-bold">
                  <Clock3 className="h-4 w-4 text-[#c98f70]" aria-hidden="true" />
                  {t("networkPanel.minutesTitle")}
                </h2>
                <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-white/50">{t("networkInteligente.minutes.usedThisMonth")}</p>
                    <p className="mt-1 text-2xl font-black tabular-nums">{minutos.data ? t("networkPanel.minutesValue", { minutos: emMinutos(minutos.data.usadosNoMesSegundos) }) : "—"}</p>
                    <p className="mt-1 text-xs leading-relaxed text-white/45">{t("networkInteligente.minutes.usedThisMonthHelp")}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-white/50">{t("networkPanel.minutesUsed")}</p>
                    <p className="mt-1 text-2xl font-black tabular-nums">{t("networkPanel.minutesValue", { minutos: emMinutos(dados.minutos.segundosEmReunioesGuardadas) })}</p>
                    <p className="mt-1 text-xs leading-relaxed text-white/45">{t("networkPanel.minutesUsedHelp")}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-white/50">{t("networkPanel.minutesLimit")}</p>
                    <p className="mt-1 text-2xl font-black tabular-nums">{t("networkPanel.minutesValue", { minutos: limite })}</p>
                    <p className="mt-1 text-xs leading-relaxed text-white/45">{t("networkPanel.minutesLimitHelp")}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-white/50">{t("networkInteligente.minutes.monthlyLimit")}</p>
                    <p className="mt-1 text-2xl font-black tabular-nums">
                      {minutos.data?.limiteMensalSegundos ? t("networkPanel.minutesValue", { minutos: emMinutos(minutos.data.limiteMensalSegundos) }) : t("networkInteligente.minutes.noMonthlyLimit")}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-white/45">{t("networkInteligente.minutes.noMonthlyLimitHelp")}</p>
                  </div>
                </div>
                <div className="mt-5 rounded-xl border border-[#c98f70]/25 bg-[#c98f70]/[0.06] p-4">
                  <p className="font-semibold text-[#efcba8]">{t("networkPanel.moreTime")}</p>
                  <p className="mt-1 text-sm leading-relaxed text-white/55">{t("networkPanel.moreTimeUnavailable", { minutos: limite })}</p>
                  {(!minutos.data || !minutos.data.ampliacao.disponivel) && (
                    <p className="mt-1 text-xs leading-relaxed text-white/45">{t("networkInteligente.minutes.dependsOnPayment")}</p>
                  )}
                </div>
              </section>

              <section aria-labelledby="nwi-atalhos" className="mt-8">
                <h2 id="nwi-atalhos" className="mb-3 text-lg font-bold">{t("networkPanel.actionsTitle")}</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Atalho href={ROTA_GRAVAR} icone={Mic} titulo={t("networkPanel.actionRecord")}
                    descricao={t("networkPanel.actionRecordDesc", { minutos: limite })}>
                    <span className="mt-3 block rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-white/50">
                      {t("networkPanel.consentNotice")}
                    </span>
                  </Atalho>
                  <Atalho href="/network" icone={Users} titulo={t("networkPanel.actionContacts")} descricao={t("networkPanel.actionContactsDesc")} />
                  <Atalho href="/memory" icone={Search} titulo={t("networkPanel.actionSearch")} descricao={t("networkPanel.actionSearchDesc")} />
                  <Atalho href="/intelligent-matches" icone={Sparkles} titulo={t("networkPanel.actionMatches")} descricao={t("networkPanel.actionMatchesDesc")} />
                </div>
              </section>

              <BuscaNoNetwork />

              <section aria-labelledby="nwi-conexoes" className={`${CARTAO} mt-8 p-5 md:p-6`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 id="nwi-conexoes" className="text-lg font-bold">{t("networkInteligente.connections.title")}</h2>
                    <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/50">{t("networkInteligente.connections.subtitle")}</p>
                  </div>
                  {registro?.termoAceito && (
                    <button type="button" disabled={procurar.isPending} onClick={() => procurar.mutate(undefined)}
                      className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[#c98f70]/35 px-4 py-2 text-sm font-semibold text-[#c98f70] hover:bg-[#c98f70]/10 disabled:opacity-50">
                      {procurar.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Globe2 className="h-4 w-4" aria-hidden="true" />}
                      {procurar.isPending ? t("networkInteligente.global.searching") : t("networkInteligente.global.search")}
                    </button>
                  )}
                </div>
                <p className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-white/50">{t("networkInteligente.global.description")}</p>
                {conexoes.isError ? (
                  <div className="mt-3"><ErroDeConsulta erro={conexoes.error} aoTentarDeNovo={() => void conexoes.refetch()} /></div>
                ) : !registro ? (
                  <p role="status" className="mt-3 text-sm text-white/45">{t("networkPanel.loading")}</p>
                ) : !registro.termoAceito ? (
                  <p className="mt-3 text-sm text-white/50">
                    {t("networkInteligente.connections.noConsent")}{" "}
                    <Link href="/intelligent-matches" className="font-semibold text-[#c98f70] underline-offset-2 hover:underline">{t("networkPanel.actionMatches")}</Link>
                  </p>
                ) : (
                  <>
                    {oportunidadeInterna && (
                      <p role="note" className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-3 text-sm text-emerald-100">
                        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                        {t("networkInteligente.connections.internalAlert")}
                      </p>
                    )}
                    {registro.lista.length === 0 ? (
                      <p className="mt-3 text-sm text-white/45">{t("networkInteligente.connections.empty")}</p>
                    ) : (
                      <ul className="mt-3 space-y-2">
                        {registro.lista.map(conexao => <ConexaoRegistrada key={conexao.id} conexao={conexao} />)}
                      </ul>
                    )}
                    <p className="mt-3 text-xs leading-relaxed text-white/40">{t("networkInteligente.connections.commissionNotice")}</p>
                  </>
                )}
              </section>

              <section aria-labelledby="nwi-incompletos" className="mt-8">
                <h2 id="nwi-incompletos" className="text-lg font-bold">{t("networkPanel.incompleteTitle")}</h2>
                {dados.contatos.total === 0 ? (
                  <p className="mt-3 text-sm text-white/50">{t("networkPanel.noContacts")}</p>
                ) : dados.contatos.incompletos === 0 ? (
                  <p className="mt-3 text-sm text-white/50">{t("networkPanel.incompleteEmpty")}</p>
                ) : (
                  <>
                    <p role="note" className="mt-3 flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm leading-relaxed text-amber-100">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                      {t("networkPanel.alert")}
                    </p>
                    <ul className="mt-3 space-y-2">
                      {dados.contatos.amostraIncompletos.map(contato => (
                        <li key={contato.id} className={`${CARTAO} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`}>
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-white">{contato.fullName}</p>
                            <p className="mt-1 text-xs text-white/50">
                              {t("networkPanel.missing")} {contato.faltando.map(campo => rotuloDoCampo(t, campo)).join(", ")}
                            </p>
                          </div>
                          {/* O perfil do contato completa por texto OU por voz (item 10). */}
                          <Link href={`/meu-network-inteligente/contatos/${contato.id}`}
                            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[#c98f70]/35 px-4 py-2 text-sm font-semibold text-[#c98f70] transition-colors hover:bg-[#c98f70]/10">
                            {t("networkPanel.complete")}
                            <ArrowRight className="h-4 w-4" aria-hidden="true" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                    {dados.contatos.incompletos > dados.contatos.amostraIncompletos.length && (
                      <p className="mt-3 text-xs text-white/45">
                        {t("networkPanel.incompleteMore", { mostrados: dados.contatos.amostraIncompletos.length, total: dados.contatos.incompletos })}{" "}
                        <Link href="/network" className="font-semibold text-[#c98f70] underline-offset-2 hover:underline">{t("networkPanel.seeAllContacts")}</Link>
                      </p>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
