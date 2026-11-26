// A ponte entre o site e a casca: um script que roda na página antes do site e
// conversa com o app por mensagens (window.ReactNativeWebView.postMessage).
//
// - Microfone: antes de o site abrir o microfone, pede ao app. No Android, a
//   WebView só entrega o microfone se o app tiver a permissão RECORD_AUDIO do
//   sistema; sem ela, a trilha nasce encerrada, o site acha que o microfone caiu
//   e vai direto para "Transcrevendo" sem ter gravado nada (T41, 23/11).
// - Gravação: avisa ao app quando um MediaRecorder começa e termina, para a tela
//   não apagar durante a gravação e para o aviso do segundo plano no iPhone.
// - Diagnóstico: console.error, console.warn, erros soltos e o que acontece com
//   o microfone vão para o log do app (o terminal do `npx expo start`).
// - Rota e idioma: avisa ao app a página aberta (também quando o site troca de
//   rota sem recarregar) e o idioma e a direção do texto, para a barra de abas
//   marcar a aba certa e falar a língua do site.

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

/** O que o app injeta para responder ao pedido de microfone `id`. */
export function respostaDoMicrofone(id: number, liberado: boolean): string {
  return `window.__wrwRespostaDoMicrofone && window.__wrwRespostaDoMicrofone(${Number(id)}, ${liberado ? 'true' : 'false'}); true;`;
}

