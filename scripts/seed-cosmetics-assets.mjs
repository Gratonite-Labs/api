import sharp from 'sharp';
import { Client } from 'minio';
import postgres from 'postgres';

// ── Config ──────────────────────────────────────────────────────────────────
const endpoint = process.env.MINIO_ENDPOINT ?? 'localhost';
const port = Number(process.env.MINIO_PORT ?? 9000);
const useSSL = (process.env.MINIO_USE_SSL ?? 'false') === 'true';
const accessKey = process.env.MINIO_ACCESS_KEY ?? 'gratonite';
const secretKey = process.env.MINIO_SECRET_KEY ?? 'gratonite123';
const dbUrl = process.env.DATABASE_URL ?? 'postgres://gratonite:gratonite@localhost:5433/gratonite';

const minio = new Client({ endPoint: endpoint, port, useSSL, accessKey, secretKey });
const sql = postgres(dbUrl, { max: 2 });
const bucket = 'avatars';

// ── Helpers ─────────────────────────────────────────────────────────────────

function nameToHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function hsl(h, s, l) {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function hexFromHue(h) {
  // Convert hue to a hex color (full saturation, 55% lightness)
  const s = 75, l = 55;
  const a = s * Math.min(l, 100 - l) / 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(2.55 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

async function upload(key, buffer) {
  await minio.putObject(bucket, `cosmetics/${key}`, buffer, buffer.length, {
    'Content-Type': 'image/webp',
  });
}

// ── Avatar Decoration SVG Generators ────────────────────────────────────────
const decorationGenerators = [
  // 0: Starfield dots on ring
  (hue) => {
    const c = hexFromHue(hue);
    const c2 = hexFromHue((hue + 40) % 360);
    const dots = Array.from({ length: 24 }, (_, i) => {
      const angle = (i / 24) * Math.PI * 2;
      const r = 210 + (i % 3) * 15;
      const x = 256 + Math.cos(angle) * r;
      const y = 256 + Math.sin(angle) * r;
      const size = 3 + (i % 4);
      return `<circle cx="${x}" cy="${y}" r="${size}" fill="${i % 2 === 0 ? c : c2}" opacity="${0.5 + (i % 3) * 0.2}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <circle cx="256" cy="256" r="220" fill="none" stroke="${c}" stroke-width="28" opacity="0.6"/>
      ${dots}
    </svg>`;
  },
  // 1: Crystalline faceted edges
  (hue) => {
    const c = hexFromHue(hue);
    const c2 = hexFromHue((hue + 60) % 360);
    const facets = Array.from({ length: 12 }, (_, i) => {
      const a1 = (i / 12) * Math.PI * 2;
      const a2 = ((i + 1) / 12) * Math.PI * 2;
      const r1 = 200, r2 = 240;
      const x1 = 256 + Math.cos(a1) * r2;
      const y1 = 256 + Math.sin(a1) * r2;
      const x2 = 256 + Math.cos(a2) * r2;
      const y2 = 256 + Math.sin(a2) * r2;
      const xm = 256 + Math.cos((a1 + a2) / 2) * r1;
      const ym = 256 + Math.sin((a1 + a2) / 2) * r1;
      return `<polygon points="${x1},${y1} ${x2},${y2} ${xm},${ym}" fill="${i % 2 === 0 ? c : c2}" opacity="${0.35 + (i % 3) * 0.1}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <circle cx="256" cy="256" r="210" fill="none" stroke="${c}" stroke-width="6" opacity="0.4"/>
      ${facets}
    </svg>`;
  },
  // 2: Petal/leaf shapes along ring
  (hue) => {
    const c = hexFromHue(hue);
    const petals = Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * 360;
      const x = 256 + Math.cos((angle * Math.PI) / 180) * 220;
      const y = 256 + Math.sin((angle * Math.PI) / 180) * 220;
      return `<ellipse cx="${x}" cy="${y}" rx="24" ry="12" transform="rotate(${angle} ${x} ${y})" fill="${c}" opacity="0.55"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <circle cx="256" cy="256" r="220" fill="none" stroke="${c}" stroke-width="20" opacity="0.35"/>
      ${petals}
    </svg>`;
  },
  // 3: Lightning bolt accents
  (hue) => {
    const c = hexFromHue(hue);
    const bolts = Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2;
      const x = 256 + Math.cos(a) * 220;
      const y = 256 + Math.sin(a) * 220;
      const dx = Math.cos(a) * 30;
      const dy = Math.sin(a) * 30;
      return `<polyline points="${x - dx},${y - dy} ${x},${y + 8} ${x + 5},${y - 5} ${x + dx},${y + dy}" fill="none" stroke="${c}" stroke-width="4" opacity="0.7"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <circle cx="256" cy="256" r="215" fill="none" stroke="${c}" stroke-width="30" opacity="0.3"/>
      <circle cx="256" cy="256" r="215" fill="none" stroke="white" stroke-width="4" opacity="0.2"/>
      ${bolts}
    </svg>`;
  },
  // 4: Vine/organic swirls
  (hue) => {
    const c = hexFromHue(hue);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <circle cx="256" cy="256" r="220" fill="none" stroke="${c}" stroke-width="24" opacity="0.4"/>
      <circle cx="256" cy="256" r="235" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="18 12" opacity="0.5"/>
      <circle cx="256" cy="256" r="200" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="8 20" opacity="0.45"/>
    </svg>`;
  },
  // 5: Pixel grid overlay
  (hue) => {
    const c = hexFromHue(hue);
    const c2 = hexFromHue((hue + 180) % 360);
    const pixels = Array.from({ length: 32 }, (_, i) => {
      const angle = (i / 32) * Math.PI * 2;
      const r = 210 + ((i * 7) % 3) * 10;
      const x = 256 + Math.cos(angle) * r;
      const y = 256 + Math.sin(angle) * r;
      return `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" fill="${i % 3 === 0 ? c2 : c}" opacity="${0.4 + (i % 4) * 0.1}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <circle cx="256" cy="256" r="220" fill="none" stroke="${c}" stroke-width="16" opacity="0.25"/>
      ${pixels}
    </svg>`;
  },
];

// ── Profile Effect SVG Generators ───────────────────────────────────────────
const effectGenerators = [
  // 0: Horizontal wavy bands
  (hue) => {
    const c = hexFromHue(hue);
    const c2 = hexFromHue((hue + 50) % 360);
    const bands = Array.from({ length: 8 }, (_, i) => {
      const y = 30 + i * 65;
      return `<path d="M0,${y} Q240,${y - 20} 480,${y} Q720,${y + 20} 960,${y}" fill="none" stroke="${i % 2 === 0 ? c : c2}" stroke-width="${6 + (i % 3) * 3}" opacity="${0.2 + (i % 3) * 0.1}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
      <rect width="960" height="540" fill="${c}" fill-opacity="0.08"/>
      ${bands}
    </svg>`;
  },
  // 1: Scattered circles (rain/confetti)
  (hue) => {
    const c = hexFromHue(hue);
    const circles = Array.from({ length: 40 }, (_, i) => {
      const x = (i * 97 + 31) % 960;
      const y = (i * 67 + 13) % 540;
      const r = 4 + (i % 8) * 3;
      const h2 = (hue + i * 15) % 360;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${hexFromHue(h2)}" opacity="${0.15 + (i % 5) * 0.08}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
      <rect width="960" height="540" fill="${c}" fill-opacity="0.06"/>
      ${circles}
    </svg>`;
  },
  // 2: Vertical falling lines (matrix/rain)
  (hue) => {
    const c = hexFromHue(hue);
    const lines = Array.from({ length: 24 }, (_, i) => {
      const x = 20 + i * 40;
      const y1 = (i * 37) % 200;
      const h = 80 + (i % 5) * 60;
      return `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y1 + h}" stroke="${c}" stroke-width="2" opacity="${0.15 + (i % 4) * 0.1}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
      <rect width="960" height="540" fill="${c}" fill-opacity="0.05"/>
      ${lines}
    </svg>`;
  },
  // 3: Radial burst from center
  (hue) => {
    const c = hexFromHue(hue);
    const c2 = hexFromHue((hue + 90) % 360);
    const rays = Array.from({ length: 16 }, (_, i) => {
      const angle = (i / 16) * Math.PI * 2;
      const x2 = 480 + Math.cos(angle) * 500;
      const y2 = 270 + Math.sin(angle) * 400;
      return `<line x1="480" y1="270" x2="${x2}" y2="${y2}" stroke="${i % 2 === 0 ? c : c2}" stroke-width="${2 + (i % 3)}" opacity="${0.1 + (i % 4) * 0.05}"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
      ${rays}
      <circle cx="480" cy="270" r="60" fill="${c}" fill-opacity="0.12"/>
    </svg>`;
  },
  // 4: Floating organic shapes (fireflies/bubbles)
  (hue) => {
    const bubbles = Array.from({ length: 20 }, (_, i) => {
      const x = (i * 131 + 50) % 920 + 20;
      const y = (i * 89 + 30) % 500 + 20;
      const r = 8 + (i % 6) * 6;
      const h2 = (hue + i * 20) % 360;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${hexFromHue(h2)}" fill-opacity="${0.12 + (i % 4) * 0.06}" stroke="${hexFromHue(h2)}" stroke-width="1" stroke-opacity="0.25"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
      ${bubbles}
    </svg>`;
  },
  // 5: Geometric grid (neon/cyber)
  (hue) => {
    const c = hexFromHue(hue);
    const gridLines = [];
    for (let x = 0; x <= 960; x += 60) {
      gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="540" stroke="${c}" stroke-width="1" opacity="0.12"/>`);
    }
    for (let y = 0; y <= 540; y += 60) {
      gridLines.push(`<line x1="0" y1="${y}" x2="960" y2="${y}" stroke="${c}" stroke-width="1" opacity="0.12"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
      ${gridLines.join('')}
      <rect x="360" y="180" width="240" height="180" fill="${c}" fill-opacity="0.06" stroke="${c}" stroke-width="2" stroke-opacity="0.3"/>
    </svg>`;
  },
];

// ── Nameplate SVG Generators ────────────────────────────────────────────────
const nameplateGenerators = [
  // 0: Clean two-tone gradient
  (hue) => {
    const c1 = hexFromHue(hue);
    const c2 = hexFromHue((hue + 60) % 360);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="48">
      <defs><linearGradient id="g"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
      <rect width="400" height="48" rx="8" fill="url(#g)"/>
    </svg>`;
  },
  // 1: Three-color gradient with middle accent
  (hue) => {
    const c1 = hexFromHue(hue);
    const c2 = hexFromHue((hue + 120) % 360);
    const c3 = hexFromHue((hue + 240) % 360);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="48">
      <defs><linearGradient id="g"><stop offset="0%" stop-color="${c1}"/><stop offset="50%" stop-color="${c2}"/><stop offset="100%" stop-color="${c3}"/></linearGradient></defs>
      <rect width="400" height="48" rx="8" fill="url(#g)"/>
    </svg>`;
  },
  // 2: Diagonal stripe overlay
  (hue) => {
    const c = hexFromHue(hue);
    const c2 = hexFromHue((hue + 30) % 360);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="48">
      <defs>
        <pattern id="stripes" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="12" stroke="${c2}" stroke-width="4" opacity="0.2"/>
        </pattern>
      </defs>
      <rect width="400" height="48" rx="8" fill="${c}"/>
      <rect width="400" height="48" rx="8" fill="url(#stripes)"/>
    </svg>`;
  },
  // 3: Metallic/chrome effect (light band)
  (hue) => {
    const c = hexFromHue(hue);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="48">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${c}" stop-opacity="0.8"/>
        <stop offset="40%" stop-color="white" stop-opacity="0.3"/>
        <stop offset="60%" stop-color="${c}" stop-opacity="0.9"/>
        <stop offset="100%" stop-color="${c}" stop-opacity="0.6"/>
      </linearGradient></defs>
      <rect width="400" height="48" rx="8" fill="url(#g)"/>
    </svg>`;
  },
  // 4: Crosshatch/fiber texture overlay
  (hue) => {
    const c = hexFromHue(hue);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="48">
      <defs>
        <pattern id="fiber" patternUnits="userSpaceOnUse" width="8" height="8">
          <line x1="0" y1="0" x2="8" y2="8" stroke="white" stroke-width="0.5" opacity="0.12"/>
          <line x1="8" y1="0" x2="0" y2="8" stroke="white" stroke-width="0.5" opacity="0.12"/>
        </pattern>
      </defs>
      <rect width="400" height="48" rx="8" fill="${c}"/>
      <rect width="400" height="48" rx="8" fill="url(#fiber)"/>
    </svg>`;
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  let generated = 0;

  // ── 1. Shop items (paid cosmetics) ──────────────────────────────────────
  console.log('Querying shop_items from database…');
  const items = await sql`SELECT id, name, type FROM shop_items WHERE type != 'soundboard_sound' ORDER BY id`;
  console.log(`Found ${items.length} cosmetic shop items to generate assets for.`);

  for (const item of items) {
    const hue = nameToHue(item.name);
    const assetKey = `shop-${item.id}.webp`;

    if (item.type === 'avatar_decoration') {
      const gen = decorationGenerators[Number(item.id) % decorationGenerators.length];
      const buffer = await sharp(Buffer.from(gen(hue))).resize(256, 256).webp({ quality: 90 }).toBuffer();
      await upload(assetKey, buffer);
    } else if (item.type === 'profile_effect') {
      const gen = effectGenerators[Number(item.id) % effectGenerators.length];
      const buffer = await sharp(Buffer.from(gen(hue))).resize(400, 240, { fit: 'cover' }).webp({ quality: 88 }).toBuffer();
      await upload(assetKey, buffer);
    } else if (item.type === 'nameplate') {
      const gen = nameplateGenerators[Number(item.id) % nameplateGenerators.length];
      const buffer = await sharp(Buffer.from(gen(hue))).resize(400, 48).webp({ quality: 90 }).toBuffer();
      await upload(assetKey, buffer);
    } else {
      continue;
    }

    await sql`UPDATE shop_items SET asset_hash = ${assetKey} WHERE id = ${item.id}`;
    generated++;
    console.log(`  [${generated}] shop_item ${item.type} "${item.name}" → cosmetics/${assetKey}`);
  }

  // ── 2. Free catalog: avatar_decorations ─────────────────────────────────
  console.log('\nQuerying avatar_decorations (free catalog)…');
  const decorations = await sql`SELECT id, name FROM avatar_decorations ORDER BY id`;
  console.log(`Found ${decorations.length} free avatar decorations.`);

  for (const dec of decorations) {
    const hue = nameToHue(dec.name);
    const assetKey = `deco-${dec.id}.webp`;
    const gen = decorationGenerators[Number(dec.id) % decorationGenerators.length];
    const buffer = await sharp(Buffer.from(gen(hue))).resize(256, 256).webp({ quality: 90 }).toBuffer();
    await upload(assetKey, buffer);
    await sql`UPDATE avatar_decorations SET asset_hash = ${assetKey} WHERE id = ${dec.id}`;
    generated++;
    console.log(`  [${generated}] avatar_decoration "${dec.name}" → cosmetics/${assetKey}`);
  }

  // ── 3. Free catalog: profile_effects ────────────────────────────────────
  console.log('\nQuerying profile_effects (free catalog)…');
  const effects = await sql`SELECT id, name FROM profile_effects ORDER BY id`;
  console.log(`Found ${effects.length} free profile effects.`);

  for (const eff of effects) {
    const hue = nameToHue(eff.name);
    const assetKey = `effect-${eff.id}.webp`;
    const gen = effectGenerators[Number(eff.id) % effectGenerators.length];
    const buffer = await sharp(Buffer.from(gen(hue))).resize(400, 240, { fit: 'cover' }).webp({ quality: 88 }).toBuffer();
    await upload(assetKey, buffer);
    await sql`UPDATE profile_effects SET asset_hash = ${assetKey} WHERE id = ${eff.id}`;
    generated++;
    console.log(`  [${generated}] profile_effect "${eff.name}" → cosmetics/${assetKey}`);
  }

  // ── 4. Free catalog: nameplates ─────────────────────────────────────────
  console.log('\nQuerying nameplates (free catalog)…');
  const nps = await sql`SELECT id, name FROM nameplates ORDER BY id`;
  console.log(`Found ${nps.length} free nameplates.`);

  for (const np of nps) {
    const hue = nameToHue(np.name);
    const assetKey = `nameplate-${np.id}.webp`;
    const gen = nameplateGenerators[Number(np.id) % nameplateGenerators.length];
    const buffer = await sharp(Buffer.from(gen(hue))).resize(400, 48).webp({ quality: 90 }).toBuffer();
    await upload(assetKey, buffer);
    await sql`UPDATE nameplates SET asset_hash = ${assetKey} WHERE id = ${np.id}`;
    generated++;
    console.log(`  [${generated}] nameplate "${np.name}" → cosmetics/${assetKey}`);
  }

  console.log(`\nDone. Generated ${generated} total assets and updated database.`);
  await sql.end();
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
