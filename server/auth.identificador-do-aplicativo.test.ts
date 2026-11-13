import { afterEach, describe, expect, it, vi } from "vitest";

// server/sessao.ts exige JWT_SECRET já na carga do módulo — vi.hoisted roda antes dos imports
vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

// A função saiu de server/auth.ts junto com a abertura da sessão (abrirSessao).
import { identificadorDoAplicativo } from "./sessao";

/**
 * O appId do JWT NUNCA pode sair vazio: `sdk.verifySession` derruba a sessão
 * inteira quando ele não é string não-vazia, e o sintoma não parece um
 * defeito de configuração — a pessoa loga, a sessão é gravada no banco, e no
 * request seguinte ela está deslogada.
 *
 * O caso que quebrou de verdade (Gabryel, #139) é o da string VAZIA, não o do
 * undefined: o `.env.example` traz `VITE_APP_ID=` em branco, o dotenv entrega
 * "", e `??` não cai no padrão com string vazia. Quem seguisse o README não
 * conseguia ficar logado em dev. Por isso o teste cobre "" e "   " junto com
 * undefined: trocar `||` por `??` de volta é uma letra.
 */

const original = process.env.VITE_APP_ID;

afterEach(() => {
  if (original === undefined) delete process.env.VITE_APP_ID;
  else process.env.VITE_APP_ID = original;
});

describe("identificadorDoAplicativo", () => {
  it("sem a variável definida, usa o padrão", () => {
    delete process.env.VITE_APP_ID;
    expect(identificadorDoAplicativo()).toBe("mmm-os");
  });

  it("com a variável VAZIA — o que o .env.example produz —, usa o padrão", () => {
    process.env.VITE_APP_ID = "";
    expect(identificadorDoAplicativo()).toBe("mmm-os");
  });

  it("com a variável só de espaços, usa o padrão", () => {
    process.env.VITE_APP_ID = "   ";
    expect(identificadorDoAplicativo()).toBe("mmm-os");
  });

  it("com valor de verdade, respeita o valor e tira os espaços da borda", () => {
    process.env.VITE_APP_ID = "  mmm-producao  ";
    expect(identificadorDoAplicativo()).toBe("mmm-producao");
  });

  it("em nenhum desses casos devolve algo que o sdk recusaria", () => {
    for (const valor of [undefined, "", "   ", "\t", "mmm-os"]) {
      if (valor === undefined) delete process.env.VITE_APP_ID;
      else process.env.VITE_APP_ID = valor;
      const appId = identificadorDoAplicativo();
      // A mesma condição de isNonEmptyString em server/_core/sdk.ts.
      expect(typeof appId === "string" && appId.length > 0).toBe(true);
    }
  });
});
