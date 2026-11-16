import { useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import { CircleAlert, Clock3, Globe2, History, ListChecks, Loader2, Mic, Pencil, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { AppHeader } from "@/components/AppHeader";
import { pedidoDaTela, useAvisosDaAgenda } from "@/components/AcaoNaAgenda";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import {
  CompletarInformacoes, DisponibilidadeDoContato, rotuloDoTipoDePessoa, SugestoesDaIA,
} from "@/components/NetworkInteligenteDoContato";
import { ConexaoRegistrada } from "@/components/ConexoesRegistradas";
import { FormularioDaAcao, mensagemDoErroDaAcao, ProximasAcoes, type ProximaAcao, type ValoresDaAcao } from "@/components/ProximasAcoes";
import { ROTA_DAS_PROXIMAS_ACOES } from "@shared/proximas-acoes";
import { rotaDaReuniao } from "@shared/rotas";
import { vozesNoTexto } from "@shared/vozes-no-texto";

/**
 * Meu Network Inteligente — o perfil de um contato (spec da Glenda de 14/09,
 * itens 20 e 22). Tudo vem de networkInteligente.contato, que só responde à
 * dona do contato:
 *
 * - QUEM SOU (só nome, telefone e e-mail, e o tipo de pessoa), com o que falta;
 * - O QUE TENHO e O QUE PRECISO;
 * - ID anônimo e o SIM/NÃO da rede global;
 * - sugestões da IA esperando confirmação, e completar por texto ou voz;
 * - as próximas ações ligadas ao contato (H5b do desenho do gravador), com a
 *   mesma lista da página /proximas-acoes e o "Nova ação" já ligado a ele;
 * - reuniões vinculadas, cada uma com o link para abrir a reunião (o resto da
 *   H1r), conexões registradas (com as etapas) e a memória de relacionamento —
 *   a linha do tempo privada.
 *
 * Editar os campos continua na Minha Rede: esta tela não duplica o formulário.
 */

type Traduzir = (chave: string, opcoes?: Record<string, unknown>) => string;
type EventoDaLinhaDoTempo = inferRouterOutputs<AppRouter>["networkInteligente"]["contato"]["linhaDoTempo"][number];

const CARTAO = "rounded-2xl border border-white/[0.08] bg-[#211e1b]/90 p-5";

function Campo({ rotulo, valor, falta }: { rotulo: string; valor: ReactNode; falta: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-xs font-semibold uppercase tracking-wide text-white/45">{rotulo}</dt>
      <dd className={falta ? "text-sm font-semibold text-amber-300" : "break-all text-sm text-white"}>
        {falta ? `— ${t("networkPanel.statusMissing")}` : valor}
      </dd>
    </div>
  );
}

function rotuloDoEvento(t: Traduzir, evento: EventoDaLinhaDoTempo) {
  switch (evento.tipo) {
    case "contato_criado": return t("networkInteligente.timeline.created");
    case "reuniao": return t("networkInteligente.timeline.meeting", { titulo: evento.titulo });
    case "contexto": return t("networkInteligente.timeline.context", { nome: evento.nome });
    case "tenho_adicionado": return t("networkInteligente.timeline.have", { valor: evento.valor });
    case "preciso_adicionado": return t("networkInteligente.timeline.need", { valor: evento.valor });
    case "quem_sou_confirmado": return t("networkInteligente.timeline.confirmed", { valor: evento.valor });
    case "disponibilidade": return evento.disponivel ? t("networkInteligente.timeline.availableYes") : t("networkInteligente.timeline.availableNo");
    case "conexao_registrada": return t("networkInteligente.timeline.connection");
    case "conexao_etapa": return t("networkInteligente.timeline.stage", { etapa: t(`networkInteligente.connections.status.${String(evento.etapa)}`) });
    case "proxima_acao":
    case "proxima_acao_feita": {
      // O nome que a dona deu à voz no lugar do rótulo; sem nome, "Falante n".
      const texto = vozesNoTexto(evento.texto, evento.vozes, numero => t("meetings.speakerLabel", { n: numero }));
      return evento.tipo === "proxima_acao_feita"
        ? t("networkInteligente.timeline.nextActionDone", { texto })
        : t("networkInteligente.timeline.nextAction", { texto });
    }
    default: return "";
  }
}

const NOVA_ACAO: ValoresDaAcao = { texto: "", detalhe: "", responsavel: "", prazo: "" };

/**
 * As próximas ações ligadas a este contato (H5b): a lista das próximas ações
 * (marcar feita, editar, apagar e tirar o vínculo) e o "Nova ação", que já nasce
 * ligada a ele. Mudar uma ação relê o perfil (a lista e a linha do tempo).
 */
function AcoesDoContato({ contactId, acoes, limite }: { contactId: number; acoes: readonly ProximaAcao[]; limite: number }) {
  const { t } = useTranslation();
  const [anotando, setAnotando] = useState(false);
  const utils = trpc.useUtils();
  // A ação anotada com prazo vai para a Google Agenda conectada (H5c); a falha da Google vem à parte.
  const avisos = useAvisosDaAgenda();
  const criar = trpc.proximasAcoes.criar.useMutation({
    onSuccess: resultado => avisos.depoisDeMandar(resultado),
    onError: erro => toast.error(mensagemDoErroDaAcao(t, erro)),
    onSettled: () => Promise.all([utils.networkInteligente.contato.invalidate({ contactId }), utils.proximasAcoes.invalidate()]),
  });
  const abertas = acoes.filter(acao => !acao.feita).length;
  return (
    <section aria-labelledby="nwi-proximas-acoes" className={`${CARTAO} mt-4`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="nwi-proximas-acoes" className="flex items-center gap-2 font-semibold"><ListChecks className="h-4 w-4 text-[#c98f70]" aria-hidden="true" />{t("proximasAcoes.title")}</h2>
        {!anotando && (
          <button type="button" onClick={() => setAnotando(true)}
            className="inline-flex items-center justify-center gap-2 self-start rounded-lg border border-[#c98f70]/35 px-3 py-2 text-sm font-semibold text-[#c98f70] hover:bg-[#c98f70]/10">
            <Plus className="h-4 w-4" aria-hidden="true" /> {t("proximasAcoes.add")}
          </button>
        )}
      </div>
      {anotando && (
        <div className="mt-3 rounded-xl border border-amber-300/25 bg-amber-300/[0.04] p-4">
          <FormularioDaAcao inicial={NOVA_ACAO} salvando={criar.isPending} aoCancelar={() => setAnotando(false)}
            aoSalvar={valores => criar.mutate({
              texto: valores.texto, detalhe: valores.detalhe, responsavel: valores.responsavel, prazo: valores.prazo, contactId,
              // O fuso do aparelho (o lembrete às 9h, H15) e os rótulos da tela (o evento na Google Agenda, H5c).
              ...pedidoDaTela(t),
            }, { onSuccess: () => setAnotando(false) })} />
        </div>
      )}
      {acoes.length === 0 ? (
        <p className="mt-3 text-sm text-white/45">{t("networkInteligente.contact.actionsEmpty")}</p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-white/45">{t("proximasAcoes.openCount", { n: abertas })}</p>
          <ProximasAcoes acoes={acoes} contatoDaPagina={contactId} />
          {acoes.length >= limite && <p className="text-xs text-white/45">{t("proximasAcoes.limitNotice", { n: limite })}</p>}
        </div>
      )}
      <Link href={ROTA_DAS_PROXIMAS_ACOES} className="mt-3 inline-block text-sm font-semibold text-[#c98f70] hover:text-[#efcba8]">
        {t("networkInteligente.contact.actionsAll")}
      </Link>
    </section>
  );
}

export default function PerfilDoContatoNetwork() {
  const { t, i18n } = useTranslation();
  const params = useParams<{ id: string }>();
  const contactId = Number(params.id);
  const valido = Number.isInteger(contactId) && contactId > 0;
  const perfil = trpc.networkInteligente.contato.useQuery({ contactId }, { enabled: valido, retry: (tentativas, erro) => erro.data?.code !== "NOT_FOUND" && tentativas < 2 });
  const utils = trpc.useUtils();
  const procurar = trpc.networkInteligente.procurarNaRedeGlobal.useMutation({
    onSuccess: r => {
      toast.success(r.conexoes.length ? t("networkInteligente.global.found", { quantidade: r.conexoes.length }) : t("networkInteligente.global.noneFound"));
      void utils.networkInteligente.contato.invalidate({ contactId });
      void utils.networkInteligente.conexoes.invalidate();
    },
    onError: () => toast.error(t("networkInteligente.global.error")),
  });
  const dados = perfil.data;
  const data = (em: number) => new Date(em).toLocaleDateString(i18n.language);

  return (
    <>
      <AppHeader title={t("networkPanel.title")} backTo="/meu-network-inteligente" />
      <main className="min-h-screen bg-transparent px-4 py-8 text-white md:px-8">
        <div className="mx-auto max-w-5xl">
          <Link href="/meu-network-inteligente" className="text-sm text-white/55 hover:text-white">← {t("networkPanel.title")}</Link>

          {!valido || perfil.error?.data?.code === "NOT_FOUND" ? (
            <p role="alert" className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-6 text-white/60">{t("networkPanel.contactNotFound")}</p>
          ) : perfil.isError ? (
            <div className="mt-6"><ErroDeConsulta erro={perfil.error} aoTentarDeNovo={() => void perfil.refetch()} /></div>
          ) : !dados ? (
            <div role="status" className="flex items-center justify-center gap-3 py-20 text-sm text-white/50">
              <Loader2 className="h-5 w-5 animate-spin text-[#c98f70]" aria-hidden="true" /> {t("networkPanel.loading")}
            </div>
          ) : (
            <>
              <header className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-bold tracking-[.18em] text-[#c98f70]">{t("networkPanel.eyebrow")}</p>
                  <h1 className="mt-2 break-words text-3xl font-bold">{dados.contato.quemSou.nome}</h1>
                </div>
                <Link href={`/network?contato=${dados.contato.id}`}
                  className="inline-flex shrink-0 items-center gap-2 self-start rounded-xl border border-[#c98f70]/35 px-4 py-2 text-sm font-semibold text-[#c98f70] hover:bg-[#c98f70]/10">
                  <Pencil className="h-4 w-4" aria-hidden="true" /> {t("networkInteligente.contact.editInNetwork")}
                </Link>
              </header>

              {dados.faltando.length > 0 && (
                <p role="note" className="mt-5 flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm leading-relaxed text-amber-100">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                  {t("networkPanel.alert")}
                </p>
              )}

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <section aria-labelledby="nwi-quem-sou" className={CARTAO}>
                  <h2 id="nwi-quem-sou" className="text-xs font-bold uppercase tracking-wider text-[#efcba8]">{t("networkPanel.whoAmI")}</h2>
                  <dl className="mt-2 divide-y divide-white/5">
                    <Campo rotulo={t("networkPanel.fields.nome")} valor={dados.contato.quemSou.nome} falta={dados.faltando.includes("nome")} />
                    <Campo rotulo={t("networkPanel.fields.telefone")} valor={dados.contato.quemSou.telefone} falta={dados.faltando.includes("telefone")} />
                    <Campo rotulo={t("networkPanel.fields.email")} valor={dados.contato.quemSou.email} falta={dados.faltando.includes("email")} />
                    <Campo rotulo={t("networkInteligente.contact.personType")} valor={rotuloDoTipoDePessoa(t, dados.contato.quemSou.tipoPessoa)} falta={false} />
                  </dl>
                </section>

                <DisponibilidadeDoContato contactId={dados.contato.id} codigoAnonimo={dados.contato.codigoAnonimo}
                  disponivel={dados.contato.disponivelRedeGlobal} alteradaEm={dados.contato.disponibilidadeAlteradaEm} />

                {([
                  ["nwi-tenho", t("networkPanel.fields.tenho"), dados.tenho, "tenho", "border-emerald-400/30 text-emerald-100"],
                  ["nwi-preciso", t("networkPanel.fields.preciso"), dados.preciso, "preciso", "border-sky-300/30 text-sky-100"],
                ] as const).map(([id, titulo, itens, campo, cor]) => (
                  <section key={id} aria-labelledby={id} className={CARTAO}>
                    <h2 id={id} className="text-xs font-bold uppercase tracking-wider text-[#efcba8]">{titulo}</h2>
                    {itens.length === 0 ? (
                      <p className="mt-3 text-sm font-semibold text-amber-300">— {dados.faltando.includes(campo) ? t("networkPanel.statusMissing") : t("networkInteligente.contact.emptyItems")}</p>
                    ) : (
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {itens.map(item => (
                          <li key={item.id} className={`rounded-full border px-3 py-1 text-sm ${cor}`}>
                            {item.label}{item.category ? <span className="text-white/40"> · {item.category}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ))}

                <SugestoesDaIA contactId={dados.contato.id} pendencias={dados.pendencias} />
                <CompletarInformacoes contactId={dados.contato.id} />
              </div>

              <AcoesDoContato contactId={dados.contato.id} acoes={dados.proximasAcoes.lista} limite={dados.proximasAcoes.limite} />

              <section aria-labelledby="nwi-reunioes" className={`${CARTAO} mt-4`}>
                <h2 id="nwi-reunioes" className="flex items-center gap-2 font-semibold"><Mic className="h-4 w-4 text-[#c98f70]" aria-hidden="true" />{t("networkInteligente.contact.meetingsTitle")}</h2>
                {dados.reunioes.length === 0 ? (
                  <p className="mt-3 text-sm text-white/45">{t("networkInteligente.contact.meetingsEmpty")}</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {dados.reunioes.map(reuniao => (
                      <li key={reuniao.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                        <p className="font-semibold">
                          <Link href={rotaDaReuniao(reuniao.id)} className="text-amber-200 underline-offset-4 hover:text-amber-100 hover:underline">{reuniao.titulo}</Link>
                        </p>
                        <p className="text-xs text-white/45">{data(reuniao.em)}</p>
                        {reuniao.assuntos.length > 0 && (
                          <p className="mt-1 text-xs text-white/55">{t("networkInteligente.contact.topics", { lista: reuniao.assuntos.join(", ") })}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="nwi-conexoes-contato" className={`${CARTAO} mt-4`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h2 id="nwi-conexoes-contato" className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4 text-[#c98f70]" aria-hidden="true" />{t("networkInteligente.contact.connectionsTitle")}</h2>
                  {dados.conexoes.termoAceito && dados.contato.disponivelRedeGlobal && (
                    <button type="button" disabled={procurar.isPending} onClick={() => procurar.mutate({ contactId: dados.contato.id })}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#c98f70]/35 px-3 py-2 text-sm font-semibold text-[#c98f70] hover:bg-[#c98f70]/10 disabled:opacity-50">
                      {procurar.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Globe2 className="h-4 w-4" aria-hidden="true" />}
                      {t("networkInteligente.contact.searchGlobal")}
                    </button>
                  )}
                </div>
                {!dados.conexoes.termoAceito ? (
                  <p className="mt-3 text-sm text-white/45">{t("networkInteligente.contact.connectionsNoConsent")}</p>
                ) : dados.conexoes.lista.length === 0 ? (
                  <p className="mt-3 text-sm text-white/45">{t("networkInteligente.connections.empty")}</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {dados.conexoes.lista.map(conexao => <ConexaoRegistrada key={conexao.id} conexao={conexao} />)}
                  </ul>
                )}
              </section>

              <section aria-labelledby="nwi-linha-do-tempo" className={`${CARTAO} mt-4`}>
                <h2 id="nwi-linha-do-tempo" className="flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-[#c98f70]" aria-hidden="true" />{t("networkInteligente.timeline.title")}</h2>
                <p className="mt-1 text-xs text-white/45">{t("networkInteligente.timeline.subtitle")}</p>
                <ol className="mt-4 space-y-3 border-l border-white/10 pl-4">
                  {dados.linhaDoTempo.map((evento, indice) => (
                    <li key={`${evento.tipo}-${evento.em}-${indice}`} className="relative">
                      <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-[#c98f70]" aria-hidden="true" />
                      <p className="flex items-center gap-1.5 text-xs text-white/40"><Clock3 className="h-3 w-3" aria-hidden="true" />{data(evento.em)}</p>
                      {/* O texto da ação pode trazer um e-mail ou um link sem ponto de quebra: a palavra longa quebra em vez de passar da largura do celular. */}
                      <p className="break-words text-sm text-white/80">
                        {evento.tipo === "reuniao"
                          ? <Link href={rotaDaReuniao(evento.meetingId)} className="underline-offset-4 hover:text-white hover:underline">{rotuloDoEvento(t, evento)}</Link>
                          : rotuloDoEvento(t, evento)}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
