import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Building2, Copy, Download, FileSpreadsheet, KeyRound, Link2, Loader2, Mail, MessageCircle, Phone, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { PedidosDaEntidade } from "@/components/PedidosDaEntidade";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { lerPlanilha, PlanilhaIlegivel, sha256DoArquivo } from "@/lib/ler-planilha";
import {
  ehErroDaEntidade, linhaDaPlanilha, mapearCabecalho, planilhaDeLinks, LINHAS_POR_BLOCO, PROBLEMAS_LISTADOS_MAX, ROTA_DA_ATIVACAO,
  type LinhaBruta, type ProblemaDaLinha,
} from "@shared/entidades";

/**
 * O painel da entidade (a base das associações, N1): a conta da federação,
 * associação ou sindicato vê os PRÓPRIOS associados (código, nome e
 * documento, com busca), importa a planilha em blocos (primeiro o ensaio,
 * depois a importação) e gera o link de convite ao app. Desde a N3, gera também
 * o link de ativação de cada empresa importada (de uso único, mostrado uma vez).
 *
 * A planilha é lida no aparelho (lib/ler-planilha.ts): só as linhas já
 * mapeadas vão ao servidor, 500 por chamada, e o servidor valida tudo de novo.
 */

type Relatorio = {
  modo: "ensaio" | "aplicar"; total: number; processadas: number;
  criados: number; atualizados: number; recusados: number; comAviso: number;
  problemas: ProblemaDaLinha[]; concluido: boolean;
};

type Planilha = { nome: string; sha256: string; linhas: LinhaBruta[] };

function useTraduzErro() {
  const { t } = useTranslation();
  return (erro: unknown) => {
    const mensagem = (erro as { message?: unknown })?.message;
    if (ehErroDaEntidade(mensagem)) return t(`entidade.erros.${mensagem}`);
    return mensagemDeErroParaTela(erro, t);
  };
}

export default function PainelDaEntidade() {
  const { t } = useTranslation();
  const minha = trpc.entidades.minha.useQuery(undefined, { retry: false });
  const traduzErro = useTraduzErro();

  if (minha.isLoading) {
    return <main className="min-h-screen text-white px-4 py-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-white/50" aria-label={t("entidade.carregando")} /></main>;
  }
  if (minha.error) {
    const codigo = minha.error.message;
    return (
      <main className="min-h-screen text-white px-4 py-8 md:px-8">
        {ehErroDaEntidade(codigo)
          ? <p role="alert" className="max-w-xl mx-auto text-white/70">{traduzErro(minha.error)}</p>
          : <ErroDeConsulta erro={minha.error} aoTentarDeNovo={() => void minha.refetch()} />}
      </main>
    );
  }
  const dados = minha.data!;
  return (
    <main className="min-h-screen text-white px-4 py-8 md:px-8 bg-transparent">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-start gap-3">
          <span className="w-11 h-11 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center shrink-0">
            <Building2 className="w-5 h-5 text-[#efcba8]" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-semibold break-words">{dados.nome}</h1>
            <p className="text-sm text-white/50">
              {t(`entidade.tipos.${dados.tipo}`)} · {dados.pais} · {t("entidade.contagem", { importados: dados.membros.importados, ativados: dados.membros.ativados })}
            </p>
          </div>
        </header>
        {!dados.convenioVigente && (
          <p role="status" className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            {t("entidade.convenioInativo")}
          </p>
        )}
        <PedidosDaEntidade habilitado={dados.convenioVigente} />
        <Membros nomeDaEntidade={dados.nome} ativacaoHabilitada={dados.convenioVigente} />
        <Importacao habilitada={dados.convenioVigente} />
        <Ativacao habilitada={dados.convenioVigente} />
        <Convite habilitado={dados.convenioVigente} nome={dados.nome} />
      </div>
    </main>
  );
}

// ─── Associados ──────────────────────────────────────────────────────────────