// Escrito em JavaScript antigo de propósito: roda como texto dentro da página,
// sem passar pelo Babel, e precisa valer em WebViews antigas. `pedeMicrofone`:
// só no Android o app pede o microfone antes; no iPhone, a WebView pede sozinha,
// e um passo a mais entre o toque e o pedido não ajuda.
export function scriptDaPonte(pedeMicrofone: boolean): string {
  return `
(function () {
  var PEDE_MICROFONE = ${pedeMicrofone ? 'true' : 'false'};
  if (window.__wrwPonte) return;
  window.__wrwPonte = true;

  function enviar(mensagem) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(mensagem)); } catch (e) {}
  }
  function texto(valor) {
    if (valor instanceof Error) return valor.stack || valor.message;
    if (typeof valor === 'string') return valor;
    try { return JSON.stringify(valor); } catch (e) { return String(valor); }
  }
  function log(nivel, mensagem) {
    enviar({ tipo: 'log', nivel: nivel, texto: String(mensagem).slice(0, 4000) });
  }

  ['error', 'warn'].forEach(function (nivel) {
    var original = console[nivel];
    console[nivel] = function () {
      try { log(nivel, Array.prototype.map.call(arguments, texto).join(' ')); } catch (e) {}
      return original.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (evento) {
    log('erro', (evento.message || 'erro') + ' em ' + (evento.filename || '?') + ':' + (evento.lineno || '?'));
  });
  window.addEventListener('unhandledrejection', function (evento) {
    log('promessa', texto(evento.reason));
  });

  log('info', 'ponte instalada em ' + location.pathname + ' | mediaDevices: ' + !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) + ' | MediaRecorder: ' + (typeof window.MediaRecorder) + ' | ' + navigator.userAgent);

  // A rota: o site troca de página pelo history (wouter) sem recarregar, e a
  // WebView nem sempre avisa o app disso. Vale o pushState, o replaceState, o
  // voltar (popstate) e a âncora.
  var ultimaRota = null;
  function avisarRota() {
    var caminho = location.pathname;
    if (caminho === ultimaRota) return;
    ultimaRota = caminho;
    enviar({ tipo: 'rota', caminho: caminho });
  }
  ['pushState', 'replaceState'].forEach(function (nome) {
    var original = window.history && window.history[nome];
    if (typeof original !== 'function') return;
    window.history[nome] = function () {
      var resultado = original.apply(this, arguments);
      try { avisarRota(); } catch (e) {}
      return resultado;
    };
  });
  window.addEventListener('popstate', avisarRota);
  window.addEventListener('hashchange', avisarRota);
  avisarRota();

  // O idioma: o site grava o idioma e a direção no <html> (lang e dir; o árabe
  // é RTL) quando carrega e quando a pessoa troca de idioma.
  var ultimoIdioma = null;
  function avisarIdioma() {
    var raiz = document.documentElement;
    if (!raiz) return;
    var lang = raiz.getAttribute('lang') || '';
    var dir = raiz.getAttribute('dir') || 'ltr';
    if (lang + '|' + dir === ultimoIdioma) return;
    ultimoIdioma = lang + '|' + dir;
    enviar({ tipo: 'idioma', lang: lang, dir: dir });
  }
  function vigiarIdioma() {
    var raiz = document.documentElement;
    if (!raiz) return;
    avisarIdioma();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(avisarIdioma).observe(raiz, { attributes: true, attributeFilter: ['lang', 'dir'] });
    }
  }
  if (document.documentElement) vigiarIdioma();
  else document.addEventListener('DOMContentLoaded', vigiarIdioma);

  var pedidos = {};
  var proximo = 0;
  window.__wrwRespostaDoMicrofone = function (id, liberado) {
    var resolver = pedidos[id];
    if (!resolver) return;
    delete pedidos[id];
    resolver(liberado);
  };
  function pedirMicrofoneAoApp() {
    return new Promise(function (resolver) {
      var id = ++proximo;
      pedidos[id] = resolver;
      enviar({ tipo: 'microfone', id: id });
      // Se o app não responder, segue e deixa a WebView decidir.
      setTimeout(function () { window.__wrwRespostaDoMicrofone(id, true); }, 60000);
    });
  }

  var dispositivos = navigator.mediaDevices;
  if (dispositivos && typeof dispositivos.getUserMedia === 'function') {
    var abrirOriginal = dispositivos.getUserMedia.bind(dispositivos);
    dispositivos.getUserMedia = function (restricoes) {
      var querAudio = !!(restricoes && restricoes.audio);
      log('info', 'o site pediu o microfone' + (querAudio && PEDE_MICROFONE ? '; perguntando ao app' : ''));
      var antes = querAudio && PEDE_MICROFONE ? pedirMicrofoneAoApp() : Promise.resolve(true);
      return antes.then(function (liberado) {
        log('info', 'resposta do app: ' + (liberado ? 'liberado' : 'negado') + '; abrindo o microfone no navegador');
        var esperando = setInterval(function () { log('warn', 'o navegador ainda não entregou o microfone'); }, 5000);
        var parar = function (valor) { clearInterval(esperando); return valor; };
        if (!liberado) {
          parar();
          log('warn', 'microfone negado no aparelho');
          throw new DOMException('O aparelho não liberou o microfone para a WRW.', 'NotAllowedError');
        }
        return abrirOriginal(restricoes).then(parar, function (erro) { parar(); throw erro; }).then(function (fluxo) {
          var trilhas = fluxo.getAudioTracks();
          log('info', 'microfone aberto: ' + trilhas.length + ' trilha(s)' + (trilhas[0] ? ', estado ' + trilhas[0].readyState + ', mudo ' + trilhas[0].muted : ''));
          trilhas.forEach(function (trilha) {
            trilha.addEventListener('ended', function () { log('warn', 'a trilha do microfone terminou'); });
          });
          return fluxo;
        }, function (erro) {
          log('erro', 'o microfone não abriu: ' + (erro && erro.name) + ' ' + (erro && erro.message));
          throw erro;
        });
      });
    };
  }

  if (typeof window.MediaRecorder === 'function') {
    var ativos = 0;
    var comecarOriginal = window.MediaRecorder.prototype.start;
    window.MediaRecorder.prototype.start = function () {
      var gravador = this;
      if (!gravador.__wrwVisto) {
        gravador.__wrwVisto = true;
        var bytes = 0;
        gravador.addEventListener('dataavailable', function (evento) { bytes += (evento.data && evento.data.size) || 0; });
        gravador.addEventListener('stop', function () {
          ativos = Math.max(0, ativos - 1);
          log('info', 'gravador parou: ' + bytes + ' bytes (' + (gravador.mimeType || 'sem tipo') + ')');
          enviar({ tipo: 'gravando', ativo: ativos > 0 });
        });
      }
      var resultado = comecarOriginal.apply(gravador, arguments);
      ativos += 1;
      log('info', 'gravador começou (' + (gravador.mimeType || 'sem tipo') + ')');
      enviar({ tipo: 'gravando', ativo: true });
      return resultado;
    };
  }
})();
true;
`;
}
