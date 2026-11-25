import { slugDoTermo } from "@shared/direcao-do-termo";

/**
 * Quem possui o quê numa sugestão do motor privado (Conexões Inteligentes), para a TELA escrever a frase do motivo
 * no idioma dela.
 *
 * A rodada do motor escreve a frase em português (`reason_text`, em match-service.ts) e a guarda assim; a tela a
 * mostrava crua, e em árabe saía "Contato K3 Exportar possui Exportar café, que Contato K2 Importadora procura."
 * (conferência de tela do pacote do match, 20/11/2026). A frase continua gravada, como antes; o que vai à tela,
 * além dela, é o dado de que a frase é feita: de quem para quem, e o que um possui que o outro procura.
 *
 * O motor junta as razões por PAR e guarda os itens sem dizer de quem é cada um, então a direção se lê aqui: no par
 * de um sentido só, tudo é de quem possui (`contactAId`, como na frase do motor); no mútuo, cada item é de quem o tem
 * registrado em "o que possui". O item que nenhum dos dois tem mais (a rodada seguinte o tira) fica com o
 * `contactAId`, o lado da maior nota.
 */
export type DirecaoDoMotivo = { deId: number; paraId: number; possui: string[] };

type ItemGuardado = { slug: string; label: string };

/** Os itens como o motor os guardou (JSON): o rótulo, e o slug — refeito do rótulo na linha gravada sem ele. */
function itensGuardados(guardado: unknown): ItemGuardado[] {
  return (Array.isArray(guardado) ? guardado : [])
    .map(item => (item && typeof item === "object" ? item as { slug?: unknown; label?: unknown } : {}))
    .map(item => {
      const label = typeof item.label === "string" ? item.label : "";
      return { label, slug: typeof item.slug === "string" && item.slug ? item.slug : slugDoTermo(label) };
    })
    .filter(item => item.label);
}

export function direcoesDoMotivo(
  sugestao: { contactAId: number; contactBId: number; matchType: string; matchedAssets: unknown },
  slugsQueCadaContatoPossui: ReadonlyMap<number, ReadonlySet<string>>,
): DirecaoDoMotivo[] {
  const a = Number(sugestao.contactAId);
  const b = Number(sugestao.contactBId);
  const itens = itensGuardados(sugestao.matchedAssets);
  const deUmSentido = [{ deId: a, paraId: b, possui: itens.map(item => item.label) }];
  if (sugestao.matchType !== "mutual") return deUmSentido;

  const possuiA = slugsQueCadaContatoPossui.get(a);
  const possuiB = slugsQueCadaContatoPossui.get(b);
  const direcoes = [
    { deId: a, paraId: b, possui: itens.filter(item => possuiA?.has(item.slug) || !possuiB?.has(item.slug)).map(item => item.label) },
    { deId: b, paraId: a, possui: itens.filter(item => possuiB?.has(item.slug)).map(item => item.label) },
  ].filter(direcao => direcao.possui.length > 0);
  return direcoes.length ? direcoes : deUmSentido;
}

/** O que cada contato da dona tem em "o que possui", pelo slug (o mesmo que o motor compara). */
export function slugsPorContato(ativos: Array<{ contactId: number; slug: string | null; label: string }>) {
  const porContato = new Map<number, Set<string>>();
  for (const ativo of ativos) {
    const slug = ativo.slug || slugDoTermo(ativo.label);
    if (!slug) continue;
    const contato = Number(ativo.contactId);
    const slugs = porContato.get(contato) ?? new Set<string>();
    slugs.add(slug);
    porContato.set(contato, slugs);
  }
  return porContato;
}