function Membros({ nomeDaEntidade, ativacaoHabilitada }: { nomeDaEntidade: string; ativacaoHabilitada: boolean }) {
  const { t } = useTranslation();
  const [digitado, setDigitado] = useState("");
  const [busca, setBusca] = useState("");
  const [pagina, setPagina] = useState(0);
  useEffect(() => {
    const espera = window.setTimeout(() => { setBusca(digitado.trim()); setPagina(0); }, 400);
    return () => window.clearTimeout(espera);
  }, [digitado]);
  const lista = trpc.entidades.membros.useQuery({ busca: busca || undefined, pagina }, { placeholderData: anterior => anterior });
  const total = lista.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / (lista.data?.porPagina ?? 50)));

  return (
    <section aria-labelledby="titulo-membros" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="titulo-membros" className="text-lg font-semibold">{t("entidade.membros.titulo")}</h2>
        <span className="text-sm text-white/50">{t("entidade.membros.total", { n: total })}</span>
      </div>
      <label className="relative block">
        <span className="sr-only">{t("entidade.membros.buscar")}</span>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
        <input
          type="search" value={digitado} onChange={e => setDigitado(e.target.value)} maxLength={100}
          placeholder={t("entidade.membros.buscarDica")}
          className="w-full rounded-xl bg-white/[0.04] border border-white/10 pl-9 pr-3 py-2.5 text-sm placeholder:text-white/35 focus:outline-none focus:border-[#c98f70]/60"
        />
      </label>
      {lista.error ? <ErroDeConsulta erro={lista.error} aoTentarDeNovo={() => void lista.refetch()} /> : null}
      {lista.isLoading ? <Loader2 className="w-5 h-5 animate-spin text-white/50" /> : null}
      {lista.data && !lista.data.membros.length ? (
        <p className="text-sm text-white/50">{busca ? t("entidade.membros.nadaNaBusca") : t("entidade.membros.vazio")}</p>
      ) : null}
      <ul className="divide-y divide-white/[0.06]">
        {lista.data?.membros.map(m => <LinhaDoMembro key={m.id} membro={m} nomeDaEntidade={nomeDaEntidade} ativacaoHabilitada={ativacaoHabilitada} />)}
      </ul>
      {paginas > 1 && (
        <nav className="flex items-center justify-between gap-2 text-sm" aria-label={t("entidade.membros.paginas")}>
          <button type="button" disabled={pagina === 0} onClick={() => setPagina(p => p - 1)}
            className="rounded-lg border border-white/10 px-3 py-1.5 disabled:opacity-40">{t("entidade.membros.anterior")}</button>
          <span className="text-white/50">{t("entidade.membros.pagina", { atual: pagina + 1, total: paginas })}</span>
          <button type="button" disabled={pagina + 1 >= paginas} onClick={() => setPagina(p => p + 1)}
            className="rounded-lg border border-white/10 px-3 py-1.5 disabled:opacity-40">{t("entidade.membros.proxima")}</button>
        </nav>
      )}
    </section>
  );
}

type Membro = { id: number; codigo: string | null; nome: string; documento: string | null; estado: string; uf: string | null; disponivel: boolean; temContato: boolean; ativacaoValidaAte?: number | null };

/** O link da ativação (N3). */
function linkDeAtivacao(token: string) {
  return `${window.location.origin}${ROTA_DA_ATIVACAO}/${token}`;
}

