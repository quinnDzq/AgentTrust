/** Original AgentTrust pixel portraits on a 16 × 16 grid. */

import type { AgentKey } from './types.ts';

interface SpriteArt {
  /** Read aloud by a screen reader in place of the drawing. */
  readonly label: string;
  /** The `<rect>` list, on a 16x16 viewBox. */
  readonly rects: string;
}

const ART: { readonly [K in AgentKey]: SpriteArt } = {
  pip: {
    label: "Pip, pigeon courier",
    rects:
      "<rect x=\"4\" y=\"15\" width=\"8\" height=\"1\" fill=\"#231F2B\" opacity=\".3\"/><rect x=\"2\" y=\"11\" width=\"2\" height=\"2\" fill=\"#6E7B95\"/><rect x=\"4\" y=\"6\" width=\"8\" height=\"7\" fill=\"#8E9BB3\"/><rect x=\"3\" y=\"8\" width=\"4\" height=\"4\" fill=\"#6E7B95\"/><rect x=\"5\" y=\"2\" width=\"6\" height=\"5\" fill=\"#8E9BB3\"/><rect x=\"5\" y=\"6\" width=\"6\" height=\"1\" fill=\"#5FA89A\"/><rect x=\"5\" y=\"1\" width=\"5\" height=\"2\" fill=\"#D9603B\"/><rect x=\"10\" y=\"2\" width=\"2\" height=\"1\" fill=\"#B24A2C\"/><rect x=\"8\" y=\"3\" width=\"2\" height=\"2\" fill=\"#FFF\"/><rect x=\"9\" y=\"4\" width=\"1\" height=\"1\" fill=\"#231F2B\"/><rect x=\"11\" y=\"4\" width=\"2\" height=\"1\" fill=\"#E8A23A\"/><rect x=\"6\" y=\"7\" width=\"1\" height=\"5\" fill=\"#7A4B2A\"/><rect x=\"9\" y=\"9\" width=\"4\" height=\"3\" fill=\"#A0683C\"/><rect x=\"10\" y=\"8\" width=\"2\" height=\"1\" fill=\"#F6EEDC\"/><rect x=\"9\" y=\"9\" width=\"4\" height=\"1\" fill=\"#7A4B2A\"/><rect x=\"6\" y=\"13\" width=\"1\" height=\"2\" fill=\"#E8A23A\"/><rect x=\"9\" y=\"13\" width=\"1\" height=\"2\" fill=\"#E8A23A\"/>",
  },
  mochi: {
    label: "Mochi, capybara negotiator",
    rects:
      "<rect x=\"3\" y=\"15\" width=\"10\" height=\"1\" fill=\"#231F2B\" opacity=\".3\"/><rect x=\"2\" y=\"6\" width=\"11\" height=\"7\" fill=\"#A9774E\"/><rect x=\"3\" y=\"11\" width=\"9\" height=\"2\" fill=\"#8C5F3B\"/><rect x=\"3\" y=\"13\" width=\"2\" height=\"2\" fill=\"#8C5F3B\"/><rect x=\"10\" y=\"13\" width=\"2\" height=\"2\" fill=\"#8C5F3B\"/><rect x=\"8\" y=\"3\" width=\"7\" height=\"6\" fill=\"#A9774E\"/><rect x=\"12\" y=\"5\" width=\"3\" height=\"4\" fill=\"#8C5F3B\"/><rect x=\"14\" y=\"6\" width=\"1\" height=\"1\" fill=\"#231F2B\"/><rect x=\"9\" y=\"2\" width=\"2\" height=\"2\" fill=\"#8C5F3B\"/><rect x=\"11\" y=\"4\" width=\"1\" height=\"1\" fill=\"#231F2B\"/><rect x=\"8\" y=\"9\" width=\"4\" height=\"1\" fill=\"#F6EEDC\"/><rect x=\"9\" y=\"9\" width=\"2\" height=\"1\" fill=\"#2F6F6B\"/><rect x=\"9\" y=\"10\" width=\"2\" height=\"3\" fill=\"#2F6F6B\"/>",
  },
  shield: {
    label: "Shield, pangolin guard",
    rects:
      "<rect x=\"1\" y=\"15\" width=\"13\" height=\"1\" fill=\"#231F2B\" opacity=\".3\"/><rect x=\"0\" y=\"10\" width=\"3\" height=\"3\" fill=\"#7D6B4F\"/><rect x=\"2\" y=\"5\" width=\"11\" height=\"8\" fill=\"#7D6B4F\"/><rect x=\"3\" y=\"6\" width=\"9\" height=\"1\" fill=\"#5E4F38\"/><rect x=\"3\" y=\"8\" width=\"9\" height=\"1\" fill=\"#5E4F38\"/><rect x=\"3\" y=\"10\" width=\"9\" height=\"1\" fill=\"#5E4F38\"/><rect x=\"6\" y=\"7\" width=\"2\" height=\"2\" fill=\"#E8B64A\"/><rect x=\"4\" y=\"13\" width=\"2\" height=\"2\" fill=\"#5E4F38\"/><rect x=\"9\" y=\"13\" width=\"2\" height=\"2\" fill=\"#5E4F38\"/><rect x=\"12\" y=\"8\" width=\"3\" height=\"4\" fill=\"#C9A877\"/><rect x=\"15\" y=\"10\" width=\"1\" height=\"1\" fill=\"#231F2B\"/><rect x=\"13\" y=\"9\" width=\"1\" height=\"1\" fill=\"#231F2B\"/><rect x=\"11\" y=\"6\" width=\"4\" height=\"2\" fill=\"#3B4A7A\"/><rect x=\"14\" y=\"7\" width=\"2\" height=\"1\" fill=\"#2B365C\"/>",
  },
  tally: {
    label: "Tally, raccoon bookkeeper",
    rects:
      "<rect x=\"3\" y=\"15\" width=\"11\" height=\"1\" fill=\"#231F2B\" opacity=\".3\"/><rect x=\"11\" y=\"9\" width=\"4\" height=\"2\" fill=\"#6F6F7D\"/><rect x=\"12\" y=\"9\" width=\"1\" height=\"2\" fill=\"#3A3644\"/><rect x=\"14\" y=\"9\" width=\"1\" height=\"2\" fill=\"#3A3644\"/><rect x=\"4\" y=\"7\" width=\"7\" height=\"6\" fill=\"#9A9AA6\"/><rect x=\"6\" y=\"9\" width=\"3\" height=\"3\" fill=\"#C7C7CF\"/><rect x=\"5\" y=\"13\" width=\"2\" height=\"2\" fill=\"#6F6F7D\"/><rect x=\"8\" y=\"13\" width=\"2\" height=\"2\" fill=\"#6F6F7D\"/><rect x=\"4\" y=\"2\" width=\"8\" height=\"6\" fill=\"#9A9AA6\"/><rect x=\"4\" y=\"1\" width=\"2\" height=\"2\" fill=\"#6F6F7D\"/><rect x=\"10\" y=\"1\" width=\"2\" height=\"2\" fill=\"#6F6F7D\"/><rect x=\"3\" y=\"2\" width=\"10\" height=\"1\" fill=\"#3E9A68\"/><rect x=\"4\" y=\"4\" width=\"8\" height=\"2\" fill=\"#3A3644\"/><rect x=\"6\" y=\"4\" width=\"1\" height=\"1\" fill=\"#FFF\"/><rect x=\"9\" y=\"4\" width=\"1\" height=\"1\" fill=\"#FFF\"/><rect x=\"6\" y=\"6\" width=\"4\" height=\"2\" fill=\"#E7E2DA\"/><rect x=\"7\" y=\"6\" width=\"2\" height=\"1\" fill=\"#231F2B\"/><rect x=\"1\" y=\"9\" width=\"3\" height=\"3\" fill=\"#E8B64A\"/><rect x=\"2\" y=\"10\" width=\"1\" height=\"1\" fill=\"#C48F25\"/>",
  },
  bolt: {
    label: "Bolt, robot Telegram relay",
    rects:
      "<rect x=\"3\" y=\"15\" width=\"10\" height=\"1\" fill=\"#231F2B\" opacity=\".3\"/><rect x=\"7\" y=\"0\" width=\"1\" height=\"2\" fill=\"#6E7B95\"/><rect x=\"6\" y=\"0\" width=\"3\" height=\"1\" fill=\"#E8B64A\"/><rect x=\"4\" y=\"2\" width=\"8\" height=\"6\" fill=\"#5FA89A\"/><rect x=\"4\" y=\"2\" width=\"8\" height=\"1\" fill=\"#7FC4B6\"/><rect x=\"3\" y=\"4\" width=\"1\" height=\"2\" fill=\"#4A8C80\"/><rect x=\"12\" y=\"4\" width=\"1\" height=\"2\" fill=\"#4A8C80\"/><rect x=\"5\" y=\"4\" width=\"6\" height=\"3\" fill=\"#12201A\"/><rect x=\"6\" y=\"5\" width=\"1\" height=\"1\" fill=\"#9FE0B0\"/><rect x=\"9\" y=\"5\" width=\"1\" height=\"1\" fill=\"#9FE0B0\"/><rect x=\"7\" y=\"8\" width=\"2\" height=\"1\" fill=\"#4A8C80\"/><rect x=\"4\" y=\"9\" width=\"8\" height=\"4\" fill=\"#5FA89A\"/><rect x=\"4\" y=\"12\" width=\"8\" height=\"1\" fill=\"#4A8C80\"/><rect x=\"7\" y=\"10\" width=\"2\" height=\"2\" fill=\"#E8B64A\"/><rect x=\"2\" y=\"9\" width=\"2\" height=\"3\" fill=\"#4A8C80\"/><rect x=\"12\" y=\"9\" width=\"2\" height=\"3\" fill=\"#4A8C80\"/><rect x=\"4\" y=\"13\" width=\"3\" height=\"2\" fill=\"#3A3644\"/><rect x=\"9\" y=\"13\" width=\"3\" height=\"2\" fill=\"#3A3644\"/>",
  },
  raven: {
    label: 'Raven, the red team',
    rects:
      '<rect x="3" y="15" width="10" height="1" fill="#231F2B" opacity=".3"/><rect x="4" y="7" width="8" height="6" fill="#2B2733"/><rect x="3" y="8" width="2" height="4" fill="#201D27"/><rect x="11" y="8" width="3" height="5" fill="#201D27"/><rect x="13" y="10" width="2" height="2" fill="#17151D"/><rect x="5" y="3" width="6" height="5" fill="#2B2733"/><rect x="5" y="2" width="6" height="2" fill="#201D27"/><rect x="9" y="5" width="2" height="2" fill="#E8A23A"/><rect x="10" y="5" width="1" height="1" fill="#231F2B"/><rect x="11" y="5" width="3" height="2" fill="#6F6F7D"/><rect x="13" y="6" width="2" height="1" fill="#4A4652"/><rect x="5" y="10" width="5" height="3" fill="#F6EEDC"/><rect x="5" y="10" width="5" height="1" fill="#C9603F"/><rect x="7" y="11" width="1" height="1" fill="#B24A2C"/><rect x="5" y="13" width="2" height="2" fill="#17151D"/><rect x="9" y="13" width="2" height="2" fill="#17151D"/>',
  },
};

/**
 * Markup for an agent's portrait. Safe to inject with `innerHTML`: it is built
 * from the constants above and never from customer input.
 */
export function agentSprite(key: AgentKey): string {
  const art = ART[key];
  return `<svg viewBox="0 0 16 16" shape-rendering="crispEdges" role="img" aria-label="${art.label}">${art.rects}</svg>`;
}
