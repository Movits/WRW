import { corteCancelado, crc32Ogg, LeitorEmJanela, limitesDoCorte, MontagemDaParte, recusa, u32le, type CorteDoArquivo, type LerBytes, type OpcoesDoCorte, type ParteCortada } from "./corte-comum";
import { amostrasOpus, escreverGranulo, etiquetasVazias, paginar } from "./paginas-do-ogg";
import { nivelDoOpus } from "./nivel-dos-quadros";
import { bitsPorMs, cortarNasPausas, partesDoCorte, SEM_PAUSAS } from "./pausas-do-corte";

/**
 * O corte do Ogg (H9b do plano do gravador): o áudio do WhatsApp (.ogg/.opus,
 * Opus), o do Firefox e o Ogg Vorbis. O Ogg é uma sequência de páginas, cada
 * uma com o número de série do fluxo, um número de sequência, o grânulo (a
 * posição em amostras do último pacote que termina nela) e um CRC-32.
 *
 * Cada parte é um Ogg completo e sozinho:
 * - as páginas de cabeçalho do codec, refeitas: o OpusHead (ou a identificação
 *   e o setup do Vorbis) do arquivo, e as etiquetas trocadas por uma vazia (o
 *   nome do programa fica; título, autor e capa ficam de fora);
 * - as páginas de áudio do trecho, com o miolo do próprio arquivo (File.slice)
 *   e o cabeçalho de 27 bytes refeito: a sequência renumerada, o grânulo
 *   menos o do fim da parte anterior (a parte começa no tempo 0), o fim do
 *   fluxo (EOS) na última página e o CRC-32 recalculado.
 * A parte só começa numa página que abre um pacote novo: o pacote que
 * atravessa páginas não se parte. Os fluxos que não são o áudio escolhido (o
 * vídeo do .ogv, o esqueleto) ficam de fora, e a página com o CRC errado também
 * (como no decodificador).
 *
 * A duração do Opus é a soma do TOC de cada pacote, a mesma conta do servidor
 * (server/duracao-do-audio.ts); a do Vorbis, a diferença dos grânulos (o
 * servidor lê o maior grânulo da parte). O fluxo cujo primeiro grânulo não é 0
 * (o trecho de uma transmissão) começa no primeiro som, nos dois codecs. O Opus
 * mantém o pre-skip do arquivo: cada parte descarta os mesmos ~6,5 ms do começo
 * que o arquivo descartava.
 */

const LIXO_TOLERADO = 2 * 1024 * 1024;
/** O maior pacote de cabeçalho aceito (as etiquetas do Opus podem trazer uma capa). */
const CABECALHO_MAXIMO = 16 * 1024 * 1024;

type Codec = "opus" | "vorbis";

type Pagina = { inicio: number; cabecalho: number; corpo: number; tipo: number; granulo: number; serial: number; lacos: number[]; bytes: Uint8Array };

/** O codec do pacote de identificação (o da página BOS), ou o nome do que não tem suporte. */
function codecDe(pacote: Uint8Array): { codec: Codec } | { semSuporte: string } | { video: true } | null {
  const texto = String.fromCharCode(...Array.from(pacote.subarray(0, 8)));
  if (texto === "OpusHead") return { codec: "opus" };
  if (texto.startsWith("\x01vorbis")) return { codec: "vorbis" };
  if (texto.startsWith("\x7fFLAC")) return { semSuporte: "FLAC (Ogg)" };
  if (texto === "Speex   ") return { semSuporte: "Speex" };
  if (texto.startsWith("\x80theora") || texto.startsWith("\x80daala") || texto.startsWith("\x01video")) return { video: true };
  return null;
}

/**
 * Corta o Ogg Opus ou Vorbis em partes de até 600 s e 14 MB (ver o comentário
 * do módulo), cada uma fechando numa pausa da fala quando há uma perto do teto
 * (lib/pausas-do-corte.ts). A parte só começa numa página que abre pacote, e a
 * pausa se mede pacote a pacote: no Opus, pela marca de voz
 * (lib/nivel-dos-quadros.ts); no Vorbis, pelo tamanho, com a duração da unidade
 * dividida entre os pacotes (só o silêncio digital vira pausa).
 */
export async function cortarOgg(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  return cortarNasPausas(o => cortarOggUmaVez(ler, tamanho, o), tamanho, opcoes, partesDoCorte);
}

