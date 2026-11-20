import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { toast } from "sonner";
import { CheckCircle, Link2, Users } from "lucide-react";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * Aba "Conexões registradas" do Painel Ouro — Meu Network Inteligente, spec da
 * Glenda de 14/09, itens 17 e 18: a rastreabilidade das conexões que podem
 * originar negócio, nas quatro origens, para a plataforma apurar comissão.
 *
 * A tela mostra o que `networkInteligente.admin.conexoes` devolve e nada além:
 * origem, etapas, status da comissão, o ID anônimo do contato e a conta que
 * responde por cada lado. A privacidade é da consulta (network-registro.ts,
 * listarTodasAsConexoes): nenhum nome, telefone ou e-mail de contato chega
 * aqui. Comissão é STATUS — nenhum percentual, valor ou cobrança —, e só depois
 * do fechamento: o servidor recusa antes, e a tela nem oferece o botão.
 *
 * Português fixo, como o resto do Painel Ouro.
 */

type ConexaoDaPlataforma = inferRouterOutputs<AppRouter>["networkInteligente"]["admin"]["conexoes"][number];
type Origem = ConexaoDaPlataforma["origem"];
type Etapa = ConexaoDaPlataforma["status"];
type StatusDeComissao = ConexaoDaPlataforma["statusComissao"];

const ROTULO_DA_ORIGEM: Record<Origem, string> = {
  PLATFORM_MATCH: "Entre membros da plataforma",
  NETWORK_PLATFORM_MATCH: "Network × membro da plataforma",
  PRIVATE_NETWORK_MATCH: "Dentro de um mesmo network",
  NETWORK_NETWORK_MATCH: "Network × outro network",
};

const ROTULO_DA_ETAPA: Record<Etapa, string> = {
  identificada: "Identificada",
  apresentacao: "Apresentação feita",
  negociacao: "Em negociação",
  fechada: "Negócio fechado",
  descartada: "Descartada",
};

const ROTULO_DA_COMISSAO: Record<StatusDeComissao, string> = {
  sem_negocio: "sem negócio",
  a_apurar: "a apurar",
  devida: "devida",
  nao_devida: "não devida",
};

/** O teto da consulta (listarTodasAsConexoes): a tela avisa quando chegou nele. */
const LIMITE_DA_LISTA = 200;

type Apuracao = {
  conexaoId: string;
  status: "a_apurar" | "devida" | "nao_devida";
  participanteId?: number;
  /** "da plataforma" ou "da originadora NW-…": o que o diálogo confirma. */
  deQuem: string;
};

const data = (momento: number | null | undefined) => (momento ? new Date(momento).toLocaleDateString("pt-BR") : null);

