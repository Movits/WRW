import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { ArrowLeft, FileSearch, Link2, Lock } from "lucide-react";
import type { AppRouter } from "../../../server/routers";
import {
  COMPLEMENTO_DO_MOTIVO_MAX,
  COMPLEMENTO_DO_MOTIVO_MIN,
  MOTIVOS_DA_CONSULTA,
  RECUSAS_DA_CONSULTA,
  ROTULO_DO_MOTIVO,
  type MotivoDaConsulta,
} from "@shared/consulta-da-administracao";
import { falasComJuntadas, nomesComJuntadas, vozesNoTexto } from "@shared/vozes-no-texto";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Aba "Reuniões" do Painel Ouro (R1a): a consulta das reuniões gravadas pela
 * administração (admin e presidente; a aba nem aparece para Ouro sem cargo, e
 * o servidor recusa com FORBIDDEN). A lista e cada abertura ficam na
 * auditoria (server/consulta-da-administracao.ts). Abrir uma reunião pede o
 * motivo ANTES: o servidor grava a consulta e só então lê. A consulta só lê:
 * nenhum controle da dona (excluir, reprocessar, compartilhar, decidir itens,
 * nomear vozes) existe aqui. Sair da reunião e voltar pede o motivo de novo e
 * grava outra linha.
 *
 * Português fixo, como o resto do Painel Ouro.
 */

type Saida = inferRouterOutputs<AppRouter>["consultaDeReunioes"];
type ReuniaoNaLista = Saida["listar"]["reunioes"][number];
type ReuniaoAberta = Saida["abrir"];

const data = (momento: number) => new Date(momento).toLocaleDateString("pt-BR");
// O status da reunião (meetings.status) como o resto do painel fala; um valor
// que ainda não esteja aqui sai como veio, em vez de sumir.
const ROTULO_DO_STATUS: Record<string, string> = {
  draft: "Rascunho", recording: "Gravando", uploading: "Enviando", processing: "Processando",
  ready: "Pronta", failed: "Falhou", deleted: "Na lixeira",
};
const rotuloDoStatus = (status: string) => ROTULO_DO_STATUS[status] ?? status;
const rotuloDaVoz = (numero: number) => `Falante ${numero}`;

const ROTULO_DA_SECAO: Record<string, string> = {
  action: "Ação", focus: "Foco", task: "Tarefa", decision: "Decisão", blocker: "Impedimento", question: "Pergunta",
};

/** A recusa do servidor, em português: o código vira frase; o resto, a frase de sempre. */
function frasesDaRecusa(erro: unknown): string | null {
  const mensagem = (erro as { message?: string } | null)?.message;
  if (mensagem === RECUSAS_DA_CONSULTA.anteriorAoAviso) {
    return "Esta reunião foi gravada antes do aviso que anuncia a consulta da administração. Ela não pode ser consultada.";
  }
  if (mensagem === RECUSAS_DA_CONSULTA.naoEncontrada) return "Reunião não encontrada: ela foi excluída ou está na lixeira.";
  return null;
}

