import type { WalletKind } from '@/lib/wallet-template';

/**
 * Small bitmaps drawn as crisp SVG pixels, the way the Studio's sprites are:
 * one rect per lit cell, `crispEdges`, no image files. Every icon on the
 * verification page comes through here, so they share one grid and one hand.
 *
 * A bitmap is rows of characters. `.` is empty; any other character is looked
 * up in the palette, and `#` defaults to the current text colour.
 */

interface Bitmap {
  readonly rows: readonly string[];
  readonly palette?: { readonly [cell: string]: string };
}

function rects({ rows, palette = {} }: Bitmap): React.ReactElement[] {
  const cells: React.ReactElement[] = [];
  rows.forEach((row, y) => {
    // Merge horizontal runs of one colour into a single rect.
    let x = 0;
    while (x < row.length) {
      const cell = row[x];
      if (cell === undefined || cell === '.') {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === cell) end += 1;
      cells.push(
        <rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} fill={palette[cell] ?? 'currentColor'} />,
      );
      x = end;
    }
  });
  return cells;
}

function Pixels({
  art,
  size,
  label,
  className,
}: {
  readonly art: Bitmap;
  readonly size: number;
  readonly label?: string;
  readonly className?: string;
}) {
  const width = art.rows[0]?.length ?? 1;
  const height = art.rows.length;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      width={(size * width) / Math.max(width, height)}
      height={(size * height) / Math.max(width, height)}
      shapeRendering="crispEdges"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {rects(art)}
    </svg>
  );
}

/* ---------- Wallets ---------- */

/*
 * PayPal is the one real provider here, so it gets its own colours and a
 * two-letter monogram drawn for this page. It is a nod to the brand, not a
 * copy of its logo. The other two are simulated kinds of wallet and stay
 * generic on purpose: no concrete product is named or drawn.
 */
const WALLET_ART: { readonly [W in WalletKind]: Bitmap } = {
  paypal: {
    palette: { B: '#003087', L: '#009cde', W: '#ffffff' },
    rows: [
      '.BBBBBBBBBBBBBB.',
      'BBBBBBBBBBBBBBBB',
      'BBBWWWWWWBBBBBBB',
      'BBBWWWWWWWBBBBBB',
      'BBBWWBBBWWBBBBBB',
      'BBBWWBLLWWLLBBBB',
      'BBBWWWWWWWLLLBBB',
      'BBBWWWWWWBBLLBBB',
      'BBBWWBLLBBBLLBBB',
      'BBBWWBLLLLLLLBBB',
      'BBBWWBLLLLLLBBBB',
      'BBBWWBLLBBBBBBBB',
      'BBBBBBLLBBBBBBBB',
      'BBBBBBLLBBBBBBBB',
      'BBBBBBBBBBBBBBBB',
      '.BBBBBBBBBBBBBB.',
    ],
  },
  electronic: {
    palette: { T: '#5fa89a', D: '#3f7f72', G: '#e8b64a', C: '#f4ecd8', K: '#221e2a' },
    rows: [
      '................',
      '................',
      '....CCCCCCCC....',
      '....CCCCCCCC....',
      '..TTTTTTTTTTTT..',
      '.TTTTTTTTTTTTTT.',
      '.TDDDDDDDDDDDDT.',
      '.TTTTTTTTTTTTTT.',
      '.TTTTTTTTTTGGGT.',
      '.TTTTTTTTTTGKGT.',
      '.TTTTTTTTTTGGGT.',
      '.TTTTTTTTTTTTTT.',
      '.TTTTTTTTTTTTTT.',
      '..DDDDDDDDDDDD..',
      '................',
      '................',
    ],
  },
  blockchain: {
    palette: { S: '#9cc4f5', U: '#56739c', A: '#f2c46b' },
    rows: [
      '................',
      '................',
      '................',
      '................',
      '................',
      '.SSSS.SSSS.SSSS.',
      '.SUUS.SUUS.SUUS.',
      '.SUUSASUUSASUUS.',
      '.SUUSASUUSASUUS.',
      '.SUUS.SUUS.SUUS.',
      '.SSSS.SSSS.SSSS.',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
  },
};

/** A wallet's mark on its tile. Decorative: the wallet's name is always written beside it. */
export function WalletIcon({ wallet, size = 48 }: { readonly wallet: WalletKind; readonly size?: number }) {
  return (
    <span className="wt-tile" data-wallet={wallet} style={{ width: size, height: size }} aria-hidden="true">
      <Pixels art={WALLET_ART[wallet]} size={Math.round(size * 0.68)} />
    </span>
  );
}

/* ---------- Glyphs ---------- */

const GLYPHS = {
  close: {
    rows: ['##....##', '###..###', '.######.', '..####..', '..####..', '.######.', '###..###', '##....##'],
  },
  check: {
    rows: ['.......##', '......###', '##...###.', '###.###..', '.#####...', '..###....', '...#.....'],
  },
  cross: {
    rows: ['##...##', '###.###', '.#####.', '..###..', '.#####.', '###.###', '##...##'],
  },
  dash: {
    rows: ['.......', '.......', '#######', '#######', '.......', '.......'],
  },
  gear: {
    rows: [
      '....###....',
      '.#..###..#.',
      '.#########.',
      '..###.###..',
      '###.....###',
      '###.....###',
      '###.....###',
      '..###.###..',
      '.#########.',
      '.#..###..#.',
      '....###....',
    ],
  },
  lock: {
    rows: [
      '..#####..',
      '.##...##.',
      '.#.....#.',
      '.#.....#.',
      '#########',
      '#########',
      '####.####',
      '####.####',
      '#########',
      '#########',
    ],
  },
  wallet: {
    rows: [
      '.##########..',
      '############.',
      '##..........#',
      '##.......####',
      '##.......#.##',
      '##.......####',
      '##..........#',
      '############.',
      '.##########..',
    ],
  },
  next: {
    rows: ['##...', '###..', '####.', '#####', '####.', '###..', '##...'],
  },
} as const satisfies { readonly [name: string]: Bitmap };

export type GlyphName = keyof typeof GLYPHS;

/** A one-colour glyph in the current text colour. Give it a label only when no text says the same. */
export function Glyph({
  name,
  size = 14,
  label,
  className,
}: {
  readonly name: GlyphName;
  readonly size?: number;
  readonly label?: string;
  readonly className?: string;
}) {
  return <Pixels art={GLYPHS[name]} size={size} {...(label ? { label } : {})} {...(className ? { className } : {})} />;
}
