export interface LinuxImageManifest {
  version: string;
  label?: string;
  description?: string;
  chunks: number;
  chunkUrlTemplate: string;
  compression?: 'none' | 'gzip';
  totalBytes: number;
  digest?: string;
  builtAt?: string;
  c2wVersion?: string;
}

export interface ResolvedLinuxImage extends LinuxImageManifest {
  manifestUrl: string;
  imageUrl: string;
  chunkUrlTemplate: string;
}

export async function loadManifest(url: string): Promise<ResolvedLinuxImage> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (error) {
    throw new Error(
      `Could not load the Linux manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `No Linux image manifest at ${url}. Build one with \`npm run build:linux\` or set a manifest URL in Settings.`,
      );
    }
    throw new Error(`Linux manifest request failed (${response.status}).`);
  }

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    if (body.trimStart().startsWith('<')) {
      throw new Error(
        `No Linux image manifest at ${url} (the server returned HTML). Run \`npm run fetch:linux-lite\` or build one with \`npm run build:linux\`.`,
      );
    }
    throw new Error(`Linux manifest is not valid JSON at ${url}.`);
  }

  if (!isRecord(parsed)) throw new Error('Linux manifest must be an object.');
  const chunks = Number(parsed.chunks);
  const totalBytes = Number(parsed.totalBytes);
  const chunkUrlTemplate =
    typeof parsed.chunkUrlTemplate === 'string' ? parsed.chunkUrlTemplate : './{index}.wasm';
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > 99) {
    throw new Error('Linux manifest `chunks` must be an integer between 1 and 99.');
  }
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('Linux manifest `totalBytes` must be a positive number.');
  }
  if (!chunkUrlTemplate.includes('{index}')) {
    throw new Error('Linux manifest `chunkUrlTemplate` must contain {index}.');
  }

  const absoluteTemplate = resolveTemplate(chunkUrlTemplate, url);
  return {
    version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
    label: typeof parsed.label === 'string' ? parsed.label : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    chunks,
    chunkUrlTemplate: absoluteTemplate,
    compression: parsed.compression === 'gzip' ? 'gzip' : 'none',
    totalBytes,
    digest: typeof parsed.digest === 'string' ? parsed.digest : undefined,
    builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : undefined,
    c2wVersion: typeof parsed.c2wVersion === 'string' ? parsed.c2wVersion : undefined,
    manifestUrl: url,
    imageUrl: url,
  };
}

function resolveTemplate(template: string, manifestUrl: string): string {
  if (/^https?:\/\//.test(template)) return template;
  const base = new URL('.', new URL(manifestUrl, window.location.href));
  if (template.startsWith('/')) {
    return `${base.origin}${template}`;
  }
  return `${base.href}${template.replace(/^\.\//, '')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
