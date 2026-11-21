import { fimSemEtiquetas } from "./corte-do-mp3";
import { corteCancelado, LeitorEmJanela, limitesDoCorte, MontagemDaParte, recusa, type CorteDoArquivo, type LerBytes, type OpcoesDoCorte, type ParteCortada } from "./corte-comum";
import { nivelDoAac } from "./nivel-dos-quadros";
import { cortarNasPausas, partesDoCorte, SEM_PAUSAS } from "./pausas-do-corte";

/**
 * O corte do AAC em ADTS (H9b do plano do gravador): o .aac que gravadores e
 * celulares exportam. Cada quadro tem um cabeçalho de 7 bytes (9 com CRC) que
 * diz o tamanho do quadro inteiro e quantos blocos de 1.024 amostras ele leva,
 * e cada parte é uma sequência de quadros do próprio arquivo, sem recodificar,
 * como no MP3 (lib/corte-do-mp3.ts). O ADTS não tem relógio no contêiner:
 * cada parte já começa em 0. O servidor mede cada parte quadro a quadro
 * (server/duracao-do-audio.ts) e a manda ao Gemini como audio/aac.
 *
 * O ID3v2 do começo (ou entre os quadros) e o ID3v1/APEv2 do fim ficam de
 * fora. Depois de lixo, um quadro só vale com os dois seguintes do mesmo fluxo.
 */

const TAXAS_AAC = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** Tiques por segundo: o mínimo múltiplo comum das 13 taxas do AAC, para cada quadro durar um número inteiro deles. */
const TIQUES_POR_SEGUNDO = 28_224_000;
const TIQUES_POR_MS = TIQUES_POR_SEGUNDO / 1000;
/** A folga à frente da posição: três quadros (o maior tem 8.191 bytes) para a confirmação e o cabeçalho do ID3. */
const FOLGA = 32 * 1024;
/** O lixo tolerado antes do primeiro quadro, como no MP3. */
const LIXO_TOLERADO = 2 * 1024 * 1024;

type Quadro = { tamanho: number; tiques: number; fluxo: number };

function quadroEm(j: LeitorEmJanela, p: number): Quadro | null {
  const b1 = j.b(p + 1);
  const b2 = j.b(p + 2);
  const b3 = j.b(p + 3);
  const b4 = j.b(p + 4);
  const b5 = j.b(p + 5);
  const b6 = j.b(p + 6);
  // Sincronismo de 12 bits e a camada 00 (a do MP3 nunca é 00).
  if (j.b(p) !== 0xff || b6 < 0 || (b1 & 0xf6) !== 0xf0) return null;
  const indice = (b2 >> 2) & 0x0f;
  if (indice > 12) return null;
  const tamanho = ((b3 & 3) << 11) | (b4 << 3) | (b5 >> 5);
  if (tamanho <= (b1 & 1 ? 7 : 9)) return null;
  const blocos = (b6 & 3) + 1;
  // O mesmo fluxo: a versão, o perfil, a taxa e os canais (sem o bit privado).
  return { tamanho, tiques: 1024 * blocos * (TIQUES_POR_SEGUNDO / TAXAS_AAC[indice]), fluxo: ((b1 & 0x08) << 16) | ((b2 & 0xfd) << 8) | (b3 & 0xc0) };
}

/** O tamanho do ID3v2 que começa em `p`, ou null. */
function tamanhoDoId3(j: LeitorEmJanela, p: number): number | null {
  if (!j.igual(p, "ID3")) return null;
  const s = [j.b(p + 6), j.b(p + 7), j.b(p + 8), j.b(p + 9)];
  if (j.b(p + 3) === 0xff || j.b(p + 4) === 0xff || j.b(p + 5) < 0 || s.some(x => x < 0 || x & 0x80)) return null;
  return 10 + ((s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]) + (j.b(p + 5) & 0x10 ? 10 : 0);
}

function confirmado(j: LeitorEmJanela, p: number, q: Quadro, fimDoAudio: number) {
  let proximo = p + q.tamanho;
  for (let seguidos = 0; seguidos < 2; seguidos++) {
    if (proximo === fimDoAudio || tamanhoDoId3(j, proximo) !== null) return true;
    const r = quadroEm(j, proximo);
    if (!r || r.fluxo !== q.fluxo || proximo + r.tamanho > fimDoAudio) return false;
    proximo += r.tamanho;
  }
  return true;
}