/** Os botões de apuração de UM status de comissão: só os que mudam alguma coisa. */
function BotoesDeApuracao({ atual, aoEscolher, desabilitado }: {
  atual: StatusDeComissao | null;
  aoEscolher: (status: Apuracao["status"]) => void;
  desabilitado: boolean;
}) {
  const opcoes: Array<{ status: Apuracao["status"]; rotulo: string }> = [
    { status: "devida", rotulo: "Comissão devida" },
    { status: "nao_devida", rotulo: "Comissão não devida" },
    { status: "a_apurar", rotulo: "Voltar para a apurar" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {opcoes
        .filter(opcao => opcao.status !== atual && (opcao.status !== "a_apurar" || atual === "devida" || atual === "nao_devida"))
        .map(opcao => (
          <Button key={opcao.status} type="button" size="sm" variant="outline" disabled={desabilitado}
            onClick={() => aoEscolher(opcao.status)}
            className="h-7 bg-transparent border-amber-400/30 text-amber-300 hover:bg-amber-400/10 text-[11px]">
            {opcao.rotulo}
          </Button>
        ))}
    </div>
  );
}

function CartaoDaConexao({ conexao, aoApurar, apurando }: {
  conexao: ConexaoDaPlataforma;
  aoApurar: (apuracao: Apuracao) => void;
  apurando: boolean;
}) {
  const fechada = conexao.status === "fechada";
  const etapas = [
    ["Registrada", data(conexao.createdAt)],
    ["Apresentação", data(conexao.apresentacaoEm)],
    ["Negociação", data(conexao.negociacaoEm)],
    ["Fechamento", data(conexao.fechamentoEm)],
    ["Descartada", data(conexao.descartadaEm)],
  ].filter((etapa): etapa is [string, string] => etapa[1] !== null);
  const itens = Array.isArray(conexao.itens) ? conexao.itens : [];

  return (
    <li className="rounded-2xl border border-white/8 bg-white/3 p-5 space-y-3" data-testid="conexao-registrada">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-amber-300">{ROTULO_DA_ORIGEM[conexao.origem] ?? conexao.origem}</span>
        <div className="flex flex-wrap gap-1.5">
          <Badge className="bg-white/5 text-white/70 border-white/15 text-[11px]">{ROTULO_DA_ETAPA[conexao.status] ?? conexao.status}</Badge>
          <Badge className="bg-amber-400/10 text-amber-300 border-amber-400/25 text-[11px]">
            Comissão da plataforma: {ROTULO_DA_COMISSAO[conexao.statusComissao] ?? conexao.statusComissao}
          </Badge>
          <Badge className="bg-white/5 text-white/50 border-white/10 text-[11px]">Nota {conexao.pontuacao}</Badge>
        </div>
      </div>

      <p className="text-sm text-white/70">{conexao.motivo}</p>
      {itens.length > 0 && (
        <ul className="space-y-0.5">
          {itens.map((item, indice) => (
            <li key={indice} className="text-xs text-white/50">Tem: {item.tem} · Precisa: {item.precisa}</li>
          ))}
        </ul>
      )}

      <ul className="grid gap-2 sm:grid-cols-2">
        {conexao.lados.map(lado => (
          <li key={lado.id} className="rounded-xl border border-white/8 bg-white/3 p-3 text-xs space-y-1.5">
            <p className="text-white/80">
              {lado.tipo === "contato"
                ? <>Contato <span className="font-mono text-amber-200">{lado.codigoAnonimo ?? "—"}</span> · network da conta {lado.conta ? `${lado.conta.nome ?? "sem nome"} (#${lado.conta.id})` : "removida"}</>
                : <>Membro da plataforma · conta {lado.conta ? `${lado.conta.nome ?? "sem nome"} (#${lado.conta.id})` : "removida"}</>}
            </p>
            {lado.originador && (
              <p className="text-white/50">
                Originadora · comissão: {lado.statusComissaoOriginador ? ROTULO_DA_COMISSAO[lado.statusComissaoOriginador] : "—"}
              </p>
            )}
            {fechada && lado.originador && (
              <BotoesDeApuracao
                atual={lado.statusComissaoOriginador}
                desabilitado={apurando}
                aoEscolher={status => aoApurar({
                  conexaoId: conexao.id, status, participanteId: lado.id,
                  deQuem: `da originadora ${lado.codigoAnonimo ?? `do lado ${lado.lado.toUpperCase()}`}`,
                })}
              />
            )}
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-white/35">{etapas.map(([rotulo, quando]) => `${rotulo} em ${quando}`).join(" · ")}</p>

      {fechada ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-[11px] text-white/40">Apuração da plataforma:</span>
          <BotoesDeApuracao
            atual={conexao.statusComissao}
            desabilitado={apurando}
            aoEscolher={status => aoApurar({ conexaoId: conexao.id, status, deQuem: "da plataforma" })}
          />
        </div>
      ) : (
        <p className="text-[11px] text-white/30">A comissão só é apurada depois do fechamento do negócio.</p>
      )}
    </li>
  );
}

export function ConexoesRegistradasDaPlataforma() {
  const [origem, setOrigem] = useState<Origem | "">("");
  const [etapa, setEtapa] = useState<Etapa | "">("");
  const [confirmando, setConfirmando] = useState<Apuracao | null>(null);

  const consulta = trpc.networkInteligente.admin.conexoes.useQuery({
    origem: origem || undefined,
    status: etapa || undefined,
  });
  const apurar = trpc.networkInteligente.admin.definirComissao.useMutation({
    onSuccess: () => {
      toast.success("Status da comissão registrado.");
      setConfirmando(null);
      void consulta.refetch();
    },
    onError: (erro) => {
      toast.error(erro.message);
      void consulta.refetch();
    },
  });

  const conexoes = consulta.data ?? [];
  const comFiltro = origem !== "" || etapa !== "";

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center flex-shrink-0">
          <Link2 size={18} className="text-amber-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">Conexões registradas</h2>
          <p className="text-sm text-white/40 mt-0.5">
            Toda conexão identificada pela plataforma, nas quatro origens, com as etapas e o status da comissão.
            Contatos aparecem só pelo ID anônimo.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs text-white/50">
          Origem
          <select value={origem} onChange={e => setOrigem(e.target.value as Origem | "")}
            className="rounded-lg border border-white/15 bg-[#1B1714] px-3 py-2 text-sm text-white">
            <option value="">Todas</option>
            {(Object.keys(ROTULO_DA_ORIGEM) as Origem[]).map(chave => <option key={chave} value={chave}>{ROTULO_DA_ORIGEM[chave]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-white/50">
          Etapa
          <select value={etapa} onChange={e => setEtapa(e.target.value as Etapa | "")}
            className="rounded-lg border border-white/15 bg-[#1B1714] px-3 py-2 text-sm text-white">
            <option value="">Todas</option>
            {(Object.keys(ROTULO_DA_ETAPA) as Etapa[]).map(chave => <option key={chave} value={chave}>{ROTULO_DA_ETAPA[chave]}</option>)}
          </select>
        </label>
      </div>

      {consulta.isLoading ? (
        <div className="space-y-3" aria-label="Carregando conexões">
          {[0, 1, 2].map(i => <div key={i} className="h-28 rounded-2xl bg-white/5 animate-pulse" />)}
        </div>
      ) : consulta.isError ? (
        // Consulta que falhou não é "nenhuma conexão": banco fora do ar é erro.
        <ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => void consulta.refetch()} />
      ) : conexoes.length === 0 ? (
        <div className="p-6 rounded-xl bg-white/3 border border-white/8 text-center text-white/30 text-sm">
          {comFiltro ? "Nenhuma conexão registrada com estes filtros." : "Nenhuma conexão registrada ainda."}
        </div>
      ) : (
        <>
          {conexoes.length >= LIMITE_DA_LISTA && (
            <p className="text-xs text-amber-300/80">Mostrando as {LIMITE_DA_LISTA} mais recentes — filtre por origem ou etapa para ver as outras.</p>
          )}
          <ul className="space-y-3">
            {conexoes.map(conexao => (
              <CartaoDaConexao key={conexao.id} conexao={conexao} aoApurar={setConfirmando} apurando={apurar.isPending} />
            ))}
          </ul>
        </>
      )}

      <div className="p-4 rounded-xl bg-amber-400/5 border border-amber-400/15 text-xs text-white/50 flex gap-2">
        <Users size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
        <span>
          A comissão é registrada como status, conforme as regras comerciais e contratuais da plataforma.
          Nenhum percentual, valor ou cobrança é aplicado automaticamente, e cada registro fica na auditoria.
        </span>
      </div>

      <Dialog open={!!confirmando} onOpenChange={aberto => { if (!aberto) setConfirmando(null); }}>
        <DialogContent className="bg-[#211e1b] border-amber-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-amber-400 flex items-center gap-2">
              <CheckCircle size={16} /> Confirmar a apuração
            </DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-sm text-white/60">
            Registrar a comissão <strong className="text-white">{confirmando?.deQuem}</strong> como{" "}
            <strong className="text-white">{confirmando ? ROTULO_DA_COMISSAO[confirmando.status] : ""}</strong>?
            A decisão fica no log de auditoria. Nenhum valor é cobrado.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmando(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-amber-400 hover:bg-amber-500 text-[#151312] font-bold"
              disabled={!confirmando || apurar.isPending}
              onClick={() => confirmando && apurar.mutate({
                conexaoId: confirmando.conexaoId,
                status: confirmando.status,
                ...(confirmando.participanteId !== undefined ? { participanteId: confirmando.participanteId } : {}),
              })}
            >
              {apurar.isPending ? "Registrando..." : "Confirmar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