async function cortarOggUmaVez(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte): Promise<CorteDoArquivo> {
  const pausas = opcoes.pausas ?? SEM_PAUSAS;
  const limites = limitesDoCorte(opcoes);
  if (opcoes.sinal?.aborted) throw corteCancelado();
  const janela = new LeitorEmJanela(ler, tamanho, opcoes);
  let pos = 0;
  let lixo = 0;
  let bytesDeAudio = 0;

  /** A próxima página íntegra (CRC conferido), pulando o que não é página; null no fim. */
  const proximaPagina = async (): Promise<Pagina | null | "lixo"> => {
    while (pos + 27 <= tamanho) {
      await janela.garantir(pos, pos + 27 + 255);
      if (janela.igual(pos, "OggS") && janela.b(pos + 4) === 0 && janela.b(pos + 26) >= 0) {
        const segmentos = janela.b(pos + 26);
        const lacos: number[] = [];
        let corpo = 0;
        for (let i = 0; i < segmentos; i++) {
          const laco = janela.b(pos + 27 + i);
          lacos.push(laco);
          corpo += laco;
        }
        const total = 27 + segmentos + corpo;
        if (lacos.every(l => l >= 0) && pos + total <= tamanho) {
          await janela.garantir(pos, pos + total);
          const bytes = janela.trecho(pos, pos + total);
          const lido = (bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24)) >>> 0;
          const crc = crc32Ogg(bytes, 26, total, crc32Ogg([0, 0, 0, 0], 0, 4, crc32Ogg(bytes, 0, 22)));
          if (crc === lido) {
            const baixo = janela.u32le(pos + 6);
            const alto = janela.u32le(pos + 10);
            const pagina: Pagina = {
              inicio: pos, cabecalho: 27 + segmentos, corpo, tipo: bytes[5], serial: janela.u32le(pos + 14), lacos, bytes,
              granulo: baixo === 0xffffffff && alto === 0xffffffff ? -1 : alto * 4294967296 + baixo,
            };
            pos += total;
            return pagina;
          }
        }
      }
      // Não é página (ou é uma página estragada): o lixo vai até o próximo "OggS".
      let proximo = pos + 1;
      for (;;) {
        const o = janela.procurar(0x4f, proximo);
        if (o < 0) { proximo = Math.max(proximo, janela.fim - 3); break; }
        if (janela.igual(o, "OggS") || janela.b(o + 3) < 0) { proximo = o; break; }
        proximo = o + 1;
      }
      lixo += proximo - pos;
      pos = proximo;
      if (lixo > Math.max(LIXO_TOLERADO, bytesDeAudio)) return "lixo";
    }
    return null;
  };

  // As páginas BOS do começo: um fluxo por página. Vale o primeiro Opus ou Vorbis.
  let escolhido: { serial: number; codec: Codec; identificacao: Uint8Array } | null = null;
  let semSuporte: string | null = null;
  let video = false;
  let pagina = await proximaPagina();
  while (pagina && pagina !== "lixo" && pagina.tipo & 2) {
    const tamanhoDoPacote = pagina.lacos.findIndex(l => l < 255);
    const fim = tamanhoDoPacote < 0 ? pagina.corpo : pagina.lacos.slice(0, tamanhoDoPacote + 1).reduce((s, l) => s + l, 0);
    const pacote = pagina.bytes.slice(pagina.cabecalho, pagina.cabecalho + fim);
    const tipo = codecDe(pacote);
    if (tipo && "codec" in tipo && !escolhido) escolhido = { serial: pagina.serial, codec: tipo.codec, identificacao: pacote };
    else if (tipo && "semSuporte" in tipo) semSuporte ??= tipo.semSuporte;
    else if (tipo && "video" in tipo) video = true;
    pagina = await proximaPagina();
  }
  if (pagina === "lixo") return recusa("DANIFICADO", "ogg");
  if (!escolhido) return semSuporte ? recusa("SEM_SUPORTE", "ogg", semSuporte) : recusa(video ? "SEM_AUDIO" : "DANIFICADO", "ogg");
  const { serial, codec } = escolhido;
  const taxa = codec === "opus" ? 48000 : (escolhido.identificacao[12] | (escolhido.identificacao[13] << 8) | (escolhido.identificacao[14] << 16) | (escolhido.identificacao[15] << 24)) >>> 0;
  if (codec === "vorbis" && !(taxa > 0)) return recusa("DANIFICADO", "ogg");
  // O bloco longo do Vorbis (o expoente nos 4 bits de cima do byte 28 da
  // identificação, de 6 a 13): cada pacote rende no máximo metade dele. Fora da
  // faixa, o maior (8.192), que mantém a conta como um teto.
  const expoenteDoBlocoLongo = (escolhido.identificacao[28] ?? 0) >> 4;
  const blocoLongoVorbis = expoenteDoBlocoLongo >= 6 && expoenteDoBlocoLongo <= 13 ? 1 << expoenteDoBlocoLongo : 8192;

  // Os outros pacotes de cabeçalho: as etiquetas (e o setup do Vorbis). O
  // último termina no fim de uma página, e o áudio começa na seguinte.
  const faltam = codec === "opus" ? 1 : 2;
  const cabecalhos: Uint8Array[] = [];
  let pedacos: Uint8Array[] = [];
  let tamanhoAberto = 0;
  while (cabecalhos.length < faltam) {
    if (!pagina || pagina === "lixo") return recusa("DANIFICADO", "ogg");
    if (pagina.serial === serial) {
      let p = pagina.cabecalho;
      for (let i = 0; i < pagina.lacos.length; i++) {
        if (cabecalhos.length >= faltam) return recusa("DANIFICADO", "ogg");
        const laco = pagina.lacos[i];
        pedacos.push(pagina.bytes.slice(p, p + laco));
        tamanhoAberto += laco;
        p += laco;
        if (tamanhoAberto > CABECALHO_MAXIMO) return recusa("DANIFICADO", "ogg");
        if (laco < 255) {
          const pacote = new Uint8Array(tamanhoAberto);
          let k = 0;
          for (const pedaco of pedacos) { pacote.set(pedaco, k); k += pedaco.length; }
          cabecalhos.push(pacote);
          pedacos = [];
          tamanhoAberto = 0;
        }
      }
    }
    pagina = await proximaPagina();
  }
  const pacotesDoCabecalho = codec === "opus"
    ? [escolhido.identificacao, etiquetasVazias("opus", cabecalhos[0])]
    : [escolhido.identificacao, etiquetasVazias("vorbis", cabecalhos[0]), cabecalhos[1]];
  // O Opus põe cada pacote de cabeçalho na sua página; o Vorbis, a identificação sozinha e os outros dois juntos.
  const primeira = paginar([pacotesDoCabecalho[0]], serial, 0, true);
  const resto = paginar(pacotesDoCabecalho.slice(1), serial, 1, false);
  const paginasDoCabecalho = Uint8Array.from([...Array.from(primeira.bytes), ...Array.from(resto.bytes)]);
  const quantasDoCabecalho = primeira.quantas + resto.quantas;

  // ─── As páginas de áudio ──────────────────────────────────────────────────
  /**
   * Uma página de áudio: as amostras Opus dos pacotes que terminam nela, quantos
   * terminam nela e, para achar a pausa, [amostras, bytes, primeiros bytes] de
   * cada pacote Opus e o tamanho de cada pacote Vorbis.
   */
  type DeAudio = { inicio: number; cabecalho: number; corpo: number; tipo: number; granulo: number; copia: Uint8Array; amostras: number; pacotes: number; pacotesOpus: Array<[number, number, number[]]>; pacotesVorbis: number[] };
  type EmMontagem = { montagem: MontagemDaParte; base: number; seq: number; amostras: number; bytes: number };
  const amostrasPorParte = limites.segundosPorParte * taxa;
  const amostrasNoTotal = limites.segundosNoTotal * taxa;
  const partes: ParteCortada[] = [];
  let parte: EmMontagem | null = null;
  let pendente: DeAudio | null = null;
  let granuloAnterior = 0;
  let primeiraUnidade = true;
  let amostrasNoArquivo = 0;
  // O pacote Opus aberto entre páginas: o TOC, o byte seguinte, o tamanho até aqui e os 5 primeiros bytes (a marca de voz).
  let aberto: { toc: number; segundo: number; tamanho: number; inicio: number[] } | null = null;
  // O tamanho do pacote Vorbis aberto entre páginas (só na leitura que acha as pausas).
  let vorbisAberto = 0;

  const emitir = (p: DeAudio, alvo: EmMontagem, fimDoFluxo: boolean) => {
    const h = p.copia.slice(0, p.cabecalho);
    h[5] = (p.tipo & 1) | (fimDoFluxo ? 4 : 0);
    escreverGranulo(h, p.granulo < 0 ? -1 : Math.max(0, p.granulo - alvo.base));
    h.set(u32le(alvo.seq++), 18);
    h.fill(0, 22, 26);
    h.set(u32le(crc32Ogg(p.copia, p.cabecalho, p.copia.length, crc32Ogg(h))), 22);
    alvo.montagem.novo(h);
    alvo.montagem.doArquivo(p.inicio + p.cabecalho, p.inicio + p.cabecalho + p.corpo);
  };

  const fechar = (alvo: EmMontagem) => {
    partes.push(alvo.montagem.fechar(Math.round((alvo.amostras / taxa) * 1000)));
  };

  /** Uma unidade (as páginas de uma que abre pacote novo até antes da seguinte que abre) entra numa parte. */
  const decidir = (unidade: DeAudio[]): "LONGO_DEMAIS" | "MUITAS_PARTES" | null => {
    const comGranulo = unidade.filter(p => p.granulo >= 0);
    const ultimoGranulo = comGranulo.length ? comGranulo[comGranulo.length - 1].granulo : granuloAnterior;
    const amostrasOpusDaUnidade = unidade.reduce((s, p) => s + p.amostras, 0);
    // O fluxo que não começa no 0 (um trecho de transmissão, gravado de um
    // Icecast): a primeira parte começa no primeiro som, e não leva o grânulo
    // inicial como duração. O Opus sabe as amostras de cada pacote pelo TOC; o
    // Vorbis, só o máximo (meio bloco longo por pacote), que tira um pouco a
    // menos do grânulo e nunca passa abaixo do 0.
    if (primeiraUnidade && codec === "opus") granuloAnterior = Math.max(0, ultimoGranulo - amostrasOpusDaUnidade);
    if (primeiraUnidade && codec === "vorbis") {
      const pacotesDaUnidade = unidade.reduce((s, p) => s + p.pacotes, 0);
      granuloAnterior = Math.max(0, ultimoGranulo - pacotesDaUnidade * (blocoLongoVorbis / 2));
    }
    primeiraUnidade = false;
    const amostras = codec === "opus" ? amostrasOpusDaUnidade : Math.max(0, ultimoGranulo - granuloAnterior);
    const bytes = unidade.reduce((s, p) => s + p.copia.length, 0);
    if (amostrasNoArquivo + amostras > amostrasNoTotal) return "LONGO_DEMAIS";
    if (parte && (parte.amostras + amostras > amostrasPorParte || parte.bytes + bytes > limites.bytesPorParte || pausas.antes((parte.amostras / taxa) * 1000, parte.bytes))) {
      emitir(pendente!, parte, true);
      fechar(parte);
      if (partes.length >= limites.partesNoMaximo) return "MUITAS_PARTES";
      parte = null;
      pendente = null;
    }
    if (!parte) {
      const montagem = new MontagemDaParte();
      montagem.novo(paginasDoCabecalho);
      parte = { montagem, base: granuloAnterior, seq: quantasDoCabecalho, amostras: 0, bytes: paginasDoCabecalho.length };
    } else if (pendente) emitir(pendente, parte, false);
    for (const p of unidade.slice(0, -1)) emitir(p, parte, false);
    pendente = unidade[unidade.length - 1];
    parte.amostras += amostras;
    parte.bytes += bytes;
    amostrasNoArquivo += amostras;
    granuloAnterior = ultimoGranulo;
    // A pausa: pacote a pacote (no Vorbis, com a duração da unidade dividida entre eles).
    const pacotesOpus = codec === "opus" && pausas.ouvindo ? unidade.flatMap(p => p.pacotesOpus) : [];
    if (pacotesOpus.length) pausas.depoisEmPedacos(bytes, pacotesOpus.map(([amostrasDoPacote, tamanhoDoPacote, inicioDoPacote]) => [(amostrasDoPacote / taxa) * 1000, nivelDoOpus(inicioDoPacote, tamanhoDoPacote, (amostrasDoPacote / taxa) * 1000)] as const));
    else if (codec === "vorbis" && pausas.ouvindo && unidade.some(p => p.pacotesVorbis.length)) {
      // O Vorbis não diz a duração de cada pacote sem o setup inteiro: a unidade se divide igual entre eles.
      const tamanhos = unidade.flatMap(p => p.pacotesVorbis);
      const ms = ((amostras / taxa) * 1000) / tamanhos.length;
      pausas.depoisEmPedacos(bytes, tamanhos.map(tamanhoDoPacote => [ms, bitsPorMs(tamanhoDoPacote, ms)] as const));
    } else pausas.depois((amostras / taxa) * 1000, bytes, bitsPorMs(bytes, (amostras / taxa) * 1000));
    return null;
  };

  /** A página BOS de um fluxo de áudio no meio do arquivo: o Ogg encadeado (outra gravação emendada), sem suporte. */
  const ehOutroAudio = (p: Pagina) => {
    if (!(p.tipo & 2)) return false;
    const tipo = codecDe(p.bytes.subarray(p.cabecalho, p.cabecalho + p.corpo));
    return !!tipo && !("video" in tipo);
  };

  let unidade: DeAudio[] = [];
  let fimDoFluxo = false;
  for (; pagina && pagina !== "lixo"; pagina = await proximaPagina()) {
    if (ehOutroAudio(pagina)) return recusa("SEM_SUPORTE", "ogg");
    if (pagina.serial !== serial || pagina.tipo & 2) continue;
    const continua = (pagina.tipo & 1) === 1;
    // A primeira página de áudio precisa abrir um pacote; a que só continua um pacote perdido fica de fora.
    if (continua && !unidade.length && primeiraUnidade) continue;
    if (!continua && unidade.length) {
      const motivo = decidir(unidade);
      if (motivo) return recusa(motivo, "ogg");
      unidade = [];
    }
    // As amostras dos pacotes Opus que terminam nesta página (e as de cada um, com o tamanho).
    let amostras = 0;
    const pacotesOpus: Array<[number, number, number[]]> = [];
    const pacotesVorbis: number[] = [];
    if (codec === "vorbis" && pausas.ouvindo) {
      if (!continua) vorbisAberto = 0;
      for (const laco of pagina.lacos) {
        vorbisAberto += laco;
        if (laco < 255) {
          pacotesVorbis.push(vorbisAberto);
          vorbisAberto = 0;
        }
      }
    }
    if (codec === "opus") {
      if (!continua) aberto = null;
      let p = pagina.cabecalho;
      for (const laco of pagina.lacos) {
        if (!aberto) aberto = { toc: laco > 0 ? pagina.bytes[p] : 0, segundo: laco > 1 ? pagina.bytes[p + 1] : -1, tamanho: 0, inicio: [] };
        else if (aberto.segundo < 0 && laco > 0) aberto.segundo = pagina.bytes[p];
        if (pausas.ouvindo) for (let k = 0; k < laco && aberto.inicio.length < 5; k++) aberto.inicio.push(pagina.bytes[p + k]);
        aberto.tamanho += laco;
        p += laco;
        if (laco < 255) {
          const amostrasDoPacote = amostrasOpus(aberto.toc, aberto.segundo, aberto.tamanho);
          amostras += amostrasDoPacote;
          pacotesOpus.push([amostrasDoPacote, aberto.tamanho, aberto.inicio]);
          aberto = null;
        }
      }
    }
    bytesDeAudio += pagina.bytes.length;
    // Cada laço menor que 255 fecha um pacote.
    const pacotes = pagina.lacos.reduce((s, laco) => s + (laco < 255 ? 1 : 0), 0);
    unidade.push({ inicio: pagina.inicio, cabecalho: pagina.cabecalho, corpo: pagina.corpo, tipo: pagina.tipo, granulo: pagina.granulo, copia: pagina.bytes.slice(), amostras, pacotes, pacotesOpus, pacotesVorbis });
    if (pagina.tipo & 4) {
      fimDoFluxo = true;
      break;
    }
  }
  if (pagina === "lixo") return recusa("DANIFICADO", "ogg");
  // Depois do fim deste fluxo, outra gravação emendada (o Ogg encadeado) não pode sumir em silêncio.
  if (fimDoFluxo) {
    const seguinte = await proximaPagina();
    if (seguinte && seguinte !== "lixo" && ehOutroAudio(seguinte)) return recusa("SEM_SUPORTE", "ogg");
  }
  if (unidade.length) {
    const motivo = decidir(unidade);
    if (motivo) return recusa(motivo, "ogg");
  }
  // O parte e o pendente mudam dentro do decidir, que o TypeScript não acompanha.
  const ultima = parte as EmMontagem | null;
  const ultimaPagina = pendente as DeAudio | null;
  if (!ultima || !ultimaPagina) return recusa("DANIFICADO", "ogg");
  emitir(ultimaPagina, ultima, true);
  fechar(ultima);
  if (!(amostrasNoArquivo > 0)) return recusa("DANIFICADO", "ogg");
  return { ok: true, formato: "ogg", mimeType: "audio/ogg", partes, duracaoMs: Math.round((amostrasNoArquivo / taxa) * 1000) };
}