/**
 * Corta o AAC em ADTS em partes de até 600 s e 14 MB (ver o comentário do
 * módulo), cada uma fechando numa pausa da fala quando há uma perto do teto
 * (lib/pausas-do-corte.ts), medida pelo passo do quantizador de cada quadro
 * (o global_gain, lib/nivel-dos-quadros.ts).
 */
export async function cortarAdts(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte = {}): Promise<CorteDoArquivo> {
  return cortarNasPausas(o => cortarAdtsUmaVez(ler, tamanho, o), tamanho, opcoes, partesDoCorte);
}

async function cortarAdtsUmaVez(ler: LerBytes, tamanho: number, opcoes: OpcoesDoCorte): Promise<CorteDoArquivo> {
  const pausas = opcoes.pausas ?? SEM_PAUSAS;
  const limites = limitesDoCorte(opcoes);
  const tiquesPorParte = limites.segundosPorParte * TIQUES_POR_SEGUNDO;
  const tiquesNoTotal = limites.segundosNoTotal * TIQUES_POR_SEGUNDO;
  if (opcoes.sinal?.aborted) throw corteCancelado();

  const fimDoAudio = await fimSemEtiquetas(ler, tamanho);
  const janela = new LeitorEmJanela(ler, tamanho, opcoes);
  const partes: ParteCortada[] = [];
  let atual: { montagem: MontagemDaParte; tiques: number } | null = null;
  let tiques = 0;
  let bytesDeAudio = 0;
  let lixo = 0;
  let anterior: Quadro | null = null;
  let pos = 0;

  while (pos < fimDoAudio) {
    await janela.garantir(pos, pos + 2 * FOLGA);
    const limite = janela.fim >= fimDoAudio ? fimDoAudio : janela.fim - FOLGA;
    while (pos < limite) {
      const id3 = tamanhoDoId3(janela, pos);
      if (id3 !== null) {
        pos += id3;
        anterior = null;
        continue;
      }
      const q = quadroEm(janela, pos);
      if (q && pos + q.tamanho <= fimDoAudio && ((anterior && anterior.fluxo === q.fluxo) || confirmado(janela, pos, q, fimDoAudio))) {
        anterior = q;
        if (tiques + q.tiques > tiquesNoTotal) return recusa("LONGO_DEMAIS", "aac");
        if (atual && (atual.tiques + q.tiques > tiquesPorParte || atual.montagem.bytes + q.tamanho > limites.bytesPorParte
          || pausas.antes(atual.tiques / TIQUES_POR_MS, atual.montagem.bytes))) {
          partes.push(atual.montagem.fechar(Math.round(atual.tiques / TIQUES_POR_MS)));
          if (partes.length >= limites.partesNoMaximo) return recusa("MUITAS_PARTES", "aac");
          atual = null;
        }
        atual ??= { montagem: new MontagemDaParte(), tiques: 0 };
        atual.montagem.doArquivo(pos, pos + q.tamanho);
        atual.tiques += q.tiques;
        tiques += q.tiques;
        bytesDeAudio += q.tamanho;
        // O bloco AAC começa depois do cabeçalho de 7 bytes (9 com o CRC, o bit de proteção em 0).
        pausas.depois(q.tiques / TIQUES_POR_MS, q.tamanho, pausas.ouvindo ? nivelDoAac(i => janela.b(i), pos + ((janela.b(pos + 1) & 1) ? 7 : 9), pos + q.tamanho) : 0);
        pos += q.tamanho;
        continue;
      }
      // Lixo até o próximo candidato: o 0xFF de um quadro ou o "I" de um ID3.
      anterior = null;
      const candidatos = [janela.procurar(0xff, pos + 1), janela.procurar(0x49, pos + 1)].filter(p => p >= 0);
      const proximo = candidatos.length ? Math.min(...candidatos) : -1;
      const ate = proximo < 0 || proximo > limite ? limite : proximo;
      lixo += ate - pos;
      pos = ate;
      if (lixo > Math.max(LIXO_TOLERADO, bytesDeAudio)) return recusa("DANIFICADO", "aac");
    }
  }
  if (atual) partes.push(atual.montagem.fechar(Math.round(atual.tiques / TIQUES_POR_MS)));
  if (!partes.length || lixo > bytesDeAudio) return recusa("DANIFICADO", "aac");
  if (partes.length > limites.partesNoMaximo) return recusa("MUITAS_PARTES", "aac");
  return { ok: true, formato: "aac", mimeType: "audio/aac", partes, duracaoMs: Math.round(tiques / TIQUES_POR_MS) };
}
