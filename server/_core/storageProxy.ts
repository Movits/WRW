// Serve os arquivos guardados no storage — /manus-storage/{chave} — com as duas
// perguntas que a versão anterior nunca fazia: QUEM é você, e este arquivo é
// SEU?
//
// A versão anterior redirecionava qualquer requisição, sem sessão, para a URL
// assinada. Documento de Deal Room sob NDA e RG do SIVC ficavam a um GET
// anônimo de distância: a chave na URL era a única proteção, e chave gravada em
// banco, colada em chat ou guardada em histórico não é segredo.
//
// A ordem das checagens importa:
//   1. sessão válida (senão 401) — anônimo não descobre nem se a chave existe
//   2. posse da chave (senão 403) — regra por prefixo, DENY por padrão
//   3. só então a URL assinada de 5 minutos, com 307
//
// As regras por prefixo espelham as políticas dos routers que criam cada tipo
// de arquivo — o proxy não inventa política, repete a que já existe no tRPC.

import type { Express } from "express";
import { eq } from "drizzle-orm";
import { sdk } from "./sdk";
import { exigirDb } from "../db";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel, MENSAGEM_BANCO_INDISPONIVEL } from "../banco-indisponivel";
import { dealRooms } from "../../drizzle/schema";
import { storageGetSignedUrl } from "../storage";

type Usuaria = { id: number; openId: string; role: string | null };
type Sala = { ownerId: number; interestedId: number } | null;
export type BuscarSala = (roomId: number) => Promise<Sala>;

// Mesma régua do dealRoom.ts: Ouro, presidente e admin acessam qualquer sala.
// Se a decisão de produto sobre a Deal Room mudar isso, muda lá e aqui junto.
const ehOuroOuAcima = (role?: string | null) =>
  role === "gold" || role === "president" || role === "admin";

/**
 * A chave pode ser baixada por esta usuária?
 *
 * Prefixos conhecidos e suas regras — qualquer coisa fora disto é NEGADA:
 *
 *   meetings/{openId}/...     só a dona da reunião (meeting-service.ts:219)
 *   contexts/{openId}/...     só a dona — fotos e documentos de contexto
 *                             (routers/contexts.ts, uploadMedia)
 *   contacts/{openId}/...     só a dona — foto e cartão de visita de um
 *                             contato privado (routers/network.ts, etapa 1)
 *   sivc/{userId}/...         só a dona dos documentos (sivc.ts:397)
 *   deal-rooms/{roomId}/...   partes da sala, ou Ouro+ (dealRoom.ts:306)
 *   generated/...             qualquer usuária logada — são imagens geradas
 *                             exibidas em listas públicas do app
 */
export async function podeBaixarChave(
  usuaria: Usuaria,
  chave: string,
  buscarSala: BuscarSala,
): Promise<boolean> {
  const partes = chave.split("/");

  if (partes[0] === "meetings") {
    return partes.length >= 2 && partes[1] === usuaria.openId;
  }

  if (partes[0] === "contexts") {
    return partes.length >= 2 && partes[1] === usuaria.openId;
  }

  if (partes[0] === "contacts") {
    return partes.length >= 2 && partes[1] === usuaria.openId;
  }

  if (partes[0] === "sivc") {
    return partes.length >= 2 && partes[1] === String(usuaria.id);
  }

  if (partes[0] === "deal-rooms") {
    const roomId = Number(partes[1]);
    if (!Number.isInteger(roomId) || roomId <= 0) return false;
    if (ehOuroOuAcima(usuaria.role)) return true;
    const sala = await buscarSala(roomId);
    if (!sala) return false;
    return sala.ownerId === usuaria.id || sala.interestedId === usuaria.id;
  }

  if (partes[0] === "generated") {
    return true; // já passou pela autenticação; imagem gerada não tem dona
  }

  // Prefixo desconhecido: negar. Um tipo novo de arquivo só passa a ser servido
  // quando alguém escrever a regra de posse dele aqui — nunca por omissão.
  return false;
}

// ─── Cache: a mesma URL assinada, e um cache curto no navegador ──────────────
//
// O problema que isto resolve é de DINHEIRO, e não de velocidade. Toda abertura
// de tela pedia ao proxy uma URL assinada NOVA — assinatura e data diferentes,
// logo URL diferente — e para o navegador URL diferente é arquivo diferente:
// ele baixava os mesmos bytes do bucket de novo. Com o Backblaze na conta
// gratuita (1 GB de download por dia), reabrir Minha Rede algumas vezes já
// consome a cota do dia.
//
// Duas medidas, nesta ordem de importância:
//
//   1. A MESMA URL por até 50 minutos (a assinatura vale 60), guardada em
//      memória por chave. Assim o cache do navegador reconhece o arquivo e não
//      o baixa de novo. Sem isto, a medida 2 não serve para nada.
//   2. Cache-Control: private, max-age=300 no 307, para a segunda abertura da
//      tela não precisar nem chegar ao proxy.
//
// O que NÃO muda: sessão e posse são conferidas em TODA requisição, antes de
// qualquer consulta ao cache. O cache guarda URL por chave, nunca por usuária,
// e nunca entrega uma URL a quem não passou pelas duas perguntas.
//
// O preço do `max-age=300`: por até 5 minutos o navegador pode repetir o
// redirecionamento sem voltar ao proxy, então uma perda de acesso nesse
// intervalo não é sentida naquele navegador. É `private` (nenhum cache
// compartilhado guarda) e vale só para os prefixos de baixo — arquivo sob NDA
// da Deal Room, documento do SIVC e áudio de reunião seguem com `no-store`.
//
// Por que só estes três prefixos: são as imagens que a tela pede em lista, de
// novo a cada abertura, e é onde a fatura dói. O áudio de reunião fica de fora
// por um segundo motivo — ele dura até 10 minutos, e reaproveitar uma URL com
// 11 minutos de vida restante poderia cortar a escuta no meio.
const PREFIXOS_COM_CACHE_NO_NAVEGADOR = new Set(["contacts", "contexts", "generated"]);

