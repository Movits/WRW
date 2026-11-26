import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  ESTADOS_DO_CONVENIO, PAISES_DE_ENTIDADE, TIPOS_DE_ENTIDADE, ehErroDaEntidade,
  type EstadoDoConvenio, type TipoDeEntidade,
} from "@shared/entidades";

/**
 * A aba Entidades do painel administrativo (a base das associações, N1), em
 * pt-BR fixo como o resto do AdminPanel. A equipe transforma a conta que a
 * associação já criou em entidade e cuida do convênio. Vê só contagens:
 * nenhuma coluna de associado chega aqui (`entidades.admin.listar`).
 */

const ROTULO_DO_TIPO: Record<TipoDeEntidade, string> = {
  federacao: "Federação", associacao: "Associação", confederacao: "Confederação", sindicato: "Sindicato", outra: "Outra",
};
const ROTULO_DO_CONVENIO: Record<EstadoDoConvenio, string> = {
  em_negociacao: "Em negociação", ativo: "Ativo", encerrado: "Encerrado",
};
const MENSAGEM: Record<string, string> = {
  CONTA_NAO_ENCONTRADA: "Nenhuma conta com esse e-mail. A associação precisa criar a conta antes.",
  CONTA_DA_EQUIPE: "Conta da equipe (admin, presidência ou Ouro) não vira entidade.",
  CONTA_JA_EH_ENTIDADE: "Essa conta já é de uma entidade.",
  PAIS_SEM_DOCUMENTO: "Esse país ainda não tem o documento definido.",
  ENTIDADE_NAO_ENCONTRADA: "Entidade não encontrada.",
};

type Formulario = {
  id?: number; emailDaConta: string; nome: string; tipo: TipoDeEntidade; pais: string;
  convenioEstado: EstadoDoConvenio; convenioInicio: string; convenioFim: string; convenioReferencia: string;
  mostrarNomeNoMatch: boolean; disponivelPorPadrao: boolean;
};

const VAZIO: Formulario = {
  emailDaConta: "", nome: "", tipo: "associacao", pais: "BR", convenioEstado: "em_negociacao",
  convenioInicio: "", convenioFim: "", convenioReferencia: "", mostrarNomeNoMatch: false, disponivelPorPadrao: true,
};

const paraData = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");
const deData = (texto: string) => (texto ? Date.parse(`${texto}T00:00:00Z`) : null);

