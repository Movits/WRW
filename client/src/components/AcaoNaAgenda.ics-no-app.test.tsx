import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const duble = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: duble.info, success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({ trpc: {} }));

import { baixarIcsOuAvisar } from "./AcaoNaAgenda";

/**
 * O .ics dentro do app das lojas (achado do T42, 26/11): a WebView da casca
 * não trata download, e o toque morria em silêncio. Lá, um aviso manda ao
 * navegador; no navegador, o download segue como antes.
 */
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; moto g82 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const CASCA_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; moto g82 5G; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 WRWApp/1.0";
const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
const t = (chave: string) => `texto:${chave}`;

let criar: ReturnType<typeof vi.fn>;
let clicou: ReturnType<typeof vi.fn>;

beforeEach(() => {
  duble.info.mockReset();
  criar = vi.fn(() => "blob:teste");
  // O jsdom não tem URL.createObjectURL nem revokeObjectURL.
  Object.assign(URL, { createObjectURL: criar, revokeObjectURL: vi.fn() });
  clicou = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(clicou);
});

afterEach(() => vi.restoreAllMocks());

describe("baixarIcsOuAvisar", () => {
  it("dentro do app das lojas, avisa para abrir no navegador e não baixa nada", () => {
    expect(baixarIcsOuAvisar(ICS, "reuniao.ics", t, CASCA_ANDROID)).toBe(false);
    expect(duble.info).toHaveBeenCalledWith("texto:agenda.card.icsInApp", expect.anything());
    expect(criar).not.toHaveBeenCalled();
    expect(clicou).not.toHaveBeenCalled();
  });

  it("no navegador, baixa o .ics como antes, sem aviso", () => {
    expect(baixarIcsOuAvisar(ICS, "reuniao.ics", t, CHROME_ANDROID)).toBe(true);
    expect(criar).toHaveBeenCalledTimes(1);
    expect(clicou).toHaveBeenCalledTimes(1);
    expect(duble.info).not.toHaveBeenCalled();
  });
});
