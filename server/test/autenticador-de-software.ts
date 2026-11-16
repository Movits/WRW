import crypto from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * Um autenticador de software, só para os testes das chaves de acesso
 * (server/chaves-de-acesso.ts). Ele faz o que o aparelho faz, sem aparelho: gera
 * um par de chaves ES256 (P-256) no próprio teste, responde ao cadastro com o
 * atestado "none" e à entrada com a asserção assinada pela chave privada dele.
 * A conferência do servidor (a @simplewebauthn/server) roda de verdade sobre
 * essas respostas. Cada campo que o servidor confere pode ser trocado por
 * parâmetro, para o teste provar a recusa: a origem, o domínio, o desafio, o
 * tipo, o contador, o identificador da conta e a verificação da pessoa.
 */

export type ConfiguracaoDoAutenticador = {
  /** A origem que o navegador escreveria no clientDataJSON. */
  origem: string;
  /** O RP ID cujo hash vai nos dados do autenticador. Padrão: o das opções. */
  rpId?: string;
  /** A chave fica numa cópia sincronizada (iCloud, Google): os bits BE e BS. */
  sincronizada?: boolean;
  /**
   * Com valor, o autenticador CONTA os usos (como uma chave física): cada
   * entrada soma 1 e assina o novo valor. Sem valor, ele não conta (como as
   * chaves sincronizadas da Apple e do Google): assina sempre zero.
   */
  contadorInicial?: number;
};

/** O que o teste pode trocar numa resposta, para provar que o servidor recusa. */
export type Desvios = {
  origem?: string;
  rpId?: string;
  desafio?: string;
  tipo?: string;
  /** O contador que vai assinado nesta resposta (na entrada). */
  contador?: number;
  /** A pessoa não foi verificada pelo aparelho (sem o bit UV). */
  semVerificarAPessoa?: boolean;
  /** O identificador da conta devolvido na entrada; null tira o campo. */
  identificadorDaConta?: string | null;
};

const BIT_UP = 0x01;
const BIT_UV = 0x04;
const BIT_BE = 0x08;
const BIT_BS = 0x10;
const BIT_AT = 0x40;

const sha256 = (dados: Uint8Array) => new Uint8Array(crypto.createHash("sha256").update(dados).digest());
const texto = (valor: string) => new Uint8Array(Buffer.from(valor, "utf8"));
const b64 = (bytes: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(bytes));

function juntar(...partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((soma, parte) => soma + parte.length, 0);
  const saida = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) {
    saida.set(parte, posicao);
    posicao += parte.length;
  }
  return saida;
}

function inteiro(valor: number, bytes: 2 | 4): Uint8Array {
  const saida = new Uint8Array(bytes);
  const visao = new DataView(saida.buffer);
  if (bytes === 2) visao.setUint16(0, valor);
  else visao.setUint32(0, valor);
  return saida;
}

export function criarAutenticador(configuracao: ConfiguracaoDoAutenticador) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const idDaCredencial = new Uint8Array(crypto.randomBytes(32));
  const credencialId = b64(idDaCredencial);
  // A chave pública no formato COSE: kty EC2 (2), alg ES256 (-7), crv P-256 (1), x e y.
  const chavePublicaCose = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, isoBase64URL.toBuffer(jwk.x)],
    [-3, isoBase64URL.toBuffer(jwk.y)],
  ]));
  const contaUsos = configuracao.contadorInicial !== undefined;
  let contador = configuracao.contadorInicial ?? 0;
  /** O identificador da conta que o servidor mandou no cadastro (user.id das opções). */
  let identificadorDaConta: string | null = null;

  const bandeiras = (desvios: Desvios, extra: number) =>
    BIT_UP
    | (desvios.semVerificarAPessoa ? 0 : BIT_UV)
    | (configuracao.sincronizada ? BIT_BE | BIT_BS : 0)
    | extra;

  const dadosDoCliente = (tipo: string, desafio: string, desvios: Desvios) =>
    texto(JSON.stringify({ type: desvios.tipo ?? tipo, challenge: desvios.desafio ?? desafio, origin: desvios.origem ?? configuracao.origem, crossOrigin: false }));

  return {
    /** O id da credencial em base64url, como o servidor o guarda. */
    credencialId,

    /** O identificador da conta guardado no cadastro (nulo antes dele). */
    get identificadorDaConta() {
      return identificadorDaConta;
    },

    /** A resposta de `navigator.credentials.create()`, com o atestado "none". */
    criar(opcoes: PublicKeyCredentialCreationOptionsJSON, desvios: Desvios = {}): RegistrationResponseJSON {
      identificadorDaConta = opcoes.user.id;
      const rpId = desvios.rpId ?? configuracao.rpId ?? opcoes.rp.id ?? "";
      const dadosDoAutenticador = juntar(
        sha256(texto(rpId)),
        Uint8Array.of(bandeiras(desvios, BIT_AT)),
        inteiro(contador, 4),
        new Uint8Array(16), // AAGUID zerado: "não sei dizer o modelo"
        inteiro(idDaCredencial.length, 2),
        idDaCredencial,
        chavePublicaCose,
      );
      const atestado = isoCBOR.encode(new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", dadosDoAutenticador],
      ]) as Parameters<typeof isoCBOR.encode>[0]);
      return {
        id: credencialId,
        rawId: credencialId,
        type: "public-key",
        response: {
          clientDataJSON: b64(dadosDoCliente("webauthn.create", opcoes.challenge, desvios)),
          attestationObject: b64(atestado),
          transports: ["internal", "hybrid"],
        },
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
      };
    },

    /** A resposta de `navigator.credentials.get()`: a asserção assinada com a chave privada. */
    obter(opcoes: PublicKeyCredentialRequestOptionsJSON, desvios: Desvios = {}): AuthenticationResponseJSON {
      const rpId = desvios.rpId ?? configuracao.rpId ?? opcoes.rpId ?? "";
      let usado = 0;
      if (desvios.contador !== undefined) usado = desvios.contador;
      else if (contaUsos) usado = ++contador;
      const dadosDoAutenticador = juntar(sha256(texto(rpId)), Uint8Array.of(bandeiras(desvios, 0)), inteiro(usado, 4));
      const cliente = dadosDoCliente("webauthn.get", opcoes.challenge, desvios);
      const assinatura = crypto.sign("sha256", juntar(dadosDoAutenticador, sha256(cliente)), privateKey);
      const identificador = desvios.identificadorDaConta === undefined ? identificadorDaConta : desvios.identificadorDaConta;
      return {
        id: credencialId,
        rawId: credencialId,
        type: "public-key",
        response: {
          clientDataJSON: b64(cliente),
          authenticatorData: b64(dadosDoAutenticador),
          signature: b64(new Uint8Array(assinatura)),
          ...(identificador ? { userHandle: identificador } : {}),
        },
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
      };
    },
  };
}

export type AutenticadorDeSoftware = ReturnType<typeof criarAutenticador>;
