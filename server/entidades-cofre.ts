import crypto from "node:crypto";
import { encryptData, decryptData } from "./security";
import { ERROS_DA_ENTIDADE } from "../shared/entidades";

/**
 * As chaves da base das associações (N1). Duas, e as duas obrigatórias, sem
 * derivar do JWT_SECRET (o `encryptData` deriva quando a do cofre falta; aqui
 * não se deixa):
 *
 * - ENTIDADES_HMAC_KEY: o HMAC-SHA256 do documento, para achar o repetido sem
 *   guardar o número em claro. Hash SEM chave não protege: o CNPJ é público, e
 *   bastaria calcular o hash de toda a base da Receita para desfazer a lista.
 * - VAULT_ENCRYPTION_KEY: cifra o documento e os contatos (AES-256-GCM, o
 *   mesmo cofre do resto do app), para a entidade vê-los de novo.
 *
 * Sem uma delas, a importação e a leitura do documento recusam com um código
 * (a tela traduz), e o resto do app segue no ar.
 */
export const TAMANHO_MINIMO_DAS_CHAVES = 32;

export class ChavesDaEntidadeAusentes extends Error {
  constructor() { super(ERROS_DA_ENTIDADE.chavesAusentes); }
}

export function chavesDaEntidadePresentes(ambiente: NodeJS.ProcessEnv = process.env): boolean {
  return (ambiente.ENTIDADES_HMAC_KEY ?? "").length >= TAMANHO_MINIMO_DAS_CHAVES
    && (ambiente.VAULT_ENCRYPTION_KEY ?? "").length >= TAMANHO_MINIMO_DAS_CHAVES;
}

export function exigirChavesDaEntidade(): void {
  if (!chavesDaEntidadePresentes()) throw new ChavesDaEntidadeAusentes();
}

/** O HMAC do documento já normalizado, com o país e o tipo (o mesmo número em dois países não colide). */
export function hmacDoDocumento(pais: string, tipo: string, valor: string): string {
  exigirChavesDaEntidade();
  return crypto.createHmac("sha256", process.env.ENTIDADES_HMAC_KEY as string)
    .update(`${pais}:${tipo}:${valor}`)
    .digest("hex");
}

export function cifrar(texto: string): string {
  exigirChavesDaEntidade();
  return encryptData(texto);
}

export function decifrar(cifrado: string): string {
  exigirChavesDaEntidade();
  return decryptData(cifrado);
}

/** O token do convite guardado como hash (o mesmo padrão do link aberto da reunião). */
export function hashDoConvite(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function gerarTokenDeConvite(): string {
  return crypto.randomBytes(24).toString("base64url");
}