/** O modal do motivo: a categoria e o texto, obrigatórios, antes de qualquer leitura. */
function ModalDoMotivo({ reuniao, aoFechar, aoAbrir }: {
  reuniao: ReuniaoNaLista;
  aoFechar: () => void;
  aoAbrir: (aberta: ReuniaoAberta) => void;
}) {
  const [motivo, setMotivo] = useState<MotivoDaConsulta | "">("");
  const [complemento, setComplemento] = useState("");
  const abrir = trpc.consultaDeReunioes.abrir.useMutation({ onSuccess: aoAbrir });
  const tamanho = complemento.trim().length;
  const valido = motivo !== "" && tamanho >= COMPLEMENTO_DO_MOTIVO_MIN && tamanho <= COMPLEMENTO_DO_MOTIVO_MAX;
  const recusa = abrir.error ? frasesDaRecusa(abrir.error) ?? abrir.error.message : null;
  return (
    <Dialog open onOpenChange={aberto => { if (!aberto) aoFechar(); }}>
      <DialogContent className="bg-[#211e1b] border-white/10 text-white">
        <DialogHeader>
          <DialogTitle>Consultar “{reuniao.titulo}”</DialogTitle>
          <DialogDescription className="text-white/60">
            Esta consulta fica registrada com o seu nome, a data e o motivo. O dono da reunião vê a data da consulta.
          </DialogDescription>
        </DialogHeader>
        <form id="motivo-da-consulta" className="space-y-3" onSubmit={evento => {
          evento.preventDefault();
          if (valido && !abrir.isPending) abrir.mutate({ meetingId: reuniao.id, motivo: motivo as MotivoDaConsulta, complemento: complemento.trim() });
        }}>
          <label className="block text-sm">
            <span className="text-white/70">Motivo</span>
            <select value={motivo} onChange={evento => setMotivo(evento.target.value as MotivoDaConsulta | "")}
              className="mt-1 w-full rounded-lg bg-[#151312] border border-white/15 px-3 py-2 text-sm">
              <option value="">Escolha o motivo</option>
              {MOTIVOS_DA_CONSULTA.map(opcao => <option key={opcao} value={opcao}>{ROTULO_DO_MOTIVO[opcao]}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-white/70">Por que esta reunião (de {COMPLEMENTO_DO_MOTIVO_MIN} a {COMPLEMENTO_DO_MOTIVO_MAX} caracteres)</span>
            <textarea value={complemento} onChange={evento => setComplemento(evento.target.value)} maxLength={COMPLEMENTO_DO_MOTIVO_MAX} rows={4}
              className="mt-1 w-full rounded-lg bg-[#151312] border border-white/15 px-3 py-2 text-sm" />
          </label>
          {recusa && <p role="alert" className="text-sm text-red-300">{recusa}</p>}
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={aoFechar}>Cancelar</Button>
          <Button type="submit" form="motivo-da-consulta" disabled={!valido || abrir.isPending} className="bg-amber-400 hover:bg-amber-500 text-[#151312] font-bold">
            {abrir.isPending ? "Registrando…" : "Registrar e abrir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A reunião aberta, só para ler: resumo, transcrição e áudio. */
function ReuniaoNaConsulta({ reuniao, aoVoltar }: { reuniao: ReuniaoAberta; aoVoltar: () => void }) {
  const [aba, setAba] = useState<"resumo" | "transcricao">("resumo");
  // As vozes juntadas pela dona (H3c) aparecem como a principal, como na tela dela.
  const juntadas = reuniao.juntadas ?? {};
  const nomes = nomesComJuntadas(reuniao.vozes, juntadas, rotuloDaVoz);
  const falas = reuniao.transcricao ? falasComJuntadas(reuniao.transcricao.segmentos, juntadas) : [];
  const voz = (falante: string) => nomes[falante]?.trim() || (/^F\d+$/.test(falante) ? rotuloDaVoz(Number(falante.slice(1))) : falante);
  return (
    <section aria-label="Reunião em consulta" className="space-y-4">
      <button type="button" onClick={aoVoltar} className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white">
        <ArrowLeft size={14} aria-hidden="true" /> Voltar à lista
      </button>
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200/80">
        Consulta registrada. O áudio toca até {new Date(reuniao.passeDoAudioAte).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}; depois, abra a consulta de novo.
      </div>
      <header>
        <h2 className="text-lg font-bold">{reuniao.titulo}</h2>
        <p className="text-sm text-white/50">{data(reuniao.criadaEm)} · {reuniao.dona ?? "Conta sem nome"} · idioma {reuniao.idioma}</p>
      </header>
      {reuniao.gravacao ? (
        <div className="space-y-2">
          {reuniao.gravacao.partes.map(parte => (
            <audio key={parte.seq} controls preload="none" src={parte.url} className="w-full" aria-label={`Parte ${parte.seq + 1} da gravação`} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-white/50">{reuniao.gravacaoExpirada ? "O áudio já foi apagado (pela regra dos 30 dias de antes de 26/11/2026)." : reuniao.gravacaoSaindo ? "O áudio está saindo do armazenamento." : "Sem áudio guardado."}</p>
      )}
      <div role="tablist" className="flex gap-1 border-b border-white/10">
        {(["resumo", "transcricao"] as const).map(id => (
          <button key={id} role="tab" type="button" aria-selected={aba === id} onClick={() => setAba(id)}
            className={`min-h-11 px-4 text-sm border-b-2 ${aba === id ? "border-amber-400 text-amber-400" : "border-transparent text-white/50"}`}>
            {id === "resumo" ? "Resumo" : "Transcrição"}
          </button>
        ))}
      </div>
      {aba === "resumo" && (
        reuniao.resumo.itens.length ? (
          <ul className="space-y-2">
            {reuniao.resumo.itens.map((item, i) => (
              <li key={i} className="rounded-xl border border-white/8 p-3 text-sm">
                <Badge className="mr-2 bg-white/5 text-white/60 border-white/10">{ROTULO_DA_SECAO[item.section] ?? item.section}</Badge>
                {vozesNoTexto(item.text, nomes, rotuloDaVoz)}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-white/50">Esta reunião não tem resumo guardado.</p>
      )}
      {aba === "transcricao" && (
        reuniao.transcricao ? (
          falas.length ? (
            <ol className="space-y-2 text-sm">
              {falas.map((fala, i) => (
                <li key={i}><span className="font-semibold text-white/80">{voz(fala.falante)}:</span> <span className="text-white/70">{fala.texto}</span></li>
              ))}
            </ol>
          ) : <p className="text-sm text-white/70 whitespace-pre-wrap">{reuniao.transcricao.texto}</p>
        ) : <p className="text-sm text-white/50">Sem transcrição.</p>
      )}
    </section>
  );
}

export function ConsultaDeReunioesDaPlataforma() {
  const [busca, setBusca] = useState("");
  const [buscaAplicada, setBuscaAplicada] = useState("");
  const [comLinkAberto, setComLinkAberto] = useState(false);
  const [paginas, setPaginas] = useState<Array<{ criadaEm: number; id: string } | undefined>>([undefined]);
  const [escolhida, setEscolhida] = useState<ReuniaoNaLista | null>(null);
  const [aberta, setAberta] = useState<ReuniaoAberta | null>(null);
  const antes = paginas[paginas.length - 1];
  // Cada leitura da lista fica na auditoria: sem nova consulta ao focar a janela.
  const lista = trpc.consultaDeReunioes.listar.useQuery(
    { busca: buscaAplicada || undefined, comLinkAberto: comLinkAberto || undefined, antes },
    { refetchOnWindowFocus: false, retry: false },
  );

  if (aberta) return <ReuniaoNaConsulta reuniao={aberta} aoVoltar={() => setAberta(null)} />;

  return (
    <section aria-label="Consulta das reuniões" className="space-y-4">
      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm text-white/60">
        <p>Só a administração da plataforma (admin e presidência) consulta reuniões gravadas, e cada consulta pede o motivo antes de abrir. Reuniões gravadas antes de 23/11/2026 não podem ser consultadas.</p>
      </div>
      <form className="flex flex-wrap gap-2 items-center" onSubmit={evento => { evento.preventDefault(); setPaginas([undefined]); setBuscaAplicada(busca.trim()); }}>
        <input value={busca} onChange={evento => setBusca(evento.target.value)} maxLength={120} placeholder="Título, nome ou e-mail do dono"
          aria-label="Buscar reuniões" className="min-w-0 basis-full sm:basis-auto flex-1 rounded-lg bg-[#151312] border border-white/15 px-3 py-2 text-sm" />
        <Button type="submit" variant="outline" className="border-white/15">Buscar</Button>
        <label className="flex items-center gap-2 text-sm text-white/60">
          <input type="checkbox" checked={comLinkAberto} onChange={evento => { setPaginas([undefined]); setComLinkAberto(evento.target.checked); }} />
          Só com link aberto
        </label>
      </form>
      {lista.isError ? <ErroDeConsulta erro={lista.error} aoTentarDeNovo={() => lista.refetch()} />
        : lista.isLoading ? <p className="text-sm text-white/50">Carregando…</p>
        : !lista.data?.reunioes.length ? <p className="text-sm text-white/50">Nenhuma reunião encontrada.</p>
        : (
          <ul className="space-y-2">
            {lista.data.reunioes.map(reuniao => (
              <li key={reuniao.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{reuniao.titulo}</p>
                  <p className="text-xs text-white/50">{data(reuniao.criadaEm)} · {reuniao.dona ?? "Conta sem nome"} · {rotuloDoStatus(reuniao.status)}
                    {reuniao.linkLigado && <span className="inline-flex items-center gap-1 ml-2"><Link2 size={11} aria-hidden="true" /> link aberto</span>}
                  </p>
                </div>
                {reuniao.podeConsultar ? (
                  <Button size="sm" onClick={() => setEscolhida(reuniao)} className="bg-amber-400 hover:bg-amber-500 text-[#151312] font-bold">
                    <FileSearch size={14} className="mr-1" aria-hidden="true" /> Consultar
                  </Button>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-white/40"><Lock size={12} aria-hidden="true" /> Gravada antes do aviso</span>
                )}
              </li>
            ))}
          </ul>
        )}
      <div className="flex gap-2">
        {paginas.length > 1 && <Button variant="ghost" onClick={() => setPaginas(paginas.slice(0, -1))}>Anteriores</Button>}
        {lista.data?.proxima && <Button variant="ghost" onClick={() => setPaginas([...paginas, lista.data!.proxima!])}>Mais antigas</Button>}
      </div>
      {escolhida && <ModalDoMotivo reuniao={escolhida} aoFechar={() => setEscolhida(null)} aoAbrir={reuniao => { setEscolhida(null); setAberta(reuniao); }} />}
    </section>
  );
}