function LinhaDoMembro({ membro, nomeDaEntidade, ativacaoHabilitada }: { membro: Membro; nomeDaEntidade: string; ativacaoHabilitada: boolean }) {
  const { t, i18n } = useTranslation();
  const traduzErro = useTraduzErro();
  const utils = trpc.useUtils();
  const contato = trpc.entidades.contatoDoMembro.useMutation({ onError: e => toast.error(traduzErro(e)) });
  const gerar = trpc.entidades.gerarLinksDeAtivacao.useMutation({
    onSuccess: () => void utils.entidades.membros.invalidate(), onError: e => toast.error(traduzErro(e)),
  });
  const gerado = gerar.data?.links[0];
  const data = (ms: number) => new Date(ms).toLocaleDateString(i18n.language);
  // Texto que a entidade manda à empresa: marcado para a Cris revisar (docs/arquitetura/entidades.md).
  const texto = gerado
    ? t("entidade.ativacao.texto", { entidade: nomeDaEntidade, empresa: membro.nome, data: data(gerado.expiraEm), link: linkDeAtivacao(gerado.token) })
    : "";
  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(t("entidade.ativacao.copiado"));
    } catch {
      toast.error(t("entidade.ativacao.naoCopiou"));
    }
  }
  return (
    <li className="py-3 flex flex-col gap-1 md:flex-row md:flex-wrap md:items-center md:gap-4">
      <span className="font-mono text-xs text-[#efcba8] md:w-24 shrink-0">{membro.codigo}</span>
      <span className="text-sm font-medium break-words md:flex-1 min-w-0">{membro.nome}</span>
      <span className="font-mono text-xs text-white/60 md:w-44 shrink-0" dir="ltr">{membro.documento}</span>
      <span className="text-xs text-white/50 md:w-28 shrink-0">
        {t(`entidade.estados.${membro.estado}`)}{membro.disponivel ? ` · ${t("entidade.membros.naRede")}` : ""}
      </span>
      {membro.temContato && (
        contato.data ? (
          <span className="text-xs text-white/70 flex flex-wrap gap-x-3" dir="ltr">
            {contato.data.telefone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{contato.data.telefone}</span>}
            {contato.data.email && <span className="inline-flex items-center gap-1 break-all"><Mail className="w-3 h-3" />{contato.data.email}</span>}
          </span>
        ) : (
          <button type="button" onClick={() => contato.mutate({ membroId: membro.id })} disabled={contato.isPending}
            className="self-start text-xs rounded-lg border border-white/10 px-2.5 py-1 text-white/70 hover:text-white">
            {t("entidade.membros.verContato")}
          </button>
        )
      )}
      {membro.estado === "importado" && !gerado && (
        <span className="flex flex-wrap items-center gap-2">
          {membro.ativacaoValidaAte ? <span className="text-xs text-white/45">{t("entidade.ativacao.validoAte", { data: data(membro.ativacaoValidaAte) })}</span> : null}
          <button type="button" onClick={() => gerar.mutate({ membroIds: [membro.id] })} disabled={!ativacaoHabilitada || gerar.isPending}
            className="self-start inline-flex items-center gap-1 text-xs rounded-lg border border-white/10 px-2.5 py-1 text-white/70 hover:text-white disabled:opacity-40">
            <KeyRound className="w-3 h-3" />{membro.ativacaoValidaAte ? t("entidade.ativacao.trocarLink") : t("entidade.ativacao.linkDoMembro")}
          </button>
        </span>
      )}
      {gerado && (
        <div className="w-full space-y-2 rounded-lg bg-black/30 p-3">
          <p className="font-mono text-xs break-all" dir="ltr">{linkDeAtivacao(gerado.token)}</p>
          <p className="text-xs text-amber-100/80">{t("entidade.ativacao.linkUmaVez")}</p>
          <button type="button" onClick={() => void copiar()} className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs">
            <Copy className="w-3 h-3" />{t("entidade.ativacao.copiar")}
          </button>
        </div>
      )}
    </li>
  );
}

// ─── Importação ──────────────────────────────────────────────────────────────

