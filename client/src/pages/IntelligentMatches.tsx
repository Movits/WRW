import { useState } from "react";
import { Link, useLocation } from "wouter";
import { rotaDaReuniao } from "@shared/rotas";
import { ArrowLeft, Check, History, Lightbulb, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { AppHeader } from "@/components/AppHeader";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { SmartMatchConsent } from "@/components/SmartMatchConsent";
import { analisarTermo, mesmoObjetoAMenosDoLugar, nomeiamAMesmaCoisa, slugDoTermo } from "@shared/direcao-do-termo";
import { familiaDoServico, mesmaFamiliaEEspecialidade, necessidadeGenericaNomeiaOServico } from "@shared/tipo-da-oferta";

type EntryKind = "asset" | "need";

type ItemDoMatch = { slug: string; label: string; category?: string | null };

/**
 * O texto do selo. "Tag exata" deixou de descrever a realidade quando a regra da
 * direção passou a casar "Exportar vinho" com "Importar vinho": o objeto é o
 * mesmo, mas as tags são visivelmente diferentes, e chamar isso de tag exata é
 * dizer à usuária uma coisa que a linha de baixo desmente.
 *
 * Não é um componente de React (não usa hooks) — recebe `t` de quem chama.
 */
export function seloDoMatch(match: { matchType: string; matchedAssets: ItemDoMatch[]; matchedNeeds: ItemDoMatch[] }, t: (key: string) => string) {
  if (match.matchType === "mutual") return t("intelligentMatches.seloMutuo");
  // "category" carrega duas coisas desde 14/09: a categoria em comum de sempre
  // e a necessidade que nomeia só a FAMÍLIA do serviço ("Consultoria" procurado
  // diante de "Consultoria tributária"). São a mesma nota, 60, mas dizer
  // "Mesma categoria" no segundo caso é afirmar à usuária uma coisa que os
  // termos na linha de baixo desmentem — o mesmo motivo pelo qual "Tag exata"
  // deixou de ser dito para todo match exato.
  if (match.matchType === "category") {
    // A mesma pergunta que o motor fez ("Assessoria jurídica" diante de "Advocacia" vale 60 sem a mesma palavra de
    // família), e a família igual dos dois lados, como antes.
    const porFamilia = match.matchedAssets.some(ativo => match.matchedNeeds.some(necessidade => {
      if (necessidadeGenericaNomeiaOServico(ativo.label, ativo.category, necessidade.label)) return true;
      const familia = familiaDoServico(ativo.label, ativo.category);
      return familia !== null && familiaDoServico(necessidade.label, necessidade.category) === familia;
    }));
    return t(porFamilia ? "intelligentMatches.seloFamilia" : "intelligentMatches.seloCategoria");
  }
  if (match.matchType !== "exact") return t("intelligentMatches.seloSignificados");

  // O mesmo objeto vale a menos do lugar de um lado só, como no motor (revisão de 17/11): "Exportação de café" ×
  // "Importação de café do Brasil" é oferta e procura, e não "Tag exata".
  const porDirecaoOposta = match.matchedAssets.some(ativo =>
    match.matchedNeeds.some(necessidade => {
      const a = analisarTermo(ativo.label);
      const n = analisarTermo(necessidade.label);
      const mesmoObjeto = a.objeto === n.objeto || mesmoObjetoAMenosDoLugar(a.objeto, n.objeto);
      return mesmoObjeto && a.direcao !== "neutro" && n.direcao !== "neutro" && a.direcao !== n.direcao;
    }));

  if (porDirecaoOposta) return t("intelligentMatches.seloOfertaProcura");

  // O 100 pelo mesmo serviço escrito de outro jeito ("Advocacia tributária" × "Advogado tributarista", "Contabilidade"
  // × "Contador") também não é tag exata: as tags na linha de baixo são visivelmente outras (9e866b9 da #127). A mesma
  // tag e o mesmo objeto seguem "Tag exata" (ac298b3), por isso a pergunta do slug e de `nomeiamAMesmaCoisa` vem antes.
  const mesmaTag = match.matchedAssets.some(ativo => match.matchedNeeds.some(necessidade =>
    slugDoTermo(ativo.label) === slugDoTermo(necessidade.label) || nomeiamAMesmaCoisa(ativo.label, necessidade.label)));
  const mesmoServico = !mesmaTag && match.matchedAssets.some(ativo => match.matchedNeeds.some(necessidade =>
    mesmaFamiliaEEspecialidade(ativo.label, ativo.category, necessidade.label)));
  return t(mesmoServico ? "intelligentMatches.seloMesmoServico" : "intelligentMatches.seloTagExata");
}

type DirecaoDoMotivo = { deId: number; paraId: number; possui: string[] };

/**
 * A frase do motivo ("Ana possui Exportar café, que Bia procura."), uma por direção, no idioma da tela.
 *
 * A rodada do motor grava a frase em português (`reasonText`), e a tela a desenhava crua: em árabe, a 375 px, saía
 * "Contato K3 Exportar possui Exportar café, que Contato K2 Importadora procura." (conferência de tela do pacote do
 * match, 20/11). O servidor manda também de quem para quem e o que um possui (`motivo`); a frase sai daqui, com a
 * lista no jeito do idioma ("X, Y e Z", "X, Y and Z", "X وY"). Sem direção nenhuma (resposta de antes desta
 * versão), fica a frase gravada.
 *
 * Não é um componente de React (não usa hooks) — recebe `t` e o idioma de quem chama.
 */
export function frasesDoMotivo(
  match: {
    contactAId: number; contactBId: number; reasonText: string; motivo?: DirecaoDoMotivo[];
    contactA?: { name: string } | null; contactB?: { name: string } | null;
  },
  t: (chave: string, opcoes?: Record<string, unknown>) => string,
  idioma: string,
): string[] {
  const direcoes = (match.motivo ?? []).filter(direcao => direcao.possui.length > 0);
  if (!direcoes.length) return [match.reasonText];
  const nome = (id: number) => (id === match.contactAId
    ? match.contactA?.name ?? t("intelligentMatches.contatoAFallback")
    : match.contactB?.name ?? t("intelligentMatches.contatoBFallback"));
  const listar = (itens: string[]) => {
    try {
      return new Intl.ListFormat(idioma, { style: "long", type: "conjunction" }).format(itens);
    } catch {
      return itens.join(", ");
    }
  };
  return direcoes.map(direcao => t("intelligentMatches.motivoDaConexao", { quem: nome(direcao.deId), itens: listar(direcao.possui), outro: nome(direcao.paraId) }));
}

export default function IntelligentMatches() {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  // Etapa 11: sem o termo aceito, o servidor recusa o cruzamento. A tela pergunta
  // antes de bater na porta fechada, para não mostrar erro onde cabe um convite.
  const { data: consent, isLoading: loadingConsent, isError: consentFalhou } = trpc.consent.status.useQuery({ type: "termo_smart_match" });
  const authorized = consent?.accepted ?? false;
  const [verHistorico, setVerHistorico] = useState(false);
  const { data: historico = [] } = trpc.consent.history.useQuery(undefined, { enabled: authorized });
  const { data: matches = [], isLoading, isError: matchesFalharam, error: erroDosMatches, refetch: recarregarMatches } = trpc.intelligentMatches.list.useQuery(undefined, { enabled: authorized });
  const { data: contacts = [], isError: contatosFalharam, error: erroDosContatos, refetch: recarregarContatos } = trpc.intelligentMatches.contacts.useQuery(undefined, { enabled: authorized });
  const revoke = trpc.consent.revoke.useMutation({
    onSuccess: () => { utils.consent.status.invalidate(); toast.success(t("intelligentMatches.toastRevogado")); },
    onError: error => toast.error(error.message || t("intelligentMatches.erroRevogar")),
  });
  const [kind, setKind] = useState<EntryKind>("asset");
  const [contactId, setContactId] = useState("");
  const [tagLabel, setTagLabel] = useState("");
  const [category, setCategory] = useState("");
  const recalculate = trpc.intelligentMatches.recalculate.useMutation({
    onSuccess: result => { utils.intelligentMatches.list.invalidate(); toast.success(t("intelligentMatches.toastRecalculado", { total: result.total })); },
    onError: error => toast.error(error.message || t("intelligentMatches.erroAtualizarMatches")),
  });
  const createAsset = trpc.intelligentMatches.addAsset.useMutation({ onSuccess: refresh });
  const createNeed = trpc.intelligentMatches.addNeed.useMutation({ onSuccess: refresh });
  const aposRemover = () => {
    utils.intelligentMatches.list.invalidate();
    utils.intelligentMatches.contacts.invalidate();
    toast.success(t("intelligentMatches.toastItemRemovido"));
  };
  const removeAsset = trpc.intelligentMatches.removeAsset.useMutation({
    onSuccess: aposRemover,
    onError: error => toast.error(error.message || t("intelligentMatches.erroRemoverItem")),
  });
  const removeNeed = trpc.intelligentMatches.removeNeed.useMutation({
    onSuccess: aposRemover,
    onError: error => toast.error(error.message || t("intelligentMatches.erroRemoverItem")),
  });
  const updateStatus = trpc.intelligentMatches.updateStatus.useMutation({ onSuccess: () => utils.intelligentMatches.list.invalidate() });

  function refresh() {
    utils.intelligentMatches.list.invalidate();
    utils.intelligentMatches.contacts.invalidate();
    setTagLabel(""); setCategory("");
    toast.success(kind === "asset" ? t("intelligentMatches.toastOfertaSalva") : t("intelligentMatches.toastNecessidadeSalva"));
  }
  /**
   * Trocar de aba limpa o que foi digitado, mas mantém o contato escolhido.
   *
   * As duas abas dividiam todo o estado: trocar não mexia em nada na tela além
   * da pílula, e as duas viravam a mesma coisa aos olhos de quem usava. Limpar
   * o texto é o sinal visível de que a troca aconteceu. O contato fica porque
   * registrar o que alguém possui e logo depois o que procura é o caminho
   * normal — apagá-lo obrigaria a escolher de novo a cada troca.
   */
  function trocarModo(novo: EntryKind) {
    if (novo === kind) return;
    setKind(novo);
    setTagLabel("");
    setCategory("");
  }

  const contatoEscolhido = contacts.find(c => String(c.id) === contactId);
  const jaRegistrados = contatoEscolhido ? (kind === "asset" ? contatoEscolhido.possui : contatoEscolhido.procura) : [];

  function submitEntry(event: React.FormEvent) {
    event.preventDefault();
    if (!contactId || !tagLabel.trim()) return toast.error(t("intelligentMatches.erroFormularioIncompleto"));
    const input = { contactId: Number(contactId), tagLabel: tagLabel.trim(), category: category.trim() || undefined };
    if (kind === "asset") createAsset.mutate(input); else createNeed.mutate(input);
  }

  return <><AppHeader title={t("intelligentMatches.titulo")} backTo="/dashboard"/>
  <main className="min-h-screen bg-transparent px-4 py-8 text-white md:px-8">
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div><p className="text-xs font-semibold tracking-wide text-amber-300">{t("intelligentMatches.eyebrow")}</p><h1 className="mt-1 text-3xl font-bold md:text-4xl">{t("intelligentMatches.titulo")}</h1><p className="mt-2 max-w-2xl text-white/55">{t("intelligentMatches.subtitulo")}</p></div>
        {authorized && <button disabled={recalculate.isPending} onClick={() => recalculate.mutate()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-5 py-3 font-bold text-[#1a120c] disabled:opacity-50"><RefreshCw size={18} className={recalculate.isPending ? "animate-spin" : ""}/> {t("intelligentMatches.botaoAtualizar")}</button>}
      </div>
      {/*
        Falha ao carregar o status NÃO pode virar tela de aceite. Sem isto,
        `authorized` caía para false e a página oferecia o botão de autorizar a
        quem já tinha autorizado — sobre um termo em branco, porque o texto
        também não carregou. O aceite gravava normalmente se a rede voltasse
        antes do clique: prova de concordância com um texto que a usuária nunca
        viu, que é o oposto do que a etapa 11 existe para produzir.
      */}
      {loadingConsent ? <p className="py-24 text-center text-white/45">{t("intelligentMatches.carregandoConsentimento")}</p>
      : consentFalhou ? <div className="rounded-3xl border border-white/15 px-6 py-16 text-center">
          <p className="text-white/70">{t("intelligentMatches.erroCarregarTermo")}</p>
          <p className="mt-2 text-sm text-white/40">{t("intelligentMatches.avisoAutorizacaoExistente")}</p>
          <button onClick={() => utils.consent.status.invalidate()} className="mt-5 rounded-xl border border-amber-300/50 px-5 py-2.5 text-sm font-semibold text-amber-200 hover:bg-amber-300/10">
            {t("intelligentMatches.botaoTentarNovo")}
          </button>
        </div>
      : !authorized ? <SmartMatchConsent onAccepted={() => utils.consent.status.invalidate()}/> : <>
      <section className="mb-7 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-5"><div className="flex gap-3"><Lightbulb className="mt-0.5 shrink-0 text-amber-300" size={20}/><p className="text-sm leading-6 text-amber-100/80">{t("intelligentMatches.explicacao")}</p></div></section>
      {/*
        O modo (possui / procura) decide o que o botão Adicionar faz, e modo
        escondido é armadilha: quem não percebe em qual está grava a informação
        no lado errado, e o cruzamento passa a casar coisa que não existe. Por
        isso o modo aparece em três lugares que mudam juntos — a aba, a frase
        acima do formulário e o texto do botão — e a lista do que já está
        registrado muda junto, que é o que faz as duas abas terem conteúdo
        diferente de verdade.
      */}
      <section className={`mb-8 rounded-2xl border p-5 transition-colors ${kind === "asset" ? "border-emerald-400/30 bg-emerald-400/[0.04]" : "border-sky-300/30 bg-sky-300/[0.04]"}`}>
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => trocarModo("asset")}
            className={`rounded-full px-4 py-2 text-sm transition-colors ${kind === "asset" ? "bg-emerald-400 font-bold text-[#1a120c]" : "border border-white/15 text-white/65 hover:border-white/30"}`}
          >
            {t("intelligentMatches.abaPossui")}
          </button>
          <button
            type="button"
            onClick={() => trocarModo("need")}
            className={`rounded-full px-4 py-2 text-sm transition-colors ${kind === "need" ? "bg-sky-300 font-bold text-[#1a120c]" : "border border-white/15 text-white/65 hover:border-white/30"}`}
          >
            {t("intelligentMatches.abaProcura")}
          </button>
        </div>

        <p className="mb-3 text-sm text-white/55">
          {contatoEscolhido
            ? <>{t("intelligentMatches.registrandoPrefixo")}{" "}
                <strong className="text-white/85">{contatoEscolhido.fullName}</strong>{" "}
                <strong className={kind === "asset" ? "text-emerald-300" : "text-sky-300"}>
                  {kind === "asset" ? t("intelligentMatches.temAOferecer") : t("intelligentMatches.estaProcurando")}
                </strong>.</>
            : <>{t("intelligentMatches.escolhaContatoPrefixo")}{" "}
                <strong className={kind === "asset" ? "text-emerald-300" : "text-sky-300"}>
                  {kind === "asset" ? t("intelligentMatches.temAOferecer") : t("intelligentMatches.estaProcurando")}
                </strong>.</>}
        </p>

        {/* Regra da demanda expressa (12/09/2026): quem registra um serviço
            precisa saber que ele não casa "com quem poderia precisar" — só
            com quem declarou precisar. Sem o aviso, a ausência de sugestão
            pareceria defeito. */}
        {kind === "asset" && (
          <p className="mb-3 text-xs text-white/40">{t("intelligentMatches.avisoServico")}</p>
        )}

        {/* Sem isto, a lista de contatos falhando virava um seletor vazio:
            parecia que a rede não tinha ninguém para registrar. */}
        {contatosFalharam && (
          <div className="mb-3"><ErroDeConsulta erro={erroDosContatos} aoTentarDeNovo={() => recarregarContatos()} /></div>
        )}
        <form onSubmit={submitEntry} className="grid gap-3 md:grid-cols-4">
          <select
            value={contactId}
            onChange={event => setContactId(event.target.value)}
            className="rounded-xl border border-white/15 bg-[#211e1b] px-3 py-3 text-white"
          >
            <option className="bg-white text-[#322C26]" value="">{t("intelligentMatches.selecioneContato")}</option>
            {contacts.map(contact => (
              <option className="bg-white text-[#322C26]" key={contact.id} value={contact.id}>
                {contact.fullName}{contact.company ? ` (${contact.company})` : ""}
              </option>
            ))}
          </select>
          <input
            value={tagLabel}
            onChange={event => setTagLabel(event.target.value)}
            placeholder={kind === "asset" ? t("intelligentMatches.placeholderOferta") : t("intelligentMatches.placeholderNecessidade")}
            className={`rounded-xl border border-white/15 bg-white/5 px-3 py-3 outline-none ${kind === "asset" ? "focus:border-emerald-400" : "focus:border-sky-300"}`}
          />
          <input
            value={category}
            onChange={event => setCategory(event.target.value)}
            placeholder={t("intelligentMatches.placeholderCategoria")}
            className={`rounded-xl border border-white/15 bg-white/5 px-3 py-3 outline-none ${kind === "asset" ? "focus:border-emerald-400" : "focus:border-sky-300"}`}
          />
          <button
            disabled={createAsset.isPending || createNeed.isPending}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-3 py-3 font-bold text-[#1a120c] transition-colors disabled:opacity-50 ${kind === "asset" ? "bg-emerald-400 hover:bg-emerald-300" : "bg-sky-300 hover:bg-sky-200"}`}
          >
            <Plus size={17}/> {kind === "asset" ? t("intelligentMatches.botaoAdicionarOferta") : t("intelligentMatches.botaoAdicionarNecessidade")}
          </button>
        </form>

        {contatoEscolhido && (
          <div className="mt-4 border-t border-white/10 pt-3">
            <p className="mb-2 text-xs text-white/40">
              {contatoEscolhido.fullName} {kind === "asset" ? t("intelligentMatches.jaOferece") : t("intelligentMatches.jaProcura")}:
            </p>
            {jaRegistrados.length === 0 ? (
              <p className="text-xs text-white/35">
                {t("intelligentMatches.nadaRegistradoPrefixo")} {kind === "asset" ? t("intelligentMatches.noQuePossui") : t("intelligentMatches.noQueProcura")}.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {jaRegistrados.map(item => (
                  <li
                    key={item.id}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${kind === "asset" ? "border-emerald-400/30 text-emerald-200/80" : "border-sky-300/30 text-sky-200/80"}`}
                  >
                    {item.label}{item.category ? <span className="text-white/35"> · {item.category}</span> : null}
                    <button
                      type="button"
                      aria-label={t("intelligentMatches.removerAriaLabel", { label: item.label })}
                      title={t("intelligentMatches.removerTooltip")}
                      disabled={removeAsset.isPending || removeNeed.isPending}
                      onClick={() => (kind === "asset" ? removeAsset.mutate({ id: item.id }) : removeNeed.mutate({ id: item.id }))}
                      className="rounded-full p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
                    >
                      <X size={12}/>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      {isLoading ? (
        <p className="py-16 text-center text-white/45">{t("intelligentMatches.carregandoOportunidades")}</p>
      ) : matchesFalharam ? (
        // Consulta falhou não é "sem oportunidades" (regra: banco fora do ar
        // é erro, nunca "sem dados").
        <ErroDeConsulta erro={erroDosMatches} aoTentarDeNovo={() => recarregarMatches()} />
      ) : !matches.length ? (
        <div className="rounded-3xl border border-dashed border-white/15 px-6 py-20 text-center">
          <Sparkles className="mx-auto mb-4 text-amber-300" size={34}/>
          <h2 className="text-xl font-semibold">{t("intelligentMatches.semOportunidadesTitulo")}</h2>
          <p className="mt-2 text-white/45">{t("intelligentMatches.semOportunidadesTexto")}</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {matches.map(match => (
            <article key={match.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
              <div className="flex flex-col justify-between gap-4 md:flex-row">
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-amber-300 px-3 py-1 text-sm font-bold text-[#1a120c]">{t("intelligentMatches.percentualCompatibilidade", { score: match.matchScore })}</span>
                    <span className={`rounded-full px-3 py-1 text-xs ${match.matchType === "mutual" ? "border border-emerald-400/50 bg-emerald-400/10 font-semibold text-emerald-300" : "border border-white/15 text-white/60"}`}>{seloDoMatch(match, t)}</span>
                  </div>
                  <h2 className="text-lg font-semibold">{match.contactA?.name ?? t("intelligentMatches.contatoAFallback")} <span className="text-white/35">→</span> {match.contactB?.name ?? t("intelligentMatches.contatoBFallback")}</h2>
                  <p className="mt-2 text-sm text-white/65">
                    {frasesDoMotivo(match, t, i18n.language).map((frase, indice) => <span key={indice} className="block">{frase}</span>)}
                  </p>
                  <p className="mt-3 text-xs text-white/40">{t("intelligentMatches.rotuloOferece")} {match.matchedAssets.map(item => item.label).join(", ")} {t("intelligentMatches.rotuloProcura")} {match.matchedNeeds.map(item => item.label).join(", ")}</p>
                  {/* N5: a reunião de que a conexão nasceu, com o trecho que a dona confirmou. */}
                  {match.origem && (
                    <p className="mt-2 text-xs text-emerald-200/80">
                      <Link href={rotaDaReuniao(match.origem.meetingId)} className="font-semibold underline-offset-4 hover:underline">
                        {t("reuniaoNoMatch.origemDaConexao", { titulo: match.origem.titulo, data: new Date(match.origem.em).toLocaleDateString(i18n.language) })}
                      </Link>
                      {match.origem.trecho && <span dir="auto" className="italic text-white/45">{` ${t("networkInteligente.suggestions.evidence", { trecho: match.origem.trecho })}`}</span>}
                    </p>
                  )}
                </div>
                {match.status === "pending" || match.status === "viewed" ? (
                  <div className="flex shrink-0 flex-wrap gap-2 self-start">
                    <button onClick={() => updateStatus.mutate({ id: match.id, status: "accepted" })} className="rounded-lg bg-emerald-400 px-3 py-2 text-sm font-bold text-[#1a120c]"><Check size={15} className="mr-1 inline"/> {t("intelligentMatches.botaoAceitar")}</button>
                    <button onClick={() => updateStatus.mutate({ id: match.id, status: "dismissed" })} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/65"><X size={15} className="mr-1 inline"/> {t("intelligentMatches.botaoDispensar")}</button>
                  </div>
                ) : (
                  <span className="text-sm text-white/45">{match.status === "accepted" ? t("intelligentMatches.statusAceita") : t("intelligentMatches.statusDispensada")}</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {!consent?.pendingText && (
        <section className="mt-10 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <p className="text-sm text-white/55">
            {t("intelligentMatches.autorizadoTexto")}{consent?.acceptedAt ? ` ${t("intelligentMatches.autorizadoDesde", { data: new Date(consent.acceptedAt).toLocaleDateString() })}` : ""}.
          </p>
          <button
            disabled={revoke.isPending}
            onClick={() => revoke.mutate({ type: "termo_smart_match" })}
            className="mt-3 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/60 transition-colors hover:border-red-400/40 hover:text-red-300 disabled:opacity-50"
          >
            {t("intelligentMatches.botaoRevogar")}
          </button>
          <p className="mt-2 text-xs text-white/35">
            {t("intelligentMatches.avisoRevogar")}
          </p>

          {/*
            O registro é metade do sentido de guardar consentimento: revogar
            preenche a data e nunca apaga a linha, justamente para que o
            histórico mostre que houve autorização no período em que os dados
            foram usados. Guardar essa prova e não mostrá-la a quem ela protege
            deixava o trabalho pela metade.
          */}
          {historico.length > 0 && (
            <div className="mt-5 border-t border-white/10 pt-4">
              <button
                onClick={() => setVerHistorico(!verHistorico)}
                className="flex items-center gap-1.5 text-xs text-white/45 transition-colors hover:text-white/70"
              >
                <History size={13}/>
                {verHistorico ? t("intelligentMatches.ocultarHistorico") : t("intelligentMatches.verHistoricoBotao")} {t("intelligentMatches.registroAutorizacoesLabel", { count: historico.length })}
              </button>

              {verHistorico && (
                <ul className="mt-3 space-y-2">
                  {historico.map(registro => {
                    // Três situações, não duas. Uma autorização de versão
                    // anterior nunca foi revogada — `revoke` só mexe na versão
                    // vigente — mas também não autoriza nada: `hasValidConsent`
                    // exige a versão vigente. Chamá-la de "ativa" dizia à
                    // usuária que ela mantém autorizações vivas que não existem,
                    // num registro que ela não tem como corrigir pela tela.
                    const vigente = registro.version === consent?.document?.version;
                    const situacao = registro.revokedAt ? "revogada" : vigente ? "ativa" : "substituída";
                    const situacaoLabel = situacao === "revogada" ? t("intelligentMatches.situacaoRevogada")
                      : situacao === "ativa" ? t("intelligentMatches.situacaoAtiva")
                      : t("intelligentMatches.situacaoSubstituida");
                    const cor = situacao === "ativa" ? "text-emerald-300/70" : "text-white/35";
                    return (
                    <li key={registro.id} className="flex flex-wrap items-baseline gap-x-2 text-xs text-white/45">
                      <span className={cor}>{situacaoLabel}</span>
                      <span className="text-white/55">{t("intelligentMatches.versaoLabel")} {registro.version}</span>
                      <span>{t("intelligentMatches.aceitaEm")} {new Date(registro.grantedAt).toLocaleString()}</span>
                      {registro.revokedAt && <span>{t("intelligentMatches.revogadaEmData", { data: new Date(registro.revokedAt).toLocaleString() })}</span>}
                      {situacao === "substituída" && <span>{t("intelligentMatches.termoMudouAviso")}</span>}
                    </li>
                  );})}
                </ul>
              )}
            </div>
          )}
        </section>
      )}
      </>}
    </div>
  </main></>;
}
