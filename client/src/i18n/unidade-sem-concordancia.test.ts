import { describe, expect, it } from "vitest";
import ar from "./locales/ar.json";
import ru from "./locales/ru.json";

/**
 * As frases da G13b com {{horas}} e {{minutos}} em russo e árabe (revisão da
 * G13b). As duas línguas flexionam o substantivo pelo número: "до 12 часов" e
 * "حتى 12 ساعة" só estão certos com o 12 de hoje (em russo, 2 a 4 pedem
 * "часа"; em árabe, 3 a 10 pedem "ساعات"), e os minutos vêm de constantes que
 * podem mudar. A unidade abreviada não concorda com o número, como o "N h" do
 * português: "до {{horas}} ч", "حتى {{horas}} س", "{{minutos}} мин",
 * "{{minutos}} د".
 */

type Dicionario = Record<string, unknown>;

// As chaves da G13b (novas e mudadas) que levam número, as da H9a (o MP3 em
// partes) e as da H13 (os minutos do vídeo do YouTube que a IA transcreve).
// networkPanel.minutesLimitHelp saiu na G14: os minutos do envio único deixaram
// a frase, que agora diz só que o limite em horas vale também para o arquivo.
const CHAVES = [
  "smartNetwork.record.desc",
  "meetings.uploadLimit",
  "meetings.importTooLong",
  "meetings.youtube.dialogIntro",
  "meetings.youtube.notice",
  "meetings.youtube.firstHourNote",
  "networkPanel.hoursValue",
  "networkPanel.moreTimeUnavailable",
  "networkPanel.actionRecordDesc",
  "networkInteligente.dashboard.minutesLine",
];

const UNIDADE: Record<"ru" | "ar", Record<string, string>> = {
  ru: { horas: "ч", minutos: "мин", usados: "мин" },
  ar: { horas: "س", minutos: "د", usados: "د" },
};
const DICIONARIO: Record<"ru" | "ar", Dicionario> = { ru, ar };

function texto(dicionario: Dicionario, chave: string): string {
  const valor = chave.split(".").reduce<unknown>((no, parte) => (no as Dicionario | undefined)?.[parte], dicionario);
  if (typeof valor !== "string") throw new Error(`a chave ${chave} não existe`);
  return valor;
}

describe("russo e árabe — as horas e os minutos das frases da G13b sem concordância de número", () => {
  it.each(["ru", "ar"] as const)("%s: cada número vem com a unidade abreviada", idioma => {
    for (const chave of CHAVES) {
      const frase = texto(DICIONARIO[idioma], chave);
      let numeros = 0;
      for (const [variavel, unidade] of Object.entries(UNIDADE[idioma])) {
        for (const [, depois] of frase.matchAll(new RegExp(`\\{\\{${variavel}\\}\\}\\s*(\\S+)`, "g"))) {
          numeros++;
          // A pontuação que fecha a frase não faz parte da unidade.
          expect(depois.replace(/[.,،]$/, ""), `${idioma}: ${chave}`).toBe(unidade);
        }
      }
      // A chave tem número: a conferência acima não passou em branco.
      expect(numeros, `${idioma}: ${chave}`).toBeGreaterThan(0);
    }
  });
});