function Importacao({ habilitada }: { habilitada: boolean }) {
  const { t } = useTranslation();
  const traduzErro = useTraduzErro();
  const utils = trpc.useUtils();
  const entrada = useRef<HTMLInputElement>(null);
  const [planilha, setPlanilha] = useState<Planilha | null>(null);
  const [erroDoArquivo, setErroDoArquivo] = useState<string | null>(null);
  const [lendo, setLendo] = useState(false);
  const [relatorio, setRelatorio] = useState<Relatorio | null>(null);
  const [rodando, setRodando] = useState(false);
  const iniciar = trpc.entidades.iniciarImportacao.useMutation();
  const bloco = trpc.entidades.importarBloco.useMutation();
  const concluir = trpc.entidades.concluirImportacao.useMutation();

  async function escolher(arquivo: File | undefined) {
    setPlanilha(null); setRelatorio(null); setErroDoArquivo(null);
    if (!arquivo) return;
    setLendo(true);
    try {
      const bytes = await arquivo.arrayBuffer();
      const celulas = await lerPlanilha(arquivo.name, bytes);
      const mapa = mapearCabecalho(celulas[0]);
      if (!mapa.ok) {
        setErroDoArquivo(t(`entidade.importar.arquivo.${mapa.codigo}`, { coluna: mapa.coluna }));
        return;
      }
      setPlanilha({ nome: arquivo.name, sha256: await sha256DoArquivo(bytes), linhas: celulas.slice(1).map(c => linhaDaPlanilha(c, mapa.colunas)) });
    } catch (e) {
      setErroDoArquivo(t(`entidade.importar.arquivo.${e instanceof PlanilhaIlegivel ? e.codigo : "PLANILHA_ILEGIVEL"}`));
    } finally {
      setLendo(false);
      if (entrada.current) entrada.current.value = "";
    }
  }

  async function rodar(modo: "ensaio" | "aplicar") {
    if (!planilha) return;
    setRodando(true);
    const atual: Relatorio = { modo, total: planilha.linhas.length, processadas: 0, criados: 0, atualizados: 0, recusados: 0, comAviso: 0, problemas: [], concluido: false };
    setRelatorio({ ...atual });
    try {
      const { importacaoId } = await iniciar.mutateAsync({ modo, arquivoSha256: planilha.sha256, totalLinhas: planilha.linhas.length });
      for (let inicio = 0; inicio < planilha.linhas.length; inicio += LINHAS_POR_BLOCO) {
        const r = await bloco.mutateAsync({ importacaoId, inicio, linhas: planilha.linhas.slice(inicio, inicio + LINHAS_POR_BLOCO) });
        atual.processadas += r.processadas; atual.criados += r.criados; atual.atualizados += r.atualizados;
        atual.recusados += r.recusados; atual.comAviso += r.comAviso;
        atual.problemas = [...atual.problemas, ...r.problemas].slice(0, PROBLEMAS_LISTADOS_MAX);
        setRelatorio({ ...atual });
      }
      await concluir.mutateAsync({ importacaoId });
      atual.concluido = true;
      setRelatorio({ ...atual });
      if (modo === "aplicar") {
        toast.success(t("entidade.importar.concluida"));
        void utils.entidades.membros.invalidate();
        void utils.entidades.minha.invalidate();
      }
    } catch (e) {
      toast.error(traduzErro(e));
    } finally {
      setRodando(false);
    }
  }

  const progresso = relatorio && relatorio.total ? Math.round((relatorio.processadas / relatorio.total) * 100) : 0;
  return (
    <section aria-labelledby="titulo-importar" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-6 space-y-4">
      <h2 id="titulo-importar" className="text-lg font-semibold">{t("entidade.importar.titulo")}</h2>
      <p className="text-sm text-white/60">{t("entidade.importar.explicacao")}</p>
      <p className="text-xs text-white/45">{t("entidade.importar.colunas")}</p>
      <p className="text-xs text-white/45">{t("entidade.importar.cnaeComoOferta")}</p>
      <div className="flex flex-wrap gap-2">
        <input ref={entrada} type="file" accept=".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only" id="arquivo-da-entidade" onChange={e => void escolher(e.target.files?.[0])} disabled={!habilitada || rodando} />
        <label htmlFor="arquivo-da-entidade"
          className={`inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm ${habilitada && !rodando ? "cursor-pointer hover:border-[#c98f70]/60" : "opacity-40"}`}>
          {lendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
          {t("entidade.importar.escolher")}
        </label>
      </div>
      {erroDoArquivo && <p role="alert" className="text-sm text-red-300">{erroDoArquivo}</p>}
      {planilha && (
        <div className="space-y-3">
          <p className="text-sm text-white/70 break-all">{t("entidade.importar.lida", { nome: planilha.nome, n: planilha.linhas.length })}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={rodando} onClick={() => void rodar("ensaio")}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm disabled:opacity-40">
              <Search className="w-4 h-4" />{t("entidade.importar.ensaio")}
            </button>
            <button type="button" disabled={rodando || !(relatorio?.modo === "ensaio" && relatorio.concluido)} onClick={() => void rodar("aplicar")}
              className="inline-flex items-center gap-2 rounded-xl bg-[#c98f70] text-black px-4 py-2 text-sm font-medium disabled:opacity-40">
              <Upload className="w-4 h-4" />{t("entidade.importar.aplicar")}
            </button>
          </div>
          <p className="text-xs text-white/45">{t("entidade.importar.ensaioPrimeiro")}</p>
        </div>
      )}
      {relatorio && (
        <div className="space-y-2" aria-live="polite">
          <div className="h-2 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progresso}>
            <div className="h-full bg-[#c98f70] transition-all" style={{ width: `${progresso}%` }} />
          </div>
          <p className="text-sm text-white/70">
            {t(relatorio.modo === "ensaio" ? "entidade.importar.relatorioEnsaio" : "entidade.importar.relatorioAplicar", {
              processadas: relatorio.processadas, total: relatorio.total, criados: relatorio.criados,
              atualizados: relatorio.atualizados, recusados: relatorio.recusados, comAviso: relatorio.comAviso,
            })}
          </p>
          {relatorio.problemas.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-white/70">{t("entidade.importar.problemas", { n: relatorio.problemas.length })}</summary>
              <ul className="mt-2 max-h-64 overflow-y-auto space-y-1 text-xs text-white/60">
                {relatorio.problemas.map((p, i) => (
                  <li key={`${p.linha}-${p.codigo}-${i}`}>
                    {t("entidade.importar.linha", { linha: p.linha })}: {t(`entidade.importar.codigos.${p.codigo}`, { primeira: p.primeira })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Ativação das empresas importadas (N3) ───────────────────────────────────

/**
 * Gera os links que faltam (importados sem link valendo), 500 por chamada, e
 * baixa a planilha montada NESTE aparelho: o token só existe nesta resposta e
 * nunca volta do servidor. A entidade manda cada link pelo canal dela.
 */
function Ativacao({ habilitada }: { habilitada: boolean }) {
  const { t, i18n } = useTranslation();
  const traduzErro = useTraduzErro();
  const utils = trpc.useUtils();
  const gerar = trpc.entidades.gerarLinksDeAtivacao.useMutation();
  const [rodando, setRodando] = useState(false);
  const [quantos, setQuantos] = useState<number | null>(null);

  async function gerarTodos() {
    setRodando(true); setQuantos(0);
    const linhas: Parameters<typeof planilhaDeLinks>[0] = [];
    try {
      let cursor: number | null = 0;
      while (cursor !== null) {
        const r: { links: Array<{ codigo: string | null; nome: string; referencia: string | null; token: string; expiraEm: number }>; proximo: number | null } =
          await gerar.mutateAsync({ pendentesDepoisDoId: cursor });
        for (const l of r.links) {
          linhas.push({ codigo: l.codigo, nome: l.nome, referencia: l.referencia, link: linkDeAtivacao(l.token), validoAte: new Date(l.expiraEm).toLocaleDateString(i18n.language) });
        }
        setQuantos(linhas.length);
        cursor = r.proximo;
      }
    } catch (e) {
      toast.error(traduzErro(e));
    } finally {
      setRodando(false);
    }
    if (!linhas.length) { toast.info(t("entidade.ativacao.nenhumPendente")); return; }
    // O que já foi gerado vale: a planilha desce mesmo se uma chamada do meio falhar.
    const c = (chave: string) => t(`entidade.ativacao.cabecalho.${chave}`);
    const csv = planilhaDeLinks(linhas, [c("codigo"), c("nome"), c("referencia"), c("link"), c("validoAte")]);
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${t("entidade.ativacao.arquivo")}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success(t("entidade.ativacao.gerados", { n: linhas.length }));
    void utils.entidades.membros.invalidate();
  }

  return (
    <section aria-labelledby="titulo-ativacao" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-6 space-y-4">
      <h2 id="titulo-ativacao" className="text-lg font-semibold">{t("entidade.ativacao.titulo")}</h2>
      <p className="text-sm text-white/60">{t("entidade.ativacao.explicacao")}</p>
      <button type="button" disabled={!habilitada || rodando} onClick={() => void gerarTodos()}
        className="inline-flex items-center gap-2 rounded-xl bg-[#c98f70] text-black px-4 py-2 text-sm font-medium disabled:opacity-40">
        {rodando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}{t("entidade.ativacao.gerarPendentes")}
      </button>
      {rodando && quantos !== null && <p aria-live="polite" className="text-sm text-white/60">{t("entidade.ativacao.gerando", { n: quantos })}</p>}
    </section>
  );
}

// ─── Convite ao app ──────────────────────────────────────────────────────────

function Convite({ habilitado, nome }: { habilitado: boolean; nome: string }) {
  const { t } = useTranslation();
  const traduzErro = useTraduzErro();
  const utils = trpc.useUtils();
  const convite = trpc.entidades.convite.useQuery();
  const gerar = trpc.entidades.gerarConvite.useMutation({
    onSuccess: () => void utils.entidades.convite.invalidate(), onError: e => toast.error(traduzErro(e)),
  });
  const revogar = trpc.entidades.revogarConvite.useMutation({
    onSuccess: () => void utils.entidades.convite.invalidate(), onError: e => toast.error(traduzErro(e)),
  });
  const link = convite.data ? `${window.location.origin}/convite/${convite.data.token}` : null;
  // Texto a terceiros: marcado para a Cris revisar (docs/arquitetura/entidades.md, seção 9).
  const texto = link ? t("entidade.convite.texto", { nome, link }) : "";

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(t("entidade.convite.copiado"));
    } catch {
      toast.error(t("entidade.convite.naoCopiou"));
    }
  }

  return (
    <section aria-labelledby="titulo-convite" className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-6 space-y-4">
      <h2 id="titulo-convite" className="text-lg font-semibold">{t("entidade.convite.titulo")}</h2>
      <p className="text-sm text-white/60">{t("entidade.convite.explicacao")}</p>
      {convite.error ? <ErroDeConsulta erro={convite.error} aoTentarDeNovo={() => void convite.refetch()} /> : null}
      {link ? (
        <div className="space-y-3">
          <p className="font-mono text-xs break-all rounded-lg bg-black/30 px-3 py-2" dir="ltr">{link}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copiar()} className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm">
              <Copy className="w-4 h-4" />{t("entidade.convite.copiar")}
            </button>
            <a href={`https://wa.me/?text=${encodeURIComponent(texto)}`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm">
              <MessageCircle className="w-4 h-4" />{t("entidade.convite.whatsapp")}
            </a>
            <a href={`mailto:?subject=${encodeURIComponent(t("entidade.convite.assunto", { nome }))}&body=${encodeURIComponent(texto)}`}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm">
              <Mail className="w-4 h-4" />{t("entidade.convite.email")}
            </a>
            <button type="button" disabled={!habilitado || gerar.isPending} onClick={() => gerar.mutate()}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2 text-sm disabled:opacity-40">
              <RefreshCw className="w-4 h-4" />{t("entidade.convite.trocar")}
            </button>
            <button type="button" disabled={revogar.isPending} onClick={() => revogar.mutate()}
              className="inline-flex items-center gap-2 rounded-xl border border-red-400/30 text-red-200 px-3 py-2 text-sm disabled:opacity-40">
              <Trash2 className="w-4 h-4" />{t("entidade.convite.revogar")}
            </button>
          </div>
          <p className="text-xs text-white/45">{t("entidade.convite.trocarExplica")}</p>
        </div>
      ) : (
        <button type="button" disabled={!habilitado || gerar.isPending || convite.isLoading} onClick={() => gerar.mutate()}
          className="inline-flex items-center gap-2 rounded-xl bg-[#c98f70] text-black px-4 py-2 text-sm font-medium disabled:opacity-40">
          <Link2 className="w-4 h-4" />{t("entidade.convite.gerar")}
        </button>
      )}
    </section>
  );
}