export const SEGUNDOS_DE_CACHE_NO_NAVEGADOR = 300;
export const MS_DE_REUSO_DA_URL = 50 * 60 * 1000;
/** Teto de chaves guardadas: ~500 entradas curtas, memória desprezível. */
export const TETO_DE_URLS_GUARDADAS = 500;

export type PoliticaDeCache = { reaproveitarUrl: boolean; cacheControl: string };

export function politicaDeCacheDaChave(chave: string): PoliticaDeCache {
  const prefixo = chave.split("/")[0];
  if (PREFIXOS_COM_CACHE_NO_NAVEGADOR.has(prefixo)) {
    return {
      reaproveitarUrl: true,
      cacheControl: `private, max-age=${SEGUNDOS_DE_CACHE_NO_NAVEGADOR}`,
    };
  }
  return { reaproveitarUrl: false, cacheControl: "no-store" };
}

export type CofreDeUrls = {
  obter(chave: string, politica: PoliticaDeCache): Promise<string>;
  limpar(): void;
  tamanho(): number;
};

/**
 * O cofre é criado por função (e não escrito solto no módulo) para o teste
 * poder trocar o assinador e o relógio. Em produção existe uma instância só.
 */
export function criarCofreDeUrls(
  assinar: (chave: string) => Promise<string>,
  relogio: () => number = Date.now,
  msDeReuso: number = MS_DE_REUSO_DA_URL,
  teto: number = TETO_DE_URLS_GUARDADAS,
): CofreDeUrls {
  const guardadas = new Map<string, { url: string; validaAte: number }>();
  return {
    async obter(chave, politica) {
      if (!politica.reaproveitarUrl) return assinar(chave);
      const agora = relogio();
      const guardada = guardadas.get(chave);
      if (guardada && guardada.validaAte > agora) return guardada.url;
      const url = await assinar(chave);
      // Reinserir move a chave para o fim da ordem do Map, que é a ordem de
      // inserção: a primeira chave é sempre a mais antiga, e é ela que sai.
      guardadas.delete(chave);
      while (guardadas.size >= teto) {
        const maisAntiga = guardadas.keys().next().value;
        if (maisAntiga === undefined) break;
        guardadas.delete(maisAntiga);
      }
      guardadas.set(chave, { url, validaAte: agora + msDeReuso });
      return url;
    },
    limpar() {
      guardadas.clear();
    },
    tamanho() {
      return guardadas.size;
    },
  };
}

const cofreDoProcesso = criarCofreDeUrls(storageGetSignedUrl);

async function buscarSalaNoBanco(roomId: number): Promise<Sala> {
  const db = await exigirDb();
  const [sala] = await db
    .select({ ownerId: dealRooms.ownerId, interestedId: dealRooms.interestedId })
    .from(dealRooms)
    .where(eq(dealRooms.id, roomId))
    .limit(1);
  return sala ?? null;
}

export function registerStorageProxy(app: Express, cofre: CofreDeUrls = cofreDoProcesso) {
  app.get("/manus-storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    // 1. Quem é você? Sem sessão não há resposta nenhuma sobre o arquivo.
    let usuaria: Usuaria;
    try {
      const autenticada = await sdk.authenticateRequest(req);
      usuaria = { id: autenticada.id, openId: autenticada.openId, role: autenticada.role };
    } catch (err) {
      // Banco fora do ar não é "sem sessão": 401 mandaria a usuária logada para
      // o login. Fora do tRPC não há middleware que traduza, então é aqui. Em
      // produção a queda chega como erro do driver, não como BancoIndisponivel.
      if (ehErroDeBancoIndisponivel(err)) {
        console.error(`[StorageProxy] banco indisponível ao ler a sessão: ${descreverErroDeBanco(err)}`);
        res.status(503).send(MENSAGEM_BANCO_INDISPONIVEL);
        return;
      }
      res.status(401).send("Não autenticado");
      return;
    }

    // 2. O arquivo é seu?
    try {
      if (!(await podeBaixarChave(usuaria, key, buscarSalaNoBanco))) {
        res.status(403).send("Sem acesso a este arquivo");
        return;
      }
    } catch (err) {
      if (ehErroDeBancoIndisponivel(err)) {
        console.error(`[StorageProxy] banco indisponível ao verificar a posse: ${descreverErroDeBanco(err)}`);
        res.status(503).send(MENSAGEM_BANCO_INDISPONIVEL);
        return;
      }
      console.error("[StorageProxy] verificação de posse falhou:", err);
      res.status(500).send("Erro ao verificar o acesso");
      return;
    }

    // 3. Só agora a URL assinada — reaproveitada, quando o prefixo permite.
    try {
      const politica = politicaDeCacheDaChave(key);
      const url = await cofre.obter(key, politica);
      res.set("Cache-Control", politica.cacheControl);
      res.redirect(307, url);
    } catch (err) {
      console.error("[StorageProxy] falhou:", err);
      res.status(503).send("Storage não configurado ou indisponível");
    }
  });
}