export function EntidadesAdmin() {
  const utils = trpc.useUtils();
  const lista = trpc.entidades.admin.listar.useQuery();
  const [formulario, setFormulario] = useState<Formulario | null>(null);
  const aoErrar = (e: { message: string }) => toast.error(ehErroDaEntidade(e.message) ? (MENSAGEM[e.message] ?? e.message) : e.message);
  const aoSalvar = () => { toast.success("Entidade salva."); setFormulario(null); void utils.entidades.admin.listar.invalidate(); };
  const criar = trpc.entidades.admin.criar.useMutation({ onSuccess: aoSalvar, onError: aoErrar });
  const atualizar = trpc.entidades.admin.atualizar.useMutation({ onSuccess: aoSalvar, onError: aoErrar });

  function salvar(f: Formulario) {
    const dados = {
      nome: f.nome, tipo: f.tipo, convenioEstado: f.convenioEstado,
      convenioInicio: deData(f.convenioInicio), convenioFim: deData(f.convenioFim),
      convenioReferencia: f.convenioReferencia.trim() || null,
      mostrarNomeNoMatch: f.mostrarNomeNoMatch, disponivelPorPadrao: f.disponivelPorPadrao,
    };
    if (f.id) atualizar.mutate({ id: f.id, ...dados });
    else criar.mutate({ ...dados, emailDaConta: f.emailDaConta, pais: f.pais });
  }

  const campo = "w-full bg-[#1B1714] border border-[#C98F70]/30 rounded-lg px-3 py-2 text-sm text-white";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Entidades</h2>
          <p className="text-sm text-gray-400">Federações, associações e sindicatos com convênio. A equipe vê só as contagens.</p>
        </div>
        <button type="button" onClick={() => setFormulario({ ...VAZIO })}
          className="px-4 py-2 text-sm bg-[#C98F70] text-[#1A120C] rounded-lg font-medium">Nova entidade</button>
      </div>

      {formulario && (
        <form className="grid gap-3 md:grid-cols-2 bg-[#1B1714]/60 border border-[#C98F70]/20 rounded-xl p-4"
          onSubmit={e => { e.preventDefault(); salvar(formulario); }}>
          {!formulario.id && (
            <label className="text-sm text-gray-300 md:col-span-2">E-mail da conta que a associação criou
              <input required type="email" className={campo} value={formulario.emailDaConta}
                onChange={e => setFormulario({ ...formulario, emailDaConta: e.target.value })} />
            </label>
          )}
          <label className="text-sm text-gray-300">Nome
            <input required minLength={2} maxLength={200} className={campo} value={formulario.nome}
              onChange={e => setFormulario({ ...formulario, nome: e.target.value })} />
          </label>
          <label className="text-sm text-gray-300">Tipo
            <select className={campo} value={formulario.tipo} onChange={e => setFormulario({ ...formulario, tipo: e.target.value as TipoDeEntidade })}>
              {TIPOS_DE_ENTIDADE.map(t => <option key={t} value={t}>{ROTULO_DO_TIPO[t]}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-300">País (define o documento: BR = CNPJ, MZ = NUIT)
            <select className={campo} value={formulario.pais} disabled={Boolean(formulario.id)}
              onChange={e => setFormulario({ ...formulario, pais: e.target.value })}>
              {PAISES_DE_ENTIDADE.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-300">Convênio
            <select className={campo} value={formulario.convenioEstado}
              onChange={e => setFormulario({ ...formulario, convenioEstado: e.target.value as EstadoDoConvenio })}>
              {ESTADOS_DO_CONVENIO.map(c => <option key={c} value={c}>{ROTULO_DO_CONVENIO[c]}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-300">Início do convênio
            <input type="date" className={campo} value={formulario.convenioInicio}
              onChange={e => setFormulario({ ...formulario, convenioInicio: e.target.value })} />
          </label>
          <label className="text-sm text-gray-300">Fim do convênio
            <input type="date" className={campo} value={formulario.convenioFim}
              onChange={e => setFormulario({ ...formulario, convenioFim: e.target.value })} />
          </label>
          <label className="text-sm text-gray-300 md:col-span-2">Referência do convênio
            <input maxLength={120} className={campo} value={formulario.convenioReferencia}
              onChange={e => setFormulario({ ...formulario, convenioReferencia: e.target.value })} />
          </label>
          <label className="text-sm text-gray-300 flex items-center gap-2">
            <input type="checkbox" checked={formulario.disponivelPorPadrao}
              onChange={e => setFormulario({ ...formulario, disponivelPorPadrao: e.target.checked })} />
            Associados entram disponíveis para a rede
          </label>
          <label className="text-sm text-gray-300 flex items-center gap-2">
            <input type="checkbox" checked={formulario.mostrarNomeNoMatch}
              onChange={e => setFormulario({ ...formulario, mostrarNomeNoMatch: e.target.checked })} />
            O convênio autoriza "membro da entidade" no match
          </label>
          <div className="md:col-span-2 flex gap-2">
            <button type="submit" disabled={criar.isPending || atualizar.isPending}
              className="px-4 py-2 text-sm bg-[#C98F70] text-[#1A120C] rounded-lg font-medium disabled:opacity-50">Salvar</button>
            <button type="button" onClick={() => setFormulario(null)} className="px-4 py-2 text-sm border border-white/15 rounded-lg text-gray-300">Cancelar</button>
          </div>
        </form>
      )}

      {lista.error && <p role="alert" className="text-sm text-red-300">{lista.error.message}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left text-gray-300">
          <thead className="text-xs text-gray-500 uppercase">
            <tr><th className="py-2 pr-4">Entidade</th><th className="py-2 pr-4">País</th><th className="py-2 pr-4">Convênio</th><th className="py-2 pr-4">Associados</th><th className="py-2 pr-4">Conta</th><th /></tr>
          </thead>
          <tbody>
            {lista.data?.map(e => (
              <tr key={e.id} className="border-t border-white/5">
                <td className="py-2 pr-4 text-white">{e.nome}<span className="block text-xs text-gray-500">{ROTULO_DO_TIPO[e.tipo as TipoDeEntidade] ?? e.tipo}</span></td>
                <td className="py-2 pr-4">{e.pais}</td>
                <td className="py-2 pr-4">{ROTULO_DO_CONVENIO[e.convenioEstado as EstadoDoConvenio] ?? e.convenioEstado}{e.convenioFim ? ` até ${paraData(e.convenioFim)}` : ""}</td>
                <td className="py-2 pr-4">{e.importados} importados · {e.ativados} ativados</td>
                <td className="py-2 pr-4 break-all">{e.contaEmail}</td>
                <td className="py-2">
                  <button type="button" className="text-xs text-[#C98F70]" onClick={() => setFormulario({
                    id: e.id, emailDaConta: "", nome: e.nome, tipo: e.tipo as TipoDeEntidade, pais: e.pais,
                    convenioEstado: e.convenioEstado as EstadoDoConvenio, convenioInicio: paraData(e.convenioInicio),
                    convenioFim: paraData(e.convenioFim), convenioReferencia: e.convenioReferencia ?? "",
                    mostrarNomeNoMatch: e.mostrarNomeNoMatch, disponivelPorPadrao: e.disponivelPorPadrao,
                  })}>Editar</button>
                </td>
              </tr>
            ))}
            {lista.data && !lista.data.length && <tr><td colSpan={6} className="py-4 text-gray-500">Nenhuma entidade ainda.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
