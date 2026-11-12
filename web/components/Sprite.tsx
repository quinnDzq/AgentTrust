import { agentSprite } from '@app/sprites.ts';
import type { AgentKey } from '@app/types.ts';

/**
 * One of Vince's crew, drawn from the studio's own pixel art.
 *
 * `agentSprite` builds its markup from constants in `app/src/sprites.ts` and
 * never from data, which is what makes injecting it safe here, exactly as the
 * studio does. Nothing from the snapshot ever goes through this.
 */
export function Sprite({
  who,
  size = 40,
  decorative = false,
  className = '',
}: {
  readonly who: AgentKey;
  readonly size?: number;
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={`vp-sprite ${className}`}
      style={{ width: size, height: size }}
      aria-hidden={decorative ? true : undefined}
      dangerouslySetInnerHTML={{ __html: agentSprite(who) }}
    />
  );
}
