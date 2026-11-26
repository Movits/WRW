// As regras puras da ponte entre o site e o app (sem React Native), testadas
// pela suíte da raiz (server/ponte-do-app.test.ts): de onde a mensagem pode
// vir e o formato de cada tipo. O script que roda na página e a resposta ao
// pedido de microfone ficam em mobile/ponte.ts, que reexporta o que está aqui.

/** Mensagens que a página manda ao app. */
export type MensagemDaPagina =
  | { tipo: 'log'; nivel: string; texto: string }
  | { tipo: 'microfone'; id: number }
  | { tipo: 'gravando'; ativo: boolean }
  | { tipo: 'rota'; caminho: string }
  | { tipo: 'idioma'; lang: string; dir: string };

const HOSTS_DA_WRW = new Set(['wrwglobal.org', 'www.wrwglobal.org']);

/** A URL é de uma página da WRW (https, wrwglobal.org ou www.wrwglobal.org)? */
export function ehDaWrw(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && HOSTS_DA_WRW.has(hostname);
  } catch {
    return false;
  }
}

/** Texto curto: o que passa disso não é mensagem da ponte. */
function textoCurto(valor: unknown, maximo: number): valor is string {
  return typeof valor === 'string' && valor.length <= maximo;
}

/**
 * Lê a mensagem e confere o formato do tipo dela. Fora do formato (JSON
 * quebrado, tipo desconhecido, campo de outro tipo ou grande demais): null, e
 * o app não faz nada.
 */
export function lerMensagem(dados: string): MensagemDaPagina | null {
  let bruto: unknown;
  try {
    bruto = JSON.parse(dados);
  } catch {
    // Mensagem que não é nossa: ignora.
    return null;
  }
  if (!bruto || typeof bruto !== 'object') return null;
  const m = bruto as Record<string, unknown>;
  switch (m.tipo) {
    case 'log':
      return textoCurto(m.nivel, 20) && typeof m.texto === 'string'
        ? { tipo: 'log', nivel: m.nivel, texto: m.texto.slice(0, 4000) }
        : null;
    case 'microfone':
      return typeof m.id === 'number' && Number.isSafeInteger(m.id) && m.id >= 0 ? { tipo: 'microfone', id: m.id } : null;
    case 'gravando':
      return typeof m.ativo === 'boolean' ? { tipo: 'gravando', ativo: m.ativo } : null;
    case 'rota':
      return textoCurto(m.caminho, 2000) && m.caminho.startsWith('/') ? { tipo: 'rota', caminho: m.caminho } : null;
    case 'idioma':
      return textoCurto(m.lang, 35) && (m.dir === 'ltr' || m.dir === 'rtl' || m.dir === '')
        ? { tipo: 'idioma', lang: m.lang, dir: m.dir === 'rtl' ? 'rtl' : 'ltr' }
        : null;
    default:
      return null;
  }
}

/**
 * A mensagem que o app aceita: só a que veio de uma página da WRW (a URL que a
 * WebView diz ter mandado), e no formato do tipo dela. Um quadro de outro site
 * dentro da página, ou uma página de fora que a WebView abriu, não fala com o
 * app (ressalva da validação da #248).
 */
export function mensagemDaWrw(url: string | null | undefined, dados: string): MensagemDaPagina | null {
  if (!ehDaWrw(url)) return null;
  return lerMensagem(dados);
}
